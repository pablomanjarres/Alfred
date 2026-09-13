import AVFoundation
import Darwin
import Foundation

struct WakeAudioError: Error, CustomStringConvertible {
  let description: String
}

struct WakeAudioProof {
  let rms: Float
  let peak: Float
  let frameSeconds: Double
  let capacitySeconds: Double
  let processingSeconds: Double
}

// Audio is consumed synchronously. No queue or converter retains a waveform.
func consumeWakeAudio(
  _ buffer: AVAudioPCMBuffer,
  accept: (UnsafeBufferPointer<Float>) throws -> Void
) throws -> WakeAudioProof {
  let started = ProcessInfo.processInfo.systemUptime
  let frames = Int(buffer.frameLength)
  let capacity = Int(buffer.frameCapacity)
  let channels = Int(buffer.format.channelCount)
  let rate = buffer.format.sampleRate
  guard buffer.format.commonFormat == .pcmFormatFloat32,
        !buffer.format.isInterleaved, let data = buffer.floatChannelData else {
    throw WakeAudioError(description: "unsupported wake audio format")
  }
  defer {
    for channel in 0..<channels {
      _ = memset_s(data[channel], capacity * MemoryLayout<Float>.stride,
                   0, capacity * MemoryLayout<Float>.stride)
    }
  }
  guard rate.isFinite, rate > 0, channels > 0, frames > 0,
        frames <= capacity, Double(capacity) / rate <= 0.25 else {
    throw WakeAudioError(description: "wake audio buffer exceeds the 250 ms limit")
  }
  var squareSum: Float = 0
  var peak: Float = 0
  for channel in 0..<channels {
    for index in 0..<frames {
      let sample = data[channel][index]
      guard sample.isFinite else {
        throw WakeAudioError(description: "invalid wake audio sample")
      }
      squareSum += sample * sample
      peak = max(peak, abs(sample))
    }
  }
  // Area averaging provides a small low-pass filter during downsampling. Each
  // output interval is independent, so even partial input chunks leave no tail.
  let count = Int(Double(frames) * 16_000 / rate)
  guard count > 0 else { throw WakeAudioError(description: "wake audio buffer is empty") }
  var samples = [Float](repeating: 0, count: count)
  try samples.withUnsafeMutableBufferPointer { output in
    defer {
      _ = memset_s(output.baseAddress, output.count * MemoryLayout<Float>.stride,
                   0, output.count * MemoryLayout<Float>.stride)
    }
    let width = rate / 16_000
    for index in 0..<count {
      let left = Double(index) * width
      let right = min(Double(frames), left + width)
      var weighted: Double = 0
      for source in Int(left)..<min(frames, Int(ceil(right))) {
        let weight = min(right, Double(source + 1)) - max(left, Double(source))
        for channel in 0..<channels { weighted += Double(data[channel][source]) * weight }
      }
      output[index] = Float(weighted / ((right - left) * Double(channels)))
    }
    for offset in stride(from: 0, to: output.count, by: 1_600) {
      let chunk = UnsafeBufferPointer(start: output.baseAddress!.advanced(by: offset),
                                      count: min(1_600, output.count - offset))
      try accept(chunk)
    }
  }
  return WakeAudioProof(
    rms: sqrt(squareSum / Float(frames * channels)), peak: peak,
    frameSeconds: Double(frames) / rate, capacitySeconds: Double(capacity) / rate,
    processingSeconds: ProcessInfo.processInfo.systemUptime - started
  )
}
