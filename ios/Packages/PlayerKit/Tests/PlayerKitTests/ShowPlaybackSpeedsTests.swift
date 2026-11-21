import Foundation
import Testing
@testable import PlayerKit

@Test func playbackSpeedIsRememberedPerShow() throws {
  let suite = "ShowPlaybackSpeedsTests.\(UUID().uuidString)"
  let defaults = try #require(UserDefaults(suiteName: suite))
  defer { defaults.removePersistentDomain(forName: suite) }
  defaults.set(2.0, forKey: "player.speed") // The old global speed isn't a show's choice.
  let speeds = ShowPlaybackSpeeds(defaults: defaults)
  #expect(speeds.speed(for: "show-a") == 1)
  speeds.setSpeed(1.5, for: "show-a")
  #expect(speeds.speed(for: "show-b") == 1)
  speeds.setSpeed(1.25, for: "show-b")

  let reopened = ShowPlaybackSpeeds(defaults: try #require(UserDefaults(suiteName: suite)))
  #expect(reopened.speed(for: "show-a") == 1.5)
  #expect(reopened.speed(for: "show-b") == 1.25)
}
