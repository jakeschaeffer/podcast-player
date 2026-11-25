// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "OnDevice",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "OnDevice", targets: ["OnDevice"])
  ],
  dependencies: [
    .package(path: "../PodcastAPI"),
    // The server's transcript core (normalize, detectAds), so a transcript made here is stored as the server would.
    .package(path: "../SnipCore"),
  ],
  targets: [
    // No third-party code: SQLite is the system's (`import SQLite3`), feeds are read with Foundation's XMLParser,
    // and speech is transcribed by the system's Speech framework.
    .target(name: "OnDevice", dependencies: ["PodcastAPI", "SnipCore"]),
    // Every route is driven through a real PodcastAPI.APIClient, so the app's own models do the decoding.
    .testTarget(name: "OnDeviceTests", dependencies: ["OnDevice", "PodcastAPI", "SnipCore"]),
  ]
)
