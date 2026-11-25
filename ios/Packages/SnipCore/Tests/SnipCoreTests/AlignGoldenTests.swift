import Foundation
import Testing

@testable import SnipCore

/// Replays every case in contracts/golden/transcript/align_v1.json against the Swift port.
struct AlignGoldenTests {
  struct File: Decodable {
    let version: String
    let defaultBand: Int
    let normalizeToken: [TokenCase]
    /// `[code point, token]` for every code point whose token is not empty.
    let survivingCodePoints: [Surviving]
    let apostropheCodePoints: [UInt32]
    let alignTokens: [AlignCase]

    enum CodingKeys: String, CodingKey {
      case version
      case defaultBand = "default_band"
      case normalizeToken = "normalize_token"
      case survivingCodePoints = "surviving_code_points"
      case apostropheCodePoints = "apostrophe_code_points"
      case alignTokens = "align_tokens"
    }
  }

  struct TokenCase: Decodable, Sendable, CustomTestStringConvertible {
    let text: String
    let expect: String
    var testDescription: String { text.debugDescription }
  }

  struct Surviving: Decodable {
    let codePoint: UInt32
    let token: String

    init(from decoder: Decoder) throws {
      var c = try decoder.unkeyedContainer()
      codePoint = try c.decode(UInt32.self)
      token = try c.decode(String.self)
    }
  }

  struct AlignCase: Decodable, Sendable, CustomTestStringConvertible {
    let name: String
    let ref: [String]
    let hyp: [String]
    let band: Int?
    let expect: Alignment
    var testDescription: String { name }
  }

  static let golden: File = Golden.load("transcript/align_v1.json")

  @Test func fileIsAlignV1() {
    #expect(Self.golden.version == "align_v1")
    #expect(Self.golden.defaultBand == 600)
    #expect(Self.golden.alignTokens.count >= 100)
    #expect(Self.golden.alignTokens.contains { $0.band == nil })
  }

  @Test(arguments: golden.normalizeToken)
  func normalizesTokens(_ c: TokenCase) {
    expectSame(normalizeToken(c.text), c.expect, c.text.debugDescription)
  }

  /// The file lists every code point that survives on its own; every other one must give the empty token.
  @Test func keepsExactlyTheCodePointsJavaScriptKeeps() {
    let surviving = Dictionary(uniqueKeysWithValues: Self.golden.survivingCodePoints.map { ($0.codePoint, $0.token) })
    #expect(surviving.count == 64)
    let differing = everyScalar.filter { !JS.equal(normalizeToken(String($0)), surviving[$0.value] ?? "") }
    #expect(differing.isEmpty, "\(differing.map { String($0.value, radix: 16) })")
  }

  /// And every code point that becomes an apostrophe inside a word.
  @Test func foldsExactlyTheApostrophesJavaScriptFolds() {
    let apostrophes = Set(Self.golden.apostropheCodePoints)
    #expect(apostrophes == [0x27, 0x2018, 0x2019])
    let differing = everyScalar.filter { scalar in
      var s = String.UnicodeScalarView()
      s.append("a")
      s.append(scalar)
      s.append("b")
      return JS.equal(normalizeToken(String(s)), "a'b") != apostrophes.contains(scalar.value)
    }
    #expect(differing.isEmpty, "\(differing.map { String($0.value, radix: 16) })")
  }

  @Test(arguments: golden.alignTokens)
  func aligns(_ c: AlignCase) {
    let actual = c.band.map { alignTokens(c.ref, c.hyp, band: $0) } ?? alignTokens(c.ref, c.hyp)
    expectSame(actual, c.expect, c.name)
    #expect(actual == c.expect)
  }
}
