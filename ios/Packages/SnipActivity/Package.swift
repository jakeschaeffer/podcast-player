// swift-tools-version: 6.2
// What the app and its Live Activity widget share: the activity's attributes and the buttons' intents. Both targets
// link this one module, so ActivityKit and App Intents see the same types on either side.
import PackageDescription

let package = Package(
  name: "SnipActivity",
  platforms: [.iOS(.v26)],
  products: [.library(name: "SnipActivity", targets: ["SnipActivity"])],
  targets: [.target(name: "SnipActivity")]
)
