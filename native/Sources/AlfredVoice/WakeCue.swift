import AVFoundation
import Foundation

// The caller keeps microphone capture stopped until this short cue finishes.
func playWakeCue(cancelled: () -> Bool = { false }) throws {
  let player = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: "/System/Library/Sounds/Tink.aiff"))
  defer { player.stop() }
  guard player.prepareToPlay(), player.play() else {
    throw WakeAudioError(description: "wake cue could not start")
  }
  let deadline = ProcessInfo.processInfo.systemUptime + 5
  while player.isPlaying {
    guard !cancelled() else { throw WakeAudioError(description: "wake cue cancelled") }
    guard ProcessInfo.processInfo.systemUptime < deadline else {
      throw WakeAudioError(description: "wake cue did not finish within five seconds")
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.01))
  }
  emit("cue", ["status": "played", "detail": "Short wake cue completed; microphone will start next"])
}
