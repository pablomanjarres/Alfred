import Foundation
import AlfredMenuCore

func runVoiceTaskSelectionTests() {
  let target = "11111111-1111-4111-8111-111111111111"
  let expectedLink = "codex://threads/\(target)"
  let previousLink = "codex://threads/22222222-2222-4222-8222-222222222222"
  func confirms(_ link: String?, changed: Bool = true, frontmost: Bool = true) -> Bool {
    VoiceTaskSelection.confirms(threadId: target, copiedLink: link, clipboardChanged: changed, appIsFrontmost: frontmost)
  }

  expect(!confirms(nil), "opening the app without a selected-task receipt cannot start voice")
  expect(!confirms(previousLink), "voice cannot start in the previous task while navigation is pending")
  expect(!confirms(expectedLink, changed: false), "an old clipboard link is not navigation confirmation")
  expect(!confirms(expectedLink, frontmost: false), "selection proof cannot start voice after focus leaves Codex")
  expect(confirms(expectedLink), "a freshly copied target link confirms the selected task")
  expect(confirms(" \(expectedLink)?hostId=local\n"), "copied task links may include host metadata and whitespace")
  expect(!confirms("https://example.com/\(target)"), "unrelated URLs cannot acknowledge a task")
  expect(!confirms("codex://threads/new?prompt=\(target)"), "a new-task composer does not acknowledge the existing task")
  expect(!confirms("codex://threads/\(target)/extra"), "extra task path segments cannot acknowledge a task")

  expect(VoiceTaskSelection.canRestoreProbeResult(threadId: target, copiedLink: expectedLink, clipboardChanged: true, appIsFrontmost: true, clipboardUnchangedSinceProbe: true), "confirmed fresh task link can restore the probe clipboard")
  expect(!VoiceTaskSelection.canRestoreProbeResult(threadId: target, copiedLink: expectedLink, clipboardChanged: true, appIsFrontmost: true, clipboardUnchangedSinceProbe: false), "concurrent clipboard changes prevent probe restoration and voice dispatch")
  expect(!VoiceTaskSelection.canRestoreProbeResult(threadId: target, copiedLink: previousLink, clipboardChanged: true, appIsFrontmost: true, clipboardUnchangedSinceProbe: true), "mismatched task link cannot restore as a successful probe")
  expect(VoiceTaskSelection.canRestoreProbeClipboard(copiedLink: previousLink, clipboardChanged: true, appIsFrontmost: true, clipboardUnchangedSinceProbe: true), "fresh wrong-task probe links can be restored before refusing voice dispatch")
  expect(!VoiceTaskSelection.canRestoreProbeClipboard(copiedLink: "notes", clipboardChanged: true, appIsFrontmost: true, clipboardUnchangedSinceProbe: true), "unrelated clipboard changes are not treated as restorable probe output")
  expect(!VoiceTaskSelection.canRestoreProbeClipboard(copiedLink: previousLink, clipboardChanged: true, appIsFrontmost: true, clipboardUnchangedSinceProbe: false), "wrong-task probe links cannot overwrite concurrent clipboard changes")
  expect(!VoiceTaskSelection.canRestoreProbeClipboard(copiedLink: previousLink, clipboardChanged: true, appIsFrontmost: false, clipboardUnchangedSinceProbe: true), "a task link copied after focus leaves Codex must not restore the old clipboard")
  func outcome(_ link: String?, changed: Bool = true, frontmost: Bool = true, expired: Bool = false, current: Bool = true) -> VoiceTaskProbeOutcome {
    VoiceTaskSelection.probeOutcome(threadId: target, copiedLink: link, clipboardChanged: changed,
                                    appIsFrontmost: frontmost, expired: expired, requestIsCurrent: current)
  }
  expect(outcome(previousLink) == .waiting, "a fresh previous-task link waits for asynchronous navigation")
  expect(outcome(expectedLink) == .confirmed, "selection can succeed after a previous-task probe")
  expect(outcome(previousLink, expired: true) == .blocked, "navigation retries stop at the deadline")
  expect(outcome(expectedLink, current: false) == .blocked, "a cancelled request cannot start from a late copied link")
  expect(outcome(expectedLink, frontmost: false) == .blocked, "losing focus after a probe blocks voice start")
  expect(outcome(nil, changed: false) == .waiting, "pending copy commands do not immediately fail navigation")
  expect(outcome("new user clipboard") == .blocked, "unrelated clipboard changes stop navigation probing")
  print("VoiceTaskSelectionTests passed")
}
