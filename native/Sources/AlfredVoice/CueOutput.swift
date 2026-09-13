import CoreAudio
import Foundation

enum CueOutputMode: String { case current, speakers }

struct CueOutputDevice {
  var id: AudioObjectID
  var uid: String
  var name: String
  var builtIn: Bool
  var alive: Bool
  var hasOutput: Bool
  var volume: Float?
  var muted: Bool?
}

func selectCueOutput(_ mode: CueOutputMode, devices: [CueOutputDevice], defaultID: AudioObjectID) throws -> CueOutputDevice {
  let candidates = devices.filter { $0.alive && $0.hasOutput }
  let selected = mode == .current ? candidates.first { $0.id == defaultID } : candidates.first { $0.builtIn }
  guard let selected else {
    throw WakeAudioError(description: mode == .speakers ? "Mac speakers are unavailable." : "The current sound output is unavailable.")
  }
  return selected
}

func requireAudibleCueOutput(_ device: CueOutputDevice) throws {
  if device.muted == true { throw WakeAudioError(description: "\(device.name) is muted. Turn on its sound before testing the cue.") }
  if let volume = device.volume, volume <= 0 { throw WakeAudioError(description: "\(device.name) is at zero volume. Raise its volume before testing the cue.") }
}

func resolveCueOutput(_ mode: CueOutputMode) throws -> CueOutputDevice {
  let system = AudioObjectID(kAudioObjectSystemObject)
  let ids: [AudioObjectID] = audioIDs(system, selector: kAudioHardwarePropertyDevices)
  guard let defaultID: UInt32 = audioNumber(system, selector: kAudioHardwarePropertyDefaultOutputDevice, initial: 0) else {
    throw WakeAudioError(description: "Could not read the current sound output.")
  }
  let devices = ids.map { id in
    let streams = audioIDs(id, selector: kAudioDevicePropertyStreams, scope: kAudioDevicePropertyScopeOutput)
    let masterVolume: Float? = audioNumber(id, selector: kAudioDevicePropertyVolumeScalar, scope: kAudioDevicePropertyScopeOutput, initial: Float(0))
    let channelVolumes: [Float] = [1, 2].compactMap { channel in
      audioNumber(id, selector: kAudioDevicePropertyVolumeScalar, scope: kAudioDevicePropertyScopeOutput, element: UInt32(channel), initial: Float(0))
    }
    let mute: UInt32? = audioNumber(id, selector: kAudioDevicePropertyMute, scope: kAudioDevicePropertyScopeOutput, initial: UInt32(0))
    let transport: UInt32? = audioNumber(id, selector: kAudioDevicePropertyTransportType, initial: UInt32(0))
    let alive: UInt32? = audioNumber(id, selector: kAudioDevicePropertyDeviceIsAlive, initial: UInt32(0))
    return CueOutputDevice(id: id, uid: audioString(id, selector: kAudioDevicePropertyDeviceUID),
      name: audioString(id, selector: kAudioObjectPropertyName), builtIn: transport == kAudioDeviceTransportTypeBuiltIn,
      alive: alive == 1, hasOutput: !streams.isEmpty, volume: masterVolume ?? channelVolumes.max(), muted: mute.map { $0 != 0 })
  }
  let selected = try selectCueOutput(mode, devices: devices, defaultID: defaultID)
  guard !selected.uid.isEmpty else { throw WakeAudioError(description: "Could not identify \(selected.name) for cue playback.") }
  return selected
}

private func audioIDs(_ id: AudioObjectID, selector: AudioObjectPropertySelector,
                      scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> [AudioObjectID] {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
  var values = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  let status = values.withUnsafeMutableBytes { bytes in AudioObjectGetPropertyData(id, &address, 0, nil, &size, bytes.baseAddress!) }
  return status == noErr ? values : []
}

private func audioNumber<T>(_ id: AudioObjectID, selector: AudioObjectPropertySelector,
                            scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
                            element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain, initial: T) -> T? {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  let status = withUnsafeMutableBytes(of: &value) { bytes in AudioObjectGetPropertyData(id, &address, 0, nil, &size, bytes.baseAddress!) }
  return status == noErr ? value : nil
}

private func audioString(_ id: AudioObjectID, selector: AudioObjectPropertySelector) -> String {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout.size(ofValue: value))
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr, let value else { return "" }
  return value.takeRetainedValue() as String
}
