import PodcastAPI

/// A snip's words cut into short pieces for the sideways reading mode, like the audiobook app's karaoke view: each
/// piece fits about three lines at a very large size, so a run-on sentence never shrinks the type. A piece ends at a
/// clause break once it is half full, or before the word that would overflow it.
public enum KaraokePieces {
  public struct Piece: Equatable, Sendable {
    public let words: [Word]
    public var startMs: Int { words.first?.startMs ?? 0 }
    public var endMs: Int { words.last?.endMs ?? 0 }
  }

  /// About three lines at the sideways size.
  public static let limit = 60

  public static func split(_ words: [Word], limit: Int = limit) -> [Piece] {
    var pieces: [Piece] = []
    var current: [Word] = []
    var chars = 0
    for (i, word) in words.enumerated() {
      current.append(word)
      chars += word.text.count + (chars == 0 ? 0 : 1)
      let next = i + 1 < words.count ? words[i + 1].text.count + 1 : 0
      let clause = word.text.last.map { ",.;:?!—".contains($0) } ?? false
      if (clause && chars >= limit / 2) || chars + next > limit {
        pieces.append(Piece(words: current))
        current = []
        chars = 0
      }
    }
    if !current.isEmpty { pieces.append(Piece(words: current)) }
    return pieces
  }

  /// A whole transcript's pieces: each segment is cut on its own, so no piece runs across a change of speaker.
  public static func split(segments: [TranscriptSegment], limit: Int = limit) -> [Piece] {
    segments.flatMap { split($0.words, limit: limit) }
  }

  /// The piece being spoken at `ms`: the last one started by then (the first before any has). Pieces are in time
  /// order, so this is a binary search; a whole episode has thousands of them.
  public static func index(_ pieces: [Piece], at ms: Int) -> Int {
    var (low, high) = (0, pieces.count)
    while low < high {
      let mid = (low + high) / 2
      if pieces[mid].startMs <= ms { low = mid + 1 } else { high = mid }
    }
    return max(low - 1, 0)
  }

  /// Which pieces the two fixed halves of the screen hold while piece `active` is spoken. They alternate: the active
  /// piece stays in the half it was shown in as "next", and the half it left shows the piece after it. So the only
  /// change on screen when speech moves on is one half fading to new text.
  public static func slots(active: Int, count: Int) -> (top: Int?, bottom: Int?) {
    let even = active.isMultiple(of: 2)
    let top = even ? active : active + 1
    let bottom = even ? active + 1 : active
    return (top < count ? top : nil, bottom < count ? bottom : nil)
  }
}
