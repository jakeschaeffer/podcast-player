import Foundation
import Testing

@testable import SnipActivity

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func state(
  positionMs: Int = 60_000, playing: Bool = true, speed: Double = 1, ad: ClosedRange<Int>? = nil, snip: SnipProgress? = nil
) -> PlaybackActivityAttributes.ContentState {
  .init(
    episodeID: "e", showTitle: "Show", title: "Title", playing: playing, positionMs: positionMs, durationMs: 600_000,
    speed: speed, at: now, adBreakStartMs: ad?.lowerBound, adBreakEndMs: ad?.upperBound, snip: snip)
}

@Suite struct RenameLink {
  @Test func roundTrips() throws {
    let url = try #require(SnipLink.rename("01JC8Y3W5Q", scheme: "org.example.snip"))
    #expect(url.absoluteString == "org.example.snip://snips/01JC8Y3W5Q/rename")
    #expect(SnipLink.renamedSnip(in: url) == "01JC8Y3W5Q")
  }

  @Test func ignoresOtherLinks() {
    for link in ["org.example.snip://snips/01JC8Y3W5Q", "org.example.snip://episodes/01JC8Y3W5Q/rename",
                 "org.example.snip://snips/01JC8Y3W5Q/rename/more", "https://example.org/snips/01JC8Y3W5Q/rename"] {
      #expect(SnipLink.renamedSnip(in: URL(string: link)!) == nil, "\(link)")
    }
  }

  @Test func onlyANamedSnipOutsideAnAdBreakLinks() throws {
    let named = SnipProgress(step: .named, snipID: "01JC8Y3W5Q", anchorMs: 1_000, lengthMs: 42_000, title: "A title")
    let url = try #require(state(snip: named).renameURL(scheme: "org.example.snip"))
    #expect(SnipLink.renamedSnip(in: url) == "01JC8Y3W5Q")
    #expect(state(ad: 50_000...90_000, snip: named).renameURL(scheme: "org.example.snip") == nil)
    #expect(state(snip: SnipProgress(step: .naming, snipID: "01JC8Y3W5Q", anchorMs: 1_000)).renameURL(scheme: "org.example.snip") == nil)
    #expect(state(snip: SnipProgress(step: .named, anchorMs: 1_000, title: "Offline")).renameURL(scheme: "org.example.snip") == nil)
  }
}

@Suite struct Clocks {
  @Test func wallClockFollowsSpeed() {
    let s = state(positionMs: 60_000, speed: 1.5)
    #expect(s.date(atMs: 90_000) == now.addingTimeInterval(20))
    #expect(s.date(atMs: 0) == now.addingTimeInterval(-40))
    #expect(s.timerRange == now.addingTimeInterval(-40)...now.addingTimeInterval(360))
  }

  @Test func onlyNormalSpeedRunsThePosition() {
    #expect(state(speed: 1).positionTicks)
    #expect(!state(speed: 1.5).positionTicks)
    #expect(!state(playing: false).positionTicks)
  }

  @Test func adBreakCountsDownInWallClockTime() throws {
    let s = state(positionMs: 60_000, speed: 1.5, ad: 30_000...90_000)
    let range = try #require(s.adBreakRange)
    #expect(range == now.addingTimeInterval(-20)...now.addingTimeInterval(20))
    #expect(s.adBreakRemainingMs == 20_000)
    #expect(s.adBreakFraction == 0.5)
  }

  @Test func formatsLikeTheApp() {
    #expect(ActivityClock.string(0) == "0:00")
    #expect(ActivityClock.string(439_000) == "7:19")
    #expect(ActivityClock.string(4_328_000) == "1:12:08")
  }
}

@Suite struct WhatTheCardShows {
  @Test func anAdBreakComesFirstThenASnip() {
    let snip = SnipProgress(step: .cutting, snipID: "s", anchorMs: 1_000)
    #expect(state(ad: 50_000...90_000, snip: snip).mode == .adBreak)
    #expect(state(snip: snip).mode == .snip(snip))
    #expect(state().mode == .episode)
  }

  @Test func anAdBreakNeedsBothEnds() {
    var s = state()
    s.adBreakEndMs = 90_000
    #expect(s.mode == .episode)
  }

  @Test func stepsFillInOrder() {
    let steps: [SnipProgress.Step] = [.choosing, .waitingForTranscript, .cutting, .naming, .named, .failed]
    #expect(steps.map { SnipProgress(step: $0, anchorMs: 0).stepsDone } == [0, 0, 1, 2, 3, 0])
    #expect(steps.map { SnipProgress(step: $0, anchorMs: 0).inProgress } == [true, true, true, true, false, false])
  }
}
