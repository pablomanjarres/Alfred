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
  let attrs = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent("handoff.json").path)
  expect((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600, "handoff state remains private")
  print("VoiceHandoffTests passed")
}
