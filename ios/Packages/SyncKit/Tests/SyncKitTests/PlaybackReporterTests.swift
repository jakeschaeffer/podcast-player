import Foundation
import PodcastAPI
import Testing

@testable import SyncKit

actor FakeServer {
  var received: [(ULID, PlaybackReport)] = []
  var failWith: APIError?

  func setFailure(_ error: APIError?) { failWith = error }

  func handle(_ id: ULID, _ report: PlaybackReport) throws {
    if let failWith { throw failWith }
    received.append((id, report))
  }
}

struct PlaybackReporterTests {
  func tempFile() -> URL {
    FileManager.default.temporaryDirectory.appending(path: "reporter-\(UUID().uuidString).json")
  }

  @Test func offlineReportsKeepOnlyTheLatestPerAssetAndReplayInSeqOrder() async {
    let server = FakeServer()
    await server.setFailure(APIError(status: 0, code: "network", message: "offline"))
    let file = tempFile()
    let reporter = PlaybackReporter(file: file) { try await server.handle($0, $1) }

    await reporter.report(assetID: "A", positionMs: 1_000, speed: 1, playing: true, finished: false)
    await reporter.report(assetID: "B", positionMs: 5_000, speed: 1, playing: true, finished: false)
    await reporter.report(assetID: "A", positionMs: 2_000, speed: 1, playing: false, finished: false)
    #expect(await reporter.pendingCount == 2)

    // A relaunch reads the outbox back from disk.
    await server.setFailure(nil)
    let relaunched = PlaybackReporter(file: file) { try await server.handle($0, $1) }
    await relaunched.flush()

    let got = await server.received
    #expect(got.map(\.0) == ["B", "A"])
    #expect(got.map(\.1.seq) == [2, 3])
    #expect(got.last?.1.positionMs == 2_000)
    #expect(await relaunched.pendingCount == 0)
  }

  @Test func retryPolicyMatchesTheWebOutbox() {
    #expect(RetryPolicy.outcome(for: nil) == .delivered)
    #expect(RetryPolicy.outcome(for: APIError(status: 0, code: "network", message: "")) == .keep)
    #expect(RetryPolicy.outcome(for: APIError(status: 401, code: "unauthorized", message: "")) == .keep)
    #expect(RetryPolicy.outcome(for: APIError(status: 503, code: "unavailable", message: "")) == .keep)
    #expect(RetryPolicy.outcome(for: APIError(status: 404, code: "not_found", message: "")) == .drop)
    #expect(RetryPolicy.outcome(for: APIError(status: 409, code: "conflict", message: "")) == .drop)
  }
}

struct SnipOutboxTests {
  actor FakeSnipServer {
    var offline = true
    var created: [String: Int] = [:]  // client_request_id → times received
    func setOffline(_ value: Bool) { offline = value }
    func create(_ body: CreateSnip) throws -> Snip {
      if offline { throw APIError(status: 0, code: "network", message: "offline") }
      created[body.clientRequestId, default: 0] += 1
      let data = try Data(contentsOf: Self.fixture)
      let recording = try JSONSerialization.jsonObject(with: data) as! [String: Any]
      return try APIClient.decoder.decode(Snip.self, from: JSONSerialization.data(withJSONObject: recording["body"]!))
    }
    static let fixture = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appending(path: "contracts/api/snips.create.json")
  }

  @Test func tapsMadeOfflineAreDeliveredOnceInOrderAfterARelaunch() async throws {
    let server = FakeSnipServer()
    let file = FileManager.default.temporaryDirectory.appending(path: "snips-\(UUID().uuidString).json")
    let outbox = SnipOutbox(file: file) { try await server.create($0) }
    var ids: [String] = []
    for anchor in [10_000, 20_000, 30_000] {
      let (pending, snip) = await outbox.capture(assetID: "A", episodeID: "E", anchorMs: anchor, heardFromMs: 0)
      #expect(snip == nil)
      ids.append(pending.id)
    }
    #expect(await outbox.pending.map(\.body.anchorMs) == [10_000, 20_000, 30_000])

    await server.setOffline(false)
    let relaunched = SnipOutbox(file: file) { try await server.create($0) }
    let sent = await relaunched.flush()
    #expect(Set(sent.keys) == Set(ids))
    #expect(await server.created == Dictionary(uniqueKeysWithValues: ids.map { ($0, 1) }))
    #expect(await relaunched.pending.isEmpty)
  }
}
