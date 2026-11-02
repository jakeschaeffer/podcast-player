import PodcastAPI
import Testing

@testable import PlayerKit

struct TranscriptPositionTests {
  static func segment(_ s: Int, _ words: [Int]) -> TranscriptSegment {
    TranscriptSegment(
      s: s, e: (words.last ?? s) + 300, spk: nil, w0: 0,
      words: words.map { Word(startMs: $0, endMs: $0 + 300, text: "w") })
  }

  let segments = [segment(1_000, [1_000, 1_400]), segment(5_000, [5_000, 5_500, 6_000]), segment(9_000, [9_000])]

  @Test func findsTheLastSegmentStartedByThePosition() {
    #expect(TranscriptPosition.segmentIndex(segments, at: 0) == nil)
    #expect(TranscriptPosition.segmentIndex(segments, at: 1_000) == 0)
    #expect(TranscriptPosition.segmentIndex(segments, at: 4_999) == 0)  // the gap belongs to the segment before it
    #expect(TranscriptPosition.segmentIndex(segments, at: 5_000) == 1)
    #expect(TranscriptPosition.segmentIndex(segments, at: 60_000) == 2)
    #expect(TranscriptPosition.segmentIndex([], at: 1_000) == nil)
  }

  @Test func findsTheWordBeingSpoken() {
    #expect(TranscriptPosition.wordIndex(segments[1], at: 4_000) == nil)
    #expect(TranscriptPosition.wordIndex(segments[1], at: 5_000) == 0)
    #expect(TranscriptPosition.wordIndex(segments[1], at: 5_700) == 1)
    #expect(TranscriptPosition.wordIndex(segments[1], at: 7_000) == 2)
  }
}
