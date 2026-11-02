import Foundation
import PodcastAPI

/// Playback reports: `PUT /v1/playback/{asset_id}` with a per-device `seq` that only ever grows, ported from
/// web/src/player/reporter.ts. Reports that cannot be sent wait in a file (latest per asset) and replay in seq
/// order, so a stale report never overwrites a newer one and an offline stretch loses nothing. Each carries
/// `observed_at`, so the server orders a late replay by when it happened, not when it arrived.
public actor PlaybackReporter {
  struct Entry: Codable {
    let assetID: ULID
    let report: PlaybackReport
  }

  struct State: Codable {
    var seq = 0
    var outbox: [ULID: Entry] = [:]
  }

  public typealias Send = @Sendable (ULID, PlaybackReport) async throws -> Void

  private let file: URL
  private let send: Send
  private var state: State
  private var flushing = false
  private var dirty = false

  public init(file: URL, send: @escaping Send) {
    self.file = file
    self.send = send
    self.state = (try? JSONDecoder().decode(State.self, from: Data(contentsOf: file))) ?? State()
  }

  public func report(assetID: ULID, positionMs: Int, speed: Double, playing: Bool, finished: Bool, at date: Date = .now) async {
    state.seq += 1
    let body = PlaybackReport(
      positionMs: positionMs, speed: speed, playing: playing, finished: finished, seq: state.seq,
      observedAt: Int(date.timeIntervalSince1970 * 1000))
    state.outbox[assetID] = Entry(assetID: assetID, report: body)
    save()
    await flush()
  }

  /// Send everything waiting, oldest seq first. Call on reachability changes and when the app goes to background.
  public func flush() async {
    if flushing {
      dirty = true
      return
    }
    flushing = true
    defer { flushing = false }
    repeat {
      dirty = false
      for entry in state.outbox.values.sorted(by: { $0.report.seq < $1.report.seq }) {
        var failure: Error?
        do { try await send(entry.assetID, entry.report) } catch { failure = error }
        if RetryPolicy.outcome(for: failure) == .keep { break }
        // Delivered, or rejected for good. A newer report for the same asset may have arrived meanwhile.
        if state.outbox[entry.assetID]?.report.seq == entry.report.seq { state.outbox[entry.assetID] = nil }
      }
      save()
    } while dirty
  }

  public var pendingCount: Int { state.outbox.count }

  /// The asset's report still waiting to be sent, if any: the phone's latest word on where playback stands.
  public func pending(assetID: ULID) -> PlaybackReport? { state.outbox[assetID]?.report }

  private func save() {
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? JSONEncoder().encode(state).write(to: file, options: .atomic)
  }
}
