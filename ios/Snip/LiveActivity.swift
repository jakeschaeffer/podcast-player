import ActivityKit
import Foundation
import os
import PlayerKit
import PodcastAPI
import SnipActivity

/// Keeps the Live Activity in step with the player. It follows the player's reports (play, pause, seek, speed, and
/// every 15 s while playing), which is when the drawn position needs correcting; between them the widget's timers run
/// the clocks and bars. One activity spans the session and changes episode in place (see PlaybackActivityAttributes).
///
/// After a snip tap the latest snip's progress takes the card, step by step as the snip card in the app learns it from
/// the server, and stays a while once the title is in (as long as the app's snip bar does) so it can be tapped to
/// rename. A snip the server takes long over, say one waiting for a transcript, gives the card back after a minute and
/// a half; it returns once it is named.
///
/// The card is given back twice over. While the app runs, it redraws the activity when the snip's time is up
/// (`refresh`). Paused, iOS suspends the app and that redraw never comes, so the content also carries the moment as its
/// stale date, and the widget draws stale content without the snip (`ContentState.drawn(stale:)`). The system marks
/// content stale no sooner than two minutes after its last update, whatever earlier date it is given (seen on iOS 26),
/// so with the app suspended a snip can keep the card that long; Play is on the snip's card for that reason.
final class LiveActivityController {
  private var activity: Activity<PlaybackActivityAttributes>?
  /// The latest snip's progress, when the tap was, and when its title came in or it failed.
  private var snip: (progress: SnipProgress, since: Date, settled: Date?)?

  static let namedFor = SnipPill.readyFor
  static let failedFor = Duration.seconds(8)
  static let workingFor = Duration.seconds(90)

  /// The lock screen's buttons act with the app out of sight, often in a process iOS has just relaunched for them:
  /// what they found and why they did nothing is only ever visible here (subsystem snip.player, category activity).
  static let log = Logger(subsystem: "snip.player", category: "activity")

  init() {
    // An activity left from an earlier launch is picked up rather than duplicated.
    let all = Activity<PlaybackActivityAttributes>.activities
    activity = all.first(where: Self.isLive)
    Self.log.notice("launch: \(all.count) activities (\(all.map { String(describing: $0.activityState) }.joined(separator: ","), privacy: .public)), picked up \(self.activity == nil ? "none" : "one", privacy: .public)")
  }

  /// Still on the lock screen and ours to update. Stale counts: it is only content whose snip has had its time.
  nonisolated private static func isLive(_ activity: Activity<PlaybackActivityAttributes>) -> Bool {
    activity.activityState == .active || activity.activityState == .stale
  }

  /// The episode the activity shows. After iOS ended the app while paused, the activity outlives it: a relaunch
  /// picks it up with the player empty, and Play opens this episode.
  var episodeID: ULID? { shown?.episodeID }

  /// Where the activity says that episode stands, which is where a Snip tapped on it means.
  var shown: (episodeID: ULID, positionMs: Int)? {
    guard let activity, Self.isLive(activity) else { return nil }
    return (activity.content.state.episodeID, activity.content.state.positionMs)
  }

  func update(_ engine: PlayerEngine) {
    guard let ep = engine.episode, engine.status == .ready else { return }
    let ad = engine.currentAdBreak
    let snip = shownSnip
    let state = PlaybackActivityAttributes.ContentState(
      episodeID: ep.id, showTitle: ep.showTitle ?? "", title: ep.title, playing: engine.playing,
      positionMs: engine.positionMs, durationMs: engine.durationMs, speed: engine.speed,
      adBreakStartMs: ad?.startMs, adBreakEndMs: ad?.endMs, snip: snip)
    let content = ActivityContent(state: state, staleDate: snip == nil ? nil : snipLeavesAt)
    if let activity, Self.isLive(activity) {
      let id = activity.id
      Task.detached { await Self.running(id)?.update(content) }
      return
    }
    // Starting one only works in the foreground; from the background this fails and the next update tries again.
    guard engine.playing, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    activity = try? Activity.request(attributes: PlaybackActivityAttributes(), content: content)
  }

  /// A snip tap: from now on the card follows it.
  func snipStarted(_ progress: SnipProgress, engine: PlayerEngine) {
    snip = (progress, .now, nil)
    update(engine)
    refresh(engine, after: Self.workingFor)
  }

  /// The server moved the snip on, or it failed.
  func snipChanged(_ progress: SnipProgress, engine: PlayerEngine) {
    guard let current = snip, current.progress != progress else { return }
    let settlesNow = !progress.inProgress && current.settled == nil
    snip = (progress, current.since, progress.inProgress ? nil : current.settled ?? .now)
    update(engine)
    if settlesNow { refresh(engine, after: progress.step == .named ? Self.namedFor : Self.failedFor) }
  }

  /// The snip was cancelled, or its bar closed in the app: the card goes back to the episode.
  func snipEnded(engine: PlayerEngine) {
    guard snip != nil else { return }
    snip = nil
    update(engine)
  }

  /// The snip, while it still has the card.
  private var shownSnip: SnipProgress? {
    guard let snip, let until = snipLeavesAt, .now < until else { return nil }
    return snip.progress
  }

  /// When the snip's time on the card is up: a while after it settled, or after the tap if it is still on its way.
  private var snipLeavesAt: Date? {
    guard let snip else { return nil }
    if let settled = snip.settled {
      let hold = snip.progress.step == .named ? Self.namedFor : Self.failedFor
      return settled.addingTimeInterval(hold.timeInterval)
    }
    return snip.since.addingTimeInterval(Self.workingFor.timeInterval)
  }

  /// Draw the card again once a snip's time on it is up.
  private func refresh(_ engine: PlayerEngine, after delay: Duration) {
    Task { [weak self] in
      try? await Task.sleep(for: delay + .milliseconds(300))
      self?.update(engine)
    }
  }

  func end() {
    guard let id = activity?.id else { return }
    activity = nil
    Task.detached { await Self.running(id)?.end(nil, dismissalPolicy: .immediate) }
  }

  /// The activity with this id, found again off the main actor (an `Activity` can't be handed across actors).
  nonisolated private static func running(_ id: String) -> Activity<PlaybackActivityAttributes>? {
    Activity<PlaybackActivityAttributes>.activities.first { $0.id == id }
  }
}

extension Duration {
  fileprivate var timeInterval: TimeInterval {
    Double(components.seconds) + Double(components.attoseconds) / 1e18
  }
}

extension SnipCardModel {
  /// The card's snip as the Live Activity shows it, from the same facts the app's snip bar reads.
  var activityProgress: SnipProgress {
    switch phase {
    case .waiting(let pending):
      return SnipProgress(step: .choosing, anchorMs: pending.body.anchorMs)
    case .snip(let snip):
      let rev = snip.revision
      let step: SnipProgress.Step =
        switch rev?.status {
        case .waiting: .waitingForTranscript
        case .preparing: rev?.clipUrl == nil ? .cutting : .naming
        case .ready: .named
        case .failed: .failed
        case .selecting, .unknown, nil: .choosing
        }
      // The span exists once the moment is chosen; before that the revision's points are the tap's placeholders.
      let chosen = step != .choosing && step != .waitingForTranscript
      return SnipProgress(
        step: step, snipID: snip.id, anchorMs: snip.anchorMs, lengthMs: chosen ? rev.map { $0.endMs - $0.startMs } : nil,
        title: rev?.title, error: rev?.error)
    }
  }
}
