#if DEBUG
  import Foundation

  /// Simulator sign-in from a file on the Mac, adapted from audiobooth-fork's DebugLaunchOptions. DEBUG-only by
  /// construction: the whole file compiles out of release builds.
  ///
  /// The file is `~/.config/podcast-player/devauth.json` on the *host*, outside the working tree, so the token
  /// can't be committed by accident. It holds a device token, never the owner password, and the server can revoke
  /// that device on its own (`DELETE /v1/devices/{id}`):
  ///
  ///     { "server": "http://localhost:8081", "token": "pp_…" }
  ///
  /// It is a fallback for an empty Keychain, not an override: a real sign-in wins.
  enum DevAuth {
    struct File: Decodable {
      let server: URL
      let token: String
    }

    static func load() -> File? {
      let environment = ProcessInfo.processInfo.environment
      // Inside the simulator HOME is the app's container; SIMULATOR_HOST_HOME is the Mac user's home.
      let candidates = [
        environment["SNIP_DEV_AUTH_FILE"],
        environment["SIMULATOR_HOST_HOME"].map { "\($0)/.config/podcast-player/devauth.json" },
      ]
      guard
        let path = candidates.compactMap({ $0 }).first(where: { FileManager.default.fileExists(atPath: $0) }),
        let data = FileManager.default.contents(atPath: path)
      else { return nil }
      guard let file = try? JSONDecoder().decode(File.self, from: data) else {
        print("DEV-AUTH \(path) is not valid JSON; ignoring")
        return nil
      }
      print("DEV-AUTH using \(file.server.absoluteString) from \(path)")
      return file
    }
  }
#endif
