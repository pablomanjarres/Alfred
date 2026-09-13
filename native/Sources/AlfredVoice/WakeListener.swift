import AppKit
import AVFoundation
import Darwin
import Foundation

protocol WakeKeywordSpotting: AnyObject {
  func accept(_ samples: UnsafeBufferPointer<Float>) throws
  func decode() throws -> Bool
  func close()
}

func waitForWake(using keyword: WakeKeywordSpotting) throws -> Bool {
  defer { keyword.close() }
  authorizeMic()
  let engine = AVAudioEngine()
  let input = engine.inputNode
  let format = input.outputFormat(forBus: 0)
  guard format.commonFormat == .pcmFormatFloat32, !format.isInterleaved,
        format.sampleRate > 0, format.channelCount > 0 else {
    throw WakeAudioError(description: "unsupported wake input format")
  }
  let clap = ClapDetector()
  let heard = Locked<String?>(nil)
  let failure = Locked<String?>(nil)
  let stopping = Locked(false)
  let lastAudio = Locked(ProcessInfo.processInfo.systemUptime)
  let frames = Locked(0)
  let maxCapacity = Locked(0.0)
  let maxProcessing = Locked(0.0)
  let started = ProcessInfo.processInfo.systemUptime
  let signals = [SIGTERM, SIGINT].map { number -> DispatchSourceSignal in
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler { stopping.set(true) }
    source.resume()
    return source
  }
  defer {
    signals.forEach { $0.cancel() }
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL)
  }
  let sleepObserver = NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.willSleepNotification, object: nil, queue: .main
  ) { _ in stopping.set(true) }
  defer { NSWorkspace.shared.notificationCenter.removeObserver(sleepObserver) }

  input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
    do {
      let proof = try consumeWakeAudio(buffer) { samples in
        if !stopping.get() && heard.get() == nil { try keyword.accept(samples) }
      }
      // Both the input and converted waveform are erased before neural decoding.
      lastAudio.set(ProcessInfo.processInfo.systemUptime)
      frames.set(frames.get() + Int(buffer.frameLength))
      maxCapacity.set(max(maxCapacity.get(), proof.capacitySeconds))
      maxProcessing.set(max(maxProcessing.get(), proof.processingSeconds))
      guard proof.processingSeconds < 0.5 else {
        throw WakeAudioError(description: "wake audio processing exceeded its time limit")
      }
      if stopping.get() || heard.get() != nil { return }
      if clap.push(rms: proof.rms, peak: proof.peak,
                   time: ProcessInfo.processInfo.systemUptime - started) {
        heard.set("clap")
      } else if try keyword.decode() { heard.set("Alfred") }
    } catch { failure.set(String(describing: error)) }
  }
  var tapInstalled = true
  func stopCapture() {
    engine.stop()
    if tapInstalled { input.removeTap(onBus: 0); tapInstalled = false }
    keyword.close()
  }
  defer { stopCapture() }
  try engine.start()
  emit("ready", ["status": "wake", "detail": "Double clap or Alfred; local keyword detection; no recordings"])
  let deadline = Date().addingTimeInterval(120)
  _ = waitUntil(deadline) {
    if ProcessInfo.processInfo.systemUptime - lastAudio.get() >= 0.75 {
      failure.set("microphone stopped delivering audio; wake buffers cleared")
    }
    return heard.get() != nil || failure.get() != nil || stopping.get()
  }
  // Release native waveform tails before reporting a trigger or going idle.
  stopCapture()
  if let error = failure.get() { throw WakeAudioError(description: error) }
  let proof: [String: Any] = [
    "frames": frames.get(), "maxCapacitySeconds": maxCapacity.get(),
    "maxProcessingSeconds": maxProcessing.get(), "speech": "unused",
    "rawAudio": "erased", "keyword": "Alfred"
  ]
  guard let trigger = heard.get(), !stopping.get() else {
    emit("idle", ["status": "wake", "detail": proof])
    return false
  }
  _ = Process.launchedProcess(launchPath: "/usr/bin/caffeinate", arguments: ["-u", "-t", "3"])
  emit("wake", ["status": trigger, "detail": proof])
  return true
}
