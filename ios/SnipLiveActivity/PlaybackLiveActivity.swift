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

/// The episode playing, on the lock screen and in the Dynamic Island: the show and title, progress, skip back,
/// play/pause, skip forward, and Snip, which saves the moment just heard without opening the app.
struct PlaybackLiveActivity: Widget {
  /// The app's accent (its icon's amber); the extension has no asset catalog of its own.
  static let accent = Color(red: 0xF3 / 255, green: 0xA7 / 255, blue: 0x2A / 255)
  /// The icon's near-black, for text on the accent.
  static let ink = Color(red: 0x0E / 255, green: 0x0F / 255, blue: 0x11 / 255)

  var body: some WidgetConfiguration {
    ActivityConfiguration(for: PlaybackActivityAttributes.self) { context in
      LockScreenView(state: context.state)
        .activityBackgroundTint(Color.black.opacity(0.75))
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      DynamicIsland {
        // One full-width region, laid out like the lock screen: titles (or the snip banner), progress, controls.
        DynamicIslandExpandedRegion(.bottom) {
          ActivityBody(state: context.state, island: true)
            .padding(.horizontal, 4)
        }
      } compactLeading: {
        Image(systemName: "scissors").foregroundStyle(Self.accent)
      } compactTrailing: {
        if context.state.note != nil {
          Image(systemName: "checkmark.circle.fill").foregroundStyle(Self.accent)
        } else if context.state.adBreakEndMs != nil {
          Text("AD").font(.caption2.weight(.heavy)).foregroundStyle(Self.accent)
        } else if context.state.playing {
          ProgressView(timerInterval: context.state.timerRange, countsDown: false) { EmptyView() } currentValueLabel: { EmptyView() }
            .progressViewStyle(.circular).tint(Self.accent).frame(width: 18, height: 18)
        } else {
          Image(systemName: "pause.fill").foregroundStyle(.secondary)
        }
      } minimal: {
        Image(systemName: context.state.note != nil ? "checkmark.circle.fill" : "scissors").foregroundStyle(Self.accent)
      }
      .keylineTint(Self.accent)
    }
  }
}

private struct LockScreenView: View {
  let state: PlaybackActivityAttributes.ContentState

  var body: some View {
    ActivityBody(state: state, island: false)
      .padding(16)
  }
}

/// What the lock screen and the expanded Dynamic Island both show. The island is shorter, so there it drops the show
/// name, keeps the title to one line and uses a smaller Snip button.
private struct ActivityBody: View {
  let state: PlaybackActivityAttributes.ContentState
  let island: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: island ? 8 : 12) {
      // A snip just made takes the titles' place, big enough to read at a glance; the titles return after it.
      if let note = state.note {
        SnippedBanner(note: note, font: island ? .title3 : .title2)
          .frame(minHeight: island ? 24 : 44, alignment: .leading)
      } else if island {
        Text(state.title).font(.subheadline.weight(.semibold)).foregroundStyle(.white).lineLimit(1)
          .frame(minHeight: 24, alignment: .leading)
      } else {
        VStack(alignment: .leading, spacing: 2) {
          Text(state.showTitle).font(.subheadline).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
          Text(state.title).font(.headline).foregroundStyle(.white).lineLimit(2)
        }
        .frame(minHeight: 44, alignment: .leading)
      }
      Progress(state: state)
      HStack(spacing: 12) {
        Controls(playing: state.playing)
        Spacer(minLength: 0)
        if state.adBreakEndMs != nil { SkipAdButton() }
        SnipButton(done: state.note != nil, size: island ? 40 : 48)
      }
    }
  }
}

private struct SnippedBanner: View {
  let note: String
  let font: Font

  var body: some View {
    Label(note, systemImage: "checkmark.circle.fill")
      .font(font.weight(.bold))
      .foregroundStyle(PlaybackLiveActivity.accent)
      .lineLimit(1)
      .minimumScaleFactor(0.8)
  }
}

/// A bar that moves on its own while playing (a timer from the last update), and stands still while paused.
private struct Progress: View {
  let state: PlaybackActivityAttributes.ContentState

  var body: some View {
    Group {
      if state.playing {
        ProgressView(timerInterval: state.timerRange, countsDown: false) { EmptyView() } currentValueLabel: { EmptyView() }
      } else {
        ProgressView(value: state.fraction)
      }
    }
    .progressViewStyle(.linear)
    .tint(PlaybackLiveActivity.accent)
  }
}

private struct Controls: View {
  let playing: Bool

  var body: some View {
    HStack(spacing: 24) {
      Button(intent: SkipBackIntent()) { Image(systemName: "gobackward.15").font(.title2) }
      Button(intent: TogglePlaybackIntent()) {
        Image(systemName: playing ? "pause.fill" : "play.fill").font(.title)
      }
      Button(intent: SkipForwardIntent()) { Image(systemName: "goforward.30").font(.title2) }
    }
    .buttonStyle(.plain)
    .foregroundStyle(.white)
  }
}

/// Like the app's: shown only while a suspected ad break plays; nothing is ever skipped on its own.
private struct SkipAdButton: View {
  var body: some View {
    Button(intent: SkipAdIntent()) {
      HStack(spacing: 2) {
        Text("Skip ad")
        Image(systemName: "chevron.forward").imageScale(.small)
      }
      .font(.callout.weight(.bold))
      .foregroundStyle(PlaybackLiveActivity.ink)
      .padding(.leading, 14)
      .padding(.trailing, 10)
      .frame(height: 38)
      .background(Color(red: 0xF3 / 255, green: 0xF1 / 255, blue: 0xEC / 255), in: .capsule)
    }
    .buttonStyle(.plain)
  }
}

/// Snip, and a checkmark for a few seconds once one is made.
private struct SnipButton: View {
  let done: Bool
  let size: CGFloat

  var body: some View {
    Button(intent: SnipIntent()) {
      Image(systemName: done ? "checkmark" : "scissors")
        .font(.system(size: size * 0.42, weight: .bold))
        .foregroundStyle(PlaybackLiveActivity.ink)
        .frame(width: size, height: size)
        .background(PlaybackLiveActivity.accent, in: .circle)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(done ? "Snipped" : "Snip")
  }
}
