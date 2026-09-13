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
  let outputCount = Int(Double(frames) * 16_000 / rate)
  guard outputCount > 0 else { throw WakeAudioError(description: "wake audio buffer is empty") }
  var samples = [Float](repeating: 0, count: outputCount)
  try samples.withUnsafeMutableBufferPointer { output in
    defer {
      _ = memset_s(output.baseAddress, output.count * MemoryLayout<Float>.stride,
                   0, output.count * MemoryLayout<Float>.stride)
    }
    resampleTo16k(data: data, frames: frames, channels: channels, sourceRate: rate, output: output)
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


private func resampleTo16k(
  data: UnsafePointer<UnsafeMutablePointer<Float>>,
  frames: Int,
  channels: Int,
  sourceRate: Double,
  output: UnsafeMutableBufferPointer<Float>
) {
  let targetRate = 16_000.0
  let step = sourceRate / targetRate
  let cutoff = min(1.0, targetRate / sourceRate)
  let lobes = 16.0
  let radius = max(1, Int(ceil(lobes / cutoff)))
  for index in 0..<output.count {
    let center = (Double(index) + 0.5) * step - 0.5
    let left = max(0, Int(floor(center)) - radius)
    let right = min(frames - 1, Int(floor(center)) + radius)
    var weighted = 0.0
    var weightSum = 0.0
    for source in left...right {
      let distance = center - Double(source)
      let windowPosition = abs(distance) / Double(radius)
      guard windowPosition <= 1 else { continue }
      let window = 0.5 + 0.5 * cos(Double.pi * windowPosition)
      let filter: Double
      if abs(distance) < 1e-9 {
        filter = cutoff
      } else {
        filter = sin(Double.pi * cutoff * distance) / (Double.pi * distance)
      }
      let weight = filter * window
      weightSum += weight
      var mixed = 0.0
      for channel in 0..<channels { mixed += Double(data[channel][source]) }
      weighted += (mixed / Double(channels)) * weight
    }
    output[index] = weightSum == 0 ? 0 : Float(weighted / weightSum)
  }
}
