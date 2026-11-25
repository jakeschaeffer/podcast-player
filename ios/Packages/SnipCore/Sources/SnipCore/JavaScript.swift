import Foundation

// SnipCore is a port of server/src/core, checked against contracts/golden. Where the TypeScript leans on something
// JavaScript does differently from Swift, the port calls one of these instead of the nearest Swift API, so each
// difference is written down once. contracts/golden/README.md lists them as porting traps; each has golden cases.

/// What JavaScript does where Swift's standard library would answer differently.
enum JS {
  /// `Number.MAX_SAFE_INTEGER`: the largest whole number a JavaScript number counts exactly, 2^53 - 1.
  static let maxSafeInteger = 9_007_199_254_740_991

  /// `Math.round`: the nearest whole number, a half going up (2.5 is 3, and -2.5 is -2). Swift's `rounded()`
  /// sends a half away from zero, and `(x + 0.5).rounded(.down)` is wrong just under a half.
  ///
  /// A JavaScript number can be far larger than an `Int`; a time beyond `maxSafeInteger` is held at it, which no
  /// recording comes near.
  static func round(_ x: Double) -> Int {
    let floor = x.rounded(.down)
    let rounded = x - floor >= 0.5 ? floor + 1 : floor
    let limit = Double(maxSafeInteger)
    return Int(min(max(rounded, -limit), limit))
  }

  /// What `String.prototype.trim` removes: the ECMAScript WhiteSpace and LineTerminator characters. Foundation's
  /// `.whitespacesAndNewlines` is a different set (it has U+0085 and lacks the byte order mark, U+FEFF).
  static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
    default: false
    }
  }

  /// `String.prototype.trim`.
  static func trim(_ s: String) -> String {
    let scalars = s.unicodeScalars
    guard let first = scalars.firstIndex(where: { !isWhitespace($0) }),
      let last = scalars.lastIndex(where: { !isWhitespace($0) })
    else { return "" }
    return String(scalars[first...last])
  }

  /// `===` on two strings: the same code units. Swift's `==` also calls two strings equal when they only look the
  /// same ("é" as one code point or as "e" plus a combining accent), which would merge two of a provider's speakers.
  static func equal(_ a: String, _ b: String) -> Bool {
    a.utf8.elementsEqual(b.utf8)
  }

  /// `===` on two values that are each a string or null.
  static func equal(_ a: String?, _ b: String?) -> Bool {
    switch (a, b) {
    case (nil, nil): true
    case let (a?, b?): equal(a, b)
    default: false
    }
  }

  /// `Array.prototype.sort` with a comparator that subtracts keys: ascending and stable. Swift's `sort` does not
  /// promise to keep equal elements in order.
  static func stableSorted<T>(_ items: [T], by key: (T) -> Int) -> [T] {
    items.enumerated()
      .sorted { a, b in
        let (ka, kb) = (key(a.element), key(b.element))
        return ka != kb ? ka < kb : a.offset < b.offset
      }
      .map(\.element)
  }
}
