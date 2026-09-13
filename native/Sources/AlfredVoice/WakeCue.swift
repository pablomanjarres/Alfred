import AVFoundation
import Foundation

// The caller keeps microphone capture stopped until this short cue finishes.
func playWakeCue(output: CueOutputMode = .current, cancelled: () -> Bool = { false }) throws {
  let device = try resolveCueOutput(output)
  var detail: [String: Any] = ["output": output.rawValue, "device": device.name,
    "deviceVolume": device.volume.map { Double($0) } as Any? ?? NSNull(),
    "deviceMuted": device.muted as Any? ?? NSNull(), "playerVolume": 1.0]
  emit("cue", ["status": "starting", "detail": detail])
  try requireAudibleCueOutput(device)
  let player = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: "/System/Library/Sounds/Tink.aiff"))
  let completion = CuePlaybackCompletion()
  player.delegate = completion
  player.currentDevice = device.uid
  player.volume = 1
  player.isMeteringEnabled = true
  defer { player.stop() }
  guard player.prepareToPlay(), player.currentDevice == device.uid, player.play() else {
    throw WakeAudioError(description: "wake cue could not start")
  }
  let started = ProcessInfo.processInfo.systemUptime
  let deadline = started + 5
  var peak: Float = -160
  while completion.success == nil && completion.error == nil {
    guard !cancelled() else { throw WakeAudioError(description: "wake cue cancelled") }
    guard ProcessInfo.processInfo.systemUptime < deadline else {
      throw WakeAudioError(description: "wake cue did not finish within five seconds")
    }
    player.updateMeters()
    peak = max(peak, player.peakPower(forChannel: 0))
    RunLoop.current.run(until: Date().addingTimeInterval(0.01))
  }
  guard completion.success == true else {
    throw WakeAudioError(description: completion.error ?? "wake cue ended without successful playback")
  }
  detail["elapsedMs"] = Int((ProcessInfo.processInfo.systemUptime - started) * 1000)
  detail["peakDb"] = peak
  emit("cue", ["status": "played", "detail": detail])
}

private final class CuePlaybackCompletion: NSObject, AVAudioPlayerDelegate {
  var success: Bool?
  var error: String?
  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { success = flag }
  func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    self.error = error?.localizedDescription ?? "wake cue decoding failed"
  }
}
