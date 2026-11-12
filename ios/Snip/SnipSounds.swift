import AVFoundation

/// Short sounds over the episode for what happens without looking: a tick when a snip tap is taken, a rising chime
/// once the server has the snip (a snip saved offline chimes when it is delivered), and a glide up when an ad break
/// is skipped on its own. They play through the app's own audio session, so they mix with the episode rather than
/// pausing it.
final class SnipSounds {
  private let request = SnipSounds.load("snip-request")
  private let created = SnipSounds.load("snip-created")
  private let adSkip = SnipSounds.load("ad-skip")  // ios/scripts/ad-skip-sound.py makes it

  func requested() { play(request) }
  func saved() { play(created) }
  func adSkipped() { play(adSkip) }

  private func play(_ player: AVAudioPlayer?) {
    guard let player else { return }
    #if DEBUG
      // `-muteAudio 1`, as for the episode: scripted simulator checks make no sound on the Mac.
      if UserDefaults.standard.bool(forKey: "muteAudio") { return }
    #endif
    player.currentTime = 0
    player.play()
  }

  private static func load(_ name: String) -> AVAudioPlayer? {
    guard let url = Bundle.main.url(forResource: name, withExtension: "wav"),
      let player = try? AVAudioPlayer(contentsOf: url)
    else { return nil }
    player.volume = 0.7
    player.prepareToPlay()
    return player
  }
}
