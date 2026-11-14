import AppIntents
import SwiftUI
import UIKit

// The activity's views. They live here rather than in the widget extension so the app's debug gallery can draw every
// state at real size (Snip/Debug/ActivityGallery.swift); SnipLiveActivity puts them in the lock screen and the Dynamic
// Island. Sizes follow the design mockup at the default text size and scale with Dynamic Type up to xxLarge, beyond
// which the lock screen's 160 pt limit would clip the longest title. Nothing is smaller than the 15 pt subheadline.

/// The app icon's amber and near-black, the cream of Skip ad and Play, and the failure red.
public enum ActivityPalette {
  public static let accent = Color(red: 0xF3 / 255, green: 0xA7 / 255, blue: 0x2A / 255)
  public static let ink = Color(red: 0x0E / 255, green: 0x0F / 255, blue: 0x11 / 255)
  public static let cream = Color(red: 0xF3 / 255, green: 0xF1 / 255, blue: 0xEC / 255)
  public static let warning = Color(red: 0xFF / 255, green: 0x7A / 255, blue: 0x6B / 255)
  /// The lock screen card's black, over the wallpaper.
  public static let plate = Color.black.opacity(0.76)
  static let secondary = Color.white.opacity(0.72)
  static let tertiary = Color.white.opacity(0.5)
  static let track = Color.white.opacity(0.16)
}

public typealias PlaybackState = PlaybackActivityAttributes.ContentState

// MARK: - Lock screen

/// The lock screen's card: the episode with Snip (and Play while paused); an ad break with its countdown, its own bar
/// and a wide Skip ad; or a snip's progress, which has the whole card.
public struct PlaybackLockScreenView: View {
  let state: PlaybackState

  public init(state: PlaybackState) { self.state = state }

  public var body: some View {
    Group {
      switch state.mode {
      case .adBreak: AdCard(state: state, island: false)
      case .snip(let snip): SnipRelay(snip: snip, island: false, paused: !state.playing)
      case .episode: EpisodeCard(state: state)
      }
    }
    .padding(EdgeInsets(top: 14, leading: 18, bottom: 14, trailing: 16))
    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
  }
}

/// Show, title (up to three lines) and position, with Snip centred on them so it lands in the same place whatever the
/// title's length. Paused, Play joins it and Snip keeps its place at the edge.
struct EpisodeCard: View {
  let state: PlaybackState

  var body: some View {
    HStack(spacing: 14) {
      VStack(alignment: .leading, spacing: 0) {
        Text(state.showTitle).font(.subheadline).foregroundStyle(ActivityPalette.secondary).lineLimit(1)
        Text(state.title).font(.headline).foregroundStyle(.white).lineLimit(3).padding(.top, 1)
        PositionLine(state: state).padding(.top, 3)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      HStack(spacing: 10) {
        if !state.playing { PlayButton(size: 48) }
        SnipButton(size: 48)
      }
    }
  }
}

/// "32:14 / 1:12:08", running while playing at normal speed; "Paused at 32:14 / 1:12:08" with a pause mark.
struct PositionLine: View {
  let state: PlaybackState

  var body: some View {
    let duration = ActivityClock.string(state.durationMs)
    HStack(spacing: 0) {
      if state.positionTicks {
        // Sized for where it will be by the next update, so crossing the hour doesn't cut it short. The space before
        // the duration is part of its width, which leaves the clock room should it draw a little wider than measured.
        RunningClock(
          range: state.timerRange, countsDown: false, reading: ActivityClock.string(state.positionMs + 20_000),
          style: .subheadline, trailingSpace: true)
        Text("/ \(duration)").foregroundStyle(ActivityPalette.tertiary)
      } else {
        if !state.playing { PauseMark().padding(.trailing, 6) }
        Text(state.playing ? ActivityClock.string(state.positionMs) : "Paused at \(ActivityClock.string(state.positionMs))")
        Text(" / \(duration)").foregroundStyle(ActivityPalette.tertiary)
      }
    }
    .font(.subheadline.monospacedDigit())
    .foregroundStyle(ActivityPalette.secondary)
    .lineLimit(1)
  }
}

// MARK: - Ad break

/// The title steps aside for the break: "Ad break · show", a big countdown, the break's own bar, and Skip ad as wide
/// as the card allows. Snip stays, for a moment heard just before the break; it shows a check while a snip made
/// meanwhile is still on its way, since the break has the card. In the island, the label and the countdown sit
/// beside the camera instead. Paused, the countdown stands still with a pause mark before it and Play joins Snip.
struct AdCard: View {
  let state: PlaybackState
  let island: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if !island {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
          Text("\(Text("Ad break").fontWeight(.semibold).foregroundStyle(ActivityPalette.accent)) · \(state.showTitle)")
            .font(.subheadline).foregroundStyle(ActivityPalette.secondary).lineLimit(1)
          Spacer(minLength: 0)
          if !state.playing {
            PauseMark().font(.title3.weight(.semibold)).foregroundStyle(ActivityPalette.secondary)
              .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
          }
          AdCountdown(state: state, style: .title1, size: 30).foregroundStyle(.white)
        }
        .padding(.bottom, 9)
      }
      AdBar(state: state)
      HStack(spacing: 12) {
        SkipAdButton(height: island ? 46 : 48)
        HStack(spacing: 10) {
          if !state.playing { PlayButton(size: island ? 46 : 48) }
          SnipButton(size: island ? 46 : 48, done: state.snip?.inProgress == true)
        }
      }
      .padding(.top, island ? 12 : 14)
    }
  }
}

/// The time left in the break, running while playing.
struct AdCountdown: View {
  let state: PlaybackState
  let style: UIFont.TextStyle
  let size: CGFloat?
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    if state.playing, let range = state.adBreakRange {
      RunningClock(range: range, countsDown: true, reading: ActivityClock.string(state.adBreakRemainingMs), style: style, size: size, weight: .semibold, alignment: .trailing)
    } else {
      Text(ActivityClock.string(state.adBreakRemainingMs))
        .font(Font(RunningClock.font(style: style, size: size, weight: .semibold, dynamicTypeSize: dynamicTypeSize) as CTFont))
    }
  }
}

/// The break as a bar that fills to its end.
struct AdBar: View {
  let state: PlaybackState

  var body: some View {
    Group {
      if state.playing, let range = state.adBreakRange {
        ProgressView(timerInterval: range, countsDown: false) { EmptyView() } currentValueLabel: { EmptyView() }
      } else {
        ProgressView(value: state.adBreakFraction)
      }
    }
    .progressViewStyle(.linear)
    .tint(ActivityPalette.accent)
    .scaleEffect(x: 1, y: 1.5)
    .accessibilityLabel("Ad break")
  }
}

/// Like the app's: shown only while a suspected ad break plays; nothing is ever skipped on its own.
struct SkipAdButton: View {
  let height: CGFloat

  var body: some View {
    Button(intent: SkipAdIntent()) {
      HStack(spacing: 3) {
        Text("Skip ad")
        Image(systemName: "chevron.forward").font(.subheadline.weight(.bold))
      }
      .font(.headline)
      .foregroundStyle(ActivityPalette.ink)
      .frame(maxWidth: .infinity)
      .frame(height: height)
      .background(ActivityPalette.cream, in: .capsule)
    }
    .buttonStyle(.plain)
  }
}

// MARK: - A snip's progress

/// After a snip: a headline and, under it, the step under way with three marks for choose, cut and name. When a step
/// finishes, both lines roll up (a push from the bottom, clipped to each line): the headline to what just finished,
/// the line under it to what's next. The last headline is the generated title, at a size that keeps any title the
/// server writes (60 characters at most) to two lines. A snip whose start came from the episode map has a title as
/// soon as its moment is chosen (the passage's), which stands in the headline while the clip is cut and named. Paused, Play stands at the edge, where it is on the episode's
/// card, and the title may take a third line on the lock screen for the room Play takes.
struct SnipRelay: View {
  let snip: SnipProgress
  let island: Bool
  var paused = false
  @ScaledMetric(relativeTo: .title) private var headlineSize: CGFloat = 30
  @ScaledMetric(relativeTo: .title2) private var titleSize: CGFloat = 24

  var body: some View {
    HStack(spacing: 14) {
      VStack(alignment: .leading, spacing: 8) {
        Rolling(id: snip.step) { headline }
        // In the island, "Saved" and the length sit beside the camera once the title is in.
        if !(island && snip.step == .named) {
          Rolling(id: snip.step) { status }
        }
      }
      .frame(maxWidth: .infinity, minHeight: island ? nil : 66, alignment: .leading)
      if paused { PlayButton(size: island ? 44 : 48) }
    }
  }

  @ViewBuilder private var headline: some View {
    switch snip.step {
    case .cutting where snip.title != nil, .naming where snip.title != nil:
      Text(snip.title ?? "Snip")
        .font(.system(size: titleSize, weight: .semibold))
        .lineLimit(paused && !island ? 3 : 2)
        .minimumScaleFactor(paused ? 0.75 : 0.85)
    case .named:
      Text(snip.title ?? "Snip")
        .font(.system(size: titleSize, weight: .semibold))
        .lineLimit(paused && !island ? 3 : 2)
        .minimumScaleFactor(paused ? 0.75 : 0.85)
    case .failed:
      HStack(spacing: 9) {
        Image(systemName: "exclamationmark.triangle").foregroundStyle(ActivityPalette.warning)
        Text("Snip failed")
      }
      .font(.system(size: headlineSize, weight: .semibold))
    case .onPhone:
      Text("Snip kept on the phone")
        .font(.system(size: headlineSize, weight: .semibold))
        .lineLimit(1)
        .minimumScaleFactor(0.6)
      .lineLimit(1)
      .minimumScaleFactor(0.6)
    default:
      Text(headlineText)
        .font(.system(size: headlineSize, weight: .semibold).monospacedDigit())
        .lineLimit(1)
        .minimumScaleFactor(0.6)
    }
  }

  private var headlineText: String {
    switch snip.step {
    case .waitingForTranscript: "Waiting for the transcript"
    case .cutting: "Snipped at \(ActivityClock.string(snip.anchorMs))"
    case .naming: "Clip ready"
    default: "Choosing the moment…"
    }
  }

  private var status: some View {
    HStack(spacing: 10) {
      switch snip.step {
      case .named:
        Image(systemName: "checkmark").font(.subheadline.weight(.bold)).foregroundStyle(ActivityPalette.accent)
      case .failed:
        EmptyView()
      case .onPhone:
        Image(systemName: "wifi.slash").font(.subheadline.weight(.semibold))
      default:
        Steps(done: snip.stepsDone)
      }
      Text(statusText).lineLimit(snip.step == .failed ? 2 : 1)
    }
    .font(.subheadline.monospacedDigit())
    .foregroundStyle(ActivityPalette.secondary)
  }

  private var statusText: String {
    switch snip.step {
    case .choosing, .waitingForTranscript: "Snipped at…"
    case .cutting: "Preparing the clip…"
    case .naming: "Naming it…"
    case .named: ["Saved", snip.lengthMs.map(ActivityClock.string), "tap to rename"].compactMap(\.self).joined(separator: " · ")
    case .failed: snip.error ?? "Open the app to try again."
    case .onPhone: "Snipped at \(ActivityClock.string(snip.anchorMs)) · sends when online"
    }
  }
}

/// A line that rolls up to its next words when `id` changes, clipped to itself.
struct Rolling<Content: View>: View {
  let id: SnipProgress.Step
  @ViewBuilder let content: Content

  var body: some View {
    ZStack(alignment: .leading) {
      content.id(id).transition(.push(from: .bottom))
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .clipped()
  }
}

/// Three marks for choose, cut and name: done ones amber, the one under way half amber.
struct Steps: View {
  let done: Int
  var compact = false

  var body: some View {
    let (width, height): (CGFloat, CGFloat) = compact ? (10, 5) : (20, 6)
    HStack(spacing: compact ? 3 : 4) {
      ForEach(0..<3, id: \.self) { i in
        Capsule()
          .fill(i < done ? ActivityPalette.accent : ActivityPalette.track)
          .overlay(alignment: .leading) {
            if i == done { Rectangle().fill(ActivityPalette.accent).frame(width: width / 2) }
          }
          .clipShape(.capsule)
          .frame(width: width, height: height)
      }
    }
    .accessibilityHidden(true)
  }
}

// MARK: - Buttons

/// Snip: the amber circle with scissors; a check while a snip is on its way and the card can't show it.
struct SnipButton: View {
  let size: CGFloat
  var done = false

  var body: some View {
    Button(intent: SnipIntent()) {
      Image(systemName: done ? "checkmark" : "scissors")
        .font(.system(size: size * 0.44, weight: .bold))
        .foregroundStyle(ActivityPalette.ink)
        .frame(width: size, height: size)
        .background(ActivityPalette.accent, in: .circle)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(done ? "Snipped" : "Snip")
  }
}

/// Play, shown only while paused.
struct PlayButton: View {
  let size: CGFloat

  var body: some View {
    Button(intent: TogglePlaybackIntent()) {
      Image(systemName: "play.fill")
        .font(.system(size: size * 0.42, weight: .bold))
        .offset(x: size * 0.04)  // a triangle looks centred a little right of the middle
        .foregroundStyle(ActivityPalette.ink)
        .frame(width: size, height: size)
        .background(ActivityPalette.cream, in: .circle)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Play")
  }
}

/// The two bars of "paused", at the size of the text beside them.
struct PauseMark: View {
  var body: some View {
    Image(systemName: "pause.fill").imageScale(.small).accessibilityHidden(true)
  }
}

// MARK: - Dynamic Island

/// Beside the camera, on the left: the show, "Ad break", or the snip's scissors (a check and "Saved" once named).
public struct PlaybackIslandLeading: View {
  let state: PlaybackState

  public init(state: PlaybackState) { self.state = state }

  public var body: some View {
    Group {
      switch state.mode {
      case .adBreak:
        Text("Ad break").fontWeight(.semibold).foregroundStyle(ActivityPalette.accent)
      case .snip(let snip):
        switch snip.step {
        case .named:
          Label("Saved", systemImage: "checkmark").fontWeight(.semibold).foregroundStyle(ActivityPalette.accent)
        case .failed:
          Image(systemName: "exclamationmark.triangle").fontWeight(.semibold).foregroundStyle(ActivityPalette.warning)
        default:
          Image(systemName: "scissors").fontWeight(.semibold).foregroundStyle(ActivityPalette.accent)
        }
      case .episode:
        Text(state.showTitle).foregroundStyle(ActivityPalette.secondary)
      }
    }
    .font(.subheadline)
    .lineLimit(1)
    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
  }
}

/// Beside the camera, on the right: the position, the break's countdown, or a named snip's length.
public struct PlaybackIslandTrailing: View {
  let state: PlaybackState

  public init(state: PlaybackState) { self.state = state }

  public var body: some View {
    Group {
      switch state.mode {
      case .adBreak:
        HStack(spacing: 7) {
          if !state.playing { PauseMark() }
          AdCountdown(state: state, style: .title3, size: 20).foregroundStyle(.white)
        }
      case .snip(let snip):
        if snip.step == .named, let length = snip.lengthMs {
          Text(ActivityClock.string(length)).foregroundStyle(ActivityPalette.secondary)
        }
      case .episode:
        if state.positionTicks {
          RunningClock(range: state.timerRange, countsDown: false, reading: ActivityClock.string(state.positionMs + 20_000), style: .subheadline, alignment: .trailing)
        } else {
          HStack(spacing: 7) {
            if !state.playing { PauseMark() }
            Text(ActivityClock.string(state.positionMs))
          }
        }
      }
    }
    .font(.subheadline.monospacedDigit())
    .foregroundStyle(ActivityPalette.secondary)
    .lineLimit(1)
    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
  }
}

/// Under the camera: the title with Snip (and Play while paused), the ad break's bar and Skip ad, or the snip's
/// progress as on the lock screen.
public struct PlaybackIslandBottom: View {
  let state: PlaybackState

  public init(state: PlaybackState) { self.state = state }

  public var body: some View {
    Group {
      switch state.mode {
      case .adBreak:
        AdCard(state: state, island: true)
      case .snip(let snip):
        SnipRelay(snip: snip, island: true, paused: !state.playing)
      case .episode:
        HStack(spacing: 14) {
          Text(state.title).font(.headline).foregroundStyle(.white).lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
          HStack(spacing: 10) {
            if !state.playing { PlayButton(size: 44) }
            SnipButton(size: 44)
          }
        }
      }
    }
    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
  }
}

/// The compact island's left end: scissors, "Ad" in a break, a check once a snip is named.
public struct PlaybackCompactLeading: View {
  let state: PlaybackState

  public init(state: PlaybackState) { self.state = state }

  public var body: some View {
    Group {
      switch state.mode {
      case .adBreak:
        Text("Ad").font(.subheadline.weight(.semibold)).foregroundStyle(ActivityPalette.accent)
      case .snip(let snip) where snip.step == .named:
        Image(systemName: "checkmark").fontWeight(.bold).foregroundStyle(ActivityPalette.accent)
      case .snip(let snip) where snip.step == .failed:
        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(ActivityPalette.warning)
      default:
        Image(systemName: "scissors").fontWeight(.semibold).foregroundStyle(ActivityPalette.accent)
      }
    }
    .dynamicTypeSize(...DynamicTypeSize.large)
  }
}

/// The compact island's right end: the episode's progress ring, a pause mark, the break's countdown, or the snip's steps.
public struct PlaybackCompactTrailing: View {
  let state: PlaybackState

  public init(state: PlaybackState) { self.state = state }

  public var body: some View {
    Group {
      switch state.mode {
      case .adBreak:
        if state.playing {
          AdCountdown(state: state, style: .subheadline, size: nil).foregroundStyle(ActivityPalette.accent)
        } else {
          PauseMark().foregroundStyle(ActivityPalette.secondary)
        }
      case .snip(let snip):
        if snip.step != .failed { Steps(done: snip.stepsDone, compact: true) }
      case .episode:
        if state.playing {
          ProgressView(timerInterval: state.timerRange, countsDown: false) { EmptyView() } currentValueLabel: { EmptyView() }
            .progressViewStyle(.circular)
            .tint(ActivityPalette.accent)
            .frame(width: 19, height: 19)
        } else {
          PauseMark().foregroundStyle(ActivityPalette.secondary)
        }
      }
    }
    .dynamicTypeSize(...DynamicTypeSize.large)
  }
}

/// The island's smallest form, beside another app's activity: scissors, "Ad", or a check once a snip is named.
public struct PlaybackMinimal: View {
  let state: PlaybackState

  public init(state: PlaybackState) { self.state = state }

  public var body: some View {
    Group {
      switch state.mode {
      case .adBreak:
        Text("Ad").font(.subheadline.weight(.bold))
      case .snip(let snip) where snip.step == .named:
        Image(systemName: "checkmark").fontWeight(.bold)
      default:
        Image(systemName: "scissors").fontWeight(.semibold)
      }
    }
    .foregroundStyle(ActivityPalette.accent)
    .dynamicTypeSize(...DynamicTypeSize.large)
  }
}

// MARK: - Running clocks

/// A clock that runs by itself between updates (`Text(timerInterval:)`), held to the width of what it reads now: left
/// alone, a timer takes all the room it is offered and pushes its neighbours aside.
struct RunningClock: View {
  let range: ClosedRange<Date>
  let countsDown: Bool
  /// What it reads now, which sets its width.
  let reading: String
  let style: UIFont.TextStyle
  /// A size at the default text size other than the style's own, scaled as the style is.
  var size: CGFloat?
  var weight: UIFont.Weight = .regular
  var alignment: Alignment = .leading
  /// Include the space after it in its width, as the room it may need to draw wider than measured; otherwise 2 pt.
  var trailingSpace = false
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    let font = Self.font(style: style, size: size, weight: weight, dynamicTypeSize: dynamicTypeSize)
    let width = { (text: String) in (text as NSString).size(withAttributes: [.font: font]).width }
    Text(timerInterval: range, countsDown: countsDown)
      .font(Font(font as CTFont))
      .frame(width: ceil(width(reading)) + (trailingSpace ? width(" ") : 2), alignment: alignment)
  }

  /// The system font with even-width digits, at `style`'s size (or `size`) scaled to the text size.
  static func font(style: UIFont.TextStyle, size: CGFloat?, weight: UIFont.Weight, dynamicTypeSize: DynamicTypeSize) -> UIFont {
    let base = size ?? UIFont.preferredFont(forTextStyle: style, compatibleWith: UITraitCollection(preferredContentSizeCategory: .large)).pointSize
    let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicTypeSize))
    return .monospacedDigitSystemFont(ofSize: UIFontMetrics(forTextStyle: style).scaledValue(for: base, compatibleWith: traits), weight: weight)
  }
}
