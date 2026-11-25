import Foundation

// A port of server/src/core/transcript/align.ts, checked against contracts/golden/transcript/align_v1.json.
// Change the TypeScript first, never this port alone.
//
// Word-sequence alignment between two transcripts of the same recording. Pure; shared by the transcription eval
// and ad detection.

/// `Op` (server/src/core/transcript/align.ts): what the alignment did with a word.
public enum AlignOp: String, Sendable, Equatable, Codable {
  case match, sub, del, ins
}

/// `[i, j]`: reference word `i` matched hypothesis word `j`.
public struct AlignedPair: Sendable, Equatable, Codable {
  public var ref: Int
  public var hyp: Int

  public init(_ ref: Int, _ hyp: Int) {
    self.ref = ref
    self.hyp = hyp
  }

  public init(from decoder: Decoder) throws {
    var c = try decoder.unkeyedContainer()
    ref = try c.decode(Int.self)
    hyp = try c.decode(Int.self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.unkeyedContainer()
    try c.encode(ref)
    try c.encode(hyp)
  }
}

/// What `alignTokens` (server/src/core/transcript/align.ts) returns: the edit script in order, the matched pairs, and the count of each kind of error.
public struct Alignment: Sendable, Equatable, Codable {
  public var ops: [AlignOp]
  public var pairs: [AlignedPair]
  public var sub: Int
  public var del: Int
  public var ins: Int

  public init(ops: [AlignOp], pairs: [AlignedPair], sub: Int, del: Int, ins: Int) {
    self.ops = ops
    self.pairs = pairs
    self.sub = sub
    self.del = del
    self.ins = ins
  }
}

/// `alignTokens` (server/src/core/transcript/align.ts): banded Levenshtein alignment between a reference (publisher text) and a hypothesis (ASR), with backtrace.
/// The band follows the scaled diagonal, which holds because both sequences follow the same audio.
///
/// Like the reference it holds `(ref.count + 1) * (2 * band + 1)` cells, five bytes each: 90 MB for 15,000 reference
/// words at the default band.
///
/// When the two sequences drift further apart than the band, the reference does not fail: its backtrace walks off
/// the band and reads whatever cell its index arithmetic lands on, or nothing at all past the table's end. The
/// answer is then poor but defined, and this port gives the same one (the golden file has such cases), so the table
/// stays one flat array indexed exactly as in the TypeScript.
public func alignTokens(_ ref: [String], _ hyp: [String], band: Int = 600) -> Alignment {
  precondition(band >= 0, "alignTokens: band must not be negative")  // the reference throws: a negative array length
  let n = ref.count
  let m = hyp.count
  let width = 2 * band + 1

  // `===` on strings compares code units, which Swift's `==` does not (JS.equal). Give every distinct token a number
  // once, by its bytes, and compare numbers in the table.
  var ids: [[UInt8]: Int32] = [:]
  func id(_ token: String) -> Int32 {
    let key = Array(token.utf8)
    if let known = ids[key] { return known }
    let made = Int32(ids.count)
    ids[key] = made
    return made
  }
  let r = ref.map(id)
  let h = hyp.map(id)

  // Where the band is centred on each row: Math.round((i * m) / n), in floating point as the reference computes it.
  let centers = (0...n).map { i in n == 0 ? 0 : JS.round(Double(i * m) / Double(n)) }
  func idx(_ i: Int, _ j: Int) -> Int { i * width + (j - centers[i] + band) }
  func inBand(_ i: Int, _ j: Int) -> Bool { j >= 0 && j <= m && abs(j - centers[i]) <= band }

  let inf: Int32 = 1 << 29
  var dist = [Int32](repeating: inf, count: (n + 1) * width)
  var move = [UInt8](repeating: 0, count: (n + 1) * width)  // 0 diag, 1 up (del ref), 2 left (ins hyp)
  if inBand(0, 0) { dist[idx(0, 0)] = 0 }
  var j = 1
  while j <= m && inBand(0, j) {
    dist[idx(0, j)] = Int32(j)
    move[idx(0, j)] = 2
    j += 1
  }
  if n > 0 {
    for i in 1...n {
      let lo = max(0, centers[i] - band)
      let hi = min(m, centers[i] + band)
      guard lo <= hi else { continue }
      for j in lo...hi {
        var best = inf
        var mv: UInt8 = 1
        if inBand(i - 1, j) {
          let v = dist[idx(i - 1, j)] + 1
          if v < best { best = v; mv = 1 }
        }
        if j > 0 && inBand(i, j - 1) {
          let v = dist[idx(i, j - 1)] + 1
          if v < best { best = v; mv = 2 }
        }
        if j > 0 && inBand(i - 1, j - 1) {
          let v = dist[idx(i - 1, j - 1)] + (r[i - 1] == h[j - 1] ? 0 : 1)
          if v <= best { best = v; mv = 0 }
        }
        dist[idx(i, j)] = best
        move[idx(i, j)] = mv
      }
    }
  }

  var ops: [AlignOp] = []
  var pairs: [AlignedPair] = []
  var i = n
  j = m
  var sub = 0
  var del = 0
  var ins = 0
  while i > 0 || j > 0 {
    let mv: UInt8
    if i == 0 {
      mv = 2
    } else if j == 0 {
      mv = 1
    } else {
      // Off the band this index is another cell's, or outside the table, where a JavaScript typed array reads
      // `undefined`: neither 0 nor 1, so the step below is an insertion.
      let at = idx(i, j)
      mv = move.indices.contains(at) ? move[at] : 2
    }
    if mv == 0 {
      if r[i - 1] == h[j - 1] {
        ops.append(.match)
        pairs.append(AlignedPair(i - 1, j - 1))
      } else {
        ops.append(.sub)
        sub += 1
      }
      i -= 1
      j -= 1
    } else if mv == 1 {
      ops.append(.del)
      del += 1
      i -= 1
    } else {
      ops.append(.ins)
      ins += 1
      j -= 1
    }
  }
  ops.reverse()
  pairs.reverse()
  return Alignment(ops: ops, pairs: pairs, sub: sub, del: del, ins: ins)
}
