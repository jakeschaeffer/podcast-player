import Foundation

// A port of `normalizeToken` in server/src/core/transcript/tokens.ts, checked against
// contracts/golden/transcript/align_v1.json. Change the TypeScript first, never this port alone.

/// `normalizeToken` (server/src/core/transcript/tokens.ts): token normalization shared by alignment, comparison, and
/// matching: lowercase, ASCII apostrophes, letters and digits only.
///
/// The TypeScript lowercases the whole string and then keeps `[a-z0-9']`, so the only characters beyond ASCII that
/// survive are the two whose lowercase holds an ASCII letter: the dotted capital I (U+0130, "i" plus a combining
/// dot) and the Kelvin sign (U+212A, "k"). They are named here instead of calling `lowercased()`, so the answer
/// does not depend on the Unicode tables of the system the app runs on; the golden file lists every code point that
/// survives.
public func normalizeToken(_ s: String) -> String {
  var out: [UInt8] = []
  out.reserveCapacity(s.utf8.count)
  for scalar in s.unicodeScalars {
    switch scalar.value {
    case 0x41...0x5A: out.append(UInt8(scalar.value) + 0x20)  // A-Z
    case 0x61...0x7A, 0x30...0x39, 0x27: out.append(UInt8(scalar.value))  // a-z, 0-9, '
    case 0x2018, 0x2019: out.append(0x27)  // curly apostrophes
    case 0x0130: out.append(0x69)  // İ → i
    case 0x212A: out.append(0x6B)  // K → k
    default: break
    }
  }
  // Apostrophes are kept inside a word ("don't") and dropped around it ("'tis", "dogs'").
  var slice = out[...]
  while slice.first == 0x27 { slice = slice.dropFirst() }
  while slice.last == 0x27 { slice = slice.dropLast() }
  return String(decoding: slice, as: UTF8.self)
}
