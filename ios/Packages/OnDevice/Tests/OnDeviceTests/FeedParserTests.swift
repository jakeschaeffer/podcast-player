import Foundation
import Testing

@testable import OnDevice

/// The cases of server/src/core/feed/parse.test.ts, on the Swift port.
struct FeedParserTests {
  static let feed = """
    <?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
    <channel>
      <title>Test Show</title>
      <link>https://example.com/show</link>
      <language>en-us</language>
      <itunes:author>Example Studio</itunes:author>
      <itunes:image href="https://example.com/art.jpg"/>
      <item>
        <title>Episode Two</title>
        <guid isPermaLink="false">ep-2</guid>
        <pubDate>Tue, 20 Oct 2026 10:00:00 GMT</pubDate>
        <itunes:duration>1:02:03</itunes:duration>
        <description><![CDATA[<p>Notes with <script>alert(1)</script><a href="https://x.test">link</a></p>]]></description>
        <enclosure url="https://cdn.example.com/ep2.mp3?token=abc" type="audio/mpeg" length="12345"/>
      </item>
      <item>
        <title>No GUID</title>
        <link>https://example.com/ep1</link>
        <enclosure url="https://cdn.example.com/ep1.mp3?sig=1" type="audio/mpeg"/>
      </item>
      <item>
        <title>No enclosure</title>
        <guid>ep-0</guid>
      </item>
      <item>
        <title>Video first, audio second</title>
        <guid>ep-3</guid>
        <enclosure url="https://cdn.example.com/ep3.mp4" type="video/mp4"/>
        <enclosure url="https://cdn.example.com/ep3.m4a" type="audio/x-m4a"/>
      </item>
    </channel>
    </rss>
    """

  let parsed: ParsedFeed

  init() throws { parsed = try FeedParser.parse(Self.feed) }

  @Test func readsChannelMetadata() {
    #expect(
      parsed.feed
        == FeedMeta(
          title: "Test Show", author: "Example Studio", imageUrl: "https://example.com/art.jpg", siteUrl: "https://example.com/show", language: "en-us"))
  }

  @Test func usesTheGuidWhenPresentAndFallsBackToTheEnclosureURLWithoutItsQuery() {
    #expect(parsed.items.map(\.identity) == ["ep-2", "https://cdn.example.com/ep1.mp3", "ep-3"])
    #expect(parsed.items.map(\.identitySource) == ["guid", "enclosure", "guid"])
  }

  @Test func skipsItemsWithoutAnEnclosureAndReportsThem() {
    #expect(parsed.skipped == [SkippedItem(title: "No enclosure", reason: "no enclosure")])
  }

  @Test func prefersTheAudioEnclosureAndRemembersTheVideoOne() {
    #expect(parsed.items[2].enclosureUrl == "https://cdn.example.com/ep3.m4a")
    #expect(parsed.items[2].mediaKind == "audio")
    #expect(parsed.items[2].videoUrl == "https://cdn.example.com/ep3.mp4")
    #expect(parsed.items[0].videoUrl == nil)
  }

  @Test func parsesDatesDurationsSizesAndRawDescriptionHtml() {
    let ep = parsed.items[0]
    #expect(ep.publishedAt == ms("2026-10-20T10:00:00Z"))
    #expect(ep.durationHintMs == (1 * 3600 + 2 * 60 + 3) * 1000)
    #expect(ep.enclosureBytes == 12345)
    #expect(ep.descriptionHtml?.contains("<script>") == true)  // sanitized later, at storage time
  }

  @Test func neverThrowsOnJunkButRefusesNonFeeds() throws {
    #expect(throws: FeedParseError(message: "not an RSS feed: no <channel>")) { try FeedParser.parse("<html><body>hi</body></html>") }
    #expect(throws: FeedParseError.self) { try FeedParser.parse("not xml at all") }
    #expect(try FeedParser.parse("<rss><channel><title>x</title></channel></rss>").items == [])
  }

  // MARK: Publisher chapters

  static let chaptered = """
    <?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:psc="http://podlove.org/simple-chapters">
    <channel>
      <title>Chaptered</title>
      <item>
        <title>Podcasting 2.0</title>
        <guid>pc20</guid>
        <enclosure url="https://cdn.example.com/a.mp3" type="audio/mpeg"/>
        <podcast:chapters url="https://cdn.example.com/a.html" type="text/html"/>
        <podcast:chapters url="https://cdn.example.com/a.json?k=1" type="application/json+chapters"/>
      </item>
      <item>
        <title>Podlove</title>
        <guid>psc</guid>
        <enclosure url="https://cdn.example.com/b.mp3" type="audio/mpeg"/>
        <psc:chapters version="1.2">
          <psc:chapter start="00:00:00.000" title="Intro"/>
          <psc:chapter start="00:12:30.500" title="Main topic" href="https://example.com"/>
          <psc:chapter start="1:02:03" title="Listener mail"/>
          <psc:chapter start="bogus" title="Dropped"/>
        </psc:chapters>
      </item>
      <item>
        <title>One psc chapter</title>
        <guid>psc1</guid>
        <enclosure url="https://cdn.example.com/c.mp3" type="audio/mpeg"/>
        <psc:chapters><psc:chapter start="0" title="Everything"/></psc:chapters>
      </item>
    </channel>
    </rss>
    """

  @Test func keepsTheJSONChaptersURLAndIgnoresOtherTypes() throws {
    let items = try FeedParser.parse(Self.chaptered).items
    #expect(items[0].chaptersUrl == "https://cdn.example.com/a.json?k=1")
    #expect(items[0].chapters == nil)
  }

  @Test func readsPodloveSimpleChaptersInlineAndNeedsTwoOfThem() throws {
    let items = try FeedParser.parse(Self.chaptered).items
    #expect(
      items[1].chapters == [
        ChapterPoint(startMs: 0, title: "Intro"), ChapterPoint(startMs: 750_500, title: "Main topic"),
        ChapterPoint(startMs: 3_723_000, title: "Listener mail"),
      ])
    #expect(items[1].chaptersUrl == nil)
    #expect(items[2].chapters == nil)
  }

  // MARK: duration

  @Test func durationAcceptsHoursMinutesSecondsAndPlainSeconds() {
    #expect(FeedParser.duration("1:02:03") == 3_723_000)
    #expect(FeedParser.duration("02:03") == 123_000)
    #expect(FeedParser.duration("45") == 45_000)
    #expect(FeedParser.duration("abc") == nil)
    #expect(FeedParser.duration("") == nil)
    #expect(FeedParser.duration(nil) == nil)
  }

  // MARK: What Foundation's XMLParser needs help with (the server's parser takes these as they come)

  @Test func readsAFeedWithHTMLEntitiesAndBareAmpersandsOutsideCDATA() throws {
    let xml = """
      <rss version="2.0"><channel><title>Salt &amp; Shingle</title>
      <item><title>Tea&nbsp;&mdash; and biscuits & jam</title><guid>s-1</guid>
        <description><![CDATA[Kept as written: &nbsp; & <b>bold</b>]]></description>
        <enclosure url="https://media.example.com/salt/1.mp3?a=1&amp;b=2" type="audio/mpeg"/></item>
      </channel></rss>
      """
    let parsed = try FeedParser.parse(xml)
    #expect(parsed.feed.title == "Salt & Shingle")
    #expect(parsed.items.map(\.title) == ["Tea\u{A0}— and biscuits & jam"])
    #expect(parsed.items[0].descriptionHtml == "Kept as written: &nbsp; & <b>bold</b>")
    #expect(parsed.items[0].enclosureUrl == "https://media.example.com/salt/1.mp3?a=1&b=2")
  }

  @Test func keepsTheEpisodesReadBeforeADocumentBreaksOff() throws {
    let xml = """
      <rss version="2.0"><channel><title>Cut Short</title>
      <item><title>Whole</title><guid>c-1</guid><enclosure url="https://media.example.com/cut/1.mp3" type="audio/mpeg"/></item>
      <item><title>Half
      """
    let parsed = try FeedParser.parse(xml)
    #expect(parsed.feed.title == "Cut Short")
    #expect(parsed.items.map(\.title) == ["Whole"])
  }

  @Test func readsTheDateFormsFeedsUse() {
    let dates = DateReader()
    let expected = ms("2026-10-20T10:00:00Z")
    #expect(dates.unixMs("Tue, 20 Oct 2026 10:00:00 GMT") == expected)
    #expect(dates.unixMs("Tue, 20 Oct 2026 10:00:00 +0000") == expected)
    #expect(dates.unixMs("Tue, 20 Oct 2026 06:00:00 -0400") == expected)
    #expect(dates.unixMs("Tue, 20 Oct 2026 03:00:00 PDT") == expected)
    #expect(dates.unixMs("20 Oct 2026 10:00:00 GMT") == expected)
    #expect(dates.unixMs("Mon, 20 Oct 2026 10:00:00 GMT") == expected)  // the wrong weekday, as feeds have it
    #expect(dates.unixMs("Tue, 20 Oct 2026 10:00 GMT") == expected)
    #expect(dates.unixMs("2026-10-20T10:00:00Z") == expected)
    #expect(dates.unixMs("2026-10-20T10:00:00.000Z") == expected)
    #expect(dates.unixMs("sometime soon") == nil)
  }

  @Test func titlesThatLookLikeNumbersKeepTheirText() throws {
    let parsed = try FeedParser.parse(
      "<rss><channel><title>2049</title><item><title>007</title><enclosure url=\"https://media.example.com/n/7.mp3\"/></item></channel></rss>")
    #expect(parsed.feed.title == "2049")
    #expect(parsed.items.map(\.title) == ["007"])
  }
}
