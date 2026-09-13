import AVFoundation
import Foundation

func wakeAudioSelftest() {
  do {
    let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 2)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4_500)!
    buffer.frameLength = 4_410
    for channel in 0..<2 {
      for index in 0..<4_500 { buffer.floatChannelData![channel][index] = 0.5 }
    }
    var consumed = false
    let proof = try consumeWakeAudio(buffer) { samples in
      consumed = samples.count == 1_600 && samples.allSatisfy { abs($0 - 0.5) < 0.0001 }
    }
    guard consumed, abs(proof.rms - 0.5) < 0.0001, proof.frameSeconds == 0.1,
          proof.capacitySeconds < 0.11, proof.processingSeconds < 0.5 else {
      fail("wake audio resampling selftest failed")
    }
    func wiped(_ fixture: AVAudioPCMBuffer) -> Bool {
      (0..<Int(fixture.format.channelCount)).allSatisfy { channel in
        (0..<Int(fixture.frameCapacity)).allSatisfy { fixture.floatChannelData![channel][$0] == 0 }
      }
    }
    guard wiped(buffer) else { fail("wake audio did not erase unused capacity") }

    for index in 0..<4_410 {
      buffer.floatChannelData![0][index] = 0.75
      buffer.floatChannelData![1][index] = -0.75
    }
    _ = try consumeWakeAudio(buffer) { samples in
      guard samples.allSatisfy({ abs($0) < 0.0001 }) else { fail("wake audio downmix failed") }
      throw WakeAudioError(description: "synthetic consumer failure")
    }
    fail("wake audio swallowed consumer failure")
  } catch let error as WakeAudioError where error.description == "synthetic consumer failure" {
    // An independent fixture below exercises the error-path wipe.
  } catch { fail("wake audio selftest failed: \(error)") }

  let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
  let delayedBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 160)!
  delayedBuffer.frameLength = 160
  for index in 0..<160 { delayedBuffer.floatChannelData![0][index] = 0.25 }
  do {
    let delayedProof = try consumeWakeAudio(delayedBuffer) { _ in
      Thread.sleep(forTimeInterval: 0.51)
    }
    guard delayedProof.processingSeconds >= 0.5,
          (0..<160).allSatisfy({ delayedBuffer.floatChannelData![0][$0] == 0 }) else {
      fail("slow wake processing did not wipe input before returning its proof")
    }
  } catch { fail("slow wake processing selftest failed: \(error)") }

  let longBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 3_200)!
  longBuffer.frameLength = 3_200
  for index in 0..<3_200 { longBuffer.floatChannelData![0][index] = 0.25 }
  var sizes: [Int] = []
  do { _ = try consumeWakeAudio(longBuffer) { sizes.append($0.count) } }
  catch { fail("wake audio chunk splitting failed: \(error)") }
  guard sizes == [1_600, 1_600],
        (0..<3_200).allSatisfy({ longBuffer.floatChannelData![0][$0] == 0 }) else {
    fail("wake audio exceeded the keyword chunk bound")
  }
  for oversized in [false, true] {
    let capacity = oversized ? 4_001 : 1_600
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(capacity))!
    buffer.frameLength = AVAudioFrameCount(capacity)
    for index in 0..<capacity { buffer.floatChannelData![0][index] = 0.75 }
    var invoked = false
    do {
      _ = try consumeWakeAudio(buffer) { _ in
        invoked = true
        throw WakeAudioError(description: "synthetic consumer failure")
      }
      fail("wake audio error-path selftest did not fail")
    } catch {}
    guard invoked != oversized,
          (0..<capacity).allSatisfy({ buffer.floatChannelData![0][$0] == 0 }) else {
      fail("wake audio error-path erasure failed")
    }
  }
  emit("ready", ["status": "wake-audio-selftest", "detail": "resampling, downmix, full-capacity wipe and error cleanup passed"])
}
