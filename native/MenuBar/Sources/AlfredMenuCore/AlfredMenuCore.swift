import Foundation

public struct AlfredCLIConfig: Codable, Equatable {
  public let nodePath: String
  public let cliPath: String
  public let stateHome: String?

  public init(nodePath: String, cliPath: String, stateHome: String? = nil) throws {
    guard nodePath.hasPrefix("/"), cliPath.hasPrefix("/"), stateHome == nil || stateHome!.hasPrefix("/") else { throw ConfigError.relativePath }
    self.nodePath = nodePath
    self.cliPath = cliPath
    self.stateHome = stateHome
  }

  public static func load(from url: URL) throws -> AlfredCLIConfig {
    let decoded = try JSONDecoder().decode(AlfredCLIConfig.self, from: Data(contentsOf: url))
    return try AlfredCLIConfig(nodePath: decoded.nodePath, cliPath: decoded.cliPath, stateHome: decoded.stateHome)
  }

  enum ConfigError: Error { case relativePath }
}

public enum CueOutput: String, Decodable, Equatable {
  case current
  case speakers

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = CueOutput(rawValue: raw) ?? .current
  }

  public var label: String {
    switch self {
    case .current: return "Current audio output"
    case .speakers: return "Mac speakers"
    }
  }
}

public struct StandbySnapshot: Decodable, Equatable {
  public struct State: Decodable, Equatable {
    public let status: String
    public let detail: String
    public let updatedAt: Date
  }

  public let loaded: Bool
  public let running: Bool
  public let pid: Int?
  public let state: State?
  public let detail: String
  public let cueOutput: CueOutput?

  public static func decode(_ json: String) throws -> StandbySnapshot {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(StandbySnapshot.self, from: Data(json.utf8))
  }

  public func menuState(now: Date = Date(), freshSeconds: TimeInterval = 180) -> MenuState {
    let status = state?.status ?? (loaded ? "loaded" : "stopped")
    let text = state?.detail.isEmpty == false ? state!.detail : detail
    let output = cueOutput ?? .current
    if status == "blocked" { return MenuState(kind: .blocked, detail: text, micIndicator: false, cueOutput: output) }
    if status == "handed-off" { return MenuState(kind: .handedOff, detail: text, micIndicator: false, cueOutput: output) }
    if status == "handoff" {
      let alive = loaded && running && pid != nil && now.timeIntervalSince(state?.updatedAt ?? .distantPast) <= 45
      return MenuState(kind: alive ? .handoff : .blocked, detail: alive ? text : "Voice handoff stopped. Choose Start listening.", micIndicator: false, cueOutput: output)
    }
    if status == "paused" { return MenuState(kind: .paused, detail: text, micIndicator: false, cueOutput: output) }
    if status == "starting" { return MenuState(kind: .starting, detail: text, micIndicator: false, cueOutput: output) }
    guard loaded, running, pid != nil else { return MenuState(kind: .stopped, detail: text, micIndicator: false, cueOutput: output) }
    guard let updatedAt = state?.updatedAt, now.timeIntervalSince(updatedAt) <= freshSeconds else {
      return MenuState(kind: .stale, detail: text, micIndicator: false, cueOutput: output)
    }
    return MenuState(kind: .listening, detail: text, micIndicator: true, cueOutput: output)
  }
}

public struct MenuState: Equatable {
  public let kind: MenuStateKind
  public let detail: String
  public let micIndicator: Bool
  public let cueOutput: CueOutput

  public init(kind: MenuStateKind, detail: String, micIndicator: Bool, cueOutput: CueOutput = .current) {
    self.kind = kind; self.detail = detail; self.micIndicator = micIndicator; self.cueOutput = cueOutput
  }

  public var label: String {
    switch kind {
    case .listening: return "Listening for clap or Alfred"
    case .starting: return "Starting listener"
    case .handoff: return "Opening Codex voice chat"
    case .handedOff: return "Voice chat in Codex"
    case .paused: return "Paused for system sleep"
    case .blocked: return "Listener blocked"
    case .stale: return "Listener state stale"
    case .stopped: return "Listener stopped"
    }
  }
}

public enum MenuStateKind: Equatable { case listening, starting, handoff, handedOff, paused, blocked, stale, stopped }

public struct MenuActionError: Equatable {
  public let message: String
  public let expiresAt: Date

  public init(message: String, expiresAt: Date) {
    self.message = message
    self.expiresAt = expiresAt
  }

  public func visibleMessage(now: Date = Date()) -> String? {
    guard now < expiresAt else { return nil }
    let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "Action failed." : trimmed
  }
}

public func menuDetail(_ state: MenuState, actionError: MenuActionError?, now: Date = Date()) -> String {
  actionError?.visibleMessage(now: now) ?? state.detail
}
