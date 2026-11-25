// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "SnipCore",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "SnipCore", targets: ["SnipCore"])
  ],
  targets: [
    // The server's pure core (server/src/core) in Swift: no I/O and no packages, so anything may link it.
    .target(name: "SnipCore"),
    // The golden tests read ../../../../contracts/golden by path, like PlayerKit's.
    .testTarget(name: "SnipCoreTests", dependencies: ["SnipCore"]),
  ]
)
