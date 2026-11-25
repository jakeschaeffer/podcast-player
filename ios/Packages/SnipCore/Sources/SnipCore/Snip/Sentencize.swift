import Foundation

// A port of server/src/core/snip/sentencize.ts (sentencizer_v1), checked against the `sentencize` cases of
// contracts/golden/selection/select_v2.json and against contracts/golden/selection/sentencizer_v1.json.
// Change the TypeScript first, under a new version, never this port alone.

/// `SENTENCIZER_VERSION` (server/src/core/snip/sentencize.ts): the version of the sentence rules; evals and the model
/// prompt depend on it.
public let sentencizerVersion = "sentencizer_v1"

/// `Sentence` (server/src/core/snip/sentencize.ts): a run of words a model may pick by its `id`.
public struct Sentence: Sendable, Equatable, Codable {
  /// Position in the returned list, used as the id a model may pick.
  public var id: Int
  public var speaker: String?
  /// Global word range `[startWord, endWord)`.
  public var startWord: Int
  public var endWord: Int
  public var startMs: Int
  public var endMs: Int
  public var text: String
  public var wordCount: Int

  public init(id: Int, speaker: String?, startWord: Int, endWord: Int, startMs: Int, endMs: Int, text: String, wordCount: Int) {
    self.id = id
    self.speaker = speaker
    self.startWord = startWord
    self.endWord = endWord
    self.startMs = startMs
    self.endMs = endMs
    self.text = text
    self.wordCount = wordCount
  }

  enum CodingKeys: String, CodingKey {
    case id, speaker, text
    case startWord = "start_word"
    case endWord = "end_word"
    case startMs = "start_ms"
    case endMs = "end_ms"
    case wordCount = "word_count"
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(Int.self, forKey: .id)
    speaker = try c.decodeIfPresent(String.self, forKey: .speaker)
    startWord = try c.decode(Int.self, forKey: .startWord)
    endWord = try c.decode(Int.self, forKey: .endWord)
    startMs = try c.decode(Int.self, forKey: .startMs)
    endMs = try c.decode(Int.self, forKey: .endMs)
    text = try c.decode(String.self, forKey: .text)
    wordCount = try c.decode(Int.self, forKey: .wordCount)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(speaker, forKey: .speaker)  // `string | null`: always present
    try c.encode(startWord, forKey: .startWord)
    try c.encode(endWord, forKey: .endWord)
    try c.encode(startMs, forKey: .startMs)
    try c.encode(endMs, forKey: .endMs)
    try c.encode(text, forKey: .text)
    try c.encode(wordCount, forKey: .wordCount)
  }
}

/// `SentencizeOptions` (server/src/core/snip/sentencize.ts).
public struct SentencizeOptions: Sendable, Equatable {
  /// Only words with `endMs > fromMs` are considered. A `Double` because callers pass fractions of a duration.
  public var fromMs: Double?
  /// Only words with `startMs < toMs` are considered.
  public var toMs: Double?
  public var pauseSplitMs: Int
  /// Same-speaker fragments shorter than this merge into their predecessor.
  public var minWords: Int

  public init(fromMs: Double? = nil, toMs: Double? = nil, pauseSplitMs: Int = 700, minWords: Int = 3) {
    self.fromMs = fromMs
    self.toMs = toMs
    self.pauseSplitMs = pauseSplitMs
    self.minWords = minWords
  }
}

private struct FlatWord {
  var index: Int
  var speaker: String?
  var w: WordTuple
}

/// How far beyond the requested range words are read, on both sides.
private let marginMs = 120_000.0

/// `sentencize` (server/src/core/snip/sentencize.ts): split a transcript (or a time range of it) into sentences,
/// deterministically:
/// a new sentence starts on a speaker change, on a pause of 700 ms or more, or after a word that ends
/// a sentence. Same-speaker fragments shorter than `minWords` are merged into their predecessor;
/// a short interjection by another speaker stays separate because it matters for boundary choice.
public func sentencize(_ t: NormalizedTranscript, _ opts: SentencizeOptions = SentencizeOptions()) -> [Sentence] {
  let pause = opts.pauseSplitMs
  let minWords = opts.minWords
  let from = opts.fromMs ?? -.infinity
  let to = opts.toMs ?? .infinity

  // Sentencize a margin around the requested range so a boundary never cuts a sentence into a
  // fragment, then keep only the sentences that overlap the range.
  let lo = from - marginMs
  let hi = to + marginMs
  var flat: [FlatWord] = []
  for s in t.segments {
    if Double(s.endMs) <= lo || Double(s.startMs) >= hi { continue }
    for (i, w) in s.words.enumerated() where Double(w.endMs) > lo && Double(w.startMs) < hi {
      flat.append(FlatWord(index: s.firstWord + i, speaker: s.speaker, w: w))
    }
  }

  var groups: [[FlatWord]] = []
  var current: [FlatWord] = []
  for (i, fw) in flat.enumerated() {
    if i > 0 {
      let prev = flat[i - 1]
      let startNew =
        !JS.equal(fw.speaker, prev.speaker) || fw.w.startMs - prev.w.endMs >= pause || endsSentence(prev.w.text)
        || fw.index != prev.index + 1
      if startNew && !current.isEmpty {
        groups.append(current)
        current = []
      }
    }
    current.append(fw)
  }
  if !current.isEmpty { groups.append(current) }

  // Merge short same-speaker fragments backwards when they are contiguous and not separated by a long pause.
  var merged: [[FlatWord]] = []
  for g in groups {
    var joins = false
    if let last = merged.last, let lastWord = last.last {
      joins =
        g.count < minWords
        && JS.equal(g[0].speaker, last[0].speaker)
        && g[0].index == lastWord.index + 1
        && g[0].w.startMs - lastWord.w.endMs < pause
    }
    if joins {
      merged[merged.count - 1].append(contentsOf: g)
    } else {
      merged.append(g)
    }
  }

  let inRange = merged.filter { g in Double(g[g.count - 1].w.endMs) > from && Double(g[0].w.startMs) < to }
  return inRange.enumerated().map { id, g in
    let first = g[0]
    let last = g[g.count - 1]
    return Sentence(
      id: id, speaker: first.speaker, startWord: first.index, endWord: last.index + 1, startMs: first.w.startMs,
      endMs: last.w.endMs, text: g.map(\.w.text).joined(separator: " "), wordCount: g.count)
  }
}
