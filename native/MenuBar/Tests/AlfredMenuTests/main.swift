import Foundation
import AlfredMenuCore

func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
  if !condition() { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
func expectThrows(_ body: () throws -> Void, _ message: String) {
  do { try body(); fputs("FAIL: \(message)\n", stderr); exit(1) } catch {}
}

let now = Date(timeIntervalSince1970: 1_789_275_000)
let fresh = try StandbySnapshot.decode(#"{"loaded":true,"running":true,"pid":42,"state":{"status":"running","detail":"Waiting for deliberate double clap or spoken Alfred","updatedAt":"2026-09-13T04:50:00.000Z"},"detail":"Waiting"}"#)
expect(fresh.menuState(now: now).kind == .listening, "fresh running standby should show listening")
expect(fresh.menuState(now: now).micIndicator, "fresh running standby should show mic indicator")

let stale = try StandbySnapshot.decode(#"{"loaded":true,"running":true,"pid":42,"state":{"status":"running","detail":"Waiting","updatedAt":"2026-09-13T04:00:00.000Z"},"detail":"Waiting"}"#)
expect(stale.menuState(now: now).kind == .stale, "stale state should not show listening")

let noPid = try StandbySnapshot.decode(#"{"loaded":true,"running":false,"state":{"status":"running","detail":"Waiting","updatedAt":"2026-09-13T04:50:00.000Z"},"detail":"Waiting"}"#)
expect(noPid.menuState(now: now).kind == .stopped, "missing running pid should show stopped")

let blocked = try StandbySnapshot.decode(#"{"loaded":true,"running":false,"state":{"status":"blocked","detail":"microphone permission denied","updatedAt":"2026-09-13T04:50:00.000Z"},"detail":"microphone permission denied"}"#).menuState(now: now)
expect(blocked.kind == .blocked, "blocked state should surface as blocked")
expect(blocked.detail == "microphone permission denied", "blocked state should keep exact detail")
expect(!blocked.micIndicator, "blocked state should not show mic active")

expectThrows(try AlfredCLIConfig(nodePath: "node", cliPath: "/tmp/alfred/dist/cli.js"), "relative node path should be rejected")
expect(try AlfredCLIConfig(nodePath: "/usr/local/bin/node", cliPath: "/tmp/alfred/dist/cli.js").nodePath == "/usr/local/bin/node", "absolute config should load")
print("AlfredMenuTests passed")
