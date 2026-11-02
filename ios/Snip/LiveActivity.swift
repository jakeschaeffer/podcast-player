import ActivityKit
import Foundation
import PlayerKit
import SnipActivity

/// Keeps the Live Activity in step with the player. It follows the player's reports (play, pause, seek, speed, and
/// every 15 s while playing), which is when the drawn position needs correcting; between them the widget's timer
/// moves the bar. One activity spans the session and changes episode in place (see PlaybackActivityAttributes).
final class LiveActivityController {
  private var activity: Activity<PlaybackActivityAttributes>?
  private var note: (text: String, until: Date)?

  init() {
    // An activity left from an earlier launch is picked up rather than duplicated.
    activity = Activity<PlaybackActivityAttributes>.activities.first { $0.activityState == .active }
  }

  func update(_ engine: PlayerEngine) {
    guard let ep = engine.episode, engine.status == .ready else { return }
    if let note, note.until < .now { self.note = nil }
    let state = PlaybackActivityAttributes.ContentState(
      episodeID: ep.id, showTitle: ep.showTitle ?? "", title: ep.title, playing: engine.playing,
      positionMs: engine.positionMs, durationMs: engine.durationMs, speed: engine.speed, note: note?.text,
      adBreakEndMs: engine.currentAdBreak?.endMs)
    let content = ActivityContent(state: state, staleDate: nil)
    if let activity, activity.activityState == .active {
      let id = activity.id
      Task.detached { await Self.running(id)?.update(content) }
      return
    }
    // Starting one only works in the foreground; from the background this fails and the next update tries again.
    guard engine.playing, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    activity = try? Activity.request(attributes: PlaybackActivityAttributes(), content: content)
  }

  /// A line under the controls for a few seconds, e.g. after a snip from the lock screen.
  func show(_ text: String, engine: PlayerEngine) {
    note = (text, Date.now.addingTimeInterval(8))
    update(engine)
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(8.5))
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
