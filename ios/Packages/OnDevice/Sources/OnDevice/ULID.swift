import Foundation

/// Ids like the server's (`server/src/lib/ids.ts`): 26 characters of Crockford base32, 48 bits of Unix ms then 80
/// random bits, so ids sort by when they were made. The server's episode cursor and its Up next tie-breaks compare
/// ids, which is why the phone makes the same kind.
///
/// Unlike the server's, these never go backwards: two ids made in the same millisecond (a whole feed's episodes are
/// inserted in one) differ by one in the random part, so they sort in the order they were made.
struct ULIDGenerator {
  private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ".utf8)
  private var last: UInt128 = 0

  mutating func next(nowMs: Int) -> String {
    let time = UInt128(UInt64(max(0, nowMs)) & 0xFFFF_FFFF_FFFF)
    let random = (UInt128(UInt16.random(in: .min ... .max)) << 64) | UInt128(UInt64.random(in: .min ... .max))
    var value = (time << 80) | random
    if value >> 80 <= last >> 80 { value = last &+ 1 }
    last = value
    return Self.encode(value)
  }

  static func encode(_ value: UInt128) -> String {
    var bytes = [UInt8](repeating: 0, count: 26)
    for i in 0..<26 {
      // 26 characters hold 130 bits; the first carries only the top three of the 128.
      bytes[i] = alphabet[Int((value >> UInt128(125 - 5 * i)) & 31)]
    }
    return String(decoding: bytes, as: UTF8.self)
  }
}
