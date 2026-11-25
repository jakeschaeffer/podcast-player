import Foundation
import PodcastAPI
import Testing

@testable import OnDevice

/// server/test/queue.test.ts on the phone: Up next is every half-heard episode, the one listened to last first,
/// whichever device it was on, in the owner's order once they place episodes. The queue is read and changed through
/// the app's `APIClient`; listening is written straight into `playback_state`, as the server's test writes it, so
/// each report has the time and the device the case calls for.
struct QueueTests {
  struct Fixture {
    let phone: Phone
    let ids: [String: String]
    let assets: [String: String]
    let devices: [String]

    init() async throws {
      phone = try Phone()
      let items = ["A", "B", "C", "D", "Never played"].map {
        TestItem(title: $0, guid: $0, duration: "10:00", url: "https://media.example.com/queue/\($0.replacingOccurrences(of: " ", with: "-")).mp3")
      }
      phone.http.serve("https://feeds.example.com/queue.xml", rss(title: "Show", items: items))
      _ = try await phone.api.createFeed(CreateFeed(url: "https://feeds.example.com/queue.xml"))
      let listed = try await phone.api.episodes().items
      ids = Dictionary(uniqueKeysWithValues: listed.map { ($0.title, $0.id) })
      assets = Dictionary(uniqueKeysWithValues: listed.map { ($0.title, $0.assetId!) })
      guard case .text(let own) = try await phone.value("SELECT id AS v FROM device") else { throw HTTPError.notFound("device") }
      // The phone itself, and a second device whose reports reached the same database.
      let laptop = "01LAPTPAAAAAAAAAAAAAAAAAAA"
      try await phone.sql("INSERT INTO device (id, name, platform, token_hash, created_at) VALUES (?, 'laptop', 'web', 'laptop', 0)", [.text(laptop)])
      devices = [own, laptop]
    }

    func play(_ title: String, _ at: Int, _ position: Int, finished: Bool = false, device: Int = 0) async throws {
      try await phone.sql(
        "INSERT OR REPLACE INTO playback_state (device_id, audio_asset_id, position_ms, finished, seq, updated_at, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [.text(devices[device]), .text(assets[title]!), .integer(Int64(position)), .integer(finished ? 1 : 0), .integer(Int64(at)), .integer(Int64(at)), .integer(Int64(at))])
    }

    func titles() async throws -> [String] { try await phone.api.queue().map(\.title) }
    func id(_ title: String) -> String { ids[title]! }
  }

  @Test func upNextKeepsTheServersOrderThroughTheServersCases() async throws {
    let f = try await Fixture()
    let api = f.phone.api
    let clock = f.phone.clock

    // lists started, unfinished episodes, most recently listened first
    try await f.play("A", 1_000, 60_000)
    try await f.play("B", 2_000, 30_000)
    try await f.play("C", 3_000, 0)  // opened but never played
    try await f.play("D", 4_000, 600_000, finished: true)  // finished
    #expect(try await f.titles() == ["B", "A"])

    // moves an episode to the top when it is left for another
    try await f.play("A", 5_000, 90_000)  // back to A, then on to something new: A's last report is the newest
    #expect(try await f.titles() == ["A", "B"])

    // follows the latest report from any device
    try await f.play("B", 6_000, 45_000, device: 1)
    #expect(try await f.titles() == ["B", "A"])
    try await f.play("B", 7_000, 600_000, finished: true, device: 1)  // finished on the laptop, so it leaves the queue
    #expect(try await f.titles() == ["A"])
    let resume = try #require(try await api.queue().first?.resume)
    #expect(resume.positionMs == 90_000 && !resume.finished)

    // keeps the owner's order once they place episodes
    clock.ms = 10_000
    try await f.play("B", 8_000, 30_000)  // B half-heard again
    #expect(try await f.titles() == ["B", "A"])
    #expect(try await api.reorderQueue([f.id("A"), f.id("B")]).map(\.title) == ["A", "B"])
    #expect(try await f.titles() == ["A", "B"])
    clock.ms = 11_000
    #expect(try await api.addToQueue(f.id("Never played"), atEnd: true).map(\.title) == ["A", "B", "Never played"])  // added at the end
    #expect(try await f.titles() == ["A", "B", "Never played"])
    _ = try await api.reorderQueue([f.id("Never played"), f.id("A"), f.id("B")])
    #expect(try await f.titles() == ["Never played", "A", "B"])

    // puts an episode listened to after it was placed back at the top
    try await f.play("B", 12_000, 40_000)
    #expect(try await f.titles() == ["B", "Never played", "A"])

    // takes an episode out until it is played again or added back
    clock.ms = 13_000
    #expect(try await api.removeFromQueue(f.id("A")).map(\.title) == ["B", "Never played"])
    #expect(try await f.titles() == ["B", "Never played"])
    try await f.play("A", 14_000, 95_000)  // listened to again: back, at the top
    #expect(try await f.titles() == ["A", "B", "Never played"])
    clock.ms = 15_000
    _ = try await api.removeFromQueue(f.id("Never played"))
    #expect(try await f.titles() == ["A", "B"])
    clock.ms = 16_000
    _ = try await api.addToQueue(f.id("Never played"), atEnd: true)
    #expect(try await f.titles() == ["A", "B", "Never played"])

    // drops an added episode once it is finished, and adds it back on request
    try await f.play("D", 17_000, 600_000, finished: true)  // D was finished before; adding brings it back
    clock.ms = 18_000
    _ = try await api.addToQueue(f.id("D"), atEnd: true)
    #expect(try await f.titles().contains("D"))
    try await f.play("D", 19_000, 600_000, finished: true)
    #expect(try await !f.titles().contains("D"))

    // adds an episode to the top, to play next, above the ones heard partway
    clock.ms = 20_000
    #expect(try await api.addToQueue(f.id("D")).first?.title == "D")
    #expect(try await f.titles() == ["D", "A", "B", "Never played"])
    clock.ms = 21_000
    _ = try await api.addToQueue(f.id("Never played"))  // the newest added goes above the last
    #expect(try await f.titles() == ["Never played", "D", "A", "B"])
    try await f.play("A", 22_000, 99_000)  // one left for another later still goes above them, as before
    #expect(try await f.titles() == ["A", "Never played", "D", "B"])
    clock.ms = 23_000
    _ = try await api.addToQueue(f.id("D"), atEnd: true)  // and the end is still the end
    #expect(try await f.titles() == ["A", "Never played", "B", "D"])

    // The list is cut to the limit asked for, from the top.
    #expect(try await api.queue(limit: 2).map(\.title) == ["A", "Never played"])
  }

  /// The server's last case is that adding an episode fetches and transcribes it. The phone's recording is already
  /// there and it transcribes nothing; what is left of the route is its checks.
  @Test func theQueueRoutesCheckWhatTheyAreGiven() async throws {
    let f = try await Fixture()
    let api = f.phone.api
    let missing = APIError(status: 404, code: "not_found", message: "episode not found")
    let unknown = "01AAAAAAAAAAAAAAAAAAAAAAAA"
    #expect(await #expect(throws: APIError.self) { try await api.addToQueue(unknown) } == missing)
    #expect(await #expect(throws: APIError.self) { try await api.removeFromQueue(unknown) } == missing)
    // An order naming an episode that does not exist changes nothing.
    _ = try await api.addToQueue(f.id("A"), atEnd: true)
    _ = try await api.addToQueue(f.id("B"), atEnd: true)
    #expect(await #expect(throws: APIError.self) { try await api.reorderQueue([f.id("B"), unknown, f.id("A")]) } == missing)
    #expect(try await f.titles() == ["A", "B"])

    let bad = await #expect(throws: APIError.self) {
      let _: QueuePage = try await api.send("POST", "/v1/queue/\(f.id("A"))", query: [URLQueryItem(name: "at", value: "middle")])
    }
    #expect(bad?.status == 400 && bad?.code == "validation")
    let noBody = await #expect(throws: APIError.self) { let _: QueuePage = try await api.send("PUT", "/v1/queue") }
    #expect(noBody?.status == 400 && noBody?.code == "validation")
    let tooMany = await #expect(throws: APIError.self) { try await api.queue(limit: 0) }
    #expect(tooMany == APIError(status: 400, code: "validation", message: "querystring/limit must be >= 1"))

    // With no `at`, the server adds at the end.
    let page: QueuePage = try await api.send("POST", "/v1/queue/\(f.id("C"))")
    #expect(page.items.map(\.title) == ["A", "B", "C"])
    // Removing twice is the same as once.
    _ = try await api.removeFromQueue(f.id("C"))
    #expect(try await api.removeFromQueue(f.id("C")).map(\.title) == ["A", "B"])
  }

  /// The same rules with nothing written by hand: this phone's own reports, through the playback route.
  @Test func thisPhonesReportsMoveEpisodesInAndOutOfUpNext() async throws {
    let f = try await Fixture()
    let api = f.phone.api
    var seq = 0
    func report(_ title: String, _ position: Int, finished: Bool = false) async throws {
      seq += 1
      f.phone.clock.ms += 60_000
      _ = try await api.reportPlayback(
        assetID: f.assets[title]!, PlaybackReport(positionMs: position, speed: 1, playing: !finished, finished: finished, seq: seq, observedAt: f.phone.clock.ms))
    }
    #expect(try await f.titles().isEmpty)
    try await report("A", 60_000)
    try await report("B", 30_000)
    try await report("C", 0)  // opened but never played
    #expect(try await f.titles() == ["B", "A"])
    try await report("A", 90_000)
    #expect(try await f.titles() == ["A", "B"])
    try await report("A", 600_000, finished: true)
    #expect(try await f.titles() == ["B"])
    let queued = try #require(try await api.queue().first)
    #expect(queued.resume?.positionMs == 30_000)
    #expect(queued.resume?.deviceName == "Test Phone")
  }
}
