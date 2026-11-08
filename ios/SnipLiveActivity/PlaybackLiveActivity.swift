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
/// title is in, a tap anywhere on the activity opens the app on renaming it (`ContentState.renameURL`).
struct PlaybackLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: PlaybackActivityAttributes.self) { context in
      PlaybackLockScreenView(state: context.state)
        .activityBackgroundTint(ActivityPalette.plate)
        .activitySystemActionForegroundColor(.white)
        .widgetURL(context.state.renameURL)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          PlaybackIslandLeading(state: context.state).padding(.leading, 6)
        }
        DynamicIslandExpandedRegion(.trailing) {
          PlaybackIslandTrailing(state: context.state).padding(.trailing, 6)
        }
        DynamicIslandExpandedRegion(.bottom) {
          PlaybackIslandBottom(state: context.state).padding(.horizontal, 6)
        }
      } compactLeading: {
        PlaybackCompactLeading(state: context.state)
      } compactTrailing: {
        PlaybackCompactTrailing(state: context.state)
      } minimal: {
        PlaybackMinimal(state: context.state)
      }
      .keylineTint(ActivityPalette.accent)
      .widgetURL(context.state.renameURL)
    }
  }
}
