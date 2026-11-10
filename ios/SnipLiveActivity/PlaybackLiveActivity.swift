import ActivityKit
import SnipActivity
import SwiftUI
import WidgetKit

@main
struct SnipLiveActivityBundle: WidgetBundle {
  var body: some Widget {
    PlaybackLiveActivity()
  }
}

/// The episode playing, on the lock screen and in the Dynamic Island. The views are in the SnipActivity package
/// (PlaybackActivityViews.swift), where the app's debug gallery draws them too; this only places them. Once a snip's
/// title is in, a tap anywhere on the activity opens the app on renaming it (`ContentState.renameURL`). Content whose
/// stale date has passed is drawn without its snip (`ContentState.drawn(stale:)`): the system redraws the activity at
/// that moment by itself, which the app, suspended while paused, cannot.
struct PlaybackLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: PlaybackActivityAttributes.self) { context in
      let state = context.state.drawn(stale: context.isStale)
      PlaybackLockScreenView(state: state)
        .activityBackgroundTint(ActivityPalette.plate)
        .activitySystemActionForegroundColor(.white)
        .widgetURL(state.renameURL)
    } dynamicIsland: { context in
      let state = context.state.drawn(stale: context.isStale)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          PlaybackIslandLeading(state: state).padding(.leading, 6)
        }
        DynamicIslandExpandedRegion(.trailing) {
          PlaybackIslandTrailing(state: state).padding(.trailing, 6)
        }
        DynamicIslandExpandedRegion(.bottom) {
          PlaybackIslandBottom(state: state).padding(.horizontal, 6)
        }
      } compactLeading: {
        PlaybackCompactLeading(state: state)
      } compactTrailing: {
        PlaybackCompactTrailing(state: state)
      } minimal: {
        PlaybackMinimal(state: state)
      }
      .keylineTint(ActivityPalette.accent)
      .widgetURL(state.renameURL)
    }
  }
}
