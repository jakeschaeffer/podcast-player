import Foundation
import PodcastAPI
import Testing

@testable import SyncKit

/// A tap that waits on the phone: its default span, and the owner's title and length travelling with it.
struct SnipOutboxEditTests {
  static func file() -> URL { FileManager.default.temporaryDirectory.appending(path: "outbox-\(UUID().uuidString).json") }

  @Test func theDefaultSpanIsNinetySecondsWithinWhatWasHeard() async {
    let outbox = SnipOutbox(file: Self.file()) { _ in throw APIError(status: 0, code: "network", message: "offline") }
    let heardLong = await outbox.add(assetID: "A", episodeID: "E", anchorMs: 600_000, heardFromMs: 0)
    #expect(heardLong.startMs == 510_000)
    #expect(heardLong.endMs == 600_000)
    let heardAMinute = await outbox.add(assetID: "A", episodeID: "E", anchorMs: 600_000, heardFromMs: 540_000)
    #expect(heardAMinute.startMs == 540_000)
    // Just after a seek the heard stretch is moments long, and doesn't make a snip of no length.
    let afterSeek = await outbox.add(assetID: "A", episodeID: "E", anchorMs: 600_000, heardFromMs: 600_000)
    #expect(afterSeek.startMs == 510_000)
    let nearStart = await outbox.add(assetID: "A", episodeID: "E", anchorMs: 20_000, heardFromMs: 0)
    #expect(nearStart.startMs == 0)
  }

  @Test func anEditWaitsWithTheTapAndIsSentWithIt() async throws {
    let file = Self.file()
    let offline = SnipOutbox(file: file) { _ in throw APIError(status: 0, code: "network", message: "offline") }
    let tap = await offline.add(assetID: "A", episodeID: "E", anchorMs: 600_000, heardFromMs: 0, episodeTitle: "Episode")
    await offline.flush()
    let edited = await offline.edit(tap.id, owner: .init(startMs: 480_000, endMs: 600_000, title: "Mine"))
    #expect(edited?.startMs == 480_000)
    // Emptied again, the tap carries nothing of the owner's.
    let emptied = await offline.edit(tap.id, owner: .init())
    #expect(emptied != nil && emptied?.body.owner == nil)
    _ = await offline.edit(tap.id, owner: .init(title: "Mine"))
    let gone = await offline.edit("gone", owner: .init(title: "x"))
    #expect(gone == nil)

    // The next launch reads the file, and the server gets the tap with the edit in it.
    let body = try JSONDecoder().decode([SnipOutbox.Pending].self, from: Data(contentsOf: file))
    #expect(body.first?.body.owner?.title == "Mine")
    #expect(body.first?.episodeTitle == "Episode")
    let sent = String(decoding: try APIClient.encoder.encode(body[0].body), as: UTF8.self)
    #expect(sent.contains("\"owner\":{\"title\":\"Mine\"}"))
  }
}
