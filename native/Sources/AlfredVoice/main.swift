import AVFoundation
import Foundation
import Speech
struct Options {
  var command = "listen"
  var locale = Locale.current.identifier
  var file: String?
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
    guard peak > 0.55, rms > 0.18, time - (startedHigh ?? time) < 0.16 else { return false }
    guard time - lastClap > 0.18 else { return false }
    defer { lastClap = time; sawFirst = true }
    return sawFirst && time - lastClap < 0.9
  }
}
func selftest() {
  let clap = ClapDetector()
  let hit = [
    clap.push(rms: 0.01, peak: 0.03, time: 0.00),
    clap.push(rms: 0.28, peak: 0.84, time: 0.10),
    clap.push(rms: 0.02, peak: 0.05, time: 0.30),
    clap.push(rms: 0.31, peak: 0.90, time: 0.58)
  ].contains(true)
  let speech = ClapDetector()
  var rejected = true
  for i in 0..<12 {
    rejected = rejected && !speech.push(rms: 0.24, peak: 0.64, time: Double(i) * 0.07)
  }
  let callbackRan = Locked(false)
  DispatchQueue.main.async {
    callbackRan.set(true)
  }
  let mainCallbackRuns = waitUntil(Date().addingTimeInterval(0.5), { callbackRan.get() })
  if hit && rejected && mainCallbackRuns { emit("ready", ["status": "selftest", "detail": "clap detector ok"]) }
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
func waitForClap() -> Bool {
  authorizeMic()
  let engine = AVAudioEngine()
  let input = engine.inputNode
  let detector = ClapDetector()
  let heard = Locked(false)
  let start = Date()
  emit("ready", ["status": "ready"])
  emit("listening", ["status": "clap"])
  input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
    guard let channel = buffer.floatChannelData?[0] else { return }
    let count = Int(buffer.frameLength)
    var sum: Float = 0
    var peak: Float = 0
    for index in 0..<count {
      let sample = abs(channel[index])
      peak = max(peak, sample)
      sum += sample * sample
    }
    let rms = sqrt(sum / Float(max(count, 1)))
    if detector.push(rms: rms, peak: peak, time: Date().timeIntervalSince(start)) { heard.set(true) }
  }
  do { try engine.start() } catch { fail("audio engine could not start: \(error.localizedDescription)") }
  let detected = waitUntil(Date().addingTimeInterval(120), { heard.get() })
  engine.stop()
  input.removeTap(onBus: 0)
  if !detected {
    emit("idle", ["status": "clap"])
    return false
  }
  _ = Process.launchedProcess(launchPath: "/usr/bin/caffeinate", arguments: ["-u", "-t", "3"])
  return true
}
let options = parseOptions()
switch options.command {
case "doctor": doctor(options.locale)
case "selftest": selftest()
case "file":
  guard let file = options.file else { fail("file mode requires --file") }
  transcribeFile(file, options.locale)
case "listen": listenOnce(options.locale)
case "clap": if waitForClap() { listenOnce(options.locale) }
default: fail("unknown command \(options.command)")
}
