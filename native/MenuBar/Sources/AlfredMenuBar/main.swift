import AppKit
import Foundation
import AlfredMenuCore

let appId = "com.pablo.alfred.menubar"
let loginLabel = "com.pablo.alfred.menubar"

final class AppDelegate: NSObject, NSApplicationDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private var config: AlfredCLIConfig?
  private var lastState = MenuState(kind: .starting, detail: "Loading Alfred status…", micIndicator: false)
  private var timer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    if NSRunningApplication.runningApplications(withBundleIdentifier: appId).contains(where: { $0.processIdentifier != getpid() }) { NSApp.terminate(nil) }
    config = try? AlfredCLIConfig.load(from: configURL())
    statusItem.button?.title = "🎩"
    rebuildMenu()
    refreshStatus()
    timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refreshStatus() }
  }

  @objc private func refreshStatus() {
    guard let config else { setError("Missing Alfred menu config. Run npm run install:menubar."); return }
    runAlfred(["standby", "status"], config: config, timeout: 10) { [weak self] result in
      switch result {
      case .success(let output):
        do { self?.lastState = try StandbySnapshot.decode(output).menuState() }
        catch { self?.setError("Could not read standby status: \(error.localizedDescription)") }
      case .failure(let error): self?.setError(error.localizedDescription)
      }
      DispatchQueue.main.async { self?.rebuildMenu() }
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
      if let error { self?.setError("Could not open Codex: \(error.localizedDescription)") }
      DispatchQueue.main.async { self?.rebuildMenu() }
    }
  }

  @objc private func toggleLogin() {
    isLoginEnabled() ? disableLogin() : enableLogin()
    rebuildMenu()
  }

  private func command(_ args: [String], timeout: TimeInterval) {
    guard let config else { setError("Missing Alfred menu config. Run npm run install:menubar."); return }
    lastState = MenuState(kind: .starting, detail: "Running alfred \(args.joined(separator: " "))…", micIndicator: false)
    rebuildMenu()
    runAlfred(args, config: config, timeout: timeout) { [weak self] result in
      if case .failure(let error) = result { self?.setError(error.localizedDescription) }
      DispatchQueue.main.async { self?.refreshStatus() }
    }
  }

  private func rebuildMenu() {
    statusItem.button?.title = lastState.micIndicator ? "🎩•" : "🎩"
    let menu = NSMenu()
    let status = NSMenuItem(title: lastState.label, action: nil, keyEquivalent: "")
    status.isEnabled = false
    menu.addItem(status)
    let detail = NSMenuItem(title: lastState.detail, action: nil, keyEquivalent: "")
    detail.isEnabled = false
    menu.addItem(detail)
    let privacy = NSMenuItem(title: "No recordings. No transcript or audio history.", action: nil, keyEquivalent: "")
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
      if process.isRunning { process.terminate(); Thread.sleep(forTimeInterval: 0.3); if process.isRunning { process.interrupt() } }
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
    _ = runLaunchctl(["bootout", "gui/\(getuid())/\(loginLabel)"], timeout: 5)
    _ = runLaunchctl(["bootstrap", "gui/\(getuid())", loginPlistURL().path], timeout: 5)
  }
  private func disableLogin() {
    _ = runLaunchctl(["bootout", "gui/\(getuid())/\(loginLabel)"], timeout: 5)
    try? FileManager.default.removeItem(at: loginPlistURL())
  }
  private func runLaunchctl(_ args: [String], timeout: TimeInterval) -> Bool {
    let process = Process(); process.executableURL = URL(fileURLWithPath: "/bin/launchctl"); process.arguments = args
    do { try process.run() } catch { return false }
    let deadline = Date().addingTimeInterval(timeout)
    while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
    if process.isRunning { process.terminate() }
    process.waitUntilExit()
    return process.terminationStatus == 0
  }
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
