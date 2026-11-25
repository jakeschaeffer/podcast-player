import Foundation
import PodcastAPI
import Testing

@testable import OnDevice

/// Feeds, show search and the routes the phone does not have, each through the app's own `APIClient`, so what is
/// checked is what the app's models decode.
struct FeedRoutesTests {
  @Test func healthAnswers() async throws {
    let phone = try Phone()
    #expect(try await phone.api.health().ok)
  }

  @Test func addingAShowReadsItBeforeAnswering() async throws {
    let phone = try Phone()
    phone.http.serve(Tidewater.url, Tidewater.feed, headers: ["ETag": "\"v1\"", "Last-Modified": "Wed, 21 Oct 2026 10:00:00 GMT"])
    let feed = try await phone.api.createFeed(CreateFeed(url: Tidewater.url))
    #expect(feed.title == "Tidewater Almanac")
    #expect(feed.author == "Example Studio")
    #expect(feed.siteUrl == "https://example.com/tidewater-almanac")
    #expect(feed.kind == "podcast")
    #expect(feed.episodeCount == 3)
    #expect(feed.lastRefreshAt == phone.clock.ms)
    #expect(feed.lastError == nil)
    #expect(feed.createdAt == phone.clock.ms)
    #expect(feed.followed == true)
    #expect(feed.isPrivate == false)
    #expect(feed.moreVideos?.status == "idle")
    #expect(feed.moreVideos?.error == nil)
    #expect(feed.id.count == 26)

    #expect(try await phone.api.feeds() == [feed])
    #expect(try await phone.api.feed(feed.id) == feed)
  }

  @Test func theSameAddressTwiceIsAConflictNamingTheFeed() async throws {
    let phone = try Phone()
    phone.http.serve(Tidewater.url, Tidewater.feed)
    let feed = try await phone.api.createFeed(CreateFeed(url: Tidewater.url))
    // Another spelling of the same address is the same feed.
    for url in [Tidewater.url, "  HTTPS://Feeds.Example.com:443/tidewater.xml "] {
      let error = await #expect(throws: APIError.self) { try await phone.api.createFeed(CreateFeed(url: url)) }
      #expect(error == APIError(status: 409, code: "conflict", message: "feed already added", feedId: feed.id))
    }
    #expect(try await phone.api.feeds().count == 1)
  }

  @Test func aShowOpenedWithoutFollowingIsManualWhateverWasAskedFor() async throws {
    let phone = try Phone()
    phone.http.serve(Tidewater.url, Tidewater.feed)
    let browsed = try await phone.api.createFeed(CreateFeed(url: Tidewater.url, autoProcess: true, backfill: 5, followed: false))
    #expect(browsed.followed == false)
    #expect(browsed.autoProcess == false)
    #expect(browsed.episodeCount == 3)
    #expect(try await phone.value("SELECT backfill AS v FROM feed") == .integer(0))

    // Follows and unfollows with PATCH; unfollowing makes a show manual.
    let followed = try await phone.api.updateFeed(browsed.id, UpdateFeed(followed: true))
    #expect(followed.followed == true)
    #expect(followed.autoProcess == false)
    let automatic: Feed = try await phone.api.send("PATCH", "/v1/feeds/\(browsed.id)", body: ["auto_process": true])
    #expect(automatic.autoProcess == true)
    let unfollowed = try await phone.api.updateFeed(browsed.id, UpdateFeed(followed: false))
    #expect(unfollowed.followed == false)
    #expect(unfollowed.autoProcess == false)
    #expect(unfollowed.episodeCount == 3)
  }

  @Test func feedsAreListedByTitleAndCanBeFilteredByWhetherTheyAreFollowed() async throws {
    let phone = try Phone()
    phone.http.serve(Tidewater.url, Tidewater.feed)
    phone.http.serve("https://feeds.example.com/marsh.xml", rss(title: "marsh radio", items: []))
    phone.http.serve("https://feeds.example.com/anchor.xml", rss(title: "Anchor Watch", items: []))
    let tidewater = try await phone.api.createFeed(CreateFeed(url: Tidewater.url))
    let marsh = try await phone.api.createFeed(CreateFeed(url: "https://feeds.example.com/marsh.xml", followed: false))
    let anchor = try await phone.api.createFeed(CreateFeed(url: "https://feeds.example.com/anchor.xml"))
    #expect(try await phone.api.feeds().map(\.id) == [anchor.id, marsh.id, tidewater.id])
    let followed: [Feed] = try await phone.api.send("GET", "/v1/feeds", query: [URLQueryItem(name: "followed", value: "true")])
    #expect(followed.map(\.id) == [anchor.id, tidewater.id])
    let browsed: [Feed] = try await phone.api.send("GET", "/v1/feeds", query: [URLQueryItem(name: "followed", value: "false")])
    #expect(browsed.map(\.id) == [marsh.id])
  }

  @Test func aPrivateAddressIsMarkedAndItsCredentialsGoInAHeader() async throws {
    let phone = try Phone()
    // The address is asked for without the credentials, which travel as Basic auth.
    phone.http.serve("https://feeds.example.com/members/tidewater.xml", Tidewater.feed)
    let feed = try await phone.api.createFeed(CreateFeed(url: "https://listener:s3cret@feeds.example.com/members/tidewater.xml"))
    #expect(feed.isPrivate)
    #expect(feed.title == "Tidewater Almanac")
    let request = try #require(phone.http.requests.first)
    #expect(request.url?.absoluteString == "https://feeds.example.com/members/tidewater.xml")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Basic " + Data("listener:s3cret".utf8).base64EncodedString())

    // A query string or a long token in the path also reads as private.
    phone.http.serve("https://feeds.example.com/tidewater.xml?key=abc", Tidewater.feed)
    #expect(try await phone.api.createFeed(CreateFeed(url: "https://feeds.example.com/tidewater.xml?key=abc")).isPrivate)
    #expect(FeedURL.looksPrivate(URLComponents(string: "https://feeds.example.com/p/aB3dE6gH9jK2mN5q/feed.xml")!))
    #expect(!FeedURL.looksPrivate(URLComponents(string: "https://feeds.example.com/shows/tidewater-almanac-weekly/feed.xml")!))
  }

  @Test func refreshAsksOnlyForWhatChangedAndAddsNewEpisodes() async throws {
    let phone = try Phone()
    let current = Current(Tidewater.feed, etag: "\"v1\"")
    phone.http.on(Tidewater.url) { request in
      let (body, etag) = current.value
      if request.value(forHTTPHeaderField: "If-None-Match") == etag { return StubHTTP.Reply(status: 304) }
      return StubHTTP.Reply(body: Data(body.utf8), headers: ["ETag": etag, "Last-Modified": "Wed, 21 Oct 2026 10:00:00 GMT"])
    }
    let feed = try await phone.api.createFeed(CreateFeed(url: Tidewater.url))
    #expect(phone.http.requests[0].value(forHTTPHeaderField: "If-None-Match") == nil)

    // Nothing changed: the publisher answers 304, and the refresh is still noted.
    phone.clock.ms += 60_000
    try await phone.api.refreshFeed(feed.id)
    let second = try #require(phone.http.requests.last)
    #expect(second.value(forHTTPHeaderField: "If-None-Match") == "\"v1\"")
    #expect(second.value(forHTTPHeaderField: "If-Modified-Since") == "Wed, 21 Oct 2026 10:00:00 GMT")
    var fresh = try await phone.api.feed(feed.id)
    #expect(fresh.lastRefreshAt == phone.clock.ms)
    #expect(fresh.episodeCount == 3)

    // A new episode arrives; the ones already here are not added twice.
    let newer = TestItem(title: "Spring Tide", guid: "tw-4", pubDate: "Wed, 28 Oct 2026 10:00:00 GMT", url: "https://media.example.com/tidewater/4.mp3")
    current.value = (rss(title: "Tidewater Almanac (renamed)", items: [newer] + Tidewater.items), "\"v2\"")
    phone.clock.ms += 60_000
    try await phone.api.refreshFeed(feed.id)
    fresh = try await phone.api.feed(feed.id)
    #expect(fresh.episodeCount == 4)
    #expect(fresh.title == "Tidewater Almanac (renamed)")
    #expect(fresh.author == "Example Studio")  // the feed no longer says, so what was known stays
    #expect(try await phone.api.episodes(feedID: feed.id).items.map(\.title) == ["Spring Tide", "The Ferry Timetable", "Low Water", "Harbour Lights"])
    #expect(try await phone.value("SELECT etag AS v FROM feed") == .text("\"v2\""))
  }

  /// Where the phone differs: it plays the publisher's file from the address in the feed, so when the feed moves an
  /// episode's file (a new host, a freshly signed link) the episode follows, and keeps its recording's id and place.
  @Test func aKnownEpisodeFollowsItsEnclosureWhenTheFeedMovesIt() async throws {
    let phone = try Phone()
    phone.http.serve(Tidewater.url, Tidewater.feed)
    let feed = try await phone.api.createFeed(CreateFeed(url: Tidewater.url))
    let before = try await phone.api.episode(try await phone.api.episodes().items[0].id)
    let asset = try #require(before.asset)
    _ = try await phone.api.reportPlayback(
      assetID: asset.id, PlaybackReport(positionMs: 95_000, speed: 1, playing: false, finished: false, seq: 1, observedAt: phone.clock.ms))

    var moved = Tidewater.items
    moved[0].url = "https://cdn.example.net/tidewater/3.m4a?sig=fresh"
    moved[0].type = "audio/x-m4a"
    moved[0].length = 9_000_000
    phone.http.serve(Tidewater.url, rss(title: "Tidewater Almanac", author: "Example Studio", items: moved))
    try await phone.api.refreshFeed(feed.id)

    let after = try await phone.api.episode(before.id)
    #expect(try await phone.api.feed(feed.id).episodeCount == 3)
    #expect(after.asset?.id == asset.id)
    #expect(after.asset?.audioUrl == "https://cdn.example.net/tidewater/3.m4a?sig=fresh")
    #expect(after.asset?.mime == "audio/x-m4a")
    #expect(after.asset?.bytes == 9_000_000)
    #expect(after.asset?.durationMs == asset.durationMs)
    #expect(after.resume?.positionMs == 95_000)
    // The others did not move, and are as they were.
    let others = try await phone.api.episodes().items
    #expect(try await phone.api.episode(others[1].id).asset?.audioUrl == "https://media.example.com/tidewater/2.mp3")
  }

  @Test func aFeedsSettingsAreStoredAndCheckedAsTheServerChecksThem() async throws {
    let phone = try Phone()
    phone.http.serve(Tidewater.url, Tidewater.feed)
    let feed = try await phone.api.createFeed(CreateFeed(url: Tidewater.url, autoProcess: true, backfill: 7))
    #expect(feed.autoProcess)
    let renamed: Feed = try await phone.api.send(
      "PATCH", "/v1/feeds/\(feed.id)",
      body: ["title": JSONValue.string("Tidewater, renamed"), "is_private": .bool(true), "backfill": .number(3), "keyterms": .array([.string("ferry")]), "transcriber": .string("whisper-local")])
    #expect(renamed.title == "Tidewater, renamed")
    #expect(renamed.isPrivate)
    #expect(try await phone.value("SELECT backfill AS v FROM feed") == .integer(3))
    #expect(try await phone.value("SELECT keyterms AS v FROM feed") == .text(#"["ferry"]"#))
    #expect(try await phone.value("SELECT transcriber AS v FROM feed") == .text("whisper-local"))
    // An empty change changes nothing.
    let same: Feed = try await phone.api.send("PATCH", "/v1/feeds/\(feed.id)", body: [String: JSONValue]())
    #expect(same == renamed)

    func refused(_ body: [String: JSONValue]) async -> APIError? {
      await #expect(throws: APIError.self) { let _: Feed = try await phone.api.send("PATCH", "/v1/feeds/\(feed.id)", body: body) }
    }
    #expect(await refused(["title": .string("")]) == APIError(status: 400, code: "validation", message: "body/title must NOT have fewer than 1 characters"))
    #expect(await refused(["backfill": .number(501)]) == APIError(status: 400, code: "validation", message: "body/backfill must be <= 500"))
    #expect(await refused(["followed": .string("yes")]) == APIError(status: 400, code: "validation", message: "body/followed must be boolean"))
    #expect(await refused(["transcriber": .string("other")])?.code == "validation")
    #expect(try await phone.api.feed(feed.id) == renamed)
  }

  @Test func aFeedThatCannotBeReadIsAddedWithTheReason() async throws {
    let phone = try Phone()
    phone.http.serve("https://feeds.example.com/gone.xml", status: 404)
    phone.http.serve("https://feeds.example.com/locked.xml", status: 403)
    phone.http.serve("https://feeds.example.com/broken.xml", status: 500)
    phone.http.serve("https://feeds.example.com/page.xml", "<html><body>Not a feed</body></html>")
    func lastError(_ url: String) async throws -> String? {
      let feed = try await phone.api.createFeed(CreateFeed(url: url))
      #expect(feed.title == nil)
      #expect(feed.episodeCount == 0)
      #expect(feed.lastRefreshAt == phone.clock.ms)  // a failed refresh is noted too, so the app stops waiting
      return feed.lastError
    }
    #expect(try await lastError("https://feeds.example.com/gone.xml") == "feed not found (404)")
    #expect(try await lastError("https://feeds.example.com/locked.xml") == "credential rejected (401/403); the private feed link may have expired")
    #expect(try await lastError("https://feeds.example.com/broken.xml") == "unexpected status 500")
    #expect(try await lastError("https://feeds.example.com/page.xml") == "parse failed: not an RSS feed: no <channel>")
    #expect(try await lastError("https://feeds.example.com/offline.xml")?.hasPrefix("fetch failed: ") == true)

    // Once the feed answers, a refresh clears the error.
    phone.http.serve("https://feeds.example.com/gone.xml", Tidewater.feed)
    let gone = try #require(try await phone.api.feeds().first { $0.lastError == "feed not found (404)" })
    try await phone.api.refreshFeed(gone.id)
    let back = try await phone.api.feed(gone.id)
    #expect(back.lastError == nil)
    #expect(back.title == "Tidewater Almanac")
  }

  @Test func whatThePhoneCannotFollowIsRefused() async throws {
    let phone = try Phone()
    func refusal(_ body: [String: String]) async -> APIError? {
      await #expect(throws: APIError.self) { let _: Feed = try await phone.api.send("POST", "/v1/feeds", body: body) }
    }
    #expect(await refusal(["url": "not a url"]) == APIError(status: 400, code: "bad_request", message: "url is not a valid URL"))
    #expect(await refusal(["url": "ftp://feeds.example.com/a.xml"]) == APIError(status: 400, code: "bad_request", message: "url must be http or https"))
    for url in ["https://www.youtube.com/@example", "https://www.youtube.com/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa", "https://youtu.be/aaaaaaaaaaa"] {
      #expect(await refusal(["url": url]) == APIError(status: 400, code: "bad_request", message: "YouTube channels are not available on this phone"))
    }
    #expect(
      await refusal(["url": "https://example.com/articles.xml", "kind": "text"])
        == APIError(status: 400, code: "bad_request", message: "text feeds are not available on this phone"))
    #expect(await refusal(["kind": "podcast"]) == APIError(status: 400, code: "validation", message: "body must have required property 'url'"))
    #expect(try await phone.api.feeds().isEmpty)
    #expect(phone.http.requests.isEmpty)
  }

  @Test func anUnknownFeedIsNotFound() async throws {
    let phone = try Phone()
    let missing = APIError(status: 404, code: "not_found", message: "feed not found")
    #expect(await #expect(throws: APIError.self) { try await phone.api.feed("01AAAAAAAAAAAAAAAAAAAAAAAA") } == missing)
    #expect(await #expect(throws: APIError.self) { try await phone.api.refreshFeed("01AAAAAAAAAAAAAAAAAAAAAAAA") } == missing)
    #expect(await #expect(throws: APIError.self) { try await phone.api.updateFeed("01AAAAAAAAAAAAAAAAAAAAAAAA", UpdateFeed(followed: true)) } == missing)
    #expect(await #expect(throws: APIError.self) { try await phone.api.sendIgnoringBody("DELETE", "/v1/feeds/01AAAAAAAAAAAAAAAAAAAAAAAA") } == missing)
  }

  @Test func removingAFeedTakesItsEpisodesPlacesAndUpNextWithIt() async throws {
    let phone = try Phone()
    phone.http.serve(Tidewater.url, Tidewater.feed)
    let feed = try await phone.api.createFeed(CreateFeed(url: Tidewater.url))
    let episode = try #require(try await phone.api.episodes().items.first)
    _ = try await phone.api.reportPlayback(
      assetID: try #require(episode.assetId), PlaybackReport(positionMs: 5_000, speed: 1, playing: true, finished: false, seq: 1, observedAt: phone.clock.ms))
    _ = try await phone.api.addToQueue(episode.id)
    try await phone.api.sendIgnoringBody("DELETE", "/v1/feeds/\(feed.id)")
    #expect(try await phone.api.feeds().isEmpty)
    #expect(try await phone.api.episodes().items.isEmpty)
    #expect(try await phone.api.queue().isEmpty)
    for table in ["episode", "audio_asset", "playback_state", "up_next"] {
      #expect(try await phone.value("SELECT COUNT(*) AS v FROM \(table)") == .integer(0))
    }
    // The address can be added again.
    #expect(try await phone.api.createFeed(CreateFeed(url: Tidewater.url)).episodeCount == 3)
  }

  @Test func refreshFeedsRefreshesTheFollowedOnesThatAreStale() async throws {
    let phone = try Phone()
    let urls = ["a", "b", "c", "d", "e", "f"].map { "https://feeds.example.com/\($0).xml" }
    for url in urls { phone.http.serve(url, rss(title: "Show \(url.suffix(5).prefix(1))", items: [])) }
    for url in urls.dropLast() { _ = try await phone.api.createFeed(CreateFeed(url: url)) }
    let browsed = try await phone.api.createFeed(CreateFeed(url: urls[5], followed: false))
    #expect(phone.http.requests.count == 6)

    // Nothing is stale yet.
    phone.clock.ms += 10 * 60_000
    await phone.backend.refreshFeeds(olderThan: 3600)
    #expect(phone.http.requests.count == 6)

    // One feed was refreshed by hand in the meantime; an hour on, the other followed ones are due.
    try await phone.api.refreshFeed(try await phone.api.feeds()[0].id)
    phone.clock.ms += 55 * 60_000
    await phone.backend.refreshFeeds(olderThan: 3600)
    let asked = phone.http.requests.dropFirst(7).compactMap { $0.url?.absoluteString }.sorted()
    #expect(asked == Array(urls[1...4]))
    #expect(try await phone.api.feed(browsed.id).lastRefreshAt == phone.clock.ms - 65 * 60_000)

    // A feed that fails is not asked again until it is stale again.
    phone.http.serve(urls[1], status: 500)
    phone.clock.ms += 61 * 60_000
    await phone.backend.refreshFeeds(olderThan: 3600)
    let count = phone.http.requests.count
    await phone.backend.refreshFeeds(olderThan: 3600)
    #expect(phone.http.requests.count == count)
    #expect(try await phone.api.feeds().compactMap(\.lastError) == ["unexpected status 500"])
  }

  // MARK: Show search

  static let directory = """
    {"resultCount": 4, "results": [
      {"collectionName": "Tidewater Almanac", "artistName": "Example Studio", "feedUrl": "https://feeds.example.com/tidewater.xml",
       "artworkUrl100": "https://example.com/art-100.jpg", "artworkUrl600": "https://example.com/art-600.jpg",
       "collectionViewUrl": "https://example.com/directory/tidewater", "trackCount": 42, "genres": ["Podcasts", "Nature"]},
      {"collectionName": "Tidewater Almanac (regional copy)", "feedUrl": "HTTPS://FEEDS.example.com/tidewater.xml", "genres": []},
      {"collectionName": "No feed listed", "artistName": "Nobody"},
      {"feedUrl": "https://feeds.example.com/marsh.xml", "artworkUrl100": "https://example.com/marsh-100.jpg"}
    ]}
    """

  @Test func searchListsOneRowPerFeedAndMarksTheShowsThePhoneHas() async throws {
    let phone = try Phone()
    let address = "https://itunes.apple.com/search?media=podcast&entity=podcast&term=tide%20water&limit=20"
    phone.http.serve(address, Self.directory)
    let before = try await phone.api.searchShows("tide water")
    #expect(before.source == "itunes")
    #expect(before.results.map(\.title) == ["Tidewater Almanac", "(untitled)"])
    #expect(before.results.allSatisfy { $0.feedId == nil && $0.followed == nil })
    let first = before.results[0]
    #expect(first.author == "Example Studio")
    #expect(first.feedUrl == Tidewater.url)
    #expect(first.artworkUrl == "https://example.com/art-600.jpg")
    #expect(first.siteUrl == "https://example.com/directory/tidewater")
    #expect(first.episodeCount == 42)
    #expect(first.genres == ["Nature"])
    #expect(first.source == "itunes")
    #expect(before.results[1].artworkUrl == "https://example.com/marsh-100.jpg")
    #expect(before.results[1].episodeCount == nil)
    #expect(phone.http.requests(to: address).count == 1)

    // Open one without following, follow the other: both are marked.
    phone.http.serve(Tidewater.url, Tidewater.feed)
    phone.http.serve("https://feeds.example.com/marsh.xml", rss(title: "Marsh Radio", items: []))
    let browsed = try await phone.api.createFeed(CreateFeed(url: first.feedUrl, followed: false))
    let followed = try await phone.api.createFeed(CreateFeed(url: "https://feeds.example.com/marsh.xml"))
    let after = try await phone.api.searchShows("tide water")
    #expect(after.results.map(\.feedId) == [browsed.id, followed.id])
    #expect(after.results.map(\.followed) == [false, true])
  }

  @Test func searchRejectsOneLetterAndReportsADirectoryThatFailsAs502() async throws {
    let phone = try Phone()
    let short = await #expect(throws: APIError.self) { try await phone.api.searchShows("a") }
    #expect(short?.status == 400)
    #expect(short?.code == "validation")
    #expect(phone.http.requests.isEmpty)
    let unavailable = APIError(status: 502, code: "upstream", message: "show search is unavailable right now (itunes)")
    #expect(await #expect(throws: APIError.self) { try await phone.api.searchShows("tide") } == unavailable)  // no network
    phone.http.serve("https://itunes.apple.com/search?media=podcast&entity=podcast&term=tide&limit=5", status: 503)
    #expect(await #expect(throws: APIError.self) { try await phone.api.searchShows("tide", limit: 5) } == unavailable)
    let tooMany = await #expect(throws: APIError.self) { try await phone.api.searchShows("tide", limit: 500) }
    #expect(tooMany?.code == "validation")
  }

  // MARK: Snips, and everything the phone does not have

  @Test func theSnipListsAreEmptyRatherThanErrors() async throws {
    let phone = try Phone()
    let snips = try await phone.api.snips()
    #expect(snips.items.isEmpty && snips.next == nil)
    #expect(try await phone.api.snips(episodeID: "01AAAAAAAAAAAAAAAAAAAAAAAA", limit: 200).items.isEmpty)
    let episodes = try await phone.api.snipEpisodes()
    #expect(episodes.items.isEmpty && episodes.next == nil)
    #expect(try await phone.api.snipShows().isEmpty)
  }

  @Test func anythingElseIsNotAvailableOnThisPhone() async throws {
    let phone = try Phone()
    let missing = APIError(status: 404, code: "not_found", message: "Not available on this phone")
    #expect(await #expect(throws: APIError.self) { try await phone.api.transcript("01AAAAAAAAAAAAAAAAAAAAAAAA") } == missing)
    #expect(await #expect(throws: APIError.self) { try await phone.api.snip("01AAAAAAAAAAAAAAAAAAAAAAAA") } == missing)
    #expect(await #expect(throws: APIError.self) { try await phone.api.readwise() } == missing)
    #expect(await #expect(throws: APIError.self) { try await phone.api.topicSearches() } == missing)
    #expect(await #expect(throws: APIError.self) { try await phone.api.prompts() } == missing)
    #expect(await #expect(throws: APIError.self) { try await phone.api.login(password: "x", deviceName: "y") } == missing)
    #expect(await #expect(throws: APIError.self) { try await phone.api.processEpisode("01AAAAAAAAAAAAAAAAAAAAAAAA") } == missing)
    #expect(await #expect(throws: APIError.self) { try await phone.api.requestVideo("01AAAAAAAAAAAAAAAAAAAAAAAA") } == missing)
    #expect(await #expect(throws: APIError.self) { try await phone.api.addPastedLink("https://example.com/a.mp3") } == missing)
    #expect(await #expect(throws: APIError.self) { try await phone.api.sendIgnoringBody("GET", "/somewhere/else") } == missing)
  }

  @Test func theAnswerIsAnHTTPResponseWhateverTheBaseURL() async throws {
    let phone = try Phone()
    var request = URLRequest(url: URL(string: "snip-local://phone/prefix/v1/health")!)
    request.httpMethod = "GET"
    let (data, response) = try await phone.backend.respond(to: request)
    let http = try #require(response as? HTTPURLResponse)
    #expect(http.statusCode == 200)
    #expect(http.value(forHTTPHeaderField: "Content-Type") == "application/json; charset=utf-8")
    #expect(String(decoding: data, as: UTF8.self) == #"{"ok":true}"#)
  }
}

/// A feed document a test can swap while the stub is serving it.
final class Current: @unchecked Sendable {
  private let lock = NSLock()
  private var body: String
  private var etag: String

  init(_ body: String, etag: String) {
    self.body = body
    self.etag = etag
  }

  var value: (String, String) {
    get { lock.withLock { (body, etag) } }
    set { lock.withLock { (body, etag) = newValue } }
  }
}
