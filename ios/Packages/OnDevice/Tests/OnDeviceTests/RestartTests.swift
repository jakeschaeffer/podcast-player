import Foundation
import PodcastAPI
import Testing

@testable import OnDevice

/// The phone's data is a file: a backend opened later on the same folder has everything the first one stored.
struct RestartTests {
  @Test func aSecondBackendOnTheSameFolderSeesTheSameData() async throws {
    let folder = FileManager.default.temporaryDirectory.appending(path: "ondevice-restart-\(UUID().uuidString)/nested")
    let clock = TestClock()
    var feeds: [Feed] = []
    var episodes: [Episode] = []
    var queue: [Episode] = []
    var detail: EpisodeDetail?
    do {
      let phone = try Phone(folder: folder, clock: clock, deviceName: "Before")
      phone.http.serve(Tidewater.url, Tidewater.feed, headers: ["ETag": "\"v1\""])
      _ = try await phone.api.createFeed(CreateFeed(url: Tidewater.url))
      episodes = try await phone.api.episodes().items
      _ = try await phone.api.reportPlayback(
        assetID: episodes[0].assetId!, PlaybackReport(positionMs: 95_000, speed: 1.25, playing: true, finished: false, seq: 7, observedAt: clock.ms))
      _ = try await phone.api.addToQueue(episodes[2].id, atEnd: true)
      _ = try await phone.api.reorderQueue([episodes[2].id, episodes[0].id])
      feeds = try await phone.api.feeds()
      episodes = try await phone.api.episodes().items
      queue = try await phone.api.queue()
      detail = try await phone.api.episode(episodes[0].id)
      #expect(queue.map(\.title) == ["Harbour Lights", "The Ferry Timetable"])
    }

    // Later, with no network at all.
    clock.ms += 3_600_000
    let phone = try Phone(folder: folder, clock: clock, deviceName: "Before")
    #expect(try await phone.api.feeds() == feeds)
    #expect(try await phone.api.episodes().items == episodes)
    #expect(try await phone.api.queue() == queue)
    #expect(try await phone.api.episode(episodes[0].id) == detail)
    #expect(detail?.resume?.positionMs == 95_000)
    #expect(phone.http.requests.isEmpty)

    // The stored seq still guards the place, and the stored validators still go out with a refresh.
    let stale = try await phone.api.reportPlayback(
      assetID: episodes[0].assetId!, PlaybackReport(positionMs: 10_000, speed: 1, playing: true, finished: false, seq: 7, observedAt: clock.ms))
    #expect(!stale.accepted && stale.positionMs == 95_000)
    phone.http.serve(Tidewater.url, status: 304)
    try await phone.api.refreshFeed(feeds[0].id)
    #expect(phone.http.requests.last?.value(forHTTPHeaderField: "If-None-Match") == "\"v1\"")
    #expect(try await phone.api.feed(feeds[0].id).lastRefreshAt == clock.ms)

    // New ids still sort after the old ones.
    phone.http.serve("https://feeds.example.com/marsh.xml", rss(title: "Marsh Radio", items: []))
    #expect(try await phone.api.createFeed(CreateFeed(url: "https://feeds.example.com/marsh.xml")).id > feeds[0].id)
  }

  @Test func aRenamedPhoneCarriesItsNewNameOnThePlacesItAlreadyReported() async throws {
    let folder = FileManager.default.temporaryDirectory.appending(path: "ondevice-rename-\(UUID().uuidString)")
    var episodeId = ""
    do {
      let phone = try Phone(folder: folder, deviceName: "Old Name")
      phone.http.serve(Tidewater.url, Tidewater.feed)
      _ = try await phone.api.createFeed(CreateFeed(url: Tidewater.url))
      let episode = try await phone.api.episodes().items[0]
      episodeId = episode.id
      _ = try await phone.api.reportPlayback(
        assetID: episode.assetId!, PlaybackReport(positionMs: 5_000, speed: 1, playing: true, finished: false, seq: 1, observedAt: phone.clock.ms))
      #expect(try await phone.api.episode(episodeId).resume?.deviceName == "Old Name")
    }
    let phone = try Phone(folder: folder, deviceName: "New Name")
    #expect(try await phone.api.episode(episodeId).resume?.deviceName == "New Name")
    #expect(try await phone.value("SELECT COUNT(*) AS v FROM device") == .integer(1))
  }

  @Test func theSchemaIsAtTheLatestVersionAndOpensAgainUntouched() async throws {
    let folder = FileManager.default.temporaryDirectory.appending(path: "ondevice-schema-\(UUID().uuidString)")
    for _ in 0..<2 {
      let phone = try Phone(folder: folder)
      #expect(try await phone.value("SELECT user_version AS v FROM pragma_user_version") == .integer(Int64(Schema.migrations.count)))
      #expect(try await phone.value("SELECT COUNT(*) AS v FROM sqlite_master WHERE type = 'table' AND name IN ('feed', 'episode', 'audio_asset', 'device', 'playback_state', 'up_next')") == .integer(6))
    }
    #expect(FileManager.default.fileExists(atPath: folder.appending(path: Store.fileName).path(percentEncoded: false)))
  }
}
