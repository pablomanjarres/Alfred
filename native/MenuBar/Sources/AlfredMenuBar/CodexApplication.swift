import AppKit

enum CodexApplication {
  static let bundleIdentifier = "com.openai.codex"

  static func installedURL() -> URL? {
    NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier)
  }
}
