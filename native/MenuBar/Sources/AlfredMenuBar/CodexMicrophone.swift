import CoreAudio
import Foundation
import Darwin

public enum CodexMicrophone {
  public static func inputIsActive(in appURL: URL) throws -> Bool {
    guard #available(macOS 14.2, *) else { throw Error.unknown("Codex microphone metadata requires macOS 14.2 or newer.") }
    return try inputIsActive14(in: appURL, allowRaceRetry: true)
  }

  @available(macOS 14.2, *)
  private static func inputIsActive14(in appURL: URL, allowRaceRetry: Bool) throws -> Bool {
    let root = appURL.resolvingSymlinksInPath().standardizedFileURL.path
    do {
      for object in try processObjects() {
        let bundleID = try stringProperty(object, kAudioProcessPropertyBundleID)
        guard isCodexBundle(bundleID) else { continue }
        let pid = try pidProperty(object)
        guard try processPath(for: pid).belongs(to: root) else { continue }
        if try boolProperty(object, kAudioProcessPropertyIsRunningInput) { return true }
      }
      return false
    } catch {
      if allowRaceRetry { return try inputIsActive14(in: appURL, allowRaceRetry: false) }
      throw error
    }
  }

  private static func isCodexBundle(_ bundleID: String) -> Bool {
    bundleID == "com.openai.codex" || bundleID == "com.openai.codex.helper" || bundleID == "com.openai.codex.helper.renderer"
  }

  @available(macOS 14.2, *)
  private static func processObjects() throws -> [AudioObjectID] {
    var address = property(kAudioHardwarePropertyProcessObjectList)
    guard AudioObjectHasProperty(AudioObjectID(kAudioObjectSystemObject), &address) else { throw Error.unknown("CoreAudio system object is missing the process list property.") }
    var size: UInt32 = 0
    try check(AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size))
    guard size > 0 else { return [] }
    guard size % UInt32(MemoryLayout<AudioObjectID>.stride) == 0 else { throw Error.unknown("CoreAudio process list returned an invalid byte size.") }
    let requestedSize = size
    let count = Int(size) / MemoryLayout<AudioObjectID>.stride
    var objects = Array(repeating: AudioObjectID(kAudioObjectUnknown), count: count)
    try objects.withUnsafeMutableBufferPointer { buffer in
      guard let base = buffer.baseAddress else { return }
      try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, base))
    }
    guard size <= requestedSize, size % UInt32(MemoryLayout<AudioObjectID>.stride) == 0 else { throw Error.unknown("CoreAudio process list changed while being read.") }
    return objects.prefix(Int(size) / MemoryLayout<AudioObjectID>.stride).filter { $0 != AudioObjectID(kAudioObjectUnknown) }
  }

  @available(macOS 14.2, *)
  private static func pidProperty(_ object: AudioObjectID) throws -> pid_t {
    var pid = pid_t(0)
    var size = UInt32(MemoryLayout<pid_t>.stride)
    try read(object, selector: kAudioProcessPropertyPID, size: &size, expectedSize: UInt32(MemoryLayout<pid_t>.stride), data: &pid)
    guard pid > 0 else { throw Error.unknown("CoreAudio process object returned an invalid pid.") }
    return pid
  }

  @available(macOS 14.2, *)
  private static func boolProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> Bool {
    var value = UInt32(0)
    var size = UInt32(MemoryLayout<UInt32>.stride)
    try read(object, selector: selector, size: &size, expectedSize: UInt32(MemoryLayout<UInt32>.stride), data: &value)
    return value != 0
  }

  @available(macOS 14.2, *)
  private static func stringProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.stride)
    try read(object, selector: selector, size: &size, expectedSize: UInt32(MemoryLayout<Unmanaged<CFString>?>.stride), data: &value)
    guard let value else { throw Error.unknown("CoreAudio process object returned a nil bundle id.") }
    return value.takeRetainedValue() as String
  }

  @available(macOS 14.2, *)
  private static func read(_ object: AudioObjectID, selector: AudioObjectPropertySelector, size: inout UInt32, expectedSize: UInt32, data: UnsafeMutableRawPointer) throws {
    var address = property(selector)
    guard AudioObjectHasProperty(object, &address) else { throw Error.unknown("CoreAudio process object is missing property \(selector).") }
    try check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, data))
    guard size == expectedSize else { throw Error.unknown("CoreAudio process property \(selector) returned an invalid byte size.") }
  }

  @available(macOS 14.2, *)
  private static func property(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  }

  private static func processPath(for pid: pid_t) throws -> String {
    var buffer = Array(repeating: CChar(0), count: 4096)
    let count = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    guard count > 0 else { throw Error.unknown("Could not resolve process path for pid \(pid).") }
    return String(cString: buffer).resolvingSymlinksInPath()
  }

  private static func check(_ status: OSStatus) throws {
    guard status == noErr else { throw Error.unknown("CoreAudio returned OSStatus \(status).") }
  }

  public enum Error: Swift.Error, LocalizedError, Equatable {
    case unknown(String)
    public var errorDescription: String? {
      switch self { case .unknown(let message): return message }
    }
  }
}

private extension String {
  func resolvingSymlinksInPath() -> String {
    URL(fileURLWithPath: self).resolvingSymlinksInPath().standardizedFileURL.path
  }

  func belongs(to root: String) -> Bool {
    self == root || hasPrefix(root.hasSuffix("/") ? root : root + "/")
  }
}
