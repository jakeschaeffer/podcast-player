// A port of web/src/lib/adBreaks.ts: when "Skip ad" shows.
import PodcastAPI

public enum AdSkip {
  /// No skip is offered in a break's last moments: by the time the button could be pressed, the ad is over.
  public static let tailMs = 1_500

  /// The suspected ad break playing at `positionMs`, if any: the one "Skip ad" would leave.
  public static func breakAt(_ breaks: [AdBreak]?, positionMs: Int) -> AdBreak? {
    breaks?.first { positionMs >= $0.startMs && positionMs < $0.endMs - tailMs }
  }
}

extension PlayerEngine {
  /// The ad break playing now, while the recording is ready; nil otherwise.
  public var currentAdBreak: AdBreak? {
    status == .ready ? AdSkip.breakAt(episode?.adBreaks, positionMs: positionMs) : nil
  }

  /// Seek past the ad break playing now. Only ever on a tap; nothing skips on its own.
  public func skipAd() {
    if let b = currentAdBreak { seek(to: b.endMs) }
  }
}
