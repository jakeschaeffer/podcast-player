import AVFoundation

/// Two short sounds over the episode for a snip made without looking: a tick when the tap is taken, and a rising
/// chime once the server has the snip. A snip saved offline chimes when it is delivered. They play through the
/// app's own audio session, so they mix with the episode rather than pausing it.
final class SnipSounds {
  private let request = SnipSounds.load("snip-request")
  private let created = SnipSounds.load("snip-created")

  func requested() { play(request) }
  func saved() { play(created) }

  private func play(_ player: AVAudioPlayer?) {
    guard let player else { return }
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
