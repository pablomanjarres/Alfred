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
    waitForProbe(threadId: threadId, app: app, snapshot: snapshot, before: before, deadline: minDate(deadline, Date().addingTimeInterval(1)), isCurrent: isCurrent) { [weak self] result in
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
                            deadline: Date, isCurrent: @escaping () -> Bool, completion: @escaping (Result<Bool, Swift.Error>) -> Void) {
    guard isCurrent() else { completion(.failure(Error.cancelled)); return }
    let currentCount = pasteboard.changeCount
    let link = pasteboard.string(forType: .string)
    let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
    guard frontmost else { completion(.failure(Error.notFrontmost)); return }
    let changed = currentCount != before
    if VoiceTaskSelection.canRestoreProbeResult(threadId: threadId, copiedLink: link, clipboardChanged: changed,
                                                appIsFrontmost: frontmost, clipboardUnchangedSinceProbe: pasteboard.changeCount == currentCount) {
      do { try snapshot.restore(to: pasteboard, replacingChangeCount: currentCount); completion(.success(true)) }
      catch { completion(.failure(error)) }
      return
    }
    if changed {
      if VoiceTaskSelection.canRestoreProbeClipboard(copiedLink: link, clipboardChanged: changed,
                                                     appIsFrontmost: frontmost,
                                                     clipboardUnchangedSinceProbe: pasteboard.changeCount == currentCount) {
        do { try snapshot.restore(to: pasteboard, replacingChangeCount: currentCount) }
        catch { completion(.failure(error)); return }
        completion(.failure(Error.selectionMismatch))
      } else {
        completion(.failure(Error.clipboardChanged))
      }
      return
    }
    guard Date() < deadline else { completion(.success(false)); return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
      self?.waitForProbe(threadId: threadId, app: app, snapshot: snapshot, before: before, deadline: deadline, isCurrent: isCurrent, completion: completion)
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
      pasteboard.clearContents()
      let restored = try items.map { saved -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, data) in saved where !item.setData(data, forType: type) { throw Error.clipboardReadFailed }
        return item
      }
      guard pasteboard.writeObjects(restored) || restored.isEmpty else { throw Error.clipboardReadFailed }
    }
  }
}
