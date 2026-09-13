import Foundation

func cueOutputSelftest() {
  let headphones = CueOutputDevice(id: 1, uid: "headphones", name: "Headphones", builtIn: false,
    alive: true, hasOutput: true, volume: 0.31, muted: false)
  let speakers = CueOutputDevice(id: 2, uid: "speakers", name: "Mac speakers", builtIn: true,
    alive: true, hasOutput: true, volume: 0.35, muted: false)
  let input = CueOutputDevice(id: 3, uid: "input", name: "Microphone", builtIn: true,
    alive: true, hasOutput: false, volume: 1, muted: false)
  let devices = [input, headphones, speakers]
  do {
    let current = try selectCueOutput(.current, devices: devices, defaultID: 1)
    let explicit = try selectCueOutput(.speakers, devices: devices, defaultID: 1)
    guard current.uid == "headphones", explicit.uid == "speakers" else {
      fail("cue output selection ignored the requested route")
    }
    try requireAudibleCueOutput(explicit)
  } catch { fail("cue output selection failed: \(error)") }

  func mustFail(_ operation: () throws -> Void) {
    do { try operation() } catch { return }
    fail("cue output should reject an unavailable or silent device")
  }
  mustFail { _ = try selectCueOutput(.speakers, devices: [input, headphones], defaultID: 1) }
  mustFail { _ = try selectCueOutput(.current, devices: devices, defaultID: 99) }
  var silent = speakers
  silent.muted = true
  mustFail { try requireAudibleCueOutput(silent) }
  silent.muted = false
  silent.volume = 0
  mustFail { try requireAudibleCueOutput(silent) }
  silent.alive = false
  mustFail { _ = try selectCueOutput(.speakers, devices: [silent], defaultID: 2) }
  silent.alive = true
  silent.volume = nil
  silent.muted = nil
  do { try requireAudibleCueOutput(silent) }
  catch { fail("devices without hardware volume controls must remain usable") }
  emit("ready", ["status": "cue-selftest", "detail": "explicit routing, missing output, mute and zero-volume checks passed; no sound played"])
}
