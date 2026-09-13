// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "AlfredMenuBar",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "AlfredMenuCore", targets: ["AlfredMenuCore"]),
    .executable(name: "AlfredMenuBar", targets: ["AlfredMenuBar"]),
    .executable(name: "AlfredMenuTests", targets: ["AlfredMenuTests"]),
  ],
  targets: [
    .target(name: "AlfredMenuCore"),
    .executableTarget(name: "AlfredMenuBar", dependencies: ["AlfredMenuCore"]),
    .executableTarget(name: "AlfredMenuTests", dependencies: ["AlfredMenuCore"], path: "Tests/AlfredMenuTests"),
  ]
)
