import Foundation
import PodcastAPI
import os

/// The server's API, answered on the phone. `APIClient` sends every request through an `HTTPTransport`; this is
/// the one for a build with no server (docs/store-app-plan.md). It takes a request for a `/v1/…` path and returns
/// the JSON the server would, read from and written to an SQLite file in `folder`, so the app's screens and models
/// work unchanged. `server/src/services` is the reference: the rules and SQL here are ported from it, and each
/// place the phone must differ says so where it does.
///
/// What is answered: health, feeds (list, add, read, change, remove, refresh), show search, episodes (list, one,
/// audio), Up next, playback reports, and the three snip lists (empty). Everything else is a 404 in the server's
/// error envelope with the message "Not available on this phone".
///
/// Where the phone differs from the server, in general:
/// - **No login.** There is one listener and no network between the app and its data, so `Authorization` is
///   ignored and nothing answers 401. `deviceName` is the name `resume.device_name` carries.
/// - **No jobs.** The server answers at once and works in the background; the phone does the work before it
///   answers. Adding a feed fetches and reads it first, so the answer already has its title and episodes.
/// - **Audio is the publisher's file.** Every episode has its recording from the moment it is listed
///   (`asset.audio_url` is the enclosure URL), and nothing is transcribed, summarized or billed.
public final class LocalBackend: HTTPTransport, Sendable {
  let store: Store
  let http: any HTTPTransport
  static let log = Logger(subsystem: "snip.ondevice", category: "backend")

  /// `folder` holds the SQLite file (made if missing). `http` is what feeds and show search are fetched through
  /// (tests pass a stub). `now` is the clock every stored time comes from.
  public init(
    folder: URL, deviceName: String, http: any HTTPTransport = URLSession.shared,
    now: @escaping @Sendable () -> Date = { Date() }
  ) throws {
    store = try Store(folder: folder, deviceName: deviceName, now: now)
    self.http = http
  }

  /// Answer a request for a `/v1/…` path with an `HTTPURLResponse` carrying the server's status codes. Never
  /// throws: a transport throws when no answer came, and the phone always has one.
  public func respond(to request: URLRequest) async throws -> (Data, URLResponse) {
    var answer: Answer
    do {
      answer = try await route(Call(request))
    } catch let error as HTTPError {
      answer = Answer(status: error.status, body: error.body)
    } catch {
      Self.log.error("unhandled error: \(String(describing: error), privacy: .public)")
      answer = Answer(status: 500, body: HTTPError(status: 500, code: "internal", message: "internal error").body)
    }
    let url = request.url ?? URL(string: "http://localhost/")!
    let data = answer.body?.data() ?? Data()
    let headers = answer.body == nil ? [:] : ["Content-Type": "application/json; charset=utf-8", "Content-Length": String(data.count)]
    let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: headers)!
    return (data, response)
  }

  /// Refresh every followed feed last refreshed more than `olderThan` seconds ago, a few at a time. The server
  /// does this on a timer; the app calls it at launch and on coming to the foreground. A feed that fails records
  /// why (`last_error`) and counts as refreshed, so a dead feed is not asked again until it is stale again.
  public func refreshFeeds(olderThan: TimeInterval) async {
    // Clamped so that a nonsense age (negative, infinite) is "everything" or "nothing" rather than a trap.
    let age = Int(max(0, min(olderThan, 1e10)) * 1000)
    guard let ids = try? await store.staleFollowedFeedIds(olderThanMs: age), !ids.isEmpty else { return }
    await withTaskGroup(of: Void.self) { group in
      var waiting = ids.makeIterator()
      for _ in 0..<4 {
        guard let id = waiting.next() else { break }
        group.addTask { _ = try? await self.refresh(feedId: id) }
      }
      while await group.next() != nil {
        guard let id = waiting.next() else { continue }
        group.addTask { _ = try? await self.refresh(feedId: id) }
      }
    }
  }

  // MARK: Routes

  struct Answer {
    var status = 200
    /// Nil for 204.
    var body: JSON?
  }

  private func route(_ call: Call) async throws -> Answer {
    let p = call.parts
    switch (call.method, p.first ?? "", p.count) {
    case ("GET", "health", 1):
      // The server adds its job counts for a signed-in device; the phone has no jobs to count.
      return Answer(body: ["ok": true])

    // Feeds (server/src/http/routes/feeds.ts)
    case ("GET", "feeds", 1):
      return Answer(body: try await store.listFeeds(followed: try call.bool("followed")))
    case ("POST", "feeds", 1):
      return Answer(status: 201, body: try await addFeed(try call.body()))
    case ("GET", "feeds", 2):
      return Answer(body: try await store.feed(p[1]))
    case ("PATCH", "feeds", 2):
      return Answer(body: try await store.updateFeed(p[1], try Self.updateFeedInput(try call.body())))
    case ("DELETE", "feeds", 2):
      try await store.deleteFeed(p[1])
      return Answer(status: 204)
    case ("POST", "feeds", 3) where p[2] == "refresh":
      // The server queues the refresh and answers 202 with the job; the phone has no jobs, so it refreshes now
      // and answers 204 when done. A refresh that fails is on the feed (`last_error`), as it is on the server.
      _ = try await store.feedRow(p[1])
      _ = try? await refresh(feedId: p[1])
      return Answer(status: 204)
    case ("GET", "search", 2) where p[1] == "shows":
      guard let q = call.query["q"] else { throw HTTPError.validation("querystring must have required property 'q'") }
      if q.count < 2 { throw HTTPError.validation("querystring/q must NOT have fewer than 2 characters") }
      if q.count > 200 { throw HTTPError.validation("querystring/q must NOT have more than 200 characters") }
      return Answer(body: try await searchShows(q, limit: try call.int("limit", 1...50) ?? 10))

    // Episodes and Up next (server/src/http/routes/episodes.ts)
    case ("GET", "episodes", 1):
      return Answer(
        body: try await store.listEpisodes(feedId: call.query["feed_id"], after: call.query["after"], limit: try call.int("limit", 1...200)))
    case ("GET", "episodes", 2):
      return Answer(body: try await store.episode(p[1]))
    case ("POST", "episodes", 3) where p[2] == "audio":
      // On the server this starts the download the player waits for. The phone's recording is already the
      // publisher's file, so all that is left of that job is the episode's chapters file, fetched once.
      _ = try await store.episodeRow(p[1])
      await fetchFeedChapters(episodeId: p[1])
      return Answer(status: 202, body: try await store.episode(p[1]))
    case ("GET", "queue", 1):
      return Answer(body: try await store.listQueue(limit: try call.int("limit", 1...200)))
    case ("PUT", "queue", 1):
      let body = try call.body()
      guard let ids = try body.strings("episode_ids") else { throw HTTPError.validation("body must have required property 'episode_ids'") }
      if ids.count > 200 { throw HTTPError.validation("body/episode_ids must NOT have more than 200 items") }
      return Answer(body: try await store.setQueueOrder(ids))
    case ("POST", "queue", 2):
      let at = call.query["at"] ?? "end"
      guard at == "start" || at == "end" else { throw HTTPError.validation("querystring/at must be equal to constant") }
      return Answer(body: try await store.addToQueue(p[1], atStart: at == "start"))
    case ("DELETE", "queue", 2):
      return Answer(body: try await store.removeFromQueue(p[1]))

    // Playback (server/src/http/routes/playback.ts)
    case ("PUT", "playback", 2):
      return Answer(body: try await store.reportPlayback(assetId: p[1], try Self.playbackInput(try call.body())))

    // Snips: none can be made on the phone yet, so the Snips tab's three lists are empty rather than errors.
    case ("GET", "snips", 1):
      return Answer(body: ["items": [], "next": nil])
    case ("GET", "snips", 2) where p[1] == "episodes":
      return Answer(body: ["items": [], "next": nil])
    case ("GET", "snips", 2) where p[1] == "shows":
      return Answer(body: ["items": []])

    default:
      throw HTTPError.notOnThisPhone
    }
  }

  /// `POST /v1/feeds`. The server inserts the feed, queues its first refresh and answers before the feed has been
  /// read (the app then polls). The phone reads the feed before answering, so the answer has the title and the
  /// episodes exist. A feed that cannot be fetched or read is still added, with `last_error` saying why, which is
  /// where the server's failed refresh job leaves it; it is tried again with the others when followed.
  private func addFeed(_ body: Body) async throws -> JSON {
    guard let url = try body.string("url") else { throw HTTPError.validation("body must have required property 'url'") }
    let kind = try body.string("kind")
    if let kind, !["podcast", "text", "youtube"].contains(kind) { throw HTTPError.validation("body/kind must be equal to constant") }
    let input = AddFeedInput(
      url: url, kind: kind, textForFeedId: try body.string("text_for_feed_id"), isPrivate: try body.bool("is_private"),
      autoProcess: try body.bool("auto_process"), keyterms: try body.strings("keyterms"), backfill: try body.int("backfill", 0...500),
      followed: try body.bool("followed"))
    let row = try await store.addFeed(input)
    _ = try? await refresh(feedId: row.id)
    return try await store.feed(row.id)
  }

  private static func updateFeedInput(_ body: Body) throws -> UpdateFeedInput {
    let title = try body.string("title")
    if let title, title.isEmpty { throw HTTPError.validation("body/title must NOT have fewer than 1 characters") }
    let transcriber = try body.string("transcriber")
    if let transcriber, !["elevenlabs", "whisper-local"].contains(transcriber) {
      throw HTTPError.validation("body/transcriber must be equal to constant")
    }
    return UpdateFeedInput(
      title: title, isPrivate: try body.bool("is_private"), autoProcess: try body.bool("auto_process"), transcriber: transcriber,
      keyterms: try body.strings("keyterms"), backfill: try body.int("backfill", 0...500), followed: try body.bool("followed"))
  }

  private static func playbackInput(_ body: Body) throws -> PlaybackReportInput {
    func required<T>(_ name: String, _ value: T?) throws -> T {
      guard let value else { throw HTTPError.validation("body must have required property '\(name)'") }
      return value
    }
    let speed = try required("speed", try body.number("speed"))
    if speed < 0.25 { throw HTTPError.validation("body/speed must be >= 0.25") }
    if speed > 4 { throw HTTPError.validation("body/speed must be <= 4") }
    return PlaybackReportInput(
      positionMs: Double(try required("position_ms", try body.int("position_ms", 0...Int.max))), speed: speed,
      playing: try required("playing", try body.bool("playing")), finished: try required("finished", try body.bool("finished")),
      seq: try required("seq", try body.int("seq", 0...Int.max)), observedAt: try body.int("observed_at", 0...Int.max).map(Double.init))
  }
}

/// A request, taken apart the way the server's router would.
struct Call {
  let method: String
  /// The path after `/v1`, split at `/`. Empty when the path has no `/v1`, which no route matches.
  let parts: [String]
  let query: [String: String]
  let bodyData: Data?

  init(_ request: URLRequest) {
    method = (request.httpMethod ?? "GET").uppercased()
    let components = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
    let segments = (components?.path ?? "").split(separator: "/").map(String.init)
    // Whatever comes before `/v1` is the base URL the app chose for this transport, which means nothing here.
    parts = segments.firstIndex(of: "v1").map { Array(segments[($0 + 1)...]) } ?? []
    var query: [String: String] = [:]
    for item in components?.queryItems ?? [] where query[item.name] == nil { query[item.name] = item.value ?? "" }
    self.query = query
    bodyData = request.httpBody
  }

  func int(_ name: String, _ range: ClosedRange<Int>) throws -> Int? {
    guard let raw = query[name] else { return nil }
    guard let value = Int(raw) else { throw HTTPError.validation("querystring/\(name) must be integer") }
    if value < range.lowerBound { throw HTTPError.validation("querystring/\(name) must be >= \(range.lowerBound)") }
    if value > range.upperBound { throw HTTPError.validation("querystring/\(name) must be <= \(range.upperBound)") }
    return value
  }

  func bool(_ name: String) throws -> Bool? {
    switch query[name] {
    case nil: return nil
    case "true", "1": return true
    case "false", "0": return false
    default: throw HTTPError.validation("querystring/\(name) must be boolean")
    }
  }

  func body() throws -> Body {
    guard let bodyData, !bodyData.isEmpty, let value = try? JSONDecoder().decode(JSONValue.self, from: bodyData),
      case .object(let members) = value
    else { throw HTTPError.validation("body must be object") }
    return Body(members: members)
  }
}

/// A JSON request body, read field by field with the checks the server's schemas make. A field of the wrong type
/// is a 400 with the server's `validation` code; one that is absent (or null) is nil.
struct Body {
  let members: [String: JSONValue]

  private func value(_ name: String) -> JSONValue? {
    guard let value = members[name], value != .null else { return nil }
    return value
  }

  func string(_ name: String) throws -> String? {
    guard let value = value(name) else { return nil }
    guard case .string(let string) = value else { throw HTTPError.validation("body/\(name) must be string") }
    return string
  }

  func bool(_ name: String) throws -> Bool? {
    guard let value = value(name) else { return nil }
    guard case .bool(let bool) = value else { throw HTTPError.validation("body/\(name) must be boolean") }
    return bool
  }

  func number(_ name: String) throws -> Double? {
    guard let value = value(name) else { return nil }
    guard case .number(let number) = value else { throw HTTPError.validation("body/\(name) must be number") }
    return number
  }

  func int(_ name: String, _ range: ClosedRange<Int>) throws -> Int? {
    guard let value = value(name) else { return nil }
    guard case .number(let number) = value, number == number.rounded(), abs(number) < 9e15 else {
      throw HTTPError.validation("body/\(name) must be integer")
    }
    let int = Int(number)
    if int < range.lowerBound { throw HTTPError.validation("body/\(name) must be >= \(range.lowerBound)") }
    if int > range.upperBound { throw HTTPError.validation("body/\(name) must be <= \(range.upperBound)") }
    return int
  }

  func strings(_ name: String) throws -> [String]? {
    guard let value = value(name) else { return nil }
    guard case .array(let items) = value else { throw HTTPError.validation("body/\(name) must be array") }
    return try items.enumerated().map { index, item in
      guard case .string(let string) = item else { throw HTTPError.validation("body/\(name)/\(index) must be string") }
      return string
    }
  }
}
