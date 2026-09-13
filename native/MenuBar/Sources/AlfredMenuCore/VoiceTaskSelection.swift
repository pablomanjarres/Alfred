import Foundation

public enum VoiceTaskSelection {
  public static func confirms(threadId: String, copiedLink: String?, clipboardChanged: Bool, appIsFrontmost: Bool) -> Bool {
    guard let target = UUID(uuidString: threadId),
          let copied = copiedThreadId(copiedLink: copiedLink, clipboardChanged: clipboardChanged, appIsFrontmost: appIsFrontmost) else { return false }
    return copied == target
  }

  public static func canRestoreProbeResult(threadId: String, copiedLink: String?, clipboardChanged: Bool,
                                           appIsFrontmost: Bool, clipboardUnchangedSinceProbe: Bool) -> Bool {
    clipboardUnchangedSinceProbe && confirms(threadId: threadId, copiedLink: copiedLink,
                                             clipboardChanged: clipboardChanged, appIsFrontmost: appIsFrontmost)
  }

  public static func canRestoreProbeClipboard(copiedLink: String?, clipboardChanged: Bool,
                                              appIsFrontmost: Bool, clipboardUnchangedSinceProbe: Bool) -> Bool {
    clipboardUnchangedSinceProbe && copiedThreadId(copiedLink: copiedLink, clipboardChanged: clipboardChanged,
                                                   appIsFrontmost: appIsFrontmost) != nil
  }

  private static func copiedThreadId(copiedLink: String?, clipboardChanged: Bool, appIsFrontmost: Bool) -> UUID? {
    guard clipboardChanged, appIsFrontmost, let copiedLink = copiedLink?.trimmingCharacters(in: .whitespacesAndNewlines),
          let components = URLComponents(string: copiedLink), components.scheme == "codex",
          components.host == "threads", components.path.first == "/" else { return nil }
    let copiedId = String(components.path.dropFirst())
    guard !copiedId.contains("/") else { return nil }
    return UUID(uuidString: copiedId)
  }
}
