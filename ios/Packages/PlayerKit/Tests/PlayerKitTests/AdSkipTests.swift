import PodcastAPI
import Testing

@testable import PlayerKit

/// Same cases as web/test/adBreaks.test.ts.
struct AdSkipTests {
  let breaks = [AdBreak(startMs: 0, endMs: 30_000), AdBreak(startMs: 600_000, endMs: 660_000)]

  @Test func offersASkipFromABreaksFirstMomentUntilJustBeforeItEnds() {
    #expect(AdSkip.breakAt(breaks, positionMs: 0) == breaks[0])
    #expect(AdSkip.breakAt(breaks, positionMs: 30_000 - AdSkip.tailMs - 1) == breaks[0])
    #expect(AdSkip.breakAt(breaks, positionMs: 30_000 - AdSkip.tailMs) == nil)
    #expect(AdSkip.breakAt(breaks, positionMs: 599_999) == nil)
    #expect(AdSkip.breakAt(breaks, positionMs: 630_000) == breaks[1])
    #expect(AdSkip.breakAt(breaks, positionMs: 660_000) == nil)
  }

  @Test func offersNothingWithoutBreaks() {
    #expect(AdSkip.breakAt(nil, positionMs: 10_000) == nil)
    #expect(AdSkip.breakAt([], positionMs: 10_000) == nil)
  }

  // The native app's own setting; the web has no automatic skip.

  @Test func skipsABreakPlaybackReaches() {
    #expect(AdSkip.automatic(breaks, positionMs: 600_100, playing: true, chosen: nil, skipped: nil) == breaks[1])
    // An episode's opening ads, played from its very start, and the rest of a break a resume point fell in.
    #expect(AdSkip.automatic(breaks, positionMs: 0, playing: true, chosen: nil, skipped: nil) == breaks[0])
    #expect(AdSkip.automatic(breaks, positionMs: 640_000, playing: true, chosen: nil, skipped: nil) == breaks[1])
  }

  @Test func leavesWhatIsNotABreakOrIsNearlyOver() {
    #expect(AdSkip.automatic(breaks, positionMs: 599_000, playing: true, chosen: nil, skipped: nil) == nil)
    #expect(AdSkip.automatic(breaks, positionMs: 660_000 - AdSkip.tailMs, playing: true, chosen: nil, skipped: nil) == nil)
    #expect(AdSkip.automatic(nil, positionMs: 10_000, playing: true, chosen: nil, skipped: nil) == nil)
  }

  @Test func waitsForPlayback() {
    #expect(AdSkip.automatic(breaks, positionMs: 600_100, playing: false, chosen: nil, skipped: nil) == nil)
  }

  @Test func playsABreakTheListenerWentInto() {
    #expect(AdSkip.automatic(breaks, positionMs: 620_000, playing: true, chosen: breaks[1], skipped: nil) == nil)
    // Choosing one break doesn't let the others play.
    #expect(AdSkip.automatic(breaks, positionMs: 5_000, playing: true, chosen: breaks[1], skipped: nil) == breaks[0])
  }

  @Test func neverSkipsTheSameBreakTwiceInARow() {
    // A tick from before the jump, reporting a time still inside the break just left.
    #expect(AdSkip.automatic(breaks, positionMs: 600_200, playing: true, chosen: nil, skipped: breaks[1]) == nil)
    #expect(AdSkip.automatic(breaks, positionMs: 1_000, playing: true, chosen: nil, skipped: breaks[1]) == breaks[0])
  }
}
