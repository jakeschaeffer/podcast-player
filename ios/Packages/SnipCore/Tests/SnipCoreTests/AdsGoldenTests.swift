import Foundation
import Testing

@testable import SnipCore

/// Replays every case in contracts/golden/ads/ads_v3.json against the Swift port.
struct AdsGoldenTests {
  struct File: Decodable {
    let version: String
    let defaultOptions: Options
    let transcripts: [String: ApiTranscript]
    let cases: [Case]

    enum CodingKeys: String, CodingKey {
      case version, transcripts, cases
      case defaultOptions = "default_options"
    }
  }

  /// The options a case names; the rest keep their defaults, as `Partial<AdOptions>` does.
  struct Options: Decodable, Sendable {
    var minGapMs: Int?
    var loneGapMinMs: Int?
    var maxIslandWords: Int?
    var minUnmatchedShare: Double?
    var minBreakMs: Int?
    var maxBreakMs: Int?
    var maxReadMs: Int?
    var maxPostrollMs: Int?
    var readEndPauseMs: Int?
    var minReadMs: Int?

    enum CodingKeys: String, CodingKey {
      case minGapMs = "min_gap_ms"
      case loneGapMinMs = "lone_gap_min_ms"
      case maxIslandWords = "max_island_words"
      case minUnmatchedShare = "min_unmatched_share"
      case minBreakMs = "min_break_ms"
      case maxBreakMs = "max_break_ms"
      case maxReadMs = "max_read_ms"
      case maxPostrollMs = "max_postroll_ms"
      case readEndPauseMs = "read_end_pause_ms"
      case minReadMs = "min_read_ms"
    }

    var options: AdOptions {
      var o = AdOptions()
      if let minGapMs { o.minGapMs = minGapMs }
      if let loneGapMinMs { o.loneGapMinMs = loneGapMinMs }
      if let maxIslandWords { o.maxIslandWords = maxIslandWords }
      if let minUnmatchedShare { o.minUnmatchedShare = minUnmatchedShare }
      if let minBreakMs { o.minBreakMs = minBreakMs }
      if let maxBreakMs { o.maxBreakMs = maxBreakMs }
      if let maxReadMs { o.maxReadMs = maxReadMs }
      if let maxPostrollMs { o.maxPostrollMs = maxPostrollMs }
      if let readEndPauseMs { o.readEndPauseMs = readEndPauseMs }
      if let minReadMs { o.minReadMs = minReadMs }
      return o
    }

    /// True when the file states every option, as `default_options` must.
    var isComplete: Bool {
      minGapMs != nil && loneGapMinMs != nil && maxIslandWords != nil && minUnmatchedShare != nil && minBreakMs != nil
        && maxBreakMs != nil && maxReadMs != nil && maxPostrollMs != nil && readEndPauseMs != nil && minReadMs != nil
    }
  }

  struct Case: Decodable, Sendable, CustomTestStringConvertible {
    struct Input: Decodable, Sendable {
      struct Publisher: Decodable, Sendable {
        let transcript: String
        let verbatim: Bool
      }

      /// Names of entries in the file's `transcripts`.
      let speech: String?
      let publisher: Publisher?
      let chapters: [AdChapter]?
      let durationMs: Int

      enum CodingKeys: String, CodingKey {
        case speech, publisher, chapters
        case durationMs = "duration_ms"
      }
    }

    let name: String
    let input: Input
    let options: Options
    let expect: [AdBreak]
    var testDescription: String { name }
  }

  static let golden: File = Golden.load("ads/ads_v3.json")

  @Test func fileIsAdsV3() {
    #expect(Self.golden.version == adDetectorVersion)
    #expect(Self.golden.defaultOptions.isComplete)
    #expect(Self.golden.defaultOptions.options == AdOptions())
    // Had a default differed, overriding with the file's would have hidden it; start from different values too.
    var other = AdOptions(
      minGapMs: 1, loneGapMinMs: 1, maxIslandWords: 1, minUnmatchedShare: 0, minBreakMs: 1, maxBreakMs: 1, maxReadMs: 1,
      maxPostrollMs: 1, readEndPauseMs: 1, minReadMs: 1)
    let d = Self.golden.defaultOptions
    other = AdOptions(
      minGapMs: d.minGapMs ?? other.minGapMs, loneGapMinMs: d.loneGapMinMs ?? other.loneGapMinMs,
      maxIslandWords: d.maxIslandWords ?? other.maxIslandWords, minUnmatchedShare: d.minUnmatchedShare ?? other.minUnmatchedShare,
      minBreakMs: d.minBreakMs ?? other.minBreakMs, maxBreakMs: d.maxBreakMs ?? other.maxBreakMs, maxReadMs: d.maxReadMs ?? other.maxReadMs,
      maxPostrollMs: d.maxPostrollMs ?? other.maxPostrollMs, readEndPauseMs: d.readEndPauseMs ?? other.readEndPauseMs,
      minReadMs: d.minReadMs ?? other.minReadMs)
    #expect(other == AdOptions())
    #expect(Self.golden.cases.count >= 270)
  }

  @Test(arguments: golden.cases)
  func detects(_ c: Case) throws {
    func named(_ name: String) throws -> NormalizedTranscript {
      transcript(try #require(Self.golden.transcripts[name], "no transcript named \(name)"))
    }
    let input = AdInput(
      speech: try c.input.speech.map(named),
      publisher: try c.input.publisher.map { AdInput.Publisher(transcript: try named($0.transcript), verbatim: $0.verbatim) },
      chapters: c.input.chapters,
      durationMs: c.input.durationMs)
    let actual = detectAds(input, options: c.options.options)
    expectSame(actual, c.expect, c.name)
    #expect(actual == c.expect)
  }
}
