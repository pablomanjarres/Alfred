import AppKit
import Foundation
import Darwin
import AlfredMenuCore

let appId = "com.pablo.alfred.menubar"
let loginLabel = "com.pablo.alfred.menubar"

final class AppDelegate: NSObject, NSApplicationDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private var config: AlfredCLIConfig?
  private var lastState = MenuState(kind: .starting, detail: "Loading Alfred status…", micIndicator: false)
  private var timer: Timer?
  private var polling = false
  private var pollGeneration = 0

  func applicationDidFinishLaunching(_ notification: Notification) {
    if NSRunningApplication.runningApplications(withBundleIdentifier: appId).contains(where: { $0.processIdentifier != getpid() }) { NSApp.terminate(nil) }
    config = try? AlfredCLIConfig.load(from: configURL())
    statusItem.button?.title = "🎩"
    rebuildMenu()
    refreshStatus(force: true)
    timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refreshStatus() }
  }

  @objc private func refreshStatus() { refreshStatus(force: false) }

  private func refreshStatus(force: Bool) {
    guard let config else { setError("Missing Alfred menu config. Run npm run install:menubar."); rebuildMenu(); return }
    if polling && !force { return }
    pollGeneration += 1
    let generation = pollGeneration
    polling = true
    runAlfred(["standby", "status"], config: config, timeout: 10) { [weak self] result in
      DispatchQueue.main.async {
        guard let self, self.pollGeneration == generation else { return }
        self.polling = false
        switch result {
        case .success(let output):
          do { self.lastState = try StandbySnapshot.decode(output).menuState() }
          catch { self.setError("Could not read standby status: \(error.localizedDescription)") }
        case .failure(let error): self.setError(error.localizedDescription)
        }
        self.rebuildMenu()
      }
    }
  }

  @objc private func startListener() { command(["standby", "start"], timeout: 30) }
  @objc private func stopListener() { command(["standby", "stop"], timeout: 20) }
  @objc private func quitUI() { NSApp.terminate(nil) }

  @objc private func openCodex() {
    let candidates = ["com.openai.codex", "com.openai.chatgpt"]
    guard let url = candidates.compactMap({ NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }).first else {
      setError("Could not find Codex. Open it once from Applications."); rebuildMenu(); return
    }
    NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { [weak self] _, error in
      DispatchQueue.main.async {
        if let error { self?.setError("Could not open Codex: \(error.localizedDescription)") }
        self?.rebuildMenu()
      }
    }
  }

  @objc private func toggleLogin() {
    isLoginEnabled() ? disableLogin() : enableLogin()
    rebuildMenu()
  }

  private func command(_ args: [String], timeout: TimeInterval) {
    guard let config else { setError("Missing Alfred menu config. Run npm run install:menubar."); return }
    lastState = MenuState(kind: .starting, detail: args.contains("stop") ? "Stopping listener…" : "Starting listener…", micIndicator: false)
    rebuildMenu()
    runAlfred(args, config: config, timeout: timeout) { [weak self] result in
      DispatchQueue.main.async {
        if case .failure(let error) = result { self?.setError(error.localizedDescription) }
        self?.refreshStatus(force: true)
      }
    }
  }

  private func rebuildMenu() {
    statusItem.button?.title = lastState.micIndicator ? "🎩•" : "🎩"
    statusItem.button?.toolTip = "Alfred standby menu"
    statusItem.button?.setAccessibilityLabel("Alfred standby menu")
    let menu = NSMenu()
    let status = NSMenuItem(title: lastState.label, action: nil, keyEquivalent: "")
    status.isEnabled = false
    menu.addItem(status)
    let detail = NSMenuItem(title: lastState.detail, action: nil, keyEquivalent: "")
    detail.isEnabled = false
    menu.addItem(detail)
    let privacy = NSMenuItem(title: "Wake detection saves no audio.", action: nil, keyEquivalent: "")
    privacy.isEnabled = false
    menu.addItem(privacy)
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Start Listener", action: #selector(startListener), keyEquivalent: "s"))
    menu.addItem(NSMenuItem(title: "Stop Listener", action: #selector(stopListener), keyEquivalent: "x"))
    menu.addItem(NSMenuItem(title: "Open Codex", action: #selector(openCodex), keyEquivalent: "o"))
    let login = NSMenuItem(title: "Launch at Login", action: #selector(toggleLogin), keyEquivalent: "l")
    login.state = isLoginEnabled() ? .on : .off
    menu.addItem(login)
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Quit Alfred UI", action: #selector(quitUI), keyEquivalent: "q"))
    statusItem.menu = menu
  }

  private func setError(_ message: String) {
    lastState = MenuState(kind: .blocked, detail: message, micIndicator: false)
  }

  private func runAlfred(_ args: [String], config: AlfredCLIConfig, timeout: TimeInterval, done: @escaping (Result<String, MenuError>) -> Void) {
    DispatchQueue.global(qos: .userInitiated).async {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: config.nodePath)
      process.arguments = [config.cliPath] + args
      let out = Pipe(), err = Pipe()
      process.standardOutput = out; process.standardError = err
      do { try process.run() } catch { done(.failure(MenuError("Could not start Alfred: \(error.localizedDescription)"))); return }
      let deadline = Date().addingTimeInterval(timeout)
      while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
      if process.isRunning { killProcess(process) }
      process.waitUntilExit()
      let output = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      let errors = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      process.terminationStatus == 0 ? done(.success(output)) : done(.failure(MenuError(errors.isEmpty ? "Alfred exited with \(process.terminationStatus)" : errors)))
    }
  }

  private func configURL() -> URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Alfred/MenuBar/config.json")
  }

  private func loginPlistURL() -> URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(loginLabel).plist")
  }

  private func isLoginEnabled() -> Bool { FileManager.default.fileExists(atPath: loginPlistURL().path) }
  private func enableLogin() {
    let exe = Bundle.main.executablePath ?? ""
    let plist = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict><key>Label</key><string>\(loginLabel)</string><key>ProgramArguments</key><array><string>\(exe)</string></array><key>RunAtLoad</key><true/></dict></plist>
    """
    try? FileManager.default.createDirectory(at: loginPlistURL().deletingLastPathComponent(), withIntermediateDirectories: true)
    try? plist.write(to: loginPlistURL(), atomically: true, encoding: .utf8)
  }
  private func disableLogin() { try? FileManager.default.removeItem(at: loginPlistURL()) }
}

func killProcess(_ process: Process) {
  process.terminate()
  let grace = Date().addingTimeInterval(0.5)
  while process.isRunning && Date() < grace { Thread.sleep(forTimeInterval: 0.05) }
  if process.isRunning { kill(process.processIdentifier, SIGKILL) }
}

struct MenuError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

@main
enum AlfredMenuMain {
  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
  }
}
