// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "AlfredVoice",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(
      name: "AlfredVoice",
      path: "Sources/AlfredVoice",
      linkerSettings: [.unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "Resources/Info.plist"])]
    )
  ]
)
