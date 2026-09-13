import Foundation

public enum VoiceTaskProbeOutcome {
  case waiting
  case confirmed
  case blocked
}

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

  public static func probeOutcome(threadId: String, copiedLink: String?, clipboardChanged: Bool,
                                  appIsFrontmost: Bool, expired: Bool, requestIsCurrent: Bool) -> VoiceTaskProbeOutcome {
    guard requestIsCurrent, appIsFrontmost, !expired, UUID(uuidString: threadId) != nil else { return .blocked }
    guard clipboardChanged else { return .waiting }
    guard let copied = copiedThreadId(copiedLink: copiedLink, clipboardChanged: clipboardChanged, appIsFrontmost: appIsFrontmost) else {
      return .blocked
    }
    return copied.uuidString.caseInsensitiveCompare(threadId) == .orderedSame ? .confirmed : .waiting
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
