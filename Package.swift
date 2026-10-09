// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "T3PetsApp",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(
      name: "T3PetsApp",
      path: "Sources/T3PetsApp"
    )
  ]
)
