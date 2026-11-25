import Foundation
import Testing

@testable import SnipCore

/// Replays every case in contracts/golden/transcript/normalize_v1.json against the Swift port.
struct NormalizeGoldenTests {
  struct File: Decodable {
    let version: String
    let defaultOptions: Options
    let normalize: [NormalizeCase]
    let normalizeInvalid: [InvalidCase]
    let endsSentence: [EndsSentenceCase]
    let sliceWords: [SliceGroup]
    let speakerTurns: [TurnGroup]
    let trimmedCodePoints: [UInt32]

    enum CodingKeys: String, CodingKey {
      case version, normalize
      case defaultOptions = "default_options"
      case normalizeInvalid = "normalize_invalid"
      case endsSentence = "ends_sentence"
      case sliceWords = "slice_words"
      case speakerTurns = "speaker_turns"
      case trimmedCodePoints = "trimmed_code_points"
    }
  }

  /// The options a case names; the rest keep their defaults, as `Partial<NormalizeOptions>` does.
  struct Options: Decodable, Sendable {
    var pauseSplitMs: Int?
    var softCapWords: Int?
    var hardCapWords: Int?
    var durationMs: Int?
    var relabelSpeakers: Bool?

    enum CodingKeys: String, CodingKey {
      case pauseSplitMs = "pause_split_ms"
      case softCapWords = "soft_cap_words"
      case hardCapWords = "hard_cap_words"
      case durationMs = "duration_ms"
      case relabelSpeakers = "relabel_speakers"
    }

    var options: NormalizeOptions {
      var o = NormalizeOptions()
      if let pauseSplitMs { o.pauseSplitMs = pauseSplitMs }
      if let softCapWords { o.softCapWords = softCapWords }
      if let hardCapWords { o.hardCapWords = hardCapWords }
      if let durationMs { o.durationMs = durationMs }
      if let relabelSpeakers { o.relabelSpeakers = relabelSpeakers }
      return o
    }
  }

  struct NormalizeCase: Decodable, Sendable, CustomTestStringConvertible {
    let name: String
    let raw: RawTranscript
    let options: Options
    let expect: NormalizedTranscript
    var testDescription: String { name }
  }

  struct InvalidCase: Decodable, Sendable, CustomTestStringConvertible {
    let name: String
    let options: Options
    var testDescription: String { name }
  }

  struct EndsSentenceCase: Decodable, Sendable, CustomTestStringConvertible {
    let text: String
    let expect: Bool
    var testDescription: String { text.debugDescription }
  }

  struct SliceGroup: Decodable, Sendable, CustomTestStringConvertible {
    struct Slice: Decodable, Sendable {
      let startWord: Int
      let endWord: Int
      let expect: [WordTuple]?
      let `throws`: Bool?

      enum CodingKeys: String, CodingKey {
        case expect, `throws`
        case startWord = "start_word"
        case endWord = "end_word"
      }
    }

    /// The name of a `normalize` case: the slices are taken from its expected transcript.
    let transcript: String
    let cases: [Slice]
    var testDescription: String { transcript }
  }

  struct TurnGroup: Decodable, Sendable, CustomTestStringConvertible {
    struct Range: Decodable, Sendable {
      let startWord: Int
      let endWord: Int
      let expect: [SpeakerTurn]

      enum CodingKeys: String, CodingKey {
        case expect
        case startWord = "start_word"
        case endWord = "end_word"
      }
    }

    let name: String
    let transcript: NormalizedTranscript
    let cases: [Range]
    var testDescription: String { name }
  }

  static let golden: File = Golden.load("transcript/normalize_v1.json")

  @Test func fileIsNormalizeV1() {
    #expect(Self.golden.version == normalizerVersion)
    #expect(Self.golden.defaultOptions.options == NormalizeOptions())
    #expect(Self.golden.defaultOptions.pauseSplitMs == NormalizeOptions().pauseSplitMs)
    #expect(Self.golden.defaultOptions.softCapWords == NormalizeOptions().softCapWords)
    #expect(Self.golden.defaultOptions.hardCapWords == NormalizeOptions().hardCapWords)
    #expect(Self.golden.normalize.count >= 50)
  }

  @Test(arguments: golden.normalize)
  func normalizes(_ c: NormalizeCase) throws {
    let actual = try normalize(c.raw, options: c.options.options)
    expectSame(actual, c.expect, c.name)
    #expect(actual == c.expect)
  }

  @Test(arguments: golden.normalizeInvalid)
  func rejectsCapsThatMakeNoSense(_ c: InvalidCase) {
    let o = c.options.options
    #expect(throws: TranscriptError.invalidCaps(softCapWords: o.softCapWords, hardCapWords: o.hardCapWords)) {
      try normalize(RawTranscript(provider: "test", model: "fixture", language: "eng", words: []), options: o)
    }
  }

  @Test(arguments: golden.endsSentence)
  func endsSentence(_ c: EndsSentenceCase) {
    #expect(SnipCore.endsSentence(c.text) == c.expect)
  }

  @Test(arguments: golden.sliceWords)
  func slicesWords(_ group: SliceGroup) throws {
    let t = try #require(Self.golden.normalize.first { $0.name == group.transcript }).expect
    #expect(!group.cases.isEmpty)
    for c in group.cases {
      let range = "[\(c.startWord), \(c.endWord))"
      if c.throws == true {
        #expect(throws: TranscriptError.wordRangeOutOfBounds(startWord: c.startWord, endWord: c.endWord, wordCount: t.wordCount), "\(range)") {
          try sliceWords(t, c.startWord, c.endWord)
        }
      } else {
        expectSame(try sliceWords(t, c.startWord, c.endWord), try #require(c.expect), range)
      }
    }
  }

  @Test(arguments: golden.speakerTurns)
  func groupsSpeakerTurns(_ group: TurnGroup) {
    #expect(!group.cases.isEmpty)
    for c in group.cases {
      expectSame(speakerTurns(group.transcript, c.startWord, c.endWord), c.expect, "[\(c.startWord), \(c.endWord))")
    }
  }

  /// The file lists every code point JavaScript's `trim` removes; the port's own list must be that one, whole.
  @Test func trimsExactlyWhatJavaScriptTrims() {
    let trimmed = Set(Self.golden.trimmedCodePoints)
    #expect(trimmed.count == 25)
    let differing = everyScalar.filter { JS.isWhitespace($0) != trimmed.contains($0.value) }
    #expect(differing.isEmpty, "\(differing.map { String($0.value, radix: 16) })")
    #expect(JS.trim("\u{FEFF} a b\u{00A0}\n") == "a b")
    #expect(JS.trim("\u{0085}a\u{200B}") == "\u{0085}a\u{200B}")
    #expect(JS.trim(" \t ") == "")
  }

  /// `Math.round` on the values where Swift's own rounding differs.
  @Test func roundsLikeMathRound() {
    #expect(JS.round(2.5) == 3)
    #expect(JS.round(-2.5) == -2)
    #expect(JS.round(-0.5) == 0)
    #expect(JS.round(0.5) == 1)
    #expect(JS.round(0.49999999999999994) == 0)
    #expect(JS.round(-2.51) == -3)
    #expect(JS.round(1e300) == JS.maxSafeInteger)
    #expect(JS.round(-1e300) == -JS.maxSafeInteger)
  }
}
