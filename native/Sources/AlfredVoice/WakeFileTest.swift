import AVFoundation
import Foundation

// Reads an explicitly supplied test fixture. This path never opens a microphone.
func testWakeFile(_ path: String, using keyword: WakeKeywordSpotting) throws {
  defer { keyword.close() }
  let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
  let capacity = AVAudioFrameCount(file.processingFormat.sampleRate * 0.1)
  guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: capacity) else {
    throw WakeAudioError(description: "could not create wake test buffer")
  }
  var detected = false
  var chunks = 0
  while file.framePosition < file.length && !detected {
    try file.read(into: buffer, frameCount: AVAudioFrameCount(min(Int64(capacity), file.length - file.framePosition)))
    _ = try consumeWakeAudio(buffer) { try keyword.accept($0) }
    detected = try keyword.decode()
    chunks += 1
  }
  // Ordinary streaming silence completes trailing phonemes without using EOF.
  let silenceFormat = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
  let silence = AVAudioPCMBuffer(pcmFormat: silenceFormat, frameCapacity: 1_600)!
  silence.frameLength = 1_600
  for index in 0..<1_600 { silence.floatChannelData![0][index] = 0 }
  for _ in 0..<10 where !detected {
    _ = try consumeWakeAudio(silence) { try keyword.accept($0) }
    detected = try keyword.decode()
    chunks += 1
  }
  keyword.close()
  emit("wake-test", ["detected": detected, "chunks": chunks, "streaming": true,
                     "microphone": "unused", "rawAudio": "erased"])
}
