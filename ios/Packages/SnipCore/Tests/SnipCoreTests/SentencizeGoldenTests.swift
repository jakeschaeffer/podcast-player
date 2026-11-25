import Foundation
import Testing

@testable import SnipCore

/// Replays the sentence cases of contracts/golden/selection: sentencizer_v1.json, and the `sentencize` part of
/// select_v2.json. That file's `select` and `word_range` cases belong to the selection port and are not read here.
struct SentencizeGoldenTests {
  struct File: Decodable {
    /// sentencizer_v1.json calls it `version`; select_v2.json, whose version is the selector's, `sentencizer`.
    let version: String
    let sentencizer: String?
    let transcripts: [String: ApiTranscript]
    let sentencize: [Case]
  }

  struct Options: Decodable, Sendable {
    var fromMs: Double?
    var toMs: Double?
    var pauseSplitMs: Int?
    var minWords: Int?

    enum CodingKeys: String, CodingKey {
      case fromMs = "from_ms"
      case toMs = "to_ms"
      case pauseSplitMs = "pause_split_ms"
      case minWords = "min_words"
    }

    var options: SentencizeOptions {
      var o = SentencizeOptions(fromMs: fromMs, toMs: toMs)
      if let pauseSplitMs { o.pauseSplitMs = pauseSplitMs }
      if let minWords { o.minWords = minWords }
      return o
    }
  }

  struct Case: Decodable, Sendable, CustomTestStringConvertible {
    let transcript: String
    let options: Options
    let expect: [Sentence]

    var testDescription: String {
      let o = [
        options.fromMs.map { "from \($0)" }, options.toMs.map { "to \($0)" }, options.pauseSplitMs.map { "pause \($0)" },
        options.minWords.map { "min words \($0)" },
      ].compactMap { $0 }
      return o.isEmpty ? transcript : "\(transcript), \(o.joined(separator: ", "))"
    }
  }

  static let own: File = Golden.load("selection/sentencizer_v1.json")
  static let selection: File = Golden.load("selection/select_v2.json")

  @Test func filesAreSentencizerV1() {
    #expect(Self.own.version == sentencizerVersion)
    #expect(Self.selection.sentencizer == sentencizerVersion)
    #expect(Self.own.sentencize.count >= 70)
    #expect(Self.selection.sentencize.count == 10)
    // Fractions of a millisecond in the options are part of the contract: select_v2.json has them.
    #expect(Self.selection.sentencize.contains { ($0.options.fromMs ?? 0).rounded() != ($0.options.fromMs ?? 0) })
  }

  @Test(arguments: own.sentencize)
  func sentencizes(_ c: Case) throws {
    let t = transcript(try #require(Self.own.transcripts[c.transcript]))
    let actual = sentencize(t, c.options.options)
    expectSame(actual, c.expect, c.testDescription)
    #expect(actual == c.expect)
  }

  @Test(arguments: selection.sentencize)
  func sentencizesTheSelectionTranscripts(_ c: Case) throws {
    let t = transcript(try #require(Self.selection.transcripts[c.transcript]))
    let actual = sentencize(t, c.options.options)
    expectSame(actual, c.expect, c.testDescription)
    #expect(actual == c.expect)
  }
}
