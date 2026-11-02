// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "PlayerKit",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "PlayerKit", targets: ["PlayerKit"])
  ],
  dependencies: [
    .package(path: "../PodcastAPI")
  ],
  targets: [
    .target(name: "PlayerKit", dependencies: ["PodcastAPI"]),
    // The golden tests read ../../../../contracts/golden by path, like PodcastAPI's decode tests.
    .testTarget(name: "PlayerKitTests", dependencies: ["PlayerKit"]),
  ]
)
