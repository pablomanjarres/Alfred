import Foundation

public enum VoiceHandoffAction: String, Codable, Equatable {
  case start
  case end
}

public enum VoiceInputState: Equatable {
  case noCodexProcess
  case active
  case inactive
  case unknown(String)
}

public enum VoiceEndDecision: Equatable {
  case finishEnded(String)
  case sendEndShortcut
  case block(String)

  public static func forInput(_ input: VoiceInputState) -> VoiceEndDecision {
    switch input {
    case .noCodexProcess:
      return .finishEnded("Codex is not running.")
    case .active:
      return .sendEndShortcut
    case .inactive:
      return .block("No active Codex voice call was detected. Open Codex and end the call there.")
    case .unknown(let detail):
      let suffix = detail.trimmingCharacters(in: .whitespacesAndNewlines)
      return .block(suffix.isEmpty ? "Could not confirm Codex voice state. Open Codex and end the call there." : "Could not confirm Codex voice state: \(suffix). Open Codex and end the call there.")
    }
  }
}


public enum VoiceStartDecision: Equatable {
  case continueToCodex
  case block(String)

  public static func forDedicatedTask(_ input: VoiceInputState) -> VoiceStartDecision {
    switch input {
    case .active:
      return .block("End the current Codex voice call, then ask Alfred again.")
    case .unknown(let detail):
      let suffix = detail.trimmingCharacters(in: .whitespacesAndNewlines)
      return .block(suffix.isEmpty ? "Could not confirm Codex voice state. End the current call in Codex, then ask Alfred again." : "Could not confirm Codex voice state: \(suffix). End the current call in Codex, then ask Alfred again.")
    case .inactive, .noCodexProcess:
      return .continueToCodex
    }
  }
}

public struct VoiceCodexProcessIdentity: Equatable {
  public let processID: Int
  public let launchDate: Date

  public init(processID: Int, launchDate: Date) {
    self.processID = processID
    self.launchDate = launchDate
  }
}

public struct VoiceHandoffStartReceipt: Codable, Equatable {
  public let requestId: String
  public let threadId: String?
  public let codexProcessID: Int
  public let codexLaunchDate: Date

  public init(requestId: String, threadId: String?, codexProcessID: Int, codexLaunchDate: Date) {
    self.requestId = requestId
    self.threadId = threadId
    self.codexProcessID = codexProcessID
    self.codexLaunchDate = codexLaunchDate
  }

  public func isValid() -> Bool {
    UUID(uuidString: requestId) != nil && (threadId == nil || UUID(uuidString: threadId!) != nil) && codexProcessID > 0
  }

  public func matches(_ process: VoiceCodexProcessIdentity) -> Bool {
    codexProcessID == process.processID && codexLaunchDate == process.launchDate
  }

  private enum CodingKeys: String, CodingKey { case requestId, threadId, codexProcessID, codexLaunchDate }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    requestId = try values.decode(String.self, forKey: .requestId)
    threadId = try values.decodeIfPresent(String.self, forKey: .threadId)
    codexProcessID = try values.decode(Int.self, forKey: .codexProcessID)
    let launchTime = try values.decode(Double.self, forKey: .codexLaunchDate)
    codexLaunchDate = Date(timeIntervalSince1970: launchTime)
  }

  public func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(requestId, forKey: .requestId)
    try values.encodeIfPresent(threadId, forKey: .threadId)
    try values.encode(codexProcessID, forKey: .codexProcessID)
    try values.encode(codexLaunchDate.timeIntervalSince1970, forKey: .codexLaunchDate)
  }
}

public enum VoiceEndOwnershipDecision: Equatable {
  case checkInput
  case block(String)

  public static func forRunningCodex(request: VoiceHandoffRequest, ownedStart: VoiceHandoffStartReceipt?, currentProcess: VoiceCodexProcessIdentity) -> VoiceEndOwnershipDecision {
    guard let ownedStart, ownedStart.isValid() else {
      return .block("Alfred has not started this Codex voice call. Open Codex and end the call there.")
    }
    if let requestedThread = request.threadId, requestedThread != ownedStart.threadId {
      return .block("This stop request belongs to a different Alfred task. Open Codex and end the call there.")
    }
    guard ownedStart.matches(currentProcess) else {
      return .block("This stop request belongs to a different Codex app session. Open Codex and end the call there.")
    }
    return .checkInput
  }
}

public struct VoiceHandoffRequest: Codable, Equatable {
  public let id: String
  public let status: String
  public let requestedAt: Date
  public let expiresAt: Date
  public let detail: String?
  public let action: VoiceHandoffAction
  public let threadId: String?

  public init(id: String, status: String, requestedAt: Date, expiresAt: Date, detail: String? = nil, action: VoiceHandoffAction = .start, threadId: String? = nil) {
    self.id = id; self.status = status; self.requestedAt = requestedAt
    self.expiresAt = expiresAt; self.detail = detail
    self.action = action; self.threadId = threadId
  }

  public func canClaim(now: Date = Date()) -> Bool { status == "pending" && isFresh(now: now) }

  public func isFresh(now: Date = Date()) -> Bool {
    UUID(uuidString: id) != nil && (threadId == nil || UUID(uuidString: threadId!) != nil)
      && now < expiresAt && now >= requestedAt.addingTimeInterval(-5)
      && expiresAt > requestedAt && expiresAt.timeIntervalSince(requestedAt) <= 45
  }

  public func changing(status: String, detail: String? = nil) -> VoiceHandoffRequest {
    VoiceHandoffRequest(id: id, status: status, requestedAt: requestedAt, expiresAt: expiresAt, detail: detail, action: action, threadId: threadId)
  }

  private enum CodingKeys: String, CodingKey { case id, status, requestedAt, expiresAt, detail, action, threadId }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(String.self, forKey: .id)
    status = try values.decode(String.self, forKey: .status)
    requestedAt = try values.decode(Date.self, forKey: .requestedAt)
    expiresAt = try values.decode(Date.self, forKey: .expiresAt)
    detail = try values.decodeIfPresent(String.self, forKey: .detail)
    action = try values.decodeIfPresent(VoiceHandoffAction.self, forKey: .action) ?? .start
    threadId = try values.decodeIfPresent(String.self, forKey: .threadId)
  }
}

public struct VoiceHandoffStore {
  public let directory: URL
  private var requestURL: URL { directory.appendingPathComponent("handoff.json") }
  private var cancelledURL: URL { directory.appendingPathComponent("handoff-cancelled.json") }
  private var sessionURL: URL { directory.appendingPathComponent("voice-session.json") }

  public init(directory: URL) { self.directory = directory }

  public func read() throws -> VoiceHandoffRequest? {
    guard let data = try readSmallFile(requestURL) else { return nil }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let text = try decoder.singleValueContainer().decode(String.self)
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let date = formatter.date(from: text) { return date }
      formatter.formatOptions = [.withInternetDateTime]
      guard let date = formatter.date(from: text) else { throw HandoffError.invalidDate }
      return date
    }
    return try decoder.decode(VoiceHandoffRequest.self, from: data)
  }

  // The menu serializes claims. The separate tombstone cannot be undone by an outcome write.
  public func claim(_ request: VoiceHandoffRequest, now: Date = Date()) throws -> Bool {
    guard let current = try read(), current.id == request.id, current.canClaim(now: now),
          !(try isCancelled(current.id)) else { return false }
    try write(current.changing(status: "claimed"))
    return try canDispatch(current.id, now: now)
  }

  public func canDispatch(_ id: String, now: Date = Date()) throws -> Bool {
    guard let current = try read(), current.id == id, current.status == "claimed",
          current.isFresh(now: now), !(try isCancelled(id)) else { return false }
    return true
  }

  @discardableResult
  public func finish(_ id: String, status: String, detail: String) throws -> Bool {
    guard ["started", "ended", "blocked"].contains(status), try canDispatch(id), let current = try read(),
          current.id == id, current.status == "claimed" else { return false }
    try write(current.changing(status: status, detail: String(detail.prefix(500))))
    return true
  }

  public func readStartReceipt() throws -> VoiceHandoffStartReceipt? {
    guard let data = try readSmallFile(sessionURL) else { return nil }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    guard let receipt = try? decoder.decode(VoiceHandoffStartReceipt.self, from: data), receipt.isValid() else { return nil }
    return receipt
  }

  public func rememberStart(_ receipt: VoiceHandoffStartReceipt) throws {
    guard receipt.isValid() else { return }
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    try encoder.encode(receipt).write(to: sessionURL, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: sessionURL.path)
  }

  public func clearStartReceipt() throws {
    try? FileManager.default.removeItem(at: sessionURL)
  }

  private func isCancelled(_ id: String) throws -> Bool {
    guard let data = try readSmallFile(cancelledURL) else { return false }
    let marker = try JSONDecoder().decode(Cancellation.self, from: data)
    return marker.id == id
  }

  private func write(_ request: VoiceHandoffRequest) throws {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    try encoder.encode(request).write(to: requestURL, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: requestURL.path)
  }

  private func readSmallFile(_ url: URL) throws -> Data? {
    do {
      let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
      guard (attributes[.size] as? NSNumber)?.intValue ?? 8193 <= 8192 else { throw HandoffError.tooLarge }
      let data = try Data(contentsOf: url)
      guard data.count <= 8192 else { throw HandoffError.tooLarge }
      return data
    } catch CocoaError.fileReadNoSuchFile { return nil }
  }

  private struct Cancellation: Decodable { let id: String }
  private enum HandoffError: Error { case invalidDate, tooLarge }
}
