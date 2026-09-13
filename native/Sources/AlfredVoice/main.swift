import AVFoundation
import Foundation
import Speech
struct Options {
  var command = "listen"
  var locale = Locale.current.identifier
  var file: String?
  var cue = false
}
func emit(_ type: String, _ fields: [String: Any] = [:]) {
  var object = fields
  object["type"] = type
  let data = try! JSONSerialization.data(withJSONObject: object)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([10]))
}
func fail(_ message: String, _ code: Int32 = 1) -> Never {
  emit("error", ["message": message])
  exit(code)
}
final class Locked<Value> {
  private let lock = NSLock()
  private var value: Value
  init(_ value: Value) { self.value = value }
  func get() -> Value { lock.lock(); defer { lock.unlock() }; return value }
  func set(_ value: Value) { lock.lock(); self.value = value; lock.unlock() }
}
func waitUntil(_ deadline: Date, _ done: () -> Bool) -> Bool {
  while !done() && Date() < deadline {
    RunLoop.current.run(mode: .default, before: min(Date().addingTimeInterval(0.02), deadline))
  }
  return done()
}
func parseOptions() -> Options {
  var options = Options()
  let args = Array(CommandLine.arguments.dropFirst())
  if let first = args.first { options.command = first }
  var index = 1
  while index < args.count {
    switch args[index] {
    case "--locale":
      index += 1
      guard index < args.count else { fail("--locale needs a value") }
      options.locale = args[index]
    case "--file":
      index += 1
      guard index < args.count else { fail("--file needs a value") }
      options.file = args[index]
    case "--cue":
      guard options.command == "wake-watch" else { fail("--cue requires wake-watch") }
      options.cue = true
    default:
      fail("unknown argument \(args[index])")
    }
    index += 1
  }
  return options
}
func recognizer(_ locale: String) -> SFSpeechRecognizer {
  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
    fail("speech recognizer unavailable for \(locale)")
  }
  guard recognizer.supportsOnDeviceRecognition else {
    fail("on-device speech recognition unavailable for \(locale)")
  }
  return recognizer
}
func doctor(_ locale: String) {
  _ = recognizer(locale)
  let speech = SFSpeechRecognizer.authorizationStatus()
  let mic = AVCaptureDevice.authorizationStatus(for: .audio)
  let hasInput = AVCaptureDevice.default(for: .audio) != nil
  let detail = "speech=\(authName(speech)) microphone=\(authName(mic)) audioInput=\(hasInput)"
  if speech != .authorized { fail("speech recognition is not authorized: \(detail)") }
  if mic != .authorized || !hasInput { fail("microphone is not ready: \(detail)") }
  emit("ready", ["status": "ready", "detail": detail])
}
func authName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
  switch status {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}
func authName(_ status: AVAuthorizationStatus) -> String {
  switch status {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}
func authorizeSpeech() {
  let completed = Locked(false)
  let allowed = Locked(false)
  SFSpeechRecognizer.requestAuthorization { status in
    allowed.set(status == .authorized)
    completed.set(true)
  }
  if !waitUntil(Date().addingTimeInterval(60), { completed.get() }) { fail("speech authorization timed out") }
  if !allowed.get() { fail("speech recognition permission was not granted") }
}
func authorizeMic() {
  let completed = Locked(false)
  let allowed = Locked(false)
  AVCaptureDevice.requestAccess(for: .audio) { granted in
    allowed.set(granted)
    completed.set(true)
  }
  if !waitUntil(Date().addingTimeInterval(60), { completed.get() }) { fail("microphone authorization timed out") }
  if !allowed.get() { fail("microphone permission was not granted") }
}
final class ClapDetector {
  private var lastClap = -10.0
  private var startedHigh: Double?
  private var sawFirst = false

  func push(rms: Float, peak: Float, time: Double) -> Bool {
    if rms < 0.05 { startedHigh = nil; return false }
    if startedHigh == nil { startedHigh = time }
    guard peak > 0.55, rms > 0.10, time - (startedHigh ?? time) < 0.16 else { return false }
    guard time - lastClap > 0.18 else { return false }
    defer { lastClap = time; sawFirst = true }
    return sawFirst && time - lastClap < 0.9
  }
}
func detectorSelftest() -> Bool {
  let clap = ClapDetector()
  let hit = [
    clap.push(rms: 0.01, peak: 0.03, time: 0.00),
    clap.push(rms: 0.28, peak: 0.84, time: 0.10),
    clap.push(rms: 0.02, peak: 0.05, time: 0.30),
    clap.push(rms: 0.31, peak: 0.90, time: 0.58)
  ].contains(true)

  let moderate = ClapDetector()
  let moderateHit = [
    moderate.push(rms: 0.01, peak: 0.03, time: 0.00),
    moderate.push(rms: 0.12, peak: 0.82, time: 0.10),
    moderate.push(rms: 0.02, peak: 0.04, time: 0.20),
    moderate.push(rms: 0.13, peak: 0.86, time: 0.50)
  ].contains(true)

  let single = ClapDetector()
  let singleRejected = ![
    single.push(rms: 0.01, peak: 0.03, time: 0.00),
    single.push(rms: 0.12, peak: 0.82, time: 0.10),
    single.push(rms: 0.02, peak: 0.04, time: 0.20)
  ].contains(true)

  let speech = ClapDetector()
  var speechRejected = true
  for i in 0..<12 {
    speechRejected = speechRejected && !speech.push(rms: 0.24, peak: 0.64, time: Double(i) * 0.07)
  }

  let sustained = ClapDetector()
  var sustainedRejected = true
  for i in 0..<8 {
    sustainedRejected = sustainedRejected && !sustained.push(rms: 0.12, peak: 0.64, time: Double(i) * 0.10)
  }

  return hit && moderateHit && singleRejected && speechRejected && sustainedRejected
}
func selftest() {
  let callbackRan = Locked(false)
  DispatchQueue.main.async { callbackRan.set(true) }
  let mainCallbackRuns = waitUntil(Date().addingTimeInterval(0.5), { callbackRan.get() })
  if detectorSelftest() && mainCallbackRuns { emit("ready", ["status": "selftest", "detail": "clap detector ok"]) }
  else { fail("clap detector selftest failed") }
}
func transcribeFile(_ path: String, _ locale: String) {
  authorizeSpeech()
  let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
  request.requiresOnDeviceRecognition = true
  let done = Locked(false)
  let output = Locked("")
  let failure = Locked<String?>(nil)
  let speechRecognizer = recognizer(locale)
  emit("ready", ["status": "ready"])
  let task = speechRecognizer.recognitionTask(with: request) { result, error in
    if result?.isFinal == true {
      output.set(result?.bestTranscription.formattedString ?? "")
      done.set(true)
    }
    if let error { failure.set(error.localizedDescription); done.set(true) }
  }
  withExtendedLifetime((speechRecognizer, task)) {
    _ = waitUntil(Date().addingTimeInterval(30), { done.get() })
  }
  if let failure = failure.get() { fail(failure) }
  if output.get().isEmpty { fail("no final transcript produced") }
  emit("transcript", ["text": output.get()])
}
func listenOnce(_ locale: String) {
  authorizeSpeech()
  authorizeMic()
  let engine = AVAudioEngine()
  let input = engine.inputNode
  let request = SFSpeechAudioBufferRecognitionRequest()
  request.requiresOnDeviceRecognition = true
  request.shouldReportPartialResults = true
  let done = Locked(false)
  let finalText = Locked("")
  let failure = Locked<String?>(nil)
  let speechRecognizer = recognizer(locale)
  let task = speechRecognizer.recognitionTask(with: request) { result, error in
    if result?.isFinal == true {
      finalText.set(result?.bestTranscription.formattedString ?? "")
      done.set(true)
    }
    if let error { failure.set(error.localizedDescription); done.set(true) }
  }
  input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
    request.append(buffer)
  }
  do { try engine.start() } catch { fail("audio engine could not start: \(error.localizedDescription)") }
  emit("ready", ["status": "ready"])
  emit("listening", ["status": "listening"])
  _ = waitUntil(Date().addingTimeInterval(12), { done.get() })
  engine.stop()
  input.removeTap(onBus: 0)
  request.endAudio()
  withExtendedLifetime((speechRecognizer, task)) {
    _ = waitUntil(Date().addingTimeInterval(5), { done.get() })
  }
  if let failure = failure.get(), finalText.get().isEmpty { fail(failure) }
  if finalText.get().isEmpty { fail("no final transcript produced") }
  emit("transcript", ["text": finalText.get()])
}

func authorizeClap() {
  authorizeMic()
  clapDoctor()
}
func clapDoctor() {
  let mic = AVCaptureDevice.authorizationStatus(for: .audio)
  let hasInput = AVCaptureDevice.default(for: .audio) != nil
  let detail = "microphone=\(authName(mic)) audioInput=\(hasInput) speech=unused"
  if mic != .authorized || !hasInput { fail("microphone is not ready: \(detail)") }
  emit("ready", ["status": "clap", "detail": detail])
}
func clapFeaturesAndWipe(_ buffer: AVAudioPCMBuffer) -> (rms: Float, peak: Float, frameDuration: Double, capacityDuration: Double, valid: Bool) {
  let frames = Int(buffer.frameLength)
  let capacity = Int(buffer.frameCapacity)
  let channels = Int(buffer.format.channelCount)
  let sampleRate = buffer.format.sampleRate
  let frameDuration = sampleRate > 0 ? Double(frames) / sampleRate : 0
  let capacityDuration = sampleRate > 0 ? Double(capacity) / sampleRate : 0
  guard buffer.format.commonFormat == .pcmFormatFloat32, !buffer.format.isInterleaved, let data = buffer.floatChannelData else {
    return (0, 0, frameDuration, capacityDuration, false)
  }
  var sum: Float = 0
  var peak: Float = 0
  defer {
    for channelIndex in 0..<channels {
      let channel = data[channelIndex]
      for index in 0..<capacity { channel[index] = 0 }
    }
  }
  for channelIndex in 0..<channels {
    let channel = data[channelIndex]
    for index in 0..<frames {
      let sample = abs(channel[index])
      peak = max(peak, sample)
      sum += sample * sample
    }
  }
  return (sqrt(sum / Float(max(frames * max(channels, 1), 1))), peak, frameDuration, capacityDuration, true)
}
func clapPrivacySelftest() {
  guard let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2),
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2048) else { fail("could not build clap fixture") }
  buffer.frameLength = 1024
  guard let data = buffer.floatChannelData else { fail("could not access clap fixture") }
  data[0][0] = 0.8; data[0][1] = -0.4; data[0][1500] = 0.5; data[1][0] = -0.7; data[1][1] = 0.2; data[1][1500] = -0.5
  let features = clapFeaturesAndWipe(buffer)
  var wiped = true
  for channelIndex in 0..<2 { for index in 0..<Int(buffer.frameCapacity) { wiped = wiped && data[channelIndex][index] == 0 } }
  guard let oversize = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48_001) else { fail("could not build oversized clap fixture") }
  oversize.frameLength = 1024
  guard let oversizeData = oversize.floatChannelData else { fail("could not access oversized clap fixture") }
  oversizeData[0][48_000] = 0.9
  let oversizeFeatures = clapFeaturesAndWipe(oversize)
  let oversizeWiped = oversizeData[0][48_000] == 0 && oversizeFeatures.capacityDuration > 1
  if detectorSelftest() && wiped && oversizeWiped && features.valid && features.frameDuration <= 1 && features.capacityDuration <= 1 && features.peak >= 0.8 {
    emit("ready", ["status": "clap"])
    emit("clap", ["status": "clap", "detail": "speech=unused audio=not-retained"])
    emit("idle", ["status": "clap"])
  } else { fail("clap privacy selftest failed") }
}

func waitForClap() -> Bool {
  authorizeMic()
  let engine = AVAudioEngine()
  let input = engine.inputNode
  let detector = ClapDetector()
  let heard = Locked(false)
  let frameCount = Locked(0)
  let maxBufferSeconds = Locked(0.0)
  let maxCapacitySeconds = Locked(0.0)
  let lastFrameAt = Locked(0.0)
  let privacyFailure = Locked<String?>(nil)
  let start = Date()
  func proof() -> [String: Any] {
    ["frames": frameCount.get(), "lastFrameAt": lastFrameAt.get(), "maxBufferSeconds": maxBufferSeconds.get(), "maxCapacitySeconds": maxCapacitySeconds.get(), "speech": "unused"]
  }
  let tapFormat = input.outputFormat(forBus: 0)
  guard tapFormat.commonFormat == .pcmFormatFloat32 && !tapFormat.isInterleaved else { fail("unsupported clap audio format") }
  emit("ready", ["status": "ready", "detail": "speech=unused audio=not-retained maxBufferSeconds<=1"])
  emit("listening", ["status": "clap"])
  input.installTap(onBus: 0, bufferSize: 1024, format: tapFormat) { buffer, _ in
    let features = clapFeaturesAndWipe(buffer)
    frameCount.set(frameCount.get() + Int(buffer.frameLength))
    maxBufferSeconds.set(max(maxBufferSeconds.get(), features.frameDuration))
    maxCapacitySeconds.set(max(maxCapacitySeconds.get(), features.capacityDuration))
    lastFrameAt.set(Date().timeIntervalSince1970)
    guard features.valid else { privacyFailure.set("unsupported clap audio format") ; return }
    guard features.frameDuration <= 1 && features.capacityDuration <= 1 else { privacyFailure.set("clap audio buffer exceeded one second") ; return }
    if detector.push(rms: features.rms, peak: features.peak, time: Date().timeIntervalSince(start)) { heard.set(true) }
  }
  do { try engine.start() } catch { fail("audio engine could not start: \(error.localizedDescription)") }
  let detected = waitUntil(Date().addingTimeInterval(120), { heard.get() || privacyFailure.get() != nil })
  engine.stop()
  input.removeTap(onBus: 0)
  if let privacyFailure = privacyFailure.get() { fail(privacyFailure) }
  if !detected {
    emit("idle", ["status": "clap", "detail": proof()])
    return false
  }
  _ = Process.launchedProcess(launchPath: "/usr/bin/caffeinate", arguments: ["-u", "-t", "3"])
  emit("clap", ["status": "clap", "detail": proof()])
  return true
}
let options = parseOptions()
switch options.command {
case "doctor": doctor(options.locale)
case "clap-authorize": authorizeClap()
case "clap-doctor": clapDoctor()
case "selftest": selftest()
case "clap-selftest": clapPrivacySelftest()
case "wake-audio-selftest": wakeAudioSelftest()
case "wake-cue":
  do { try playWakeCue() } catch { fail(String(describing: error)) }
case "wake-watch", "wake-file":
  do {
    guard let resources = Bundle.main.resourceURL else {
      throw WakeAudioError(description: "Alfred wake resources are missing")
    }
    let keyword = try AlfredKeywordSpotter(resourcesDirectory: resources)
    if options.command == "wake-watch" {
      _ = try waitForWake(using: keyword, cueBeforeListening: options.cue)
    }
    else {
      guard let file = options.file else {
        keyword.close()
        throw WakeAudioError(description: "wake-file requires --file")
      }
      try testWakeFile(file, using: keyword)
    }
  } catch { fail(String(describing: error)) }
case "clap-watch": _ = waitForClap()
case "file":
  guard let file = options.file else { fail("file mode requires --file") }
  transcribeFile(file, options.locale)
case "listen": fail("Alfred-owned live microphone transcription is disabled. Use the Codex voice button for spoken commands.")
case "clap": fail("Alfred-owned live microphone transcription is disabled. Use clap-watch or standby for clap detection only.")
default: fail("unknown command \(options.command)")
}
