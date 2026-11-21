import Foundation

/// The last speed chosen in the player for each feed, kept on this device.
struct ShowPlaybackSpeeds {
  var defaults: UserDefaults = .standard

  func speed(for feedID: String) -> Double {
    defaults.object(forKey: key(for: feedID)) as? Double ?? 1
  }

  func setSpeed(_ speed: Double, for feedID: String) {
    defaults.set(speed, forKey: key(for: feedID))
  }

  private func key(for feedID: String) -> String { "player.speed.show.\(feedID)" }
}
