import Foundation
import PodcastAPI
import Synchronization
import Testing

@testable import SyncKit

/// A server for snip taps that can be offline, or hold a request until the test lets it through.
actor HoldingSnipServer {
  var offline = false
  var held: CheckedContinuation<Void, Never>?
  var holdNext = false
  private(set) var created: [String] = []

  func setOffline(_ value: Bool) { offline = value }
  func holdNextRequest() { holdNext = true }
  func release() {
    held?.resume()
    held = nil
  }
  var isHolding: Bool { held != nil }

  func create(_ body: CreateSnip) async throws -> Snip {
    if offline { throw APIError(status: 0, code: "network", message: "offline") }
    if holdNext {
      holdNext = false
      await withCheckedContinuation { held = $0 }
    }
    created.append(body.clientRequestId)
    let json = """
      {"id":"S-\(body.clientRequestId)","asset_id":"\(body.assetId)","episode_id":"E","episode_title":"Ep","media_kind":"audio",
       "anchor_ms":\(body.anchorMs),"heard_from_ms":\(body.heardFromMs),"share_url":"https://x/s/1",
       "share_state":"active","created_at":0}
      """
    return try APIClient.decoder.decode(Snip.self, from: Data(json.utf8))
  }
}

struct SnipOutboxCancelTests {
  func tempFile() -> URL {
    FileManager.default.temporaryDirectory.appending(path: "snips-\(UUID().uuidString).json")
  }

  @Test func aCancelledOfflineTapIsNeverSent() async {
    let server = HoldingSnipServer()
    await server.setOffline(true)
    let outbox = SnipOutbox(file: tempFile()) { try await server.create($0) }
    let (pending, snip) = await outbox.capture(assetID: "A", episodeID: "E", anchorMs: 60_000, heardFromMs: 0)
    #expect(snip == nil)
    await outbox.cancel(pending.id)
    await server.setOffline(false)
    await outbox.flush()
    #expect(await server.created.isEmpty)
    #expect(await outbox.pending.isEmpty)
  }

  @Test func aCancelWhileSendingStillReportsTheSnipAndLosesNoOtherTap() async throws {
    let server = HoldingSnipServer()
    await server.setOffline(true)
    let outbox = SnipOutbox(file: tempFile()) { try await server.create($0) }
    let (first, _) = await outbox.capture(assetID: "A", episodeID: "E", anchorMs: 60_000, heardFromMs: 0)
    let (second, _) = await outbox.capture(assetID: "A", episodeID: "E", anchorMs: 90_000, heardFromMs: 0)
    let sentIDs = Mutex<[String]>([])
    await outbox.onEvent { event in
      if case .sent(let pending, _) = event { sentIDs.withLock { $0.append(pending.id) } }
    }
    await server.setOffline(false)
    await server.holdNextRequest()
    let flushing = Task { await outbox.flush() }
    while !(await server.isHolding) { await Task.yield() }
    await outbox.cancel(first.id)  // the first tap is on the wire now
    await server.release()
    _ = await flushing.value
    // The first still arrives (the app deletes it); the second must not be dropped in its place.
    #expect(await server.created == [first.id, second.id])
    #expect(sentIDs.withLock { $0 } == [first.id, second.id])
    #expect(await outbox.pending.isEmpty)
  }
}
