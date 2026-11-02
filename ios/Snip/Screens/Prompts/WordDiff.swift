import Foundation

/// A word-level diff, ported from web/src/lib/diff.ts: the parts of `a` and `b` in order, each kept, removed (only
/// in a), or added (only in b). Runs of whitespace are tokens too, so the kept and removed parts joined give `a`.
enum WordDiff {
  enum Kind: Hashable { case same, del, add }

  struct Part: Hashable {
    var kind: Kind
    var text: String
  }

  static func diff(_ a: String, _ b: String) -> [Part] {
    let x = tokens(a)
    let y = tokens(b)
    let (n, m) = (x.count, y.count)
    let w = m + 1
    // Longest common subsequence table, filled from the end so the walk below can go forwards.
    var lcs = [Int32](repeating: 0, count: (n + 1) * w)
    for i in stride(from: n - 1, through: 0, by: -1) {
      for j in stride(from: m - 1, through: 0, by: -1) {
        lcs[i * w + j] = x[i] == y[j] ? lcs[(i + 1) * w + j + 1] + 1 : max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
      }
    }
    var parts: [Part] = []
    func push(_ kind: Kind, _ text: Substring) {
      if parts.last?.kind == kind { parts[parts.count - 1].text += text } else { parts.append(Part(kind: kind, text: String(text))) }
    }
    var (i, j) = (0, 0)
    while i < n && j < m {
      if x[i] == y[j] {
        push(.same, x[i])
        i += 1
        j += 1
      } else if lcs[(i + 1) * w + j] >= lcs[i * w + j + 1] {
        push(.del, x[i])
        i += 1
      } else {
        push(.add, y[j])
        j += 1
      }
    }
    while i < n { push(.del, x[i]); i += 1 }
    while j < m { push(.add, y[j]); j += 1 }
    return parts
  }

  /// Words and the whitespace between them, alternating, like `split(/(\s+)/)` without the empty strings.
  static func tokens(_ s: String) -> [Substring] {
    var out: [Substring] = []
    var start = s.startIndex
    var previous: Bool?
    for i in s.indices {
      let space = s[i].isWhitespace
      if let previous, previous != space {
        out.append(s[start..<i])
        start = i
      }
      previous = space
    }
    if start < s.endIndex { out.append(s[start...]) }
    return out
  }
}
