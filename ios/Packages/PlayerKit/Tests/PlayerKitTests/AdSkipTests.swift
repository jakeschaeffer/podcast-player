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
}
