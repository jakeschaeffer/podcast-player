// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "PodcastAPI",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "PodcastAPI", targets: ["PodcastAPI"])
  ],
  targets: [
    .target(name: "PodcastAPI"),
    // The decode tests read ../../../../contracts/api by path, so the server's recordings stay the only copy.
    .testTarget(name: "PodcastAPITests", dependencies: ["PodcastAPI"]),
  ]
)
