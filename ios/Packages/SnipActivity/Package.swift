// swift-tools-version: 6.2
// What the app and its Live Activity widget share: the activity's attributes, the buttons' intents, and the views (so the
// app's debug gallery draws them too). Both targets link this one module, so ActivityKit and App Intents see the same
// types on either side.
import PackageDescription

let package = Package(
  name: "SnipActivity",
  platforms: [.iOS(.v26)],
  products: [.library(name: "SnipActivity", targets: ["SnipActivity"])],
  targets: [
    .target(name: "SnipActivity"),
    // iOS only (ActivityKit), so these run in the simulator: `xcodebuild test -scheme Snip`.
    .testTarget(name: "SnipActivityTests", dependencies: ["SnipActivity"]),
  ]
)
