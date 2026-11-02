import Foundation
import Testing

@testable import PodcastAPI

/// Consumer contract test: every response the server recorded in contracts/api/ must decode into the app's
/// models. A server change that would break the app fails here, in the same commit.
struct DecodeFixturesTests {
  static let fixturesDir = URL(filePath: #filePath)
    .deletingLastPathComponent()  // PodcastAPITests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // PodcastAPI
    .deletingLastPathComponent()  // Packages
    .deletingLastPathComponent()  // ios
    .deletingLastPathComponent()  // repo root
    .appending(path: "contracts/api")

  /// Which model each recording decodes into. A new recording without an entry fails `everyFileIsCovered`.
  static let decoders: [String: @Sendable (Data) throws -> Any] = [
    "devices.create": { try decode(DeviceLogin.self, $0) },
    "feeds.list": { try decode([Feed].self, $0) },
    "feeds.get": { try decode(Feed.self, $0) },
    "feeds.create": { try decode(Feed.self, $0) },
    "search.shows": { try decode(ShowSearch.self, $0) },
    "episodes.list": { try decode(Page<Episode>.self, $0) },
    "episodes.get": { try decode(EpisodeDetail.self, $0) },
    "queue.list": { try decode(QueuePage.self, $0) },
    "episodes.share.create": { try decode(EpisodeShare.self, $0) },
    "episodes.share.get": { try decode(EpisodeShare?.self, $0) },  // null until the episode is shared
    "transcripts.get": { try decode(Transcript.self, $0) },
    "playback.report": { try decode(PlaybackAck.self, $0) },
    "snips.create": { try decode(Snip.self, $0) },
    "snips.create.selecting": { try decode(Snip.self, $0) },
    "snips.create.waiting": { try decode(Snip.self, $0) },
    "snips.get.ready": { try decode(Snip.self, $0) },
    "snips.get.failed": { try decode(Snip.self, $0) },
    "snips.edit": { try decode(Snip.self, $0) },
    "snips.list": { try decode(Page<Snip>.self, $0) },
    "errors.unauthorized": { try decode(APIError.Envelope.self, $0) },
    "errors.bad_request": { try decode(APIError.Envelope.self, $0) },
    "errors.conflict": { try decode(APIError.Envelope.self, $0) },
    "errors.conflict.feed": { try decode(APIError.Envelope.self, $0) },
    "health": { try decode(Health.self, $0) },
    "prompts.list": { try decode([Prompt].self, $0) },
    "prompts.version.get": { try decode(PromptVersion.self, $0) },
    "evals.runs.create": { try decode(EvalRun.self, $0) },
    "evals.runs.get": { try decode(EvalRunDetail.self, $0) },
    // Not used by v1 screens yet; listed so adding them is a conscious choice.
    "jobs.list": { _ in () },
    "public.snip": { _ in () },
    "public.episode": { _ in () },
  ]

  static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
    try APIClient.decoder.decode(T.self, from: data)
  }

  static var fixtureNames: [String] {
    let files = (try? FileManager.default.contentsOfDirectory(atPath: fixturesDir.path())) ?? []
    return files.filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) }.sorted()
  }

  /// The `body` of a recording, re-serialized on its own.
  static func body(of name: String) throws -> Data {
    let data = try Data(contentsOf: fixturesDir.appending(path: "\(name).json"))
    let recording = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    return try JSONSerialization.data(withJSONObject: try #require(recording["body"]), options: [.fragmentsAllowed])
  }

  @Test func everyFileIsCovered() {
    #expect(!Self.fixtureNames.isEmpty, "no recordings found at \(Self.fixturesDir.path())")
    #expect(Set(Self.fixtureNames) == Set(Self.decoders.keys))
  }

  @Test(arguments: fixtureNames)
  func decodes(_ name: String) throws {
    let decode = try #require(Self.decoders[name], "no decoder for \(name)")
    _ = try decode(try Self.body(of: name))
  }

  /// The recordings fill in every field, but real data doesn't (an untitled feed, an episode with no show title).
  /// This decodes each recording again with every field the contract marks nullable set to null and every
  /// optional field removed, so a model that is stricter than server/openapi.json fails here.
  @Test(arguments: fixtureNames.filter { !$0.hasPrefix("errors.") })
  func decodesWithEveryNullableFieldNull(_ name: String) throws {
    let data = try Data(contentsOf: Self.fixturesDir.appending(path: "\(name).json"))
    let recording = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    let request = try #require(recording["request"] as? [String: Any])
    let method = try #require(request["method"] as? String).lowercased()
    let url = try #require(request["url"] as? String)
    let status = String(try #require(recording["status"] as? Int))
    guard let schema = try OpenAPI.responseSchema(method: method, url: url, status: status) else {
      return  // a route outside /v1 (public pages) or one the contract leaves untyped
    }
    let minimal = OpenAPI.minimize(try #require(recording["body"]), schema: schema)
    let body = try JSONSerialization.data(withJSONObject: minimal, options: [.fragmentsAllowed])
    let decode = try #require(Self.decoders[name])
    _ = try decode(body)
  }

  /// Opt-in: decode real responses saved from a live server (`ios/scripts/check-live.sh` writes them). Each file
  /// is a raw response body named `<recording name>.<anything>.json`, e.g. `episodes.get.01M5….json`. They hold
  /// private data, so they live outside the repo and this test is skipped unless the variable is set.
  @Test(.enabled(if: ProcessInfo.processInfo.environment["PODCAST_API_LIVE_DIR"] != nil))
  func decodesLiveResponses() throws {
    let dir = URL(filePath: try #require(ProcessInfo.processInfo.environment["PODCAST_API_LIVE_DIR"]))
    let files = try FileManager.default.contentsOfDirectory(atPath: dir.path()).filter { $0.hasSuffix(".json") }
    #expect(!files.isEmpty, "no saved responses in \(dir.path())")
    for file in files.sorted() {
      let key = Self.decoders.keys.sorted { $0.count > $1.count }.first { file.hasPrefix($0 + ".") }
      let decode = try #require(key.flatMap { Self.decoders[$0] }, "no decoder for \(file)")
      #expect(throws: Never.self, "\(file)") { _ = try decode(try Data(contentsOf: dir.appending(path: file))) }
    }
  }

  @Test func transcriptWordsAreTuples() throws {
    let t = try Self.decode(Transcript.self, try Self.body(of: "transcripts.get"))
    let first = try #require(t.segments.first?.words.first)
    #expect(first == Word(startMs: 800, endMs: 1140, text: "The"))
    #expect(t.segments.map(\.words.count).reduce(0, +) == t.wordCount)
  }

  @Test func episodeCarriesASignedAudioURL() throws {
    let ep = try Self.decode(EpisodeDetail.self, try Self.body(of: "episodes.get"))
    let asset = try #require(ep.asset)
    #expect(URLComponents(string: asset.audioUrl)?.queryItems?.contains { $0.name == "e" } == true)
    #expect(ep.resume?.positionMs == 95_000)
  }

  @Test func unknownStatesDoNotBreakDecoding() throws {
    let json = Data(#"{"audio":"ready","transcript":"someday","text":"none","summary":"queued"}"#.utf8)
    let p = try Self.decode(Processing.self, json)
    #expect(p.transcript == .unknown)
    #expect(p.audio == .ready)
  }

  @Test func editBodyMatchesTheRecording() throws {
    let data = try Data(contentsOf: Self.fixturesDir.appending(path: "snips.edit.json"))
    let recorded = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["request"] as? [String: Any]
    // The revision id is minted afresh each time the fixtures are recorded; take it from the recording.
    let revision = try #require((recorded?["body"] as? [String: Any])?["if_revision"] as? String)
    let body = EditSnip(startMs: 40_000, endMs: 90_000, title: "Flat fees left money on the table", ifRevision: revision)
    let sent = try JSONSerialization.jsonObject(with: APIClient.encoder.encode(body)) as? NSDictionary
    #expect(sent == recorded?["body"] as? NSDictionary)
    // A title-only save carries no boundaries.
    let titleOnly = try JSONSerialization.jsonObject(with: APIClient.encoder.encode(EditSnip(title: "New", ifRevision: "R"))) as? [String: Any]
    #expect(Set(titleOnly?.keys.map { $0 } ?? []) == ["title", "if_revision"])
  }

  @Test func subscribeBodyMatchesTheRecording() throws {
    // Opening a show from search: unfollowed, manual, nothing backfilled. It must never start paid transcription.
    let sent = try JSONSerialization.jsonObject(
      with: APIClient.encoder.encode(CreateFeed(url: "https://feeds.example.com/hardfork.xml", followed: false)))
      as? NSDictionary
    let data = try Data(contentsOf: Self.fixturesDir.appending(path: "feeds.create.json"))
    let recorded = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["request"] as? [String: Any]
    #expect(sent == recorded?["body"] as? NSDictionary)
  }

  @Test func promptVersionCarriesItsPreviousTextAndRuns() throws {
    let v = try Self.decode(PromptVersion.self, try Self.body(of: "prompts.version.get"))
    #expect(v.previous?.version == "v1")
    #expect(v.runs.map(\.status) == [.queued, .done])
    #expect(v.runs.last?.score?.n == 2)
    let detail = try Self.decode(EvalRunDetail.self, try Self.body(of: "evals.runs.get"))
    #expect(detail.cases.first?.pass == false)  // failures first
    // Starting a run sends the version the way the server was recorded accepting it.
    let sent = try JSONSerialization.jsonObject(with: APIClient.encoder.encode(APIClient.VersionBody(version: "v2"))) as? NSDictionary
    let data = try Data(contentsOf: Self.fixturesDir.appending(path: "evals.runs.create.json"))
    let recorded = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["request"] as? [String: Any]
    #expect(sent == recorded?["body"] as? NSDictionary)
  }

  @Test func duplicateFeedNamesTheExistingOne() throws {
    let envelope = try Self.decode(APIError.Envelope.self, try Self.body(of: "errors.conflict.feed"))
    let created = try Self.decode(Feed.self, try Self.body(of: "feeds.create"))
    #expect(envelope.error.feedId == created.id)
    let found = try Self.decode(ShowSearch.self, try Self.body(of: "search.shows"))
    #expect(found.results.first?.feedId == created.id)
    #expect(found.results.first?.followed == false)
  }

  @Test func requestBodiesMatchTheRecordings() throws {
    // What the app sends must be what the server was recorded accepting.
    let report = PlaybackReport(positionMs: 95_000, speed: 1.25, playing: true, finished: false, seq: 1, observedAt: 1_799_999_999_000)
    let sent = try JSONSerialization.jsonObject(with: APIClient.encoder.encode(report)) as? NSDictionary
    let data = try Data(contentsOf: Self.fixturesDir.appending(path: "playback.report.json"))
    let recorded = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["request"] as? [String: Any]
    #expect(sent == recorded?["body"] as? NSDictionary)
  }
}
