import Foundation

// Ports of server/src/core/chapters/points.ts and showNotes.ts, and of the part of server/src/services/chapters.ts
// that lays a publisher's chapter points over a recording. Change the TypeScript first; these follow it.

/// A regular expression compiled once. The patterns are the server's, with `\d` written `[0-9]` because ICU's `\d`
/// takes any script's digits and JavaScript's only ASCII's.
struct Pattern: @unchecked Sendable {
  private let regex: NSRegularExpression

  init(_ pattern: String, caseInsensitive: Bool = false) {
    // The patterns are literals in this package, so one that does not compile is a bug found by the first test.
    regex = try! NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])
  }

  func matches(_ text: String) -> Bool {
    regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
  }

  /// The first match: the whole of it, then each group (nil for a group that took no part).
  func groups(_ text: String) -> [Substring?]? {
    guard let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
    return (0..<match.numberOfRanges).map { Range(match.range(at: $0), in: text).map { text[$0] } }
  }

  func replacingAll(in text: String, with replacement: String) -> String {
    regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: replacement)
  }

  func replacingFirst(in text: String, with replacement: String) -> String {
    guard let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
      let range = Range(match.range, in: text)
    else { return text }
    return text.replacingCharacters(in: range, with: replacement)
  }

  /// Where the matches start, for splitting at zero-width matches.
  func matchStarts(_ text: String) -> [String.Index] {
    regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { Range($0.range, in: text)?.lowerBound }
  }
}

/// A chapter's start and title, as a publisher supplies them.
struct ChapterPoint: Equatable, Sendable {
  var startMs: Int
  var title: String

  var json: JSON { ["start_ms": .int(startMs), "title": .string(title)] }
}

enum ChapterPoints {
  /// A first chapter this close to the start is taken to begin the episode (its start becomes 0).
  static let firstChapterMaxMs = 180_000
  static let titleMax = 200
  /// No publisher list is this long; a longer one is a transcript or a playlist, not chapters.
  static let maxPoints = 500

  private static let clock = Pattern(#"^(?:([0-9]{1,2}):([0-5][0-9]):([0-5][0-9])|([0-9]{1,3}):([0-5][0-9]))$"#)
  private static let npt = Pattern(#"^(?:(?:([0-9]+):)?([0-9]+):)?([0-9]+(?:\.[0-9]+)?)$"#)
  private static let whitespace = Pattern(#"\s+"#)

  /// Show-notes clock times: `M:SS`, `MM:SS`, `MMM:SS`, or `H:MM:SS`, seconds (and minutes, with hours) below 60.
  static func parseClock(_ s: String) -> Int? {
    guard let m = clock.groups(s.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
    if let h = m[1], let min = m[2], let sec = m[3] { return (Int(h)! * 3600 + Int(min)! * 60 + Int(sec)!) * 1000 }
    guard let min = m[4], let sec = m[5] else { return nil }
    return (Int(min)! * 60 + Int(sec)!) * 1000
  }

  /// Podlove's normal play time: `[[HH:]MM:]SS[.mmm]`, e.g. `00:01:02.500` or `62.5`.
  static func parseNpt(_ s: String) -> Int? {
    guard let m = npt.groups(s.trimmingCharacters(in: .whitespacesAndNewlines)), let last = m[3], let sec = Double(last) else { return nil }
    let seconds = Double(m[1].flatMap { Int($0) } ?? 0) * 3600 + Double(m[2].flatMap { Int($0) } ?? 0) * 60 + sec
    return seconds.isFinite ? Int((seconds * 1000).rounded()) : nil
  }

  /// The points of a Podcasting 2.0 JSON chapters document. Chapters marked `"toc": false` are pictures or links
  /// for a moment, not table-of-contents entries, and are skipped, as are untitled ones.
  static func jsonChapters(_ document: Data) -> [ChapterPoint]? {
    guard let object = try? JSONSerialization.jsonObject(with: document) as? [String: Any], let list = object["chapters"] as? [Any]
    else { return nil }
    var points: [ChapterPoint] = []
    for raw in list.prefix(maxPoints) {
      guard let chapter = raw as? [String: Any], let title = chapter["title"] as? String else { continue }
      if let toc = chapter["toc"] as? NSNumber, CFGetTypeID(toc) == CFBooleanGetTypeID(), !toc.boolValue { continue }
      let seconds: Double
      if let number = chapter["startTime"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
        seconds = number.doubleValue
      } else if let string = chapter["startTime"] as? String, let parsed = Double(string.trimmingCharacters(in: .whitespaces)) {
        seconds = parsed
      } else {
        continue
      }
      guard seconds.isFinite, seconds >= 0 else { continue }
      points.append(ChapterPoint(startMs: Int((seconds * 1000).rounded()), title: title))
    }
    return orderedPoints(points)
  }

  /// Tidy a publisher's list: trimmed non-empty titles, sorted by start, one point per start time, capped in
  /// length. Nil when fewer than two remain, since one chapter seeks nowhere.
  static func orderedPoints(_ points: [ChapterPoint]) -> [ChapterPoint]? {
    let tidy = points.map { ChapterPoint(startMs: max(0, $0.startMs), title: cleanTitle($0.title)) }.filter { !$0.title.isEmpty }
    // The server's sort is stable (points with one start keep their order, and the first is the one kept).
    let sorted = tidy.enumerated().sorted { ($0.element.startMs, $0.offset) < ($1.element.startMs, $1.offset) }.map(\.element)
    var out: [ChapterPoint] = []
    for point in sorted where out.last?.startMs != point.startMs { out.append(point) }
    return out.count >= 2 ? Array(out.prefix(maxPoints)) : nil
  }

  /// Feed chapters as they apply to one recording: points at or past its end are dropped, since the file is
  /// shorter than the edition they were written for.
  static func feedChapterPoints(_ points: [ChapterPoint], durationMs: Int) -> [ChapterPoint]? {
    guard let ordered = orderedPoints(points) else { return nil }
    let inside = ordered.filter { $0.startMs < durationMs }
    return inside.count >= 2 ? inside : nil
  }

  static func cleanTitle(_ title: String) -> String {
    let t = whitespace.replacingAll(in: title, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    guard t.count > titleMax else { return t }
    return String(t.prefix(titleMax - 1)).replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression) + "…"
  }

  private static let adKind = Pattern(#"\bsponsor|^(ads?|ad break|advertisement)\b"#, caseInsensitive: true)
  private static let introKind = Pattern(#"^(intros?|introductions?|cold open|opening)\b"#, caseInsensitive: true)
  private static let outroKind = Pattern(#"^(outro|closing|wrap[- ]?up|end of episode)\b"#, caseInsensitive: true)

  /// The summary's chapter kinds, guessed from a publisher's title so sponsor reads are labelled alike.
  static func chapterKind(_ title: String) -> String {
    if adKind.matches(title) { return "ad" }
    if introKind.matches(title) { return "intro" }
    if outroKind.matches(title) { return "outro" }
    return "content"
  }

  /// The feed's chapters, else the show notes', laid over the episode's length; nil when the publisher gave
  /// neither, or the length is unknown. `publishedChapters` and `laidOver` in server/src/services/chapters.ts, less
  /// the word indices: those point into a transcript, and the phone has none yet, so they are null as they are on
  /// the server before an episode is transcribed.
  static func published(feedChapters: String?, descriptionHtml: String?, durationMs: Int?) -> JSON {
    guard let durationMs, durationMs > 0 else { return .null }
    if let feed = feedChapterPoints(decodeStored(feedChapters), durationMs: durationMs) {
      return laidOver(source: "feed", feed, durationMs: durationMs)
    }
    if let notes = ShowNotesChapters.chapters(html: descriptionHtml, durationMs: durationMs) {
      return laidOver(source: "shownotes", notes, durationMs: durationMs)
    }
    return .null
  }

  /// Points become chapters that end where the next begins; a first chapter near the start begins the episode.
  private static func laidOver(source: String, _ points: [ChapterPoint], durationMs: Int) -> JSON {
    let starts = points.enumerated().map { $0.offset == 0 && $0.element.startMs <= firstChapterMaxMs ? 0 : $0.element.startMs }
    let items: [JSON] = points.enumerated().map { i, point in
      [
        "start_ms": .int(starts[i]), "end_ms": .int(i + 1 < starts.count ? starts[i + 1] : durationMs), "start_word": nil,
        "end_word": nil, "title": .string(point.title), "description": nil, "kind": .string(chapterKind(point.title)),
      ]
    }
    return ["source": .string(source), "transcript_id": nil, "items": .array(items)]
  }

  /// `episode.feed_chapters` is JSON `[{start_ms, title}]`, or `[]` once a chapters file turned out to be unusable.
  static func decodeStored(_ json: String?) -> [ChapterPoint] {
    guard let json, let list = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]] else { return [] }
    return list.compactMap { item in
      guard let start = item["start_ms"] as? Int, let title = item["title"] as? String else { return nil }
      return ChapterPoint(startMs: start, title: title)
    }
  }

  static func encodeStored(_ points: [ChapterPoint]?) -> String {
    String(decoding: JSON.array((points ?? []).map(\.json)).data(), as: UTF8.self)
  }
}

/// Chapters from the timestamps publishers write into show notes: lines such as `00:00 Intro`, `(12:34) Topic`,
/// `1:02:03 - Topic`, `[05:10] Topic` or `* 4:19 Topic`, in list items, paragraphs, or `<br>`-separated lines.
///
/// Show notes are prose first, so a list is only believed when it looks like a table of contents: one unbroken run
/// of timestamp-led lines (a bulleted sentence under an entry doesn't break it), at least three, strictly
/// increasing, the first within three minutes of the start, none far past the end of the recording, typically 20 s
/// or more apart, each followed by a short title. When several runs qualify the longest wins. The server's file
/// (core/chapters/showNotes.ts) says which shows each rule was calibrated on.
enum ShowNotesChapters {
  static let minPoints = 3
  /// Longer than this is a sentence or a transcript paragraph, not a chapter title.
  private static let titleMax = 120
  /// Chapters closer together than this, typically, are a timestamped transcript rather than a table of contents.
  private static let minMedianGapMs = 20_000

  private static let blockTags: Set<String> = [
    "p", "li", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "tr", "ul", "ol",
  ]
  private static let skipTags: Set<String> = ["script", "style", "img"]
  private static let time = #"([0-9]{1,2}:[0-9]{2}:[0-9]{2}|[0-9]{1,3}:[0-9]{2})"#
  private static let bullet = Pattern(#"^(?:[*•·▪‣◦>-]|[–—])\s*"#)
  private static let bulletLine = Pattern(#"^(?:[*•·▪‣◦-]|[–—])\s+\S"#)
  private static let lead = Pattern(#"^[(\[]?\s*"# + time)
  /// The end of a range written as `00:00 - 05:10 Topic`; dropped.
  private static let rangeEnd = Pattern(#"^\s*(?:[-–—]|to)\s*[(\[]?"# + time + #"[)\]]?(?=[\s\-–—:|]|$)"#)
  private static let separators = Pattern(#"^[\s\-–—:|.,·•]+"#)
  private static let glued = Pattern(#"(?<=[^\s0-9(\[:])(?=(?:[0-9]{1,2}:[0-9]{2}:[0-9]{2}|[0-9]{1,3}:[0-9]{2})\s)"#)
  private static let runsOn = Pattern(#"^[\p{L}0-9:]"#)
  private static let closer = Pattern(#"^\s*[)\]]"#)
  private static let meridiem = Pattern(#"^[ap]\.?m\b\.?"#, caseInsensitive: true)
  private static let trailing = Pattern(#"[\s\-–—:|]+$"#)
  private static let whitespace = Pattern(#"\s+"#)
  private static let hasLetter = Pattern(#"\p{L}"#)
  private static let bareLink = Pattern(#"^(https?://|www\.)\S*$"#, caseInsensitive: true)

  /// The chapter points in a show-notes fragment, or nil when there is no credible list. `durationMs` is the
  /// recording's length; points well past it reject the list, and points just past it are dropped.
  static func chapters(html: String?, durationMs: Int?) -> [ChapterPoint]? {
    guard let html, !html.isEmpty else { return nil }
    var best: [ChapterPoint]?
    var run: [ChapterPoint] = []
    func close() {
      if let ok = credibleRun(run, durationMs: durationMs), ok.count > (best?.count ?? 0) { best = ok }
      run = []
    }
    for line in lines(html).flatMap(unglue) {
      if let point = timestampLine(line) {
        run.append(point)
      } else if !run.isEmpty, bulletLine.matches(line) {
        // Some lists put a bulleted sentence under each timestamp; it neither ends the list nor becomes a chapter.
        continue
      } else {
        close()
      }
    }
    close()
    return best
  }

  /// The text of the notes, one entry per block or `<br>`-separated line, entities decoded, whitespace collapsed.
  static func lines(_ html: String) -> [String] {
    var parts = ""
    var skipping = 0
    for token in HTML.tokens(html) {
      switch token {
      case .text(let raw):
        if skipping == 0 { parts += HTML.decodeEntities(raw) }
      case .open(let name, _, let selfClosing):
        if skipTags.contains(name) {
          if name != "img", !selfClosing { skipping += 1 }
        } else if blockTags.contains(name) {
          parts += "\n"
        }
      case .close(let name):
        if skipTags.contains(name) {
          skipping = max(0, skipping - 1)
        } else if blockTags.contains(name) {
          parts += "\n"
        }
      }
    }
    return parts.split(whereSeparator: \.isNewline)
      .map { whitespace.replacingAll(in: String($0), with: " ").trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
  }

  /// A list whose line breaks were lost in the publisher's HTML reads `00:00 Welcome and Guests00:22 Announcing
  /// X01:41 Architecture`. Split it before each timestamp that follows a non-space character directly; one after a
  /// space, as in a transcript written `(00:05) Welcome. (00:06) We're here`, stays in the text.
  private static func unglue(_ line: String) -> [String] {
    guard timestampLine(line) != nil else { return [line] }
    var pieces: [String] = []
    var start = line.startIndex
    for cut in glued.matchStarts(line) where cut > start {
      pieces.append(String(line[start..<cut]))
      start = cut
    }
    pieces.append(String(line[start...]))
    return pieces.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
  }

  /// A point when the line opens with a timestamp (after an optional bullet) and goes on to a title.
  static func timestampLine(_ line: String) -> ChapterPoint? {
    let body = bullet.replacingFirst(in: line, with: "")
    guard let m = lead.groups(body), let whole = m[0], let clock = m[1], let startMs = ChapterPoints.parseClock(String(clock))
    else { return nil }
    var rest = String(body[whole.endIndex...])
    // "2:30pm", "12:345", "1:02:03:04": the time runs on into something else.
    if runsOn.matches(rest) { return nil }
    rest = closer.replacingFirst(in: rest, with: "")
    rest = rangeEnd.replacingFirst(in: rest, with: "")
    rest = separators.replacingFirst(in: rest, with: "")
    if meridiem.matches(rest) { return nil }  // "2:30 pm ET"
    let title = trailing.replacingFirst(in: rest, with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    return title.isEmpty ? nil : ChapterPoint(startMs: startMs, title: title)
  }

  /// The run as chapters if it reads like a table of contents for this recording, else nil.
  private static func credibleRun(_ run: [ChapterPoint], durationMs: Int?) -> [ChapterPoint]? {
    guard run.count >= minPoints, run[0].startMs <= ChapterPoints.firstChapterMaxMs else { return nil }
    for i in 1..<run.count where run[i].startMs <= run[i - 1].startMs { return nil }
    guard run.allSatisfy({ plausibleTitle($0.title) }) else { return nil }
    let gaps = (1..<run.count).map { run[$0].startMs - run[$0 - 1].startMs }.sorted()
    guard gaps[gaps.count / 2] >= minMedianGapMs else { return nil }
    guard let durationMs else { return run }
    // Slack for an edition a little longer than our file (an intro or ad cut, a video cut of the same talk).
    let slack = max(60_000, Double(durationMs) * 0.05)
    if Double(run[run.count - 1].startMs) > Double(durationMs) + slack { return nil }
    let inside = run.filter { $0.startMs < durationMs }
    return inside.count >= minPoints ? inside : nil
  }

  private static func plausibleTitle(_ title: String) -> Bool {
    if title.utf16.count < 2 || title.utf16.count > titleMax { return false }
    if !hasLetter.matches(title) { return false }
    if bareLink.matches(title) { return false }
    return true
  }
}
