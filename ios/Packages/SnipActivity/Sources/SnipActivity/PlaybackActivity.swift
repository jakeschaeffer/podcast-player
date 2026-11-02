import ActivityKit
import AppIntents
import Foundation

/// The Live Activity for what is playing: on the lock screen and in the Dynamic Island, with play/pause, skips and
/// Snip. Started and updated by the app (local updates only; there is no push). One activity spans a listening
/// session, so the episode lives in the state: an app may start an activity only in the foreground, but the next
/// episode in the queue starts in the background.
public struct PlaybackActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable, Sendable {
    public var episodeID: String
    public var showTitle: String
    public var title: String
    public var playing: Bool
    /// Where playback was at `at`; while playing it advances at `speed`, which the views draw with a timer.
    public var positionMs: Int
    public var durationMs: Int
    public var speed: Double
    public var at: Date
    /// A banner for a few seconds after a snip ("Snipped at 7:19"), shown in place of the titles; else nil.
    public var note: String?
    /// Set while a suspected ad break plays: where Skip ad would go.
    public var adBreakEndMs: Int?

    public init(episodeID: String, showTitle: String, title: String, playing: Bool, positionMs: Int, durationMs: Int, speed: Double, at: Date = .now, note: String? = nil, adBreakEndMs: Int? = nil) {
      self.episodeID = episodeID
      self.showTitle = showTitle
      self.title = title
      self.playing = playing
      self.positionMs = positionMs
      self.durationMs = durationMs
      self.speed = speed
      self.at = at
      self.note = note
      self.adBreakEndMs = adBreakEndMs
    }

    /// The span a progress timer runs over: when the episode started and when it will end, at the current speed.
    public var timerRange: ClosedRange<Date> {
      let speed = max(self.speed, 0.1)
      let start = at.addingTimeInterval(-Double(positionMs) / 1000 / speed)
      let end = at.addingTimeInterval(Double(max(durationMs - positionMs, 0)) / 1000 / speed)
      return start...max(end, start.addingTimeInterval(1))
    }

    public var fraction: Double { durationMs > 0 ? min(max(Double(positionMs) / Double(durationMs), 0), 1) : 0 }
  }

  public init() {}
}

/// What the activity's buttons do. The app installs `handler` at launch; the intents run in the app's process
/// (`LiveActivityIntent`), so they reach the player directly.
public enum PlaybackActivityAction: Sendable {
  case toggle, back, forward, snip, skipAd
}

@MainActor
public enum PlaybackActivityControl {
  public static var handler: (@MainActor (PlaybackActivityAction) async -> Void)?

  static func run(_ action: PlaybackActivityAction) async {
    await handler?(action)
  }
}

public struct TogglePlaybackIntent: LiveActivityIntent {
  public static let title: LocalizedStringResource = "Play or pause"
  public init() {}
  public func perform() async throws -> some IntentResult {
    await PlaybackActivityControl.run(.toggle)
    return .result()
  }
}

public struct SkipBackIntent: LiveActivityIntent {
  public static let title: LocalizedStringResource = "Back 15 seconds"
  public init() {}
  public func perform() async throws -> some IntentResult {
    await PlaybackActivityControl.run(.back)
    return .result()
  }
}

public struct SkipForwardIntent: LiveActivityIntent {
  public static let title: LocalizedStringResource = "Forward 30 seconds"
  public init() {}
  public func perform() async throws -> some IntentResult {
    await PlaybackActivityControl.run(.forward)
    return .result()
  }
}

public struct SnipIntent: LiveActivityIntent {
  public static let title: LocalizedStringResource = "Snip"
  public static let description = IntentDescription("Save the moment you just heard.")
  public init() {}
  public func perform() async throws -> some IntentResult {
    await PlaybackActivityControl.run(.snip)
    return .result()
  }
}

public struct SkipAdIntent: LiveActivityIntent {
  public static let title: LocalizedStringResource = "Skip ad"
  public init() {}
  public func perform() async throws -> some IntentResult {
    await PlaybackActivityControl.run(.skipAd)
    return .result()
  }
}
