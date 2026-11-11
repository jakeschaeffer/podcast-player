import Foundation
import PodcastAPI

/// Snip taps, saved to a file first and sent in order, ported from web/src/snips/outbox.ts. `client_request_id`
/// makes a resend harmless (a replayed POST returns the same snip with HTTP 200), so a tap made offline, or while
/// the server restarts, is delivered when the connection returns. `captured_at` keeps the moment of the tap.
public actor SnipOutbox {
  public struct Pending: Codable, Sendable, Hashable, Identifiable {
    public var body: CreateSnip
    public let episodeID: ULID
    /// What a list needs to show the tap before the server has made a snip of it.
    public var episodeTitle: String?
    public var showTitle: String?
    public var imageUrl: String?
    public var id: String { body.clientRequestId }

    /// How much before the tap a waiting snip covers until the owner or the server says otherwise.
    public static let defaultLengthMs = 90_000

    /// A heard stretch shorter than this (a tap just after a seek) doesn't bound the span: nobody snips a few seconds.
    public static let shortestHeardMs = 30_000

    /// The span shown while the tap waits: the owner's if they set one, else the default length back from the tap,
    /// and not before the start of the stretch they heard unless that stretch is only moments long.
    public var startMs: Int {
      if let start = body.owner?.startMs { return start }
      let back = max(body.anchorMs - Self.defaultLengthMs, 0)
      return body.anchorMs - body.heardFromMs >= Self.shortestHeardMs ? max(body.heardFromMs, back) : back
    }
    public var endMs: Int { body.owner?.endMs ?? body.anchorMs }
  }

  public enum Event: Sendable {
    case sent(Pending, Snip)
    /// The server rejected the tap for good (asset gone, bad fields); it was dropped.
    case failed(Pending, String)
  }

  public typealias Send = @Sendable (CreateSnip) async throws -> Snip

  private let file: URL
  private let send: Send
  private var queue: [Pending]
  private var flushing = false
  private var listener: (@Sendable (Event) -> Void)?

  public init(file: URL, send: @escaping Send) {
    self.file = file
    self.send = send
    self.queue = (try? JSONDecoder().decode([Pending].self, from: Data(contentsOf: file))) ?? []
  }

  public func onEvent(_ listener: @escaping @Sendable (Event) -> Void) { self.listener = listener }

  public var pending: [Pending] { queue }

  /// Queue a tap and try to send it now. Returns the snip when the server answered, nil while it waits.
  public func capture(assetID: ULID, episodeID: ULID, anchorMs: Int, heardFromMs: Int, at date: Date = .now) async
    -> (Pending, Snip?)
  {
    let pending = add(assetID: assetID, episodeID: episodeID, anchorMs: anchorMs, heardFromMs: heardFromMs, at: date)
    let sent = await flush()
    return (pending, sent[pending.id])
  }

  /// Save a tap without sending it; `flush` sends it. The caller can show it at once, however long the server takes.
  public func add(
    assetID: ULID, episodeID: ULID, anchorMs: Int, heardFromMs: Int, episodeTitle: String? = nil,
    showTitle: String? = nil, imageUrl: String? = nil, at date: Date = .now
  ) -> Pending {
    let pending = Pending(
      body: CreateSnip(
        clientRequestId: UUID().uuidString.lowercased(), assetId: assetID, anchorMs: anchorMs,
        heardFromMs: heardFromMs, capturedAt: Int(date.timeIntervalSince1970 * 1000)),
      episodeID: episodeID, episodeTitle: episodeTitle, showTitle: showTitle, imageUrl: imageUrl)
    queue.append(pending)
    save()
    return pending
  }

  /// The owner's title, note or span for a tap still waiting; it goes with the tap when it is sent. Returns the tap
  /// as it now stands, or nil when it has already gone (the edit then belongs on the snip it became).
  public func edit(_ id: String, owner: CreateSnip.Owner) -> Pending? {
    guard let i = queue.firstIndex(where: { $0.id == id }) else { return nil }
    queue[i].body.owner = owner.isEmpty ? nil : owner
    save()
    return queue[i]
  }

  /// Drop a tap that hasn't reached the server. A tap already on its way may still arrive: the caller deletes the snip
  /// it becomes when `.sent` reports it.
  public func cancel(_ id: String) {
    queue.removeAll { $0.id == id }
    save()
  }

  /// Send everything waiting, oldest first; stops at the first tap that should be retried later.
  @discardableResult
  public func flush() async -> [String: Snip] {
    var sent: [String: Snip] = [:]
    guard !flushing else { return sent }
    flushing = true
    defer { flushing = false }
    while let next = queue.first {
      do {
        let snip = try await send(next.body)
        queue.removeAll { $0.id == next.id }  // by id: a cancel may have removed it while it was being sent
        save()
        sent[next.id] = snip
        listener?(.sent(next, snip))
      } catch {
        guard RetryPolicy.outcome(for: error) == .drop else { break }  // offline, signed out, server trouble
        queue.removeAll { $0.id == next.id }
        save()
        listener?(.failed(next, error.localizedDescription))
      }
    }
    return sent
  }

  private func save() {
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? JSONEncoder().encode(queue).write(to: file, options: .atomic)
  }
}
