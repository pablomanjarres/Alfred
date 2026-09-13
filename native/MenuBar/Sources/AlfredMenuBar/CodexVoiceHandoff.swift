import AppKit
import ApplicationServices
import AlfredMenuCore

final class CodexVoiceHandoff {
  private let store: VoiceHandoffStore
  private let changed: () -> Void
  private var activeID: String?

  init(store: VoiceHandoffStore, changed: @escaping () -> Void) {
    self.store = store; self.changed = changed
  }

  static var permissionGranted: Bool { AXIsProcessTrusted() }

  static func requestPermission() {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
  }

  func poll() {
    guard activeID == nil, let request = try? store.read(), request.canClaim() else { return }
    do {
      guard try store.claim(request) else { return }
      activeID = request.id
      try begin(request)
    } catch { finish(request, error: error.localizedDescription) }
  }

  private func begin(_ request: VoiceHandoffRequest) throws {
    guard Self.permissionGranted else {
      finish(request, error: "Allow Alfred in System Settings > Privacy & Security > Accessibility, then choose Start listening.")
      return
    }
    guard let url = CodexApplication.installedURL() else {
      finish(request, error: "Codex is not installed. Open Codex once, then choose Start listening.")
      return
    }
    guard try store.canDispatch(request.id) else { activeID = nil; return }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
      guard self?.activeID == request.id else { return }
      self?.finish(request, error: "Codex voice did not become ready. Open a Codex task, then choose Start listening.")
    }
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { [weak self] app, error in
      DispatchQueue.main.async {
        guard let self, self.activeID == request.id else { return }
        if let error { self.finish(request, error: "Could not open Codex: \(error.localizedDescription)"); return }
        guard let app else { self.finish(request, error: "Codex did not open."); return }
        self.waitForFocus(request, app: app, url: url, deadline: Date().addingTimeInterval(5))
      }
    }
  }

  private func waitForFocus(_ request: VoiceHandoffRequest, app: NSRunningApplication, url: URL, deadline: Date) {
    guard current(request) else { return }
    guard !app.isTerminated else { finish(request, error: "Codex closed before voice started."); return }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
      guard Date() < deadline else { finish(request, error: "Bring Codex to the front, then choose Start listening."); return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.waitForFocus(request, app: app, url: url, deadline: deadline) }
      return
    }
    do {
      if try CodexMicrophone.inputIsActive(in: url) {
        finish(request, detail: "Codex already has the microphone. End the call, then choose Start listening.")
        return
      }
      guard current(request), Self.permissionGranted else { finish(request, error: "Alfred voice control permission is unavailable."); return }
      // Codex documents Control-Shift-V as a toggle. Send it once, only to the Codex PID.
      guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: true),
            let up = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: false) else {
        finish(request, error: "Could not send the Codex voice shortcut."); return
      }
      down.flags = [.maskControl, .maskShift]; up.flags = [.maskControl, .maskShift]
      down.postToPid(app.processIdentifier); up.postToPid(app.processIdentifier)
      waitForInput(request, url: url, deadline: Date().addingTimeInterval(8))
    } catch { finish(request, error: "Could not check Codex microphone: \(error.localizedDescription)") }
  }

  private func waitForInput(_ request: VoiceHandoffRequest, url: URL, deadline: Date) {
    guard current(request) else { return }
    do {
      if try CodexMicrophone.inputIsActive(in: url) {
        finish(request, detail: "Codex has the microphone. End the call, then choose Start listening.")
        return
      }
    } catch { finish(request, error: "Could not confirm Codex microphone: \(error.localizedDescription)"); return }
    guard Date() < deadline else {
      finish(request, error: "Codex did not start listening. Open a task and check Codex voice access, then choose Start listening."); return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.waitForInput(request, url: url, deadline: deadline) }
  }

  private func current(_ request: VoiceHandoffRequest) -> Bool {
    guard activeID == request.id else { return false }
    do {
      if try store.canDispatch(request.id) { return true }
      activeID = nil
    } catch { finish(request, error: "Could not read voice handoff: \(error.localizedDescription)") }
    return false
  }

  private func finish(_ request: VoiceHandoffRequest, detail: String = "", error: String? = nil) {
    guard activeID == request.id else { return }
    _ = try? store.finish(request.id, status: error == nil ? "started" : "blocked", detail: error ?? detail)
    activeID = nil
    changed()
  }
}
