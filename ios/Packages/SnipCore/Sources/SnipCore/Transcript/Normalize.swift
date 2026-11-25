import Foundation

// A port of server/src/core/transcript/normalize.ts (normalize_v1), checked against
// contracts/golden/transcript/normalize_v1.json. The phone transcribes audio itself on the build with no server
// (docs/store-app-plan.md) and must store the segments the server would. Change the TypeScript first, under a new
// version, never this port alone.

/// `NORMALIZER_VERSION` (server/src/core/transcript/normalize.ts): the version of the segmentation rules, recorded
/// alongside evals so results stay comparable.
public let normalizerVersion = "normalize_v1"

/// `NormalizeOptions` (server/src/core/transcript/normalize.ts). Its defaults are `DEFAULT_NORMALIZE_OPTIONS`; where
/// the TypeScript takes a partial object, give the initializer only what differs.
public struct NormalizeOptions: Sendable, Equatable {
  /// A silence at least this long starts a new segment.
  public var pauseSplitMs: Int
  /// Once a segment has this many words, the next sentence end closes it.
  public var softCapWords: Int
  /// A segment never exceeds this many words.
  public var hardCapWords: Int
  /// When known, no word may end after this.
  public var durationMs: Int?
  /// Relabel provider speaker ids to S1, S2… (default). False keeps the labels given, e.g. names from publisher text.
  public var relabelSpeakers: Bool

  public init(pauseSplitMs: Int = 700, softCapWords: Int = 40, hardCapWords: Int = 60, durationMs: Int? = nil, relabelSpeakers: Bool = true) {
    self.pauseSplitMs = pauseSplitMs
    self.softCapWords = softCapWords
    self.hardCapWords = hardCapWords
    self.durationMs = durationMs
    self.relabelSpeakers = relabelSpeakers
  }
}

/// Where `normalize` and `sliceWords` (server/src/core/transcript/normalize.ts) throw.
public enum TranscriptError: Error, Equatable, Sendable {
  /// `normalize: require 1 <= soft_cap_words <= hard_cap_words`.
  case invalidCaps(softCapWords: Int, hardCapWords: Int)
  /// `sliceWords`' RangeError: the range is not inside `0...wordCount`, or ends before it starts.
  case wordRangeOutOfBounds(startWord: Int, endWord: Int, wordCount: Int)
}

/// `endsSentence` (server/src/core/transcript/normalize.ts): the text ends in `.`, `!`, `?` or `…`, with any closing quotes and brackets after it
/// (`/[.!?…][’'")\]]*$/u`).
///
/// Written out instead of handed to a regular expression engine: Foundation's `$` also matches before a final
/// line end, JavaScript's does not. It reads code points, as the `u` flag does, so an accent after the full stop
/// is not swallowed into it the way Swift's `Character` would.
public func endsSentence(_ text: String) -> Bool {
  endsSentence(text, closers: ["\u{2019}", "'", "\"", ")", "]"])
}

/// The rule behind `endsSentence`, with the closing characters given: ad detection has its own list.
func endsSentence(_ text: String, closers: Set<Unicode.Scalar>) -> Bool {
  var scalars = text.unicodeScalars[...]
  while let last = scalars.last, closers.contains(last) { scalars = scalars.dropLast() }
  guard let last = scalars.last else { return false }
  return last == "." || last == "!" || last == "?" || last == "\u{2026}"
}

/// A word after rule 1: trimmed, with whole-millisecond times.
private struct CleanWord {
  var text: String
  var startMs: Int
  var endMs: Int
  var speaker: String?
}

/// `normalize` (server/src/core/transcript/normalize.ts): turn a provider's raw words into the immutable segment form.
///
/// Pure and deterministic: the same input always yields the same output. Rules, in order:
/// 1. Drop empty tokens and tokens without finite timings; round timings to integer milliseconds.
/// 2. Order words by start time (stable), then clamp so no word starts before the previous one ends
///    and no word ends before it starts or after the asset's duration.
/// 3. Relabel speakers S1, S2… in order of first appearance; a transcript without speakers has nil.
/// 4. Start a new segment on a speaker change, on a pause of `pauseSplitMs` or more, when the segment
///    reached `hardCapWords`, or when it reached `softCapWords` and the previous word ended a sentence.
/// 5. Assign global word indices in that order, once.
public func normalize(_ raw: RawTranscript, options opts: NormalizeOptions = NormalizeOptions()) throws -> NormalizedTranscript {
  if opts.softCapWords < 1 || opts.hardCapWords < opts.softCapWords {
    throw TranscriptError.invalidCaps(softCapWords: opts.softCapWords, hardCapWords: opts.hardCapWords)
  }

  let words = cleanWords(raw.words, durationMs: opts.durationMs)
  var relabeled: [[UInt8]: String] = [:]
  /// A provider's label as stored: none and the empty label are no speaker; the rest become S1, S2… unless kept.
  func speakerOf(_ label: String?) -> String? {
    guard let label, !label.isEmpty else { return nil }
    guard opts.relabelSpeakers else { return label }
    // Keyed by the label's bytes: two labels are one speaker only when they are the same string to JavaScript.
    let key = Array(label.utf8)
    if let known = relabeled[key] { return known }
    let made = "S\(relabeled.count + 1)"
    relabeled[key] = made
    return made
  }

  var segments: [Segment] = []
  var previous: CleanWord?
  for w in words {
    let speaker = speakerOf(w.speaker)
    let startNew: Bool
    if let current = segments.last, let previous {
      startNew =
        !JS.equal(speaker, current.speaker)
        || w.startMs - previous.endMs >= opts.pauseSplitMs
        || current.words.count >= opts.hardCapWords
        || (current.words.count >= opts.softCapWords && endsSentence(previous.text))
    } else {
      startNew = true
    }
    if startNew {
      let firstWord = segments.last.map { $0.firstWord + $0.words.count } ?? 0
      segments.append(Segment(idx: segments.count, startMs: w.startMs, endMs: w.endMs, speaker: speaker, firstWord: firstWord, text: "", words: []))
    }
    segments[segments.count - 1].words.append(WordTuple(w.startMs, w.endMs, w.text))
    segments[segments.count - 1].endMs = w.endMs
    previous = w
  }
  for i in segments.indices { segments[i].text = segments[i].words.map(\.text).joined(separator: " ") }

  // Events are rounded like words but not clamped: one may start before zero or run past the last word.
  var events: [EventTuple] = []
  for e in raw.events {
    let label = JS.trim(e.label)
    guard !label.isEmpty, e.startMs.isFinite, e.endMs.isFinite else { continue }
    let start = JS.round(e.startMs)
    events.append(EventTuple(start, max(start, JS.round(e.endMs)), label))
  }
  // By start, then end; two events with both equal keep the provider's order.
  events = JS.stableSorted(JS.stableSorted(events, by: \.endMs), by: \.startMs)

  return NormalizedTranscript(provider: raw.provider, model: raw.model, language: raw.language, wordCount: words.count, segments: segments, events: events)
}

private func cleanWords(_ input: [RawWord], durationMs: Int?) -> [CleanWord] {
  var words: [CleanWord] = []
  for w in input {
    let text = JS.trim(w.text)
    if text.isEmpty || !w.startMs.isFinite || !w.endMs.isFinite { continue }
    words.append(CleanWord(text: text, startMs: JS.round(w.startMs), endMs: JS.round(w.endMs), speaker: w.speaker))
  }
  // Stable, so equal start times keep provider order.
  words = JS.stableSorted(words, by: \.startMs)
  var previousEnd = 0
  for i in words.indices {
    if words[i].startMs < previousEnd { words[i].startMs = previousEnd }
    if words[i].endMs < words[i].startMs { words[i].endMs = words[i].startMs }
    if let durationMs {
      if words[i].startMs > durationMs { words[i].startMs = durationMs }
      if words[i].endMs > durationMs { words[i].endMs = durationMs }
    }
    previousEnd = words[i].endMs
  }
  return words
}

/// `sliceWords` (server/src/core/transcript/normalize.ts): words of `t` with global index in `[startWord, endWord)`,
/// in order. Used to materialize snip excerpts.
public func sliceWords(_ t: NormalizedTranscript, _ startWord: Int, _ endWord: Int) throws -> [WordTuple] {
  guard startWord >= 0, endWord <= t.wordCount, startWord <= endWord else {
    throw TranscriptError.wordRangeOutOfBounds(startWord: startWord, endWord: endWord, wordCount: t.wordCount)
  }
  var out: [WordTuple] = []
  for s in t.segments {
    let segEnd = s.firstWord + s.words.count
    if segEnd <= startWord { continue }
    if s.firstWord >= endWord { break }
    let from = max(0, startWord - s.firstWord)
    let to = min(s.words.count, endWord - s.firstWord)
    if from < to { out.append(contentsOf: s.words[from..<to]) }
  }
  return out
}

/// `SpeakerTurn` (server/src/core/transcript/normalize.ts): one speaker's run of words inside a range, for showing
/// who said what.
public struct SpeakerTurn: Sendable, Equatable, Codable {
  public var speaker: String?
  public var text: String

  public init(speaker: String?, text: String) {
    self.speaker = speaker
    self.text = text
  }

  enum CodingKeys: String, CodingKey { case speaker, text }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    speaker = try c.decodeIfPresent(String.self, forKey: .speaker)
    text = try c.decode(String.self, forKey: .text)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(speaker, forKey: .speaker)  // `string | null`: always present
    try c.encode(text, forKey: .text)
  }
}

/// `speakerTurns` (server/src/core/transcript/normalize.ts): the words in `[startWord, endWord)` grouped into turns: consecutive segments by the same speaker run together,
/// and a new turn starts where the speaker changes. Without speaker labels the whole range is one turn.
///
/// Unlike `sliceWords` it takes any range: one outside the transcript, or backwards, gives fewer turns or none.
public func speakerTurns(_ t: NormalizedTranscript, _ startWord: Int, _ endWord: Int) -> [SpeakerTurn] {
  var turns: [SpeakerTurn] = []
  for s in t.segments {
    let segEnd = s.firstWord + s.words.count
    if segEnd <= startWord { continue }
    if s.firstWord >= endWord { break }
    let from = max(0, startWord - s.firstWord)
    let to = min(s.words.count, endWord - s.firstWord)
    // JavaScript's `slice` gives nothing for a backwards range; a Swift range would trap.
    guard from < to else { continue }
    let text = s.words[from..<to].map(\.text).joined(separator: " ")
    if let last = turns.last, JS.equal(last.speaker, s.speaker) {
      turns[turns.count - 1].text += " \(text)"
    } else {
      turns.append(SpeakerTurn(speaker: s.speaker, text: text))
    }
  }
  return turns
}
