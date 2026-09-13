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

public struct VoiceHandoffStartReceipt: Equatable {
  public let requestId: String
  public let threadId: String?

  public init(requestId: String, threadId: String?) {
    self.requestId = requestId
    self.threadId = threadId
  }
}

public enum VoiceEndOwnershipDecision: Equatable {
  case checkInput
  case block(String)

  public static func forRunningCodex(request: VoiceHandoffRequest, ownedStart: VoiceHandoffStartReceipt?) -> VoiceEndOwnershipDecision {
    guard let ownedStart else {
      return .block("Alfred has not started this Codex voice call. Open Codex and end the call there.")
    }
    if let requestedThread = request.threadId, requestedThread != ownedStart.threadId {
      return .block("This stop request belongs to a different Alfred task. Open Codex and end the call there.")
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
