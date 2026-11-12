// A port of web/src/lib/adBreaks.ts (when "Skip ad" shows), and the native app's own setting to skip ads by itself.
import Foundation
import PodcastAPI

public enum AdSkip {
  /// No skip is offered in a break's last moments: by the time the button could be pressed, the ad is over.
  public static let tailMs = 1_500
  /// How long "Undo skip" stays after a break was skipped on its own.
  public static let undoSeconds = 10
  /// The setting (UserDefaults, a Bool): skip each ad break as playback reaches it. Off by default.
  public static let automaticKey = "player.autoSkipAds"

  /// The suspected ad break playing at `positionMs`, if any: the one "Skip ad" would leave.
  public static func breakAt(_ breaks: [AdBreak]?, positionMs: Int) -> AdBreak? {
    breaks?.first { positionMs >= $0.startMs && positionMs < $0.endMs - tailMs }
  }

  /// With ads skipped automatically, the break to leave now: the one playing, unless the listener went into it
  /// themselves (`chosen`: a scrub, a skip back or Undo skip landed in it), or it is the one just left (`skipped`),
  /// so a late tick from before the jump can't skip it twice. Breaks reached by playing are skipped, wherever playing
  /// started: from an episode's start into its opening ads, or from a resume point in the middle of one.
  public static func automatic(
    _ breaks: [AdBreak]?, positionMs: Int, playing: Bool, chosen: AdBreak?, skipped: AdBreak?
  ) -> AdBreak? {
    guard playing, let b = breakAt(breaks, positionMs: positionMs), b != chosen, b != skipped else { return nil }
    return b
  }
}

extension PlayerEngine {
  /// The ad break playing now, while the recording is ready; nil otherwise.
  public var currentAdBreak: AdBreak? {
    status == .ready ? AdSkip.breakAt(episode?.adBreaks, positionMs: positionMs) : nil
  }

  /// The owner's setting: each ad break is skipped as playback reaches it, with a sound (`onAdSkipped`).
  public var skipsAdsAutomatically: Bool { UserDefaults.standard.bool(forKey: AdSkip.automaticKey) }

  /// Seek past the ad break playing now (the Skip ad button).
  public func skipAd() {
    if let b = currentAdBreak { seek(to: b.endMs) }
  }

  /// Go back to the start of the break just skipped on its own; it then plays, as one the listener chose.
  public func undoAdSkip() {
    if let b = skippedAd { seek(to: b.startMs) }
  }
}
