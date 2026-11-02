import AVFoundation
import MediaPlayer

/// Spoken-word, long-form playback that keeps going in the background and on the lock screen.
enum AudioSessionController {
  static func configure() {
    #if os(iOS)
      let session = AVAudioSession.sharedInstance()
      try? session.setCategory(.playback, mode: .spokenAudio, policy: .longFormAudio)
    #endif
  }

  /// Made active before each play, so that after an interruption (a call, Siri, another app's audio) the app takes
  /// the audio, and with it the headphones' buttons, back.
  static func activate() {
    #if os(iOS)
      try? AVAudioSession.sharedInstance().setActive(true)
    #endif
  }
}

/// Lock screen and Control Center metadata.
@MainActor
enum NowPlaying {
  static func update(for engine: PlayerEngine) {
    guard let ep = engine.episode else {
      // Between episodes (loading the next) the last entry stays, so the headphones' buttons keep reaching the app.
      if engine.status == .idle { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil }
      return
    }
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: ep.title,
      MPMediaItemPropertyArtist: ep.showTitle ?? "",
      MPMediaItemPropertyPlaybackDuration: Double(engine.durationMs) / 1000,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: Double(engine.positionMs) / 1000,
      MPNowPlayingInfoPropertyPlaybackRate: engine.playing ? engine.speed : 0,
      MPNowPlayingInfoPropertyDefaultPlaybackRate: engine.speed,
    ]
    if let artwork = engine.nowPlayingArtwork { info[MPMediaItemPropertyArtwork] = artwork }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }
}

/// Headphone, lock screen and Control Center buttons, installed once for the app and acting on the latest engine
/// (signing in again makes a new one). Skips go through the engine so heard tracking sees them.
///
/// Headphones send "next track" and "previous track" (AirPods: a double press and a triple press, or a double tap
/// set to Next or Previous Track per ear), never which ear. Next track snips (`onNextTrack`); previous track goes back
/// 15 s. The 15/30 s skip commands are on too: the lock screen draws their circular buttons in place of ⏮/⏭ when
/// both are enabled, while headphones still send next/previous track.
@MainActor
enum RemoteCommands {
  private static weak var engine: PlayerEngine?
  private static var installed = false

  static func install(on engine: PlayerEngine) {
    Self.engine = engine
    guard !installed else { return }
    installed = true
    let center = MPRemoteCommandCenter.shared()
    func handle(_ command: MPRemoteCommand, _ action: @escaping @MainActor (PlayerEngine) -> Void) {
      command.isEnabled = true
      command.addTarget { _ in
        MainActor.assumeIsolated {
          guard let engine = Self.engine, engine.episode != nil else { return .noActionableNowPlayingItem }
          action(engine)
          return .success
        }
      }
    }
    handle(center.playCommand) { $0.play() }
    handle(center.pauseCommand) { $0.pause() }
    handle(center.togglePlayPauseCommand) { $0.toggle() }
    handle(center.nextTrackCommand) { $0.onNextTrack?() }
    handle(center.previousTrackCommand) { $0.skip(by: -15_000) }
    center.skipBackwardCommand.preferredIntervals = [15]
    handle(center.skipBackwardCommand) { $0.skip(by: -15_000) }
    center.skipForwardCommand.preferredIntervals = [30]
    handle(center.skipForwardCommand) { $0.skip(by: 30_000) }
    center.changePlaybackPositionCommand.isEnabled = true
    center.changePlaybackPositionCommand.addTarget { event in
      MainActor.assumeIsolated {
        guard let e = event as? MPChangePlaybackPositionCommandEvent, let engine = Self.engine else { return .commandFailed }
        engine.seek(to: Int(e.positionTime * 1000))
        return .success
      }
    }
  }
}
