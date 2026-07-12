// swift-tools-version: 5.10

import PackageDescription

let package = Package(
  name: "CUAppKitFixture",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .executable(name: "CUAppKitFixture", targets: ["CUAppKitFixture"]),
  ],
  targets: [
    .executableTarget(
      name: "CUAppKitFixture",
      path: "Sources/CUAppKitFixture"
    ),
  ],
  swiftLanguageVersions: [.v5]
)
