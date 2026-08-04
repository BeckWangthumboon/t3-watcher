// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "T3WatcherApp",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(
      name: "T3WatcherApp",
      path: "Sources/T3WatcherApp"
    )
  ]
)
