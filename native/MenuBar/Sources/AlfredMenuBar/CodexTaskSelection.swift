import AppKit
import AlfredMenuCore

final class CodexTaskSelection {
  private let pasteboard: NSPasteboard

  init(pasteboard: NSPasteboard = .general) {
    self.pasteboard = pasteboard
  }

  func confirm(threadId: String, app: NSRunningApplication, deadline: Date, isCurrent: @escaping () -> Bool,
               completion: @escaping (Result<Void, Swift.Error>) -> Void) {
    attempt(threadId: threadId, app: app, deadline: deadline, isCurrent: isCurrent, completion: completion)
  }

  private func attempt(threadId: String, app: NSRunningApplication, deadline: Date, isCurrent: @escaping () -> Bool,
                       completion: @escaping (Result<Void, Swift.Error>) -> Void) {
    guard isCurrent() else { completion(.failure(Error.cancelled)); return }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
      completion(.failure(Error.notFrontmost)); return
    }
    guard Date() < deadline else { completion(.failure(Error.timeout)); return }
    let snapshot: ClipboardSnapshot
    do { snapshot = try ClipboardSnapshot.capture(pasteboard) }
    catch { completion(.failure(error)); return }
    let before = pasteboard.changeCount
    do { try postCopyLinkShortcut(to: app.processIdentifier) }
    catch { completion(.failure(error)); return }
    waitForProbe(threadId: threadId, app: app, snapshot: snapshot, before: before,
                 pollDeadline: minDate(deadline, Date().addingTimeInterval(1)), overallDeadline: deadline,
                 isCurrent: isCurrent) { [weak self] result in
      guard let self else { completion(.failure(Error.cancelled)); return }
      switch result {
      case .success(true): completion(.success(()))
      case .success(false):
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
          self?.attempt(threadId: threadId, app: app, deadline: deadline, isCurrent: isCurrent, completion: completion)
        }
      case .failure(let error): completion(.failure(error))
      }
    }
  }

  private func waitForProbe(threadId: String, app: NSRunningApplication, snapshot: ClipboardSnapshot, before: Int,
                            pollDeadline: Date, overallDeadline: Date, isCurrent: @escaping () -> Bool,
                            completion: @escaping (Result<Bool, Swift.Error>) -> Void) {
    let currentCount = pasteboard.changeCount
    let link = pasteboard.string(forType: .string)
    let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
    let changed = currentCount != before
    let current = isCurrent()
    let unchanged = pasteboard.changeCount == currentCount
    let outcome = VoiceTaskSelection.probeOutcome(threadId: threadId, copiedLink: link, clipboardChanged: changed,
                                                  appIsFrontmost: frontmost, expired: Date() >= overallDeadline,
                                                  requestIsCurrent: current)
    if outcome != .confirmed,
       VoiceTaskSelection.canRestoreProbeClipboard(copiedLink: link, clipboardChanged: changed,
                                                   appIsFrontmost: true, clipboardUnchangedSinceProbe: unchanged) {
      do { try snapshot.restore(to: pasteboard, replacingChangeCount: currentCount) }
      catch { completion(.failure(error)); return }
    }
    switch outcome {
    case .confirmed:
      guard VoiceTaskSelection.canRestoreProbeResult(threadId: threadId, copiedLink: link, clipboardChanged: changed,
                                                     appIsFrontmost: frontmost, clipboardUnchangedSinceProbe: unchanged) else {
        completion(.failure(Error.clipboardChanged)); return
      }
      do { try snapshot.restore(to: pasteboard, replacingChangeCount: currentCount); completion(.success(true)) }
      catch { completion(.failure(error)) }
    case .waiting:
      if changed { completion(.success(false)); return }
      guard Date() < pollDeadline else { completion(.success(false)); return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
        self?.waitForProbe(threadId: threadId, app: app, snapshot: snapshot, before: before,
                           pollDeadline: pollDeadline, overallDeadline: overallDeadline, isCurrent: isCurrent, completion: completion)
      }
    case .blocked:
      if !current { completion(.failure(Error.cancelled)) }
      else if !frontmost { completion(.failure(Error.notFrontmost)) }
      else if Date() >= overallDeadline { completion(.failure(Error.timeout)) }
      else { completion(.failure(Error.clipboardChanged)) }
    }
  }

  private func postCopyLinkShortcut(to pid: pid_t) throws {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 37, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 37, keyDown: false) else {
      throw Error.shortcutUnavailable
    }
    down.flags = [.maskCommand, .maskAlternate]; up.flags = [.maskCommand, .maskAlternate]
    down.postToPid(pid); up.postToPid(pid)
  }

  private func minDate(_ a: Date, _ b: Date) -> Date { a < b ? a : b }

  enum Error: LocalizedError {
    case cancelled, notFrontmost, timeout, shortcutUnavailable, clipboardReadFailed, clipboardChanged, selectionMismatch

    var errorDescription: String? {
      switch self {
      case .cancelled: return "Voice handoff was cancelled."
      case .notFrontmost: return "Bring Codex to the front, then ask Alfred again."
      case .timeout: return "Could not confirm the selected Codex task. Open the Alfred task, then ask again."
      case .shortcutUnavailable: return "Could not copy the Codex task link."
      case .clipboardReadFailed: return "Could not safely preserve the clipboard."
      case .clipboardChanged: return "The clipboard changed during task confirmation. Ask Alfred again."
      case .selectionMismatch: return "Codex did not select the requested Alfred task. Open the Alfred task, then ask again."
      }
    }
  }

  private struct ClipboardSnapshot {
    let items: [[NSPasteboard.PasteboardType: Data]]

    static func capture(_ pasteboard: NSPasteboard) throws -> ClipboardSnapshot {
      let captured = try (pasteboard.pasteboardItems ?? []).map { item in
        try Dictionary(uniqueKeysWithValues: item.types.map { type in
          guard let data = item.data(forType: type) else { throw Error.clipboardReadFailed }
          return (type, data)
        })
      }
      return ClipboardSnapshot(items: captured)
    }

    func restore(to pasteboard: NSPasteboard, replacingChangeCount changeCount: Int) throws {
      guard pasteboard.changeCount == changeCount else { throw Error.clipboardChanged }
      let restored = try items.map { saved -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, data) in saved where !item.setData(data, forType: type) { throw Error.clipboardReadFailed }
        return item
      }
      pasteboard.clearContents()
      guard pasteboard.writeObjects(restored) || restored.isEmpty else { throw Error.clipboardReadFailed }
    }
  }
}
