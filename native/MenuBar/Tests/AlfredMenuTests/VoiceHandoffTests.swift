import Foundation
import AlfredMenuCore

private func checkHandoff(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  let result = try condition()
  expect(result, message)
}

func runVoiceHandoffTests() throws {
  let now = Date()
  let request = VoiceHandoffRequest(id: UUID().uuidString, status: "pending", requestedAt: now, expiresAt: now.addingTimeInterval(30))
  expect(request.canClaim(now: now), "fresh pending request can be claimed")
  expect(!request.canClaim(now: now.addingTimeInterval(31)), "expired request cannot act")
  expect(!request.canClaim(now: now.addingTimeInterval(-10)), "future request cannot act")
  expect(!request.changing(status: "claimed").canClaim(now: now), "claimed request cannot be claimed twice")
  let invalid = VoiceHandoffRequest(id: "not-a-uuid", status: "pending", requestedAt: now, expiresAt: now.addingTimeInterval(30))
  expect(!invalid.canClaim(now: now), "invalid request id cannot act")


  let decoder = JSONDecoder()
  decoder.dateDecodingStrategy = .iso8601
  let implicitStart = try decoder.decode(VoiceHandoffRequest.self, from: Data(#"{"id":"11111111-1111-4111-8111-111111111111","status":"pending","requestedAt":"2026-09-13T12:00:00Z","expiresAt":"2026-09-13T12:00:30Z"}"#.utf8))
  expect(implicitStart.action == .start, "missing handoff action defaults to start")
  expect(implicitStart.threadId == nil, "missing thread id stays nil")
  let endRequest = try decoder.decode(VoiceHandoffRequest.self, from: Data(#"{"id":"22222222-2222-4222-8222-222222222222","status":"pending","action":"end","threadId":"33333333-3333-4333-8333-333333333333","requestedAt":"2026-09-13T12:00:00Z","expiresAt":"2026-09-13T12:00:30Z"}"#.utf8))
  expect(endRequest.action == .end, "explicit end action decodes")
  expect(endRequest.threadId == "33333333-3333-4333-8333-333333333333", "valid thread id is preserved")
  let badThread = VoiceHandoffRequest(id: UUID().uuidString, status: "pending", requestedAt: now, expiresAt: now.addingTimeInterval(30), action: .start, threadId: "not-a-uuid")
  expect(!badThread.canClaim(now: now), "invalid thread id cannot dispatch")

  expect(VoiceEndDecision.forInput(.noCodexProcess) == .finishEnded("Codex is not running."), "end request finishes when Codex is not running")
  expect(VoiceEndDecision.forInput(.active) == .sendEndShortcut, "active Codex input sends one end shortcut")
  if case .block(let inactiveDetail) = VoiceEndDecision.forInput(.inactive) {
    expect(inactiveDetail.contains("No active Codex voice call"), "inactive input blocks instead of toggling on")
  } else { expect(false, "inactive input must block") }
  if case .block(let unknownDetail) = VoiceEndDecision.forInput(.unknown("metadata unavailable")) {
    expect(unknownDetail.contains("Could not confirm Codex voice state"), "unknown input blocks with actionable detail")
  } else { expect(false, "unknown input must block") }

  expect(VoiceStartDecision.forDedicatedTask(.inactive) == .continueToCodex, "dedicated start can navigate when Codex input is inactive")
  if case .block(let activeStartDetail) = VoiceStartDecision.forDedicatedTask(.active) {
    expect(activeStartDetail.contains("End the current Codex voice call"), "dedicated start blocks an active Codex call before navigation")
  } else { expect(false, "active Codex input must block dedicated start") }
  if case .block(let unknownStartDetail) = VoiceStartDecision.forDedicatedTask(.unknown("metadata unavailable")) {
    expect(unknownStartDetail.contains("Could not confirm Codex voice state"), "dedicated start blocks unknown input before navigation")
  } else { expect(false, "unknown Codex input must block dedicated start") }

  let ownedThread = "44444444-4444-4444-8444-444444444444"
  let launchDate = Date(timeIntervalSince1970: 1_789_275_100.125)
  let sameProcess = VoiceCodexProcessIdentity(processID: 1234, launchDate: launchDate)
  let ownedStart = VoiceHandoffStartReceipt(requestId: "55555555-5555-4555-8555-555555555555", threadId: ownedThread, codexProcessID: 1234, codexLaunchDate: launchDate)
  let matchingEnd = VoiceHandoffRequest(id: UUID().uuidString, status: "pending", requestedAt: now, expiresAt: now.addingTimeInterval(30), action: .end, threadId: ownedThread)
  expect(VoiceEndOwnershipDecision.forRunningCodex(request: matchingEnd, ownedStart: ownedStart, currentProcess: sameProcess) == .checkInput, "matching owned call can check input before ending")
  let unscopedEnd = VoiceHandoffRequest(id: UUID().uuidString, status: "pending", requestedAt: now, expiresAt: now.addingTimeInterval(30), action: .end)
  expect(VoiceEndOwnershipDecision.forRunningCodex(request: unscopedEnd, ownedStart: ownedStart, currentProcess: sameProcess) == .checkInput, "owned current call can end without a repeated thread id")
  if case .block(let missingOwnerDetail) = VoiceEndOwnershipDecision.forRunningCodex(request: matchingEnd, ownedStart: nil, currentProcess: sameProcess) {
    expect(missingOwnerDetail.contains("Alfred has not started"), "end blocks without an Alfred-owned start")
  } else { expect(false, "running Codex end must require ownership") }
  let mismatchedEnd = VoiceHandoffRequest(id: UUID().uuidString, status: "pending", requestedAt: now, expiresAt: now.addingTimeInterval(30), action: .end, threadId: "66666666-6666-4666-8666-666666666666")
  if case .block(let mismatchDetail) = VoiceEndOwnershipDecision.forRunningCodex(request: mismatchedEnd, ownedStart: ownedStart, currentProcess: sameProcess) {
    expect(mismatchDetail.contains("different Alfred task"), "end blocks a mismatched thread id")
  } else { expect(false, "mismatched end must block") }
  let legacyOwnedStart = VoiceHandoffStartReceipt(requestId: "77777777-7777-4777-8777-777777777777", threadId: nil, codexProcessID: 1234, codexLaunchDate: launchDate)
  if case .block(let legacyMismatchDetail) = VoiceEndOwnershipDecision.forRunningCodex(request: matchingEnd, ownedStart: legacyOwnedStart, currentProcess: sameProcess) {
    expect(legacyMismatchDetail.contains("different Alfred task"), "threaded end blocks a legacy owned receipt")
  } else { expect(false, "threaded end must not match unscoped ownership") }

  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: directory) }
  let store = VoiceHandoffStore(directory: directory)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let encoder = JSONEncoder()
  encoder.dateEncodingStrategy = .iso8601
  try encoder.encode(request).write(to: directory.appendingPathComponent("handoff.json"))
  try checkHandoff(store.claim(request, now: now), "first claim succeeds")
  try checkHandoff(!(try store.claim(request, now: now)), "duplicate claim is suppressed")
  try checkHandoff(store.canDispatch(request.id, now: now), "claimed request can dispatch")

  let cancelled = try JSONSerialization.data(withJSONObject: ["id": request.id])
  try cancelled.write(to: directory.appendingPathComponent("handoff-cancelled.json"))
  try checkHandoff(!(try store.canDispatch(request.id, now: now)), "cancellation survives a prior claim")
  try checkHandoff(!(try store.finish(request.id, status: "started", detail: "late completion")), "late completion cannot resurrect cancellation")

  let replacement = VoiceHandoffRequest(id: UUID().uuidString, status: "pending", requestedAt: now, expiresAt: now.addingTimeInterval(30))
  try encoder.encode(replacement).write(to: directory.appendingPathComponent("handoff.json"))
  try checkHandoff(!(try store.finish(request.id, status: "blocked", detail: "old result")), "stale result cannot overwrite a new request")
  try checkHandoff(store.claim(replacement, now: now), "new request remains claimable")
  try checkHandoff(store.finish(replacement.id, status: "ended", detail: "Codex voice ended"), "matching end completion succeeds")
  try checkHandoff(store.read()?.status == "ended", "ended completion is persisted")
  try checkHandoff(!(try store.canDispatch(replacement.id, now: now)), "completed request never dispatches again")


  let persistentReceipt = VoiceHandoffStartReceipt(requestId: replacement.id, threadId: ownedThread, codexProcessID: 1234, codexLaunchDate: launchDate)
  try store.rememberStart(persistentReceipt)
  let reloadedStore = VoiceHandoffStore(directory: directory)
  let reloadedReceipt = try reloadedStore.readStartReceipt()
  try checkHandoff(reloadedReceipt?.requestId == persistentReceipt.requestId && reloadedReceipt?.threadId == persistentReceipt.threadId && reloadedReceipt?.codexProcessID == 1234, "owned call receipt survives menu relaunch")
  try checkHandoff(abs((reloadedReceipt?.codexLaunchDate.timeIntervalSince1970 ?? 0) - launchDate.timeIntervalSince1970) < 0.000_001, "fractional Codex launch time survives receipt encoding")
  let sessionAttrs = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent("voice-session.json").path)
  expect((sessionAttrs[.posixPermissions] as? NSNumber)?.intValue == 0o600, "voice session receipt remains private")
  expect(VoiceEndOwnershipDecision.forRunningCodex(request: matchingEnd, ownedStart: persistentReceipt, currentProcess: sameProcess) == .checkInput, "matching process identity can end the owned call")
  let relaunchedProcess = VoiceCodexProcessIdentity(processID: 1234, launchDate: launchDate.addingTimeInterval(1))
  if case .block(let relaunchedDetail) = VoiceEndOwnershipDecision.forRunningCodex(request: matchingEnd, ownedStart: persistentReceipt, currentProcess: relaunchedProcess) {
    expect(relaunchedDetail.contains("different Codex app session"), "restarted Codex process invalidates old ownership")
  } else { expect(false, "restarted Codex process must not reuse an old receipt") }
  let badReceipt = directory.appendingPathComponent("voice-session.json")
  try Data(#"{"requestId":"bad","codexProcessID":0,"codexLaunchDate":"2026-09-13T12:00:00Z"}"#.utf8).write(to: badReceipt)
  try checkHandoff(reloadedStore.readStartReceipt() == nil, "invalid voice session receipt is ignored")
  try store.rememberStart(persistentReceipt)
  try store.clearStartReceipt()
  try checkHandoff(store.readStartReceipt() == nil, "terminal end clears owned call receipt")

  let attrs = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent("handoff.json").path)
  expect((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600, "handoff state remains private")
  print("VoiceHandoffTests passed")
}
