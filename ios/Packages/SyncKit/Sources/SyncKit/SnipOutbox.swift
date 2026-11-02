import Foundation
import PodcastAPI

/// Snip taps, saved to a file first and sent in order, ported from web/src/snips/outbox.ts. `client_request_id`
/// makes a resend harmless (a replayed POST returns the same snip with HTTP 200), so a tap made offline, or while
/// the server restarts, is delivered when the connection returns. `captured_at` keeps the moment of the tap.
public actor SnipOutbox {
  public struct Pending: Codable, Sendable, Hashable, Identifiable {
    public let body: CreateSnip
    public let episodeID: ULID
    public var id: String { body.clientRequestId }
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
    let pending = Pending(
      body: CreateSnip(
        clientRequestId: UUID().uuidString.lowercased(), assetId: assetID, anchorMs: anchorMs,
        heardFromMs: heardFromMs, capturedAt: Int(date.timeIntervalSince1970 * 1000)),
      episodeID: episodeID)
    queue.append(pending)
    save()
    let sent = await flush()
    return (pending, sent[pending.id])
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
