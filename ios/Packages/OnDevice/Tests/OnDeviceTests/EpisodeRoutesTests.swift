import Foundation
import PodcastAPI
import Testing

@testable import OnDevice

/// The episode lists and one episode as the player reads it, through the app's own `APIClient`.
struct EpisodeRoutesTests {
  static func tidewater() async throws -> (Phone, Feed) {
    let phone = try Phone()
    phone.http.serve(Tidewater.url, Tidewater.feed)
    return (phone, try await phone.api.createFeed(CreateFeed(url: Tidewater.url)))
  }

  @Test func episodesAreListedNewestFirstWithTheirRecordingReady() async throws {
    let (phone, feed) = try await Self.tidewater()
    let page = try await phone.api.episodes()
    #expect(page.items.map(\.title) == ["The Ferry Timetable", "Low Water", "Harbour Lights"])
    #expect(page.next == nil)
    let newest = page.items[0]
    #expect(newest.feedId == feed.id)
    #expect(newest.showTitle == "Tidewater Almanac")
    #expect(newest.publishedAt == ms("2026-10-21T10:00:00Z"))
    #expect(newest.durationMs == 30 * 60_000)
    #expect(newest.assetId?.count == 26)
    #expect(newest.transcriptId == nil)
    #expect(newest.hasSummary == false)
    #expect(newest.processing.audio == .ready)
    #expect(newest.processing.transcript == JobState.none && newest.processing.text == JobState.none && newest.processing.summary == JobState.none)
    #expect(newest.resume == nil)
    #expect(newest.mediaKind == "audio")
    #expect(newest.youtubeId == nil)
    #expect(newest.video.status == "none" && newest.video.error == nil)
    // The feed gave no length for the oldest, so the list has none to show.
    #expect(page.items[2].durationMs == nil)
    // Every episode has its own recording, and keeps it.
    #expect(Set(page.items.compactMap(\.assetId)).count == 3)
    #expect(try await phone.api.episodes().items.map(\.assetId) == page.items.map(\.assetId))
  }

  @Test func theListPagesWithTheServersCursor() async throws {
    let (phone, feed) = try await Self.tidewater()
    let first = try await phone.api.episodes(limit: 2)
    #expect(first.items.map(\.title) == ["The Ferry Timetable", "Low Water"])
    #expect(first.next == "\(ms("2026-10-14T10:00:00Z"))_\(first.items[1].id)")
    let second = try await phone.api.episodes(limit: 2, after: first.next)
    #expect(second.items.map(\.title) == ["Harbour Lights"])
    #expect(second.next == nil)
    #expect(try await phone.api.episodes(feedID: feed.id, limit: 1, after: first.next).items.map(\.title) == ["Harbour Lights"])
    // Not a cursor: nothing matches, as on the server.
    #expect(try await phone.api.episodes(after: "nonsense").items.isEmpty)
    let tooMany = await #expect(throws: APIError.self) { try await phone.api.episodes(limit: 201) }
    #expect(tooMany == APIError(status: 400, code: "validation", message: "querystring/limit must be <= 200"))
  }

  @Test func episodesWithoutADateSortLastAndPageByTheirIds() async throws {
    let phone = try Phone()
    let items = ["One", "Two", "Three"].map { TestItem(title: $0, guid: $0, url: "https://media.example.com/undated/\($0).mp3") }
    phone.http.serve("https://feeds.example.com/undated.xml", rss(title: "Undated", items: items))
    phone.http.serve(Tidewater.url, Tidewater.feed)
    _ = try await phone.api.createFeed(CreateFeed(url: "https://feeds.example.com/undated.xml"))
    _ = try await phone.api.createFeed(CreateFeed(url: Tidewater.url))
    // Dated ones first; the undated ones by id, the last made first.
    let all = try await phone.api.episodes()
    #expect(all.items.map(\.title) == ["The Ferry Timetable", "Low Water", "Harbour Lights", "Three", "Two", "One"])
    let page = try await phone.api.episodes(limit: 4)
    #expect(page.next == "0_\(page.items[3].id)")
    #expect(try await phone.api.episodes(limit: 4, after: page.next).items.map(\.title) == ["Two", "One"])
  }

  /// server/test/feed-follow.test.ts: a show opened without following keeps out of every feed's new episodes until
  /// one of its episodes is in progress.
  @Test func anUnfollowedShowsEpisodesAppearAmongAllOnlyWhileOneIsInProgress() async throws {
    let (phone, _) = try await Self.tidewater()
    let item = TestItem(title: "Browsed Episode", guid: "b-1", pubDate: "Thu, 22 Oct 2026 10:00:00 GMT", url: "https://media.example.com/browsed/1.mp3")
    phone.http.serve("https://feeds.example.com/browsed.xml", rss(title: "Browsed", items: [item]))
    let browsed = try await phone.api.createFeed(CreateFeed(url: "https://feeds.example.com/browsed.xml", followed: false))
    let own = try await phone.api.episodes(feedID: browsed.id)
    #expect(own.items.map(\.title) == ["Browsed Episode"])
    #expect(try await phone.api.episodes().items.map(\.title) == ["The Ferry Timetable", "Low Water", "Harbour Lights"])

    let asset = try #require(own.items[0].assetId)
    func report(_ seq: Int, _ position: Int, finished: Bool = false) async throws {
      _ = try await phone.api.reportPlayback(
        assetID: asset, PlaybackReport(positionMs: position, speed: 1, playing: !finished, finished: finished, seq: seq, observedAt: phone.clock.ms))
    }
    try await report(1, 2_000)
    #expect(try await phone.api.episodes().items.map(\.title) == ["Browsed Episode", "The Ferry Timetable", "Low Water", "Harbour Lights"])
    try await report(2, 60_000, finished: true)
    #expect(try await phone.api.episodes().items.map(\.title) == ["The Ferry Timetable", "Low Water", "Harbour Lights"])
  }

  @Test func oneEpisodeHasThePublishersFileAsItsRecording() async throws {
    let (phone, feed) = try await Self.tidewater()
    let listed = try await phone.api.episodes().items
    let episode = try await phone.api.episode(listed[0].id)
    #expect(episode.id == listed[0].id)
    #expect(episode.feedId == feed.id)
    #expect(episode.showTitle == "Tidewater Almanac")
    #expect(episode.title == "The Ferry Timetable")
    #expect(episode.durationMs == 30 * 60_000)
    #expect(episode.assetId == listed[0].assetId)
    #expect(episode.processing == listed[0].processing)
    // Show notes are stored sanitized: the script and the handler are gone, the link stays.
    #expect(episode.descriptionHtml == #"<p>Notes with <a href="https://example.com/ferry">a link</a></p>"#)
    #expect(episode.link == nil)
    #expect(episode.text == nil)
    #expect(episode.chapters == nil)
    #expect(episode.summary == nil)
    #expect(episode.snipCount == 0)
    #expect(episode.adBreaks == [])
    #expect(episode.resume == nil)
    #expect(episode.mediaKind == "audio" && episode.youtubeId == nil && episode.video.status == "none")
    #expect(!episode.isUnfetchedChannelVideo)

    let asset = try #require(episode.asset)
    #expect(asset.id == listed[0].assetId)
    #expect(asset.audioUrl == "https://media.example.com/tidewater/3.mp3?src=feed")
    #expect(asset.mime == "audio/mpeg")
    #expect(asset.bytes == 14_400_000)
    #expect(asset.durationMs == 30 * 60_000)
    #expect(asset.videoUrl == nil && asset.videoWidth == nil && asset.videoHeight == nil && asset.videoBytes == nil)

    // What the feed does not say is 0 on the recording, and the enclosure's own type is kept.
    let oldest = try #require(try await phone.api.episode(listed[2].id).asset)
    #expect(oldest.audioUrl == "https://media.example.com/tidewater/1.m4a")
    #expect(oldest.mime == "audio/x-m4a")
    #expect(oldest.bytes == 0)
    #expect(oldest.durationMs == 0)

    let missing = await #expect(throws: APIError.self) { try await phone.api.episode("01AAAAAAAAAAAAAAAAAAAAAAAA") }
    #expect(missing == APIError(status: 404, code: "not_found", message: "episode not found"))
  }

  @Test func askingForTheAudioAnswersWithTheSameEpisode() async throws {
    let (phone, _) = try await Self.tidewater()
    let id = try await phone.api.episodes().items[0].id
    let prepared = try await phone.api.prepareAudio(id)
    #expect(prepared == (try await phone.api.episode(id)))
    #expect(prepared.asset?.audioUrl == "https://media.example.com/tidewater/3.mp3?src=feed")
    let missing = await #expect(throws: APIError.self) { try await phone.api.prepareAudio("01AAAAAAAAAAAAAAAAAAAAAAAA") }
    #expect(missing?.status == 404)
  }

  // MARK: Chapters (server/test/chapters.test.ts, the cases that need no transcript)

  static let notes =
    "<p>In this one:</p><p>(00:00) Introduction<br>(00:41) Charts, take one<br>(01:20) Sponsor: Acme<br>(01:30) Soundings</p><p>Thanks for listening.</p>"

  @Test func showNotesTimestampsBecomeChaptersTimedOnTheFeedsDuration() async throws {
    let phone = try Phone()
    let item = TestItem(title: "Charts", guid: "c-1", duration: "125", url: "https://media.example.com/charts/1.mp3", description: Self.notes)
    let untimed = TestItem(title: "No length", guid: "c-0", url: "https://media.example.com/charts/0.mp3", description: Self.notes)
    phone.http.serve("https://feeds.example.com/charts.xml", rss(title: "Charts", items: [item, untimed]))
    let feed = try await phone.api.createFeed(CreateFeed(url: "https://feeds.example.com/charts.xml"))
    let listed = try await phone.api.episodes(feedID: feed.id).items
    let episode = try await phone.api.episode(try #require(listed.first { $0.title == "Charts" }).id)
    let chapters = try #require(episode.chapters)
    #expect(chapters.source == "shownotes")
    #expect(chapters.transcriptId == nil)
    #expect(chapters.items.map(\.title) == ["Introduction", "Charts, take one", "Sponsor: Acme", "Soundings"])
    #expect(chapters.items.map(\.startMs) == [0, 41_000, 80_000, 90_000])
    #expect(chapters.items.map(\.endMs) == [41_000, 80_000, 90_000, 125_000])
    #expect(chapters.items.map(\.kind) == ["intro", "content", "ad", "content"])
    #expect(chapters.items.allSatisfy { $0.startWord == nil && $0.endWord == nil && $0.description == nil })
    // With no length to lay them over there are no chapters, as on the server.
    #expect(try await phone.api.episode(try #require(listed.first { $0.title == "No length" }).id).chapters == nil)
  }

  @Test func theFeedsOwnChaptersComeBeforeTheShowNotes() async throws {
    let phone = try Phone()
    let podlove = TestItem(
      title: "Podlove", guid: "p-1", pubDate: "Wed, 21 Oct 2026 10:00:00 GMT", duration: "10:00", url: "https://media.example.com/chaptered/1.mp3",
      description: Self.notes,
      extra: #"<psc:chapters version="1.2"><psc:chapter start="00:00:10" title="Cold open"/><psc:chapter start="00:05:00.500" title="From the feed"/><psc:chapter start="00:20:00" title="Past the end"/></psc:chapters>"#)
    let file = TestItem(
      title: "A chapters file", guid: "p-2", pubDate: "Wed, 14 Oct 2026 10:00:00 GMT", duration: "10:00", url: "https://media.example.com/chaptered/2.mp3",
      description: Self.notes, extra: #"<podcast:chapters url="https://media.example.com/chaptered/2.json" type="application/json+chapters"/>"#)
    let missing = TestItem(
      title: "A file that is not there", guid: "p-3", pubDate: "Wed, 07 Oct 2026 10:00:00 GMT", duration: "125", url: "https://media.example.com/chaptered/3.mp3",
      description: Self.notes, extra: #"<podcast:chapters url="https://media.example.com/chaptered/3.json" type="application/json+chapters"/>"#)
    phone.http.serve("https://feeds.example.com/chaptered.xml", rss(title: "Chaptered", items: [podlove, file, missing]))
    phone.http.serve(
      "https://media.example.com/chaptered/2.json",
      #"{"version": "1.2.0", "chapters": [{"startTime": 0, "title": "Opening"}, {"startTime": 30.2, "title": "From the file"}, {"startTime": 61, "title": "Also from the file"}]}"#)
    phone.http.serve("https://media.example.com/chaptered/3.json", status: 404)
    let feed = try await phone.api.createFeed(CreateFeed(url: "https://feeds.example.com/chaptered.xml"))
    let listed = try await phone.api.episodes(feedID: feed.id).items

    // Podlove chapters come inline; the one past the end of the recording is dropped.
    let inline = try #require(try await phone.api.episode(listed[0].id).chapters)
    #expect(inline.source == "feed")
    #expect(inline.items.map(\.title) == ["Cold open", "From the feed"])
    #expect(inline.items.map(\.startMs) == [0, 300_500])
    #expect(inline.items.map(\.endMs) == [300_500, 600_000])

    // A chapters file is fetched with the refresh, once.
    let fetched = try #require(try await phone.api.episode(listed[1].id).chapters)
    #expect(fetched.source == "feed")
    #expect(fetched.items.map(\.title) == ["Opening", "From the file", "Also from the file"])
    #expect(fetched.items.map(\.startMs) == [0, 30_200, 61_000])
    #expect(fetched.items.map(\.kind) == ["intro", "content", "content"])

    // One that is not there is recorded as such, so it is not fetched again, and the show notes serve.
    #expect(try await phone.api.episode(listed[2].id).chapters?.source == "shownotes")
    try await phone.api.refreshFeed(feed.id)
    _ = try await phone.api.prepareAudio(listed[2].id)
    #expect(phone.http.requests(to: "https://media.example.com/chaptered/2.json").count == 1)
    #expect(phone.http.requests(to: "https://media.example.com/chaptered/3.json").count == 1)
  }

  @Test func aChaptersFileThatCouldNotBeReachedIsFetchedWhenTheEpisodeIsAskedFor() async throws {
    let phone = try Phone()
    let item = TestItem(
      title: "Later", guid: "l-1", duration: "10:00", url: "https://media.example.com/later/1.mp3",
      extra: #"<podcast:chapters url="https://media.example.com/later/1.json" type="application/json+chapters"/>"#)
    phone.http.serve("https://feeds.example.com/later.xml", rss(title: "Later", items: [item]))
    phone.http.serve("https://media.example.com/later/1.json", status: 503)
    _ = try await phone.api.createFeed(CreateFeed(url: "https://feeds.example.com/later.xml"))
    let id = try await phone.api.episodes().items[0].id
    #expect(try await phone.api.episode(id).chapters == nil)
    phone.http.serve("https://media.example.com/later/1.json", #"{"chapters": [{"startTime": 0, "title": "Start"}, {"startTime": 200, "title": "Middle"}]}"#)
    #expect(try await phone.api.prepareAudio(id).chapters?.items.map(\.title) == ["Start", "Middle"])
  }
}
