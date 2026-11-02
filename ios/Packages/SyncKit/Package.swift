// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "SyncKit",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "SyncKit", targets: ["SyncKit"])
  ],
  dependencies: [
    .package(path: "../PodcastAPI")
  ],
  targets: [
    .target(name: "SyncKit", dependencies: ["PodcastAPI"]),
    .testTarget(name: "SyncKitTests", dependencies: ["SyncKit"]),
  ]
)
