import ActivityKit
import AppIntents
import Foundation

/// The Live Activity for what is playing, on the lock screen and in the Dynamic Island. Play, pause and the skips are
/// left to the system's Now Playing card, which is always there while audio plays; the activity shows what that card
/// can't: the whole title and the position, Snip, an ad break with Skip ad, and a snip's way from the tap to its title.
/// Play joins Snip while paused, since the system card can leave a while after audio stops.
///
/// Started and updated by the app (local updates only; there is no push). One activity spans a listening session, so
/// the episode lives in the state: an app may start an activity only in the foreground, but the next episode in the
/// queue starts in the background.
public struct PlaybackActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable, Sendable {
    public var episodeID: String
    public var showTitle: String
    public var title: String
    public var playing: Bool
    /// Where playback was at `at`; while playing it advances at `speed`, which the views draw with timers.
    public var positionMs: Int
    public var durationMs: Int
    public var speed: Double
    public var at: Date
    /// Set while a suspected ad break plays: where it began (its bar fills from there) and where Skip ad would go.
    public var adBreakStartMs: Int?
    public var adBreakEndMs: Int?
    /// The latest snip, from the tap until a while after its title is in. It takes the card meanwhile, except during
    /// an ad break, whose Skip ad can't wait.
    public var snip: SnipProgress?

    public init(
      episodeID: String, showTitle: String, title: String, playing: Bool, positionMs: Int, durationMs: Int,
      speed: Double, at: Date = .now, adBreakStartMs: Int? = nil, adBreakEndMs: Int? = nil, snip: SnipProgress? = nil
    ) {
      self.episodeID = episodeID
      self.showTitle = showTitle
      self.title = title
      self.playing = playing
      self.positionMs = positionMs
      self.durationMs = durationMs
      self.speed = speed
      self.at = at
      self.adBreakStartMs = adBreakStartMs
      self.adBreakEndMs = adBreakEndMs
      self.snip = snip
    }
  }

  public init() {}
}

extension PlaybackActivityAttributes.ContentState {
  /// What the card is about: an ad break first, then a snip, then the episode.
  public enum Mode: Equatable, Sendable {
    case adBreak
    case snip(SnipProgress)
    case episode
  }

  public var mode: Mode {
    if adBreakRange != nil { return .adBreak }
    if let snip { return .snip(snip) }
    return .episode
  }

  /// When playback reaches `ms` of the episode at the current speed; in the past for a point already played.
  public func date(atMs ms: Int) -> Date {
    at.addingTimeInterval(Double(ms - positionMs) / 1000 / max(speed, 0.1))
  }

  /// The span a progress timer runs over: when the episode started and when it will end, at the current speed.
  public var timerRange: ClosedRange<Date> {
    let start = date(atMs: 0)
    return start...max(date(atMs: max(durationMs, positionMs)), start.addingTimeInterval(1))
  }

  public var fraction: Double { durationMs > 0 ? min(max(Double(positionMs) / Double(durationMs), 0), 1) : 0 }

  /// A timer counts wall-clock seconds, so a running clock can show the position only at normal speed; at any other
  /// speed the position is drawn as of the last update (the player reports every 15 s).
  public var positionTicks: Bool { playing && abs(speed - 1) < 0.01 }

  /// The ad break playing, as wall-clock time: its bar fills over this span and its countdown ends with it.
  public var adBreakRange: ClosedRange<Date>? {
    guard let start = adBreakStartMs, let end = adBreakEndMs, end > start else { return nil }
    return date(atMs: start)...date(atMs: end)
  }

  /// How much of the ad break is left, in wall-clock time at the current speed, as of `at`.
  public var adBreakRemainingMs: Int {
    guard let end = adBreakEndMs else { return 0 }
    return Int((Double(max(end - positionMs, 0)) / max(speed, 0.1)).rounded())
  }

  public var adBreakFraction: Double {
    guard let start = adBreakStartMs, let end = adBreakEndMs, end > start else { return 0 }
    return min(max(Double(positionMs - start) / Double(end - start), 0), 1)
  }

  /// Where a tap on the card goes: once a snip's title is in, to renaming it in the app. Otherwise nil, and a tap opens
  /// the app as it was.
  public var renameURL: URL? { SnipLink.appScheme.flatMap(renameURL(scheme:)) }

  func renameURL(scheme: String) -> URL? {
    guard case .snip(let snip) = mode, snip.step == .named, let id = snip.snipID else { return nil }
    return SnipLink.rename(id, scheme: scheme)
  }
}

/// One snip on its way from the tap to its title, as the activity shows it: a headline for the step just finished
/// (at first, the one under way) and under it the step under way. When a step finishes, the line under the headline
/// moves up into it.
public struct SnipProgress: Codable, Hashable, Sendable {
  public enum Step: String, Codable, Sendable {
    /// The server is choosing the moment, or hasn't got the tap yet.
    case choosing
    /// The episode has no transcript yet; the moment is chosen once it has.
    case waitingForTranscript
    /// The moment is chosen and the clip is being cut.
    case cutting
    /// The clip is cut and its title is being written.
    case naming
    /// Done: the title is in.
    case named
    case failed
  }

  public var step: Step
  /// The snip's id once the server has it; a tap made offline has none yet.
  public var snipID: String?
  /// Where the tap was, for "Snipped at 7:19".
  public var anchorMs: Int
  /// The clip's length, once the moment is chosen.
  public var lengthMs: Int?
  public var title: String?
  /// Why it failed, in the server's words.
  public var error: String?

  public init(step: Step, snipID: String? = nil, anchorMs: Int, lengthMs: Int? = nil, title: String? = nil, error: String? = nil) {
    self.step = step
    self.snipID = snipID
    self.anchorMs = anchorMs
    self.lengthMs = lengthMs
    self.title = title
    self.error = error
  }

  /// How many of the three steps (choose the moment, cut the clip, name it) are done.
  public var stepsDone: Int {
    switch step {
    case .choosing, .waitingForTranscript, .failed: 0
    case .cutting: 1
    case .naming: 2
    case .named: 3
    }
  }

  /// The server is still working on it.
  public var inProgress: Bool { step != .named && step != .failed }
}

/// The link the activity opens when a snip's title is tapped: the app comes up on that snip with its title selected,
/// ready to type over. The scheme is the app's bundle id, which the app registers (Config/Info.plist), so nothing of
/// one deployment is written here.
public enum SnipLink {
  public static func rename(_ snipID: String) -> URL? {
    appScheme.flatMap { rename(snipID, scheme: $0) }
  }

  static func rename(_ snipID: String, scheme: String) -> URL? {
    var link = URLComponents()
    link.scheme = scheme
    link.host = "snips"
    link.path = "/\(snipID)/rename"
    return link.url
  }

  /// The snip a rename link names, if `url` is one.
  public static func renamedSnip(in url: URL) -> String? {
    guard url.host() == "snips" else { return nil }
    let parts = url.pathComponents.filter { $0 != "/" }
    guard parts.count == 2, parts[1] == "rename", !parts[0].isEmpty else { return nil }
    return parts[0]
  }

  /// The app's bundle id, read in the app or in its Live Activity extension, whose bundle id is the app's plus one more
  /// part (Apple requires the prefix).
  static var appScheme: String? {
    guard let id = Bundle.main.bundleIdentifier else { return nil }
    let app = Bundle.main.bundleURL.pathExtension == "appex" ? id.split(separator: ".").dropLast().joined(separator: ".") : id
    return app.isEmpty ? nil : app.lowercased()
  }
}

/// Times as the app writes them: 1:02:03 or 4:05.
public enum ActivityClock {
  public static func string(_ ms: Int) -> String {
    let total = max(0, ms / 1000)
    let (h, m, s) = (total / 3600, total / 60 % 60, total % 60)
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
  }
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

/// Not drawn on the activity any more (the system's Now Playing card has the skips); kept so nothing that names these
/// intents breaks.
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
