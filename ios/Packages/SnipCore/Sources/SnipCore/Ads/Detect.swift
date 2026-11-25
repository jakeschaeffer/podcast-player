import Foundation

// A port of server/src/core/ads/detect.ts (ads_v3), checked against contracts/golden/ads/ads_v3.json.
// Change the TypeScript first, under a new version, never this port alone.
//
// Find the ad breaks in a recording, so the player can offer "Skip ad" while one plays. Pure and deterministic; no
// model call. Three signals, strongest first:
//
// 1. Publisher gap. When the publisher's own text was aligned to the audio, an ad is speech that the text does not
//    have: a long run of ASR words with no counterpart in the article. This gives exact boundaries.
// 2. Sponsor phrases in the speech ("this update is presented by", "promo code"), bounded by the end of the read:
//    a "back to the update" or "onto the update" line, a music sting, a long pause, or the recording's end. Some
//    publishers print the sponsor read in the article too, so this signal stands on its own even where publisher
//    text exists (no gap appears there).
// 3. Chapters the episode summary labelled `ad`.
//
// Signals that overlap merge into one break. A gap gives both edges when present. Otherwise the break opens at the
// earliest signal and ends where the most exact one does: a read that ended on a hand-back line, sting or the
// recording's end, then the chapter, then a read that ended on a pause.
//
// Words are not stored: a break is milliseconds on the asset, and skipping it seeks to `endMs`, which sits just
// before the first word after the break.
//
// The phone has no publisher text yet, so only signals 2 and 3 fire there; the gap signal is ported all the same,
// because the detector is one versioned thing.

/// `AD_DETECTOR_VERSION` (server/src/core/ads/detect.ts). Bump when the rules change; stored detections from an older
/// version are recomputed.
public let adDetectorVersion = "ads_v3"

/// `AdSource` (server/src/core/ads/detect.ts): a signal that found a break.
public enum AdSource: String, Sendable, Equatable, Codable {
  case publisherGap = "publisher_gap"
  case sponsorPhrase = "sponsor_phrase"
  case adChapter = "ad_chapter"
}

/// An `AdBreak`'s `confidence` (server/src/core/ads/detect.ts).
public enum AdConfidence: String, Sendable, Equatable, Codable {
  case high, medium
}

/// `AdBreak` (server/src/core/ads/detect.ts): one ad break, in the shape the server stores (`ad_detection.breaks`) and serves on an episode (`ad_breaks`).
public struct AdBreak: Sendable, Equatable, Codable {
  public var startMs: Int
  /// Where "Skip ad" lands: just before the first word after the break.
  public var endMs: Int
  /// `high` when two signals agree; `medium` when one does.
  public var confidence: AdConfidence
  public var sources: [AdSource]
  /// The sponsor phrase heard in the break, as normalized words, if any.
  public var cue: String?

  public init(startMs: Int, endMs: Int, confidence: AdConfidence, sources: [AdSource], cue: String?) {
    self.startMs = startMs
    self.endMs = endMs
    self.confidence = confidence
    self.sources = sources
    self.cue = cue
  }

  enum CodingKeys: String, CodingKey {
    case confidence, sources, cue
    case startMs = "start_ms"
    case endMs = "end_ms"
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    startMs = try c.decode(Int.self, forKey: .startMs)
    endMs = try c.decode(Int.self, forKey: .endMs)
    confidence = try c.decode(AdConfidence.self, forKey: .confidence)
    sources = try c.decode([AdSource].self, forKey: .sources)
    cue = try c.decodeIfPresent(String.self, forKey: .cue)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(startMs, forKey: .startMs)
    try c.encode(endMs, forKey: .endMs)
    try c.encode(confidence, forKey: .confidence)
    try c.encode(sources, forKey: .sources)
    try c.encode(cue, forKey: .cue)  // `string | null`: always present
  }
}

/// One of the summary's chapters, as much of it as the detector reads (`AdInput.chapters` in
/// server/src/core/ads/detect.ts).
public struct AdChapter: Sendable, Equatable, Codable {
  public var startMs: Int
  public var endMs: Int
  /// Only `ad` makes a chapter a candidate.
  public var kind: String

  public init(startMs: Int, endMs: Int, kind: String) {
    self.startMs = startMs
    self.endMs = endMs
    self.kind = kind
  }

  enum CodingKeys: String, CodingKey {
    case kind
    case startMs = "start_ms"
    case endMs = "end_ms"
  }
}

/// `AdInput` (server/src/core/ads/detect.ts): what the detector reads for one recording.
public struct AdInput: Sendable, Equatable {
  /// The publisher's text aligned to the same recording.
  public struct Publisher: Sendable, Equatable {
    public var transcript: NormalizedTranscript
    /// True when the text is read word for word (Updates and Articles): then a long passage missing from it is an ad
    /// even without a sponsor phrase. Interviews are edited transcripts that drop whole passages, so there a gap
    /// needs a second signal.
    public var verbatim: Bool

    public init(transcript: NormalizedTranscript, verbatim: Bool) {
      self.transcript = transcript
      self.verbatim = verbatim
    }
  }

  /// The ASR transcript: the only one that holds an ad's words.
  public var speech: NormalizedTranscript?
  public var publisher: Publisher?
  /// The summary's chapters; those of kind `ad` are candidates.
  public var chapters: [AdChapter]?
  public var durationMs: Int

  public init(speech: NormalizedTranscript?, publisher: Publisher? = nil, chapters: [AdChapter]? = nil, durationMs: Int) {
    self.speech = speech
    self.publisher = publisher
    self.chapters = chapters
    self.durationMs = durationMs
  }
}

/// `AdOptions` (server/src/core/ads/detect.ts). Its defaults are `DEFAULT_AD_OPTIONS`; where the TypeScript takes a
/// partial object, give the initializer only what differs.
public struct AdOptions: Sendable, Equatable {
  /// A publisher gap shorter than this is an aside or an intro line, not an ad.
  public var minGapMs: Int
  /// A gap with no second signal counts only in verbatim text, and only from this long.
  public var loneGapMinMs: Int
  /// Matched words inside a gap that still count as part of it (an ad's "the" aligned to the article's).
  public var maxIslandWords: Int
  /// Share of a gap's words that must be unmatched.
  public var minUnmatchedShare: Double
  /// No break is shorter than this or longer than `maxBreakMs`.
  public var minBreakMs: Int
  public var maxBreakMs: Int
  /// A sponsor read with no end found within this long is left alone rather than guessed.
  public var maxReadMs: Int
  /// A read that runs to the end of the recording counts as a post-roll only up to this long.
  public var maxPostrollMs: Int
  /// Silence that ends a sponsor read, once it has run `minReadMs`.
  public var readEndPauseMs: Int
  public var minReadMs: Int

  public init(
    minGapMs: Int = 20_000, loneGapMinMs: Int = 45_000, maxIslandWords: Int = 3, minUnmatchedShare: Double = 0.75,
    minBreakMs: Int = 10_000, maxBreakMs: Int = 6 * 60_000, maxReadMs: Int = 120_000, maxPostrollMs: Int = 90_000,
    readEndPauseMs: Int = 1_500, minReadMs: Int = 15_000
  ) {
    self.minGapMs = minGapMs
    self.loneGapMinMs = loneGapMinMs
    self.maxIslandWords = maxIslandWords
    self.minUnmatchedShare = minUnmatchedShare
    self.minBreakMs = minBreakMs
    self.maxBreakMs = maxBreakMs
    self.maxReadMs = maxReadMs
    self.maxPostrollMs = maxPostrollMs
    self.readEndPauseMs = readEndPauseMs
    self.minReadMs = minReadMs
  }
}

// The phrase patterns are the TypeScript's, character for character. They run over normalized words joined by single
// spaces, so the text holds only a-z, 0-9, apostrophes and spaces; on that alphabet Foundation's engine (ICU) and
// JavaScript's agree on `\b`, `\d`, greed and the order alternatives are tried in. The golden file speaks every
// alternative of every pattern, and near misses of each.
private func patterns(_ sources: [String]) -> [NSRegularExpression] {
  sources.map { try! NSRegularExpression(pattern: $0) }
}

/// Phrases that open or carry a sponsor read. Matched against normalized words joined by single spaces.
private let strongCues = patterns([
  #"\b(?:this|today's|the) (?:daily |weekly )?(?:episode|show|podcast|update|interview|article|post|essay|newsletter|program|segment|conversation)(?: of [a-z']+(?: [a-z']+)?)? (?:is |was )?(?:brought to you|sponsored|supported|presented|powered|underwritten|made possible) by\b"#,
  #"\bbrought to you by\b"#,
  #"\b(?:thanks|thank you) to (?:our|today's|this week's|this episode's) sponsors?\b"#,
  #"\b(?:a |one )?(?:quick |short |brief )?(?:word|message|break) from (?:our|today's|this week's) sponsors?\b"#,
  #"\bsupport for (?:this|the) (?:show|podcast|episode) comes from\b"#,
  #"\bour sponsor (?:today|this week|for this episode)\b"#,
  #"\btoday's sponsor\b"#,
  #"\b(?:presenting|title|exclusive) sponsor\b"#,
  #"\b(?:promo|discount|coupon) code\b"#,
])

/// Phrases common in ad copy but also in ordinary talk: they confirm a break, never start one.
private let weakCues = patterns([
  #"\bsponsored by\b"#,
  #"\bsponsors?\b"#,
  #"\buse (?:the )?code\b"#,
  #"\bfree trial\b"#,
  #"\b(?:first|1st) (?:month|week) free\b"#,
  #"\b\d+ percent off\b"#,
  #"\b(?:sign up|get started|head over|go) (?:today |now )?(?:at|to) [a-z0-9]+ ?(?:dot ?)?(?:com|ai|io|co)\b"#,
  #"\bterms (?:and conditions )?apply\b"#,
  #"\blimited time\b"#,
])

/// Lines that hand back to the show at the end of a read.
private let endCues = patterns([
  #"\b(?:on|onto|on to) (?:the|today's) (?:update|show|episode|interview|article)\b"#,
  #"\b(?:and )?(?:now )?back to (?:the|our) (?:show|episode|interview|conversation|update|program)\b"#,
  #"\band now (?:on|back) (?:to|with) the show\b"#,
])

private struct Word {
  var text: String
  var tok: String
  var startMs: Int
  var endMs: Int
}

private struct Cue {
  var word: Int
  var strong: Bool
  var phrase: String
}

/// `firm`: a read that ended on a hand-back line or a sting. `qualifies`: a gap that counts with no second signal.
private struct Candidate {
  var startMs: Int
  var endMs: Int
  var source: AdSource
  var cue: String?
  var firm = false
  var qualifies = false
}

/// `detectAds` (server/src/core/ads/detect.ts): the ad breaks of one recording, in order, from whichever of the three
/// signals its input holds. The rules are at the top of this file.
public func detectAds(_ input: AdInput, options opts: AdOptions = AdOptions()) -> [AdBreak] {
  let words = input.speech.map(flatWords) ?? []
  let cues = findCues(words, strongCues, strong: true) + findCues(words, weakCues, strong: false)
  let handBacks = Set(findCues(words, endCues, strong: true).map(\.word))
  let adChapters = (input.chapters ?? [])
    .filter { JS.equal($0.kind, "ad") && $0.endMs - $0.startMs >= opts.minBreakMs && $0.endMs - $0.startMs <= opts.maxBreakMs }
    .map { Candidate(startMs: $0.startMs, endMs: $0.endMs, source: .adChapter) }

  var gaps: [Candidate] = []
  if let publisher = input.publisher, !words.isEmpty {
    gaps = publisherGaps(words, publisher.transcript, opts).map { g in
      Candidate(startMs: g.startMs, endMs: g.endMs, source: .publisherGap, qualifies: publisher.verbatim && g.endMs - g.startMs >= opts.loneGapMinMs)
    }
  }
  let events = input.speech?.events ?? []
  let reads = cues.filter(\.strong).compactMap { sponsorRead(words, $0, handBacks, events, opts) }

  var breaks: [AdBreak] = []
  for group in mergeOverlapping(gaps + adChapters + reads) {
    let gap = group.first { $0.source == .publisherGap }
    let chapter = group.first { $0.source == .adChapter }
    let read = group.first { $0.source == .sponsorPhrase && $0.firm } ?? group.first { $0.source == .sponsorPhrase }
    // A gap alone is an aside or a cut passage unless the text is verbatim and the gap is long.
    if let gap, chapter == nil, read == nil, !gap.qualifies, cueIn(cues, words, gap.startMs, gap.endMs) == nil { continue }
    // Without a gap, the break opens at the earliest signal: a read opens on its cue's sentence, which can come after
    // the ad's first lines ("…the presenting sponsor"), or before a chapter's start where the model cut mid-sentence.
    let startMs = gap?.startMs ?? group.map(\.startMs).min()!
    let firmRead = read.flatMap { $0.firm ? $0 : nil }
    let endMs = (gap ?? firmRead ?? chapter ?? read)!.endMs
    let cue = cueIn(cues, words, startMs - 5_000, endMs)
    var sources: [AdSource] = []
    if gap != nil { sources.append(.publisherGap) }
    if read != nil || cue != nil { sources.append(.sponsorPhrase) }
    if chapter != nil { sources.append(.adChapter) }
    breaks.append(AdBreak(startMs: startMs, endMs: endMs, confidence: sources.count > 1 ? .high : .medium, sources: sources, cue: read?.cue ?? cue?.phrase))
  }

  let clamped = breaks
    .map { b in
      var b = b
      b.startMs = max(0, b.startMs)
      b.endMs = min(input.durationMs, b.endMs)
      return b
    }
    .filter { $0.endMs - $0.startMs >= opts.minBreakMs && $0.endMs - $0.startMs <= opts.maxBreakMs }
  return JS.stableSorted(clamped, by: \.startMs)
}

private func flatWords(_ t: NormalizedTranscript) -> [Word] {
  var out: [Word] = []
  out.reserveCapacity(t.wordCount)
  for s in t.segments {
    for w in s.words { out.append(Word(text: w.text, tok: normalizeToken(w.text), startMs: w.startMs, endMs: w.endMs)) }
  }
  return out
}

/// Every match of the patterns over the spoken words, located at the word it starts on (an index into `words`).
private func findCues(_ words: [Word], _ patterns: [NSRegularExpression], strong: Bool) -> [Cue] {
  var at: [Int] = []
  var text = ""
  // Offset of each token in `text`, for mapping a match back to its word. Tokens are ASCII, so an offset means the
  // same whether counted in JavaScript's code units, NSString's, or bytes.
  var offsets: [Int] = []
  for (k, w) in words.enumerated() where !w.tok.isEmpty {
    if !text.isEmpty { text += " " }
    at.append(k)
    offsets.append(text.utf8.count)
    text += w.tok
  }
  guard !at.isEmpty else { return [] }
  let ns = text as NSString
  var out: [Cue] = []
  for re in patterns {
    for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
      var lo = 0
      var hi = offsets.count - 1
      while lo < hi {
        let mid = (lo + hi + 1) >> 1
        if offsets[mid] <= m.range.location { lo = mid } else { hi = mid - 1 }
      }
      out.append(Cue(word: at[lo], strong: strong, phrase: ns.substring(with: m.range)))
    }
  }
  return JS.stableSorted(out, by: \.word)
}

private func cueIn(_ cues: [Cue], _ words: [Word], _ fromMs: Int, _ toMs: Int) -> Cue? {
  let inside = cues.filter { words[$0.word].startMs >= fromMs && words[$0.word].startMs < toMs }
  return inside.first(where: \.strong) ?? inside.first
}

/// Runs of speech the publisher's text does not have, at least `minGapMs` long.
private func publisherGaps(_ words: [Word], _ publisher: NormalizedTranscript, _ opts: AdOptions) -> [(startMs: Int, endMs: Int)] {
  let spoken = words.filter { !$0.tok.isEmpty }
  let ref = flatWords(publisher).map(\.tok).filter { !$0.isEmpty }
  if spoken.isEmpty || ref.isEmpty { return [] }
  var matched = [Bool](repeating: false, count: spoken.count)
  for pair in alignTokens(ref, spoken.map(\.tok)).pairs { matched[pair.hyp] = true }

  // Unmatched runs, joined across islands of a few matched words.
  var runs: [(Int, Int)] = []
  var j = 0
  while j < spoken.count {
    if matched[j] {
      j += 1
      continue
    }
    var end = j
    while end + 1 < spoken.count && !matched[end + 1] { end += 1 }
    if let last = runs.last, j - last.1 - 1 <= opts.maxIslandWords {
      runs[runs.count - 1].1 = end
    } else {
      runs.append((j, end))
    }
    j = end + 1
  }

  var out: [(startMs: Int, endMs: Int)] = []
  for (a, b) in runs {
    let first = spoken[a]
    let last = spoken[b]
    if last.endMs - first.startMs < opts.minGapMs { continue }
    let unmatched = (a...b).count { !matched[$0] }
    if Double(unmatched) / Double(b - a + 1) < opts.minUnmatchedShare { continue }
    out.append((first.startMs, resumeAt(last, b + 1 < spoken.count ? spoken[b + 1] : nil)))
  }
  return out
}

/// Where playback should resume after a break that ends with `last`: just before the next word, if it comes soon.
private func resumeAt(_ last: Word, _ next: Word?) -> Int {
  if let next, next.startMs - last.endMs <= 3_000 { return max(last.endMs, next.startMs - 100) }
  return last.endMs + 300
}

/// The sentence rule the read's edges use (`/[.!?…]["')\]]*$/`): `endsSentence` without the curly apostrophe among
/// the closers. The reference has the two rules apart, so the port does.
private func endsReadSentence(_ text: String) -> Bool {
  endsSentence(text, closers: ["\"", "'", ")", "]"])
}

/// `/music|jingle|sting/i`: the label holds one of the three words, in either case of the ASCII letters only.
/// Without the `u` flag JavaScript does not fold a character beyond ASCII onto an ASCII one, so a long s is no "s"
/// and a dotted capital I no "i", which Foundation's case-insensitive search would allow.
private func isSting(_ label: String) -> Bool {
  let folded = label.unicodeScalars.map { (0x41...0x5A).contains($0.value) ? $0.value + 0x20 : $0.value }
  return ["music", "jingle", "sting"].contains { needle in
    let n = needle.unicodeScalars.map(\.value)
    guard folded.count >= n.count else { return false }
    return (0...(folded.count - n.count)).contains { folded[$0..<($0 + n.count)].elementsEqual(n) }
  }
}

/// The extent of a sponsor read that a strong cue opens: from the start of the cue's sentence to the first hand-back
/// line, music sting, long pause, or the end of the recording after it. Nil when no end is found within `maxReadMs`;
/// a skip that might land in the middle of the episode is worse than none.
private func sponsorRead(_ words: [Word], _ cue: Cue, _ handBacks: Set<Int>, _ events: [EventTuple], _ opts: AdOptions) -> Candidate? {
  var s = cue.word
  // Back to the sentence start: the previous word ends a sentence, or a pause comes before this one.
  while s > 0 && !endsReadSentence(words[s - 1].text) && words[s].startMs - words[s - 1].endMs < 700 { s -= 1 }
  let start = words[s].startMs
  let limit = start + opts.maxReadMs
  let music = events.filter { isSting($0.label) && $0.startMs >= start + opts.minBreakMs && $0.startMs <= limit }

  var k = cue.word
  while k < words.count && words[k].startMs <= limit {
    let w = words[k]
    let next = k + 1 < words.count ? words[k + 1] : nil
    if handBacks.contains(k) {
      // Through the end of the hand-back sentence.
      var e = k
      while e + 1 < words.count && !endsReadSentence(words[e].text) && words[e + 1].startMs - words[e].endMs < 700 { e += 1 }
      return Candidate(startMs: start, endMs: resumeAt(words[e], e + 1 < words.count ? words[e + 1] : nil), source: .sponsorPhrase, cue: cue.phrase, firm: true)
    }
    if let sting = music.first(where: { $0.startMs >= w.endMs && (next == nil || $0.startMs < next!.startMs) }) {
      return Candidate(startMs: start, endMs: max(sting.endMs, w.endMs), source: .sponsorPhrase, cue: cue.phrase, firm: true)
    }
    // A post-roll read runs to the end of the recording; skipping it finishes the episode.
    if next == nil && w.endMs - start >= opts.minReadMs && w.endMs - start <= opts.maxPostrollMs {
      return Candidate(startMs: start, endMs: JS.maxSafeInteger, source: .sponsorPhrase, cue: cue.phrase, firm: true)
    }
    if let next, w.endMs - start >= opts.minReadMs && next.startMs - w.endMs >= opts.readEndPauseMs {
      return Candidate(startMs: start, endMs: resumeAt(w, next), source: .sponsorPhrase, cue: cue.phrase)
    }
    k += 1
  }
  return nil
}

private func mergeOverlapping(_ cands: [Candidate]) -> [[Candidate]] {
  let sorted = JS.stableSorted(cands, by: \.startMs)
  var groups: [[Candidate]] = []
  var end = 0
  for c in sorted {
    if !groups.isEmpty && c.startMs <= end + 2_000 {
      groups[groups.count - 1].append(c)
      end = max(end, c.endMs)
    } else {
      groups.append([c])
      end = c.endMs
    }
  }
  return groups
}
