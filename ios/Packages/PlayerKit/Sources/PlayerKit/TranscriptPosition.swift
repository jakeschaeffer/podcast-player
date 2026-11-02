// A port of web/src/lib/transcript.ts: which segment and word are being spoken.
import PodcastAPI

public enum TranscriptPosition {
  /// Index of the segment playing at `ms` (the last one whose start is ≤ ms), or nil before the first.
  public static func segmentIndex(_ segments: [TranscriptSegment], at ms: Int) -> Int? {
    var lo = 0
    var hi = segments.count - 1
    var best: Int?
    while lo <= hi {
      let mid = (lo + hi) / 2
      if segments[mid].s <= ms {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return best
  }

  /// Index of the word playing at `ms` inside a segment, or nil before its first word.
  public static func wordIndex(_ segment: TranscriptSegment, at ms: Int) -> Int? {
    var best: Int?
    for (i, word) in segment.words.enumerated() {
      guard word.startMs <= ms else { break }
      best = i
    }
    return best
  }
}
