import Foundation
import Testing

@testable import SnipCore

/// Reading contracts/golden and comparing answers with it exactly.
enum Golden {
  static let repoRoot = URL(filePath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()  // SnipCore
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()  // repo root

  /// A golden file, decoded. A raw word's time may be the string "NaN", "Infinity" or "-Infinity", which is how the
  /// files write what JSON cannot (contracts/golden/README.md).
  static func load<T: Decodable>(_ path: String, as type: T.Type = T.self) -> T {
    let decoder = JSONDecoder()
    decoder.nonConformingFloatDecodingStrategy = .convertFromString(positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")
    let file = repoRoot.appending(path: "contracts/golden").appending(path: path)
    return try! decoder.decode(type, from: Data(contentsOf: file))
  }

  /// The value as JSON bytes with sorted keys. Two values are the same answer only when these are equal: Swift's own
  /// `==` calls two strings equal when they merely look alike ("é" composed or decomposed), and the reference does
  /// not, so comparing with `==` alone would let such a difference through.
  static func bytes<T: Encodable>(_ value: T) -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try! encoder.encode(value)
  }
}

/// Expect `actual` to be `expected` to the byte, and say both when it is not.
func expectSame<T: Encodable>(_ actual: T, _ expected: T, _ context: @autoclosure () -> String = "", sourceLocation: SourceLocation = #_sourceLocation) {
  let (a, e) = (Golden.bytes(actual), Golden.bytes(expected))
  if a != e {
    Issue.record(
      "\(context())\n  expected: \(String(decoding: e, as: UTF8.self))\n  actual:   \(String(decoding: a, as: UTF8.self))",
      sourceLocation: sourceLocation)
  }
}

/// Every Unicode scalar value: what the files' exhaustive lists are checked against.
let everyScalar: [Unicode.Scalar] = (0...0x10FFFF).compactMap { Unicode.Scalar(UInt32($0)) }

/// A transcript as the golden files hold one, with the provider and model the TypeScript generators give it.
func transcript(_ api: ApiTranscript) -> NormalizedTranscript {
  NormalizedTranscript(api: api, provider: "test", model: "golden")
}
