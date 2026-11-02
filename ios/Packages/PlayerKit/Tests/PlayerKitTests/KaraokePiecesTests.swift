import PodcastAPI
import Testing

@testable import PlayerKit

struct KaraokePiecesTests {
  static func words(_ text: String) -> [Word] {
    text.split(separator: " ").enumerated().map { i, w in Word(startMs: i * 300, endMs: i * 300 + 250, text: String(w)) }
  }

  @Test func breaksAtAClauseOnceHalfFull() {
    let pieces = KaraokePieces.split(Self.words("So a lot of matrix factorization, a lot of compute-intensive stuff."))
    #expect(pieces.map { $0.words.map(\.text).joined(separator: " ") } == [
      "So a lot of matrix factorization,", "a lot of compute-intensive stuff.",
    ])
  }

  @Test func neverExceedsTheLimit() {
    let text = Array(repeating: "word", count: 40).joined(separator: " ")
    let pieces = KaraokePieces.split(Self.words(text))
    #expect(pieces.allSatisfy { $0.words.map(\.text).joined(separator: " ").count <= KaraokePieces.limit })
    #expect(pieces.flatMap(\.words).count == 40)
  }

  @Test func ignoresAnEarlyClauseBreak() {
    let pieces = KaraokePieces.split(Self.words("Yes, I joined after school and spent seven years there"))
    #expect(pieces.count == 1)
  }

  @Test func findsTheSpokenPiece() {
    let pieces = KaraokePieces.split(Self.words("So a lot of matrix factorization, a lot of compute-intensive stuff."))
    #expect(KaraokePieces.index(pieces, at: -100) == 0)
    #expect(KaraokePieces.index(pieces, at: pieces[1].startMs) == 1)
    #expect(KaraokePieces.index(pieces, at: 1_000_000) == 1)
  }

  @Test func neverRunsAcrossSegments() {
    let a = TranscriptSegment(s: 0, e: 600, spk: "S1", w0: 0, words: Self.words("Yes I agree"))
    let later = Self.words("and then we built it").map { Word(startMs: $0.startMs + 1_000, endMs: $0.endMs + 1_000, text: $0.text) }
    let b = TranscriptSegment(s: 1_000, e: 2_500, spk: "S2", w0: 3, words: later)
    let pieces = KaraokePieces.split(segments: [a, b])
    #expect(pieces.map { $0.words.count } == [3, 5])
    #expect(KaraokePieces.index(pieces, at: 1_100) == 1)
    #expect(KaraokePieces.index(pieces, at: 999) == 0)
  }

  @Test func halvesAlternate() {
    #expect(KaraokePieces.slots(active: 0, count: 3) == (0, 1))
    #expect(KaraokePieces.slots(active: 1, count: 3) == (2, 1))
    #expect(KaraokePieces.slots(active: 2, count: 3) == (2, nil))
    #expect(KaraokePieces.slots(active: 0, count: 1) == (0, nil))
  }
}
