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
  let sema = DispatchSemaphore(value: 0)
  var allowed = false
  SFSpeechRecognizer.requestAuthorization { status in
    allowed = status == .authorized
    sema.signal()
  }
  sema.wait()
  if !allowed { fail("speech recognition permission was not granted") }
}
func authorizeMic() {
  let sema = DispatchSemaphore(value: 0)
  var allowed = false
  AVCaptureDevice.requestAccess(for: .audio) { granted in
    allowed = granted
    sema.signal()
  }
  sema.wait()
  if !allowed { fail("microphone permission was not granted") }
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
  if hit && rejected { emit("ready", ["status": "selftest", "detail": "clap detector ok"]) }
  else { fail("clap detector selftest failed") }
}
func transcribeFile(_ path: String, _ locale: String) {
  authorizeSpeech()
  let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
  request.requiresOnDeviceRecognition = true
  let sema = DispatchSemaphore(value: 0)
  var output = ""
  var failure: String?
  emit("ready", ["status": "ready"])
  recognizer(locale).recognitionTask(with: request) { result, error in
    if let result { output = result.bestTranscription.formattedString }
    if let error { failure = error.localizedDescription; sema.signal() }
    if result?.isFinal == true { sema.signal() }
  }
  _ = sema.wait(timeout: .now() + 30)
  if let failure { fail(failure) }
  if output.isEmpty { fail("no transcript produced") }
  emit("transcript", ["text": output])
}
func listenOnce(_ locale: String) {
  authorizeSpeech()
  authorizeMic()
  let engine = AVAudioEngine()
  let input = engine.inputNode
  let request = SFSpeechAudioBufferRecognitionRequest()
  request.requiresOnDeviceRecognition = true
  request.shouldReportPartialResults = true
  var best = ""
  var failure: String?
  let sema = DispatchSemaphore(value: 0)
  recognizer(locale).recognitionTask(with: request) { result, error in
    if let result { best = result.bestTranscription.formattedString }
    if let error { failure = error.localizedDescription; sema.signal() }
    if result?.isFinal == true { sema.signal() }
  }
  input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
    request.append(buffer)
  }
  do { try engine.start() } catch { fail("audio engine could not start: \(error.localizedDescription)") }
  emit("ready", ["status": "ready"])
  emit("listening", ["status": "listening"])
  _ = sema.wait(timeout: .now() + 12)
  engine.stop()
  input.removeTap(onBus: 0)
  request.endAudio()
  if let failure, best.isEmpty { fail(failure) }
  if best.isEmpty { fail("no transcript produced") }
  emit("transcript", ["text": best])
}
func waitForClap() {
  authorizeMic()
  let engine = AVAudioEngine()
  let input = engine.inputNode
  let detector = ClapDetector()
  let sema = DispatchSemaphore(value: 0)
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
    if detector.push(rms: rms, peak: peak, time: Date().timeIntervalSince(start)) { sema.signal() }
  }
  do { try engine.start() } catch { fail("audio engine could not start: \(error.localizedDescription)") }
  if sema.wait(timeout: .now() + 120) == .timedOut { fail("double clap was not heard") }
  engine.stop()
  input.removeTap(onBus: 0)
  _ = Process.launchedProcess(launchPath: "/usr/bin/caffeinate", arguments: ["-u", "-t", "3"])
}
let options = parseOptions()
switch options.command {
case "doctor": doctor(options.locale)
case "selftest": selftest()
case "file":
  guard let file = options.file else { fail("file mode requires --file") }
  transcribeFile(file, options.locale)
case "listen": listenOnce(options.locale)
case "clap": waitForClap(); listenOnce(options.locale)
default: fail("unknown command \(options.command)")
}
