import Foundation
import Testing

@testable import OnDevice

/// The cases of server/src/core/chapters/points.test.ts (less `firstWordAtOrAfter`: the phone has no transcript
/// words to index yet) and showNotes.test.ts, on the Swift ports.
struct ChapterPointsTests {
  @Test func readsShowNotesClockTimes() {
    #expect(ChapterPoints.parseClock("0:00") == 0)
    #expect(ChapterPoints.parseClock("12:34") == 754_000)
    #expect(ChapterPoints.parseClock("75:30") == 4_530_000)
    #expect(ChapterPoints.parseClock("1:02:03") == 3_723_000)
    #expect(ChapterPoints.parseClock("00:00:01") == 1000)
    #expect(ChapterPoints.parseClock("12:60") == nil)
    #expect(ChapterPoints.parseClock("1:60:00") == nil)
    #expect(ChapterPoints.parseClock("2:30pm") == nil)
  }

  @Test func readsPodloveNormalPlayTime() {
    #expect(ChapterPoints.parseNpt("00:01:02.500") == 62_500)
    #expect(ChapterPoints.parseNpt("01:02") == 62_000)
    #expect(ChapterPoints.parseNpt("62.5") == 62_500)
    #expect(ChapterPoints.parseNpt("1:00:00") == 3_600_000)
    #expect(ChapterPoints.parseNpt("soon") == nil)
  }

  @Test func readsAChaptersFileSkippingHiddenAndUntitledEntriesInTimeOrder() {
    let document = """
      {"version": "1.2.0", "chapters": [
        {"startTime": 0, "title": "Intro"},
        {"startTime": 95.5, "title": "  The   main topic "},
        {"startTime": 60, "title": "A picture", "toc": false, "img": "https://x.test/a.jpg"},
        {"startTime": 300},
        {"startTime": 1800, "title": "Listener mail", "endTime": 2000},
        {"startTime": 1200, "title": "Sponsor: Acme"}
      ]}
      """
    #expect(
      ChapterPoints.jsonChapters(Data(document.utf8)) == [
        ChapterPoint(startMs: 0, title: "Intro"), ChapterPoint(startMs: 95_500, title: "The main topic"),
        ChapterPoint(startMs: 1_200_000, title: "Sponsor: Acme"), ChapterPoint(startMs: 1_800_000, title: "Listener mail"),
      ])
  }

  @Test func returnsNilForAnythingThatIsNotAUsableChaptersDocument() {
    #expect(ChapterPoints.jsonChapters(Data("null".utf8)) == nil)
    #expect(ChapterPoints.jsonChapters(Data("not json".utf8)) == nil)
    #expect(ChapterPoints.jsonChapters(Data(#"{"chapters": "no"}"#.utf8)) == nil)
    #expect(ChapterPoints.jsonChapters(Data(#"{"chapters": [{"startTime": 0, "title": "Only one"}]}"#.utf8)) == nil)
    #expect(ChapterPoints.jsonChapters(Data(#"{"chapters": [{"startTime": -5, "title": "Bad"}, {"startTime": "x", "title": "Worse"}]}"#.utf8)) == nil)
  }

  @Test func dropsPointsAtOrPastTheEndOfTheRecordingAndNeedsTwoLeft() {
    let points = [ChapterPoint(startMs: 0, title: "A"), ChapterPoint(startMs: 50_000, title: "B"), ChapterPoint(startMs: 100_000, title: "C")]
    #expect(ChapterPoints.feedChapterPoints(points, durationMs: 100_000) == Array(points.prefix(2)))
    #expect(ChapterPoints.feedChapterPoints(points, durationMs: 40_000) == nil)
  }

  @Test func labelsSponsorReadsIntrosAndOutrosAsTheSummaryDoes() {
    #expect(ChapterPoints.chapterKind("Sponsor: Acme") == "ad")
    #expect(ChapterPoints.chapterKind("Our sponsors") == "ad")
    #expect(ChapterPoints.chapterKind("Ad break") == "ad")
    #expect(ChapterPoints.chapterKind("Introduction") == "intro")
    #expect(ChapterPoints.chapterKind("Intros & background") == "intro")
    #expect(ChapterPoints.chapterKind("Outro") == "outro")
    #expect(ChapterPoints.chapterKind("Adaptive pricing") == "content")
    #expect(ChapterPoints.chapterKind("Why introductions matter") == "content")
  }
}

struct ShowNotesChaptersTests {
  static let hour = 3_600_000

  /// `[seconds, title]` pairs, as the server's test reads them.
  func titles(_ html: String, _ duration: Int = hour) -> [[String]]? {
    ShowNotesChapters.chapters(html: html, durationMs: duration)?.map { ["\($0.startMs / 1000)", $0.title] }
  }

  // MARK: Lists it believes

  @Test func readsBrSeparatedLinesWithParenthesisedTimesAndDashSeparators() {
    let html = """
      <p>Thanks to our sponsors.<br />
      – <b>Acme</b>: <a href="https://acme.test/show">https://acme.test/show</a></p>
      <p><b>OUTLINE:</b><br />
      Here are the timestamps for the episode.<br />
      (00:00) – Introduction<br />
      (07:37) – The first topic<br />
      (1:01:10) – A later topic &amp; more<br />
      (1:10:02) – Hope</p>
      """
    #expect(titles(html, 2 * Self.hour) == [["0", "Introduction"], ["457", "The first topic"], ["3670", "A later topic & more"], ["4202", "Hope"]])
  }

  @Test func readsListItemsAndParagraphsInTheCommonFormatsBulletsAndBracketsIncluded() {
    let html = """
      <p>Timestamps</p><ul>
      <li>00:00 Intro</li><li>[05:10] Why we started</li><li>(12:34) Pricing, take two</li><li>1:02:03 - The long tail</li></ul>
      <p>Links</p><ul><li><a href="https://x.test">A link</a></li></ul>
      """
    #expect(titles(html, 2 * Self.hour) == [["0", "Intro"], ["310", "Why we started"], ["754", "Pricing, take two"], ["3723", "The long tail"]])
    let paragraphs = #"<p>Chapters</p><p>* [00:00:01] Introductions</p><p>* [00:01:28] Founding story</p><p>* [00:03:50] "Minimum viable agents"</p>"#
    #expect(titles(paragraphs) == [["1", "Introductions"], ["88", "Founding story"], ["230", #""Minimum viable agents""#]])
  }

  @Test func findsTheListAfterTheCreditsKeepsTheEndOfARangeOutOfTheTitleAndStopsAtTheNextParagraph() {
    let html =
      "A story about prices.<br /><br />Our director is A. Person.<br /><br />(0:00) Introduction<br />(02:29 – 06:48) Prices and pay<br />(06:49) A court ruling<br />(10:25) A new prosecutor<br /><br />See example.test for privacy information."
    #expect(titles(html, 841_000) == [["0", "Introduction"], ["149", "Prices and pay"], ["409", "A court ruling"], ["625", "A new prosecutor"]])
  }

  @Test func splitsAListWhoseLineBreaksWereLostAndLetsABulletedSentenceSitUnderEachEntry() {
    #expect(
      titles("<p>00:00 Hello and guests00:22 The launch01:41 How it works05:39 The training recipe</p>")
        == [["0", "Hello and guests"], ["22", "The launch"], ["101", "How it works"], ["339", "The training recipe"]])
    let described =
      "<p>00:00 The idea</p><p>* The guest introduces the idea.</p><p>04:10 Where it came from</p><p>* Early years.</p><p>09:30 What is next</p><p>* Plans.</p>"
    #expect(titles(described) == [["0", "The idea"], ["250", "Where it came from"], ["570", "What is next"]])
  }

  @Test func prefersTheTableOfContentsOverATimestampedTranscriptPastedBelowIt() {
    let sentence = String(repeating: "So this is what a transcript paragraph sounds like when somebody talks for a while about a thing. ", count: 3)
    let transcript = (0..<6).map { i in "<p><strong>\(Int(Double(i) * 1.5)):\(i % 2 == 1 ? "30" : "00")</strong> \(sentence)</p>" }.joined()
    let html = "<p>Timestamps</p><p>* 0:00 What we do</p><p>* 1:25 From the old job to this one</p><p>* 4:19 Founding</p><p>Transcript</p>\(transcript)"
    #expect(titles(html) == [["0", "What we do"], ["85", "From the old job to this one"], ["259", "Founding"]])
  }

  @Test func dropsEntriesJustPastTheEndOfASlightlyShorterRecordingAndAllowsALateFirstEntryUpToThreeMinutes() {
    #expect(titles("<p>00:00 Ay</p><p>10:00 Bee</p><p>20:00 Sea</p><p>30:30 Dee</p>", 30 * 60_000) == [["0", "Ay"], ["600", "Bee"], ["1200", "Sea"]])
    #expect(titles("<p>02:27 Intros</p><p>10:00 Bee</p><p>20:00 Sea</p>") == [["147", "Intros"], ["600", "Bee"], ["1200", "Sea"]])
  }

  // MARK: Lists it rejects

  @Test func aSingleTimestampInProseOrTwo() {
    #expect(titles("<p>If you want the details, jump to 15:55 in the podcast.</p><p>00:00 Intro</p><p>Then 31:10 has the demo.</p>") == nil)
    #expect(titles("<p>00:00 Intro</p><p>10:00 Demo</p>") == nil)
  }

  @Test func timesOutOfOrder() {
    #expect(titles("<p>00:00 Intro</p><p>13:01 Search</p><p>1:14:48 Platform</p><p>21:17 Chemistry</p>") == nil)
    #expect(titles("<p>00:00 Intro</p><p>05:00 Same</p><p>05:00 Again</p>") == nil)
  }

  @Test func clockTimesOfDay() {
    #expect(titles("<p>Schedule</p><p>2:30pm Doors open</p><p>3:00pm Keynote</p><p>4:15pm Panel</p>") == nil)
    #expect(titles("<p>2:30 pm Doors open</p><p>3:00 p.m. Keynote</p><p>4:15 PM Panel</p>") == nil)
    #expect(ShowNotesChapters.timestampLine("12:345 is not a time") == nil)
  }

  @Test func sponsorAndPromoCodeLines() {
    let html =
      "<p>Sponsors:</p><ul><li>Acme: use code SHOW at acme.test, offer ends 11:59 PM</li><li>Widget: code 10:10OFF for 10% off</li><li>Gadget: 20% off before 12:00 tomorrow</li></ul>"
    #expect(titles(html) == nil)
  }

  @Test func aListThatStartsWellIntoTheEpisodeOrRunsWellPastItsEnd() {
    #expect(titles("<p>10:00 A topic</p><p>20:00 Another</p><p>30:00 A third</p>") == nil)
    #expect(titles("<p>00:00 Ay</p><p>40:00 Bee</p><p>1:20:00 Sea</p>", Self.hour) == nil)
  }

  @Test func garbageTitlesABareLinkPunctuationOrATranscriptParagraph() {
    #expect(titles("<p>00:00 Intro</p><p>05:00 https://example.test/a</p><p>10:00 Outro</p>") == nil)
    #expect(titles("<p>00:00 Intro</p><p>05:00 ---</p><p>10:00 Outro</p>") == nil)
    #expect(titles("<p>00:00 Intro</p><p>05:00 \(String(repeating: "word ", count: 40))</p><p>10:00 Outro</p>") == nil)
  }

  @Test func aTranscriptWhoseShortLinesAreEachTimestamped() {
    let html = (0..<30).map { i in "<p>[00:00:\(String(format: "%02d", i * 2))] Host: Yeah.</p>" }.joined()
    #expect(titles(html) == nil)
  }

  @Test func nothingAtAll() {
    #expect(ShowNotesChapters.chapters(html: nil, durationMs: Self.hour) == nil)
    #expect(ShowNotesChapters.chapters(html: "<p>Just prose.</p>", durationMs: Self.hour) == nil)
  }

  @Test func splitsAtBlocksAndLineBreaksDecodesEntitiesAndKeepsPlainTextNewlines() {
    #expect(ShowNotesChapters.lines("<p>One &amp; two<br>three</p><ul><li>four</li></ul>five\nsix") == ["One & two", "three", "four", "five", "six"])
  }
}

/// `sanitizeShowNotes` (server/src/lib/sanitize.ts) has no test file on the server; these pin what its allowlist does.
struct ShowNotesSanitizeTests {
  @Test func keepsFormattingAndLinksAndDropsEverythingElse() {
    #expect(
      ShowNotes.sanitize(#"<p>Notes with <script>alert(1)</script><a href="https://example.com/a?x=1&amp;y=2" onclick="x()">a link</a></p>"#)
        == #"<p>Notes with <a href="https://example.com/a?x=1&amp;y=2">a link</a></p>"#)
    #expect(ShowNotes.sanitize("<div><span style=\"color:red\">Plain</span> <img src=\"https://example.com/p.png\"> text</div>") == "Plain  text")
    #expect(ShowNotes.sanitize("<style>p { color: red }</style><h2>Heading</h2><ul><li>One<li>Two</ul>") == "<h2>Heading</h2><ul><li>One</li><li>Two</li></ul>")
    #expect(ShowNotes.sanitize("Line one<br>Line two &lt;not a tag&gt; &amp; more") == "Line one<br />Line two &lt;not a tag&gt; &amp; more")
  }

  @Test func keepsOnlyLinksItCanTrust() {
    #expect(ShowNotes.sanitize(#"<a href="javascript:alert(1)">x</a>"#) == "<a>x</a>")
    #expect(ShowNotes.sanitize("<a href=\"java\nscript:alert(1)\">x</a>") == "<a>x</a>")
    #expect(ShowNotes.sanitize(#"<a href="mailto:hello@example.com">write</a>"#) == #"<a href="mailto:hello@example.com">write</a>"#)
    #expect(ShowNotes.sanitize(#"<a href="/episodes/3">relative</a>"#) == #"<a href="/episodes/3">relative</a>"#)
  }

  @Test func closesWhatThePublisherLeftOpenAndReturnsNilForNothing() {
    #expect(ShowNotes.sanitize("<p>Open <b>bold") == "<p>Open <b>bold</b></p>")
    #expect(ShowNotes.sanitize(nil) == nil)
    #expect(ShowNotes.sanitize("") == nil)
    #expect(ShowNotes.sanitize("  <script>only()</script>  ") == nil)
  }
}

struct ULIDTests {
  @Test func idsAre26CrockfordCharactersThatSortByTimeThenByOrderMade() {
    var ids = ULIDGenerator()
    let first = (0..<200).map { _ in ids.next(nowMs: 1_800_000_000_000) }
    #expect(first.allSatisfy { $0.count == 26 && $0.allSatisfy { "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains($0) } })
    #expect(first == first.sorted())
    #expect(Set(first).count == 200)
    let later = ids.next(nowMs: 1_800_000_000_001)
    #expect(later > first.last!)
    // A clock that steps back does not make an id that sorts before the last one.
    #expect(ids.next(nowMs: 1_700_000_000_000) > later)
    // The time is the first ten characters: 2026-10-20T10:00:00Z here.
    #expect(ULIDGenerator.encode(UInt128(1_792_490_400_000) << 80).hasPrefix("01"))
  }
}
