// swift-tools-version: 5.9
import PackageDescription
import Foundation

let dependencyRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .appendingPathComponent(".build/alfred-deps").path
let libraries = ["alfred-kws-private", "sherpa-onnx-c-api", "sherpa-onnx-core",
  "kaldi-native-fbank-core", "kissfft-float", "kaldi-decoder-core",
  "sherpa-onnx-kaldifst-core", "sherpa-onnx-fstfar", "sherpa-onnx-fst",
  "ssentencepiece_core", "onnxruntime"]

let package = Package(
  name: "AlfredVoice",
  platforms: [.macOS(.v13)],
  targets: [
    .systemLibrary(name: "CSherpaOnnx", path: "Sources/CSherpaOnnx"),
    .executableTarget(
      name: "AlfredVoice",
      dependencies: ["CSherpaOnnx"],
      path: "Sources/AlfredVoice",
      swiftSettings: [.unsafeFlags(["-Xcc", "-I\(dependencyRoot)/include"])],
      linkerSettings: libraries.map { .linkedLibrary($0) } + [
        .linkedLibrary("c++"), .linkedFramework("CoreML"), .linkedFramework("Accelerate"),
        .unsafeFlags(["-L\(dependencyRoot)/lib", "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "Resources/Info.plist"])
      ]
    )
  ]
)
