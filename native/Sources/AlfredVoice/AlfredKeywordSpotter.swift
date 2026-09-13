import CSherpaOnnx
import Darwin
import Foundation

final class AlfredKeywordSpotter: WakeKeywordSpotting {
  static let modelDirectoryName = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
  static let keywordFileName = "alfred-keywords.txt"

  private static let quietSamplesBeforeRefresh = 3_200
  private static let priorStreamTailSamples = 8_000
  private static let soundRMSFloor: Float = 0.01

  private let lock = NSLock()
  private let cstrings = CStringArena()
  private var spotter: OpaquePointer?
  private var stream: OpaquePointer?
  private var priorStream: OpaquePointer?
  private var priorRemainingSamples = 0
  private var quietSamples = 0
  private var hasSound = false
  private var isClosed = false

  convenience init(resourcesDirectory: URL) throws {
    let modelDirectory = resourcesDirectory.appendingPathComponent(Self.modelDirectoryName, isDirectory: true)
    let keywordsFile = modelDirectory.appendingPathComponent(Self.keywordFileName, isDirectory: false)
    try self.init(modelDirectory: modelDirectory, keywordsFile: keywordsFile)
  }

  init(modelDirectory: URL, keywordsFile: URL) throws {
    let paths = ModelPaths(modelDirectory: modelDirectory, keywordsFile: keywordsFile)
    try paths.requireReadableFiles()

    var config = SherpaOnnxKeywordSpotterConfig()
    config.feat_config.sample_rate = 16_000
    config.feat_config.feature_dim = 80
    config.model_config.transducer.encoder = cstrings.copy(paths.encoder.path)
    config.model_config.transducer.decoder = cstrings.copy(paths.decoder.path)
    config.model_config.transducer.joiner = cstrings.copy(paths.joiner.path)
    config.model_config.tokens = cstrings.copy(paths.tokens.path)
    config.model_config.num_threads = 1
    config.model_config.provider = cstrings.copy("cpu")
    config.max_active_paths = 4
    config.num_trailing_blanks = 3
    config.keywords_score = 3.0
    config.keywords_threshold = 0.10
    config.keywords_file = cstrings.copy(paths.keywordsFile.path)

    guard let createdSpotter = SherpaOnnxCreateKeywordSpotter(&config) else {
      throw WakeAudioError(description: "could not create Alfred keyword spotter")
    }
    do {
      stream = try Self.createPrimedStream(spotter: createdSpotter)
      spotter = createdSpotter
    } catch {
      SherpaOnnxDestroyKeywordSpotter(createdSpotter)
      throw error
    }
  }

  func accept(_ samples: UnsafeBufferPointer<Float>) throws {
    lock.lock()
    defer { lock.unlock() }
    guard !isClosed, let stream else { throw WakeAudioError(description: "Alfred keyword spotter is closed") }
    guard !samples.isEmpty, samples.count <= Int(ALFRED_KWS_MAX_CHUNK_SAMPLES), let baseAddress = samples.baseAddress else {
      throw WakeAudioError(description: "Alfred keyword chunk must be 1...1600 samples at 16 kHz")
    }

    var sumSquares: Float = 0
    for sample in samples {
      guard sample.isFinite else {
        closeLocked()
        throw WakeAudioError(description: "Alfred keyword chunk contains an invalid sample")
      }
      sumSquares += sample * sample
    }

    do {
      try Self.accept(samples: baseAddress, count: samples.count, into: stream)
      if let priorStream {
        try Self.accept(samples: baseAddress, count: samples.count, into: priorStream)
        priorRemainingSamples -= samples.count
      }
    } catch {
      closeLocked()
      throw error
    }

    let rms = (sumSquares / Float(samples.count)).squareRoot()
    if rms >= Self.soundRMSFloor {
      hasSound = true
      quietSamples = 0
    } else if hasSound {
      quietSamples += samples.count
    }
  }

  func decode() throws -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !isClosed, let spotter, let stream else { throw WakeAudioError(description: "Alfred keyword spotter is closed") }

    let currentHit = Self.decode(stream: stream, spotter: spotter)
    let priorHit = priorStream.map { Self.decode(stream: $0, spotter: spotter) } ?? false
    if currentHit || priorHit { return true }

    if let priorStream, priorRemainingSamples <= 0 {
      AlfredKwsFinishAndDestroyStream(priorStream)
      self.priorStream = nil
      priorRemainingSamples = 0
    }

    if hasSound && quietSamples >= Self.quietSamplesBeforeRefresh {
      try rotateAfterPause(spotter: spotter, currentStream: stream)
    }
    return false
  }

  func close() {
    lock.lock()
    defer { lock.unlock() }
    closeLocked()
  }

  deinit {
    close()
  }

  private func rotateAfterPause(spotter: OpaquePointer, currentStream: OpaquePointer) throws {
    if let priorStream {
      AlfredKwsFinishAndDestroyStream(priorStream)
      self.priorStream = nil
      priorRemainingSamples = 0
    }

    do {
      let refreshedStream = try Self.createPrimedStream(spotter: spotter)
      priorStream = currentStream
      priorRemainingSamples = Self.priorStreamTailSamples
      stream = refreshedStream
      hasSound = false
      quietSamples = 0
    } catch {
      closeLocked()
      throw error
    }
  }

  private func closeLocked() {
    guard !isClosed else { return }
    isClosed = true
    if let priorStream { AlfredKwsFinishAndDestroyStream(priorStream) }
    if let stream { AlfredKwsFinishAndDestroyStream(stream) }
    if let spotter { SherpaOnnxDestroyKeywordSpotter(spotter) }
    priorStream = nil
    stream = nil
    spotter = nil
    priorRemainingSamples = 0
    quietSamples = 0
    hasSound = false
  }

  private static func createPrimedStream(spotter: OpaquePointer) throws -> OpaquePointer {
    guard let stream = SherpaOnnxCreateKeywordStream(spotter) else {
      throw WakeAudioError(description: "could not create Alfred keyword stream")
    }
    do {
      try prime(spotter, stream: stream)
      return stream
    } catch {
      AlfredKwsFinishAndDestroyStream(stream)
      throw error
    }
  }

  private static func accept(samples: UnsafePointer<Float>, count: Int, into stream: OpaquePointer) throws {
    let status = AlfredKwsAccept16k100ms(stream, samples, Int32(count))
    guard status == ALFRED_KWS_OK else {
      throw WakeAudioError(description: "Alfred keyword accept failed: \(Self.statusName(status))")
    }
  }

  private static func decode(stream: OpaquePointer, spotter: OpaquePointer) -> Bool {
    while SherpaOnnxIsKeywordStreamReady(spotter, stream) == 1 {
      SherpaOnnxDecodeKeywordStream(spotter, stream)
      guard let result = SherpaOnnxGetKeywordResult(spotter, stream) else { continue }
      defer { SherpaOnnxDestroyKeywordResult(result) }
      guard let keywordPointer = result.pointee.keyword else { continue }
      let keyword = String(cString: keywordPointer)
      if keyword == "ALFRED" { return true }
      // The decoder already clears matched hypotheses. Keep its encoder and
      // timestamps continuous so an ignored name cannot hide the next match.
    }
    return false
  }

  private static func prime(_ spotter: OpaquePointer, stream: OpaquePointer) throws {
    let silence = [Float](repeating: 0, count: Int(ALFRED_KWS_MAX_CHUNK_SAMPLES))
    try silence.withUnsafeBufferPointer { buffer in
      guard let baseAddress = buffer.baseAddress else {
        throw WakeAudioError(description: "could not prime Alfred keyword stream")
      }
      for _ in 0..<5 {
        let status = AlfredKwsAccept16k100ms(stream, baseAddress, Int32(buffer.count))
        guard status == ALFRED_KWS_OK else {
          throw WakeAudioError(description: "Alfred keyword prime failed: \(Self.statusName(status))")
        }
        while SherpaOnnxIsKeywordStreamReady(spotter, stream) == 1 {
          SherpaOnnxDecodeKeywordStream(spotter, stream)
          guard let result = SherpaOnnxGetKeywordResult(spotter, stream) else { continue }
          SherpaOnnxDestroyKeywordResult(result)
        }
      }
    }
  }

  private static func statusName(_ status: AlfredKwsStatus) -> String {
    switch status {
    case ALFRED_KWS_OK: return "ok"
    case ALFRED_KWS_NULL_STREAM: return "null stream"
    case ALFRED_KWS_NULL_SAMPLES: return "null samples"
    case ALFRED_KWS_BAD_CHUNK_SIZE: return "bad chunk size"
    default: return "unknown status \(status.rawValue)"
    }
  }
}

private struct ModelPaths {
  let encoder: URL
  let decoder: URL
  let joiner: URL
  let tokens: URL
  let keywordsFile: URL

  init(modelDirectory: URL, keywordsFile: URL) {
    encoder = modelDirectory.appendingPathComponent("encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
    decoder = modelDirectory.appendingPathComponent("decoder-epoch-12-avg-2-chunk-16-left-64.onnx")
    joiner = modelDirectory.appendingPathComponent("joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
    tokens = modelDirectory.appendingPathComponent("tokens.txt")
    self.keywordsFile = keywordsFile
  }

  func requireReadableFiles() throws {
    let files = [encoder, decoder, joiner, tokens, keywordsFile]
    for file in files where !FileManager.default.isReadableFile(atPath: file.path) {
      throw WakeAudioError(description: "missing Alfred keyword resource: \(file.path)")
    }
  }
}

private final class CStringArena {
  private var pointers: [UnsafeMutablePointer<CChar>] = []

  func copy(_ string: String) -> UnsafePointer<CChar> {
    let pointer = strdup(string)
    precondition(pointer != nil, "strdup failed")
    pointers.append(pointer!)
    return UnsafePointer(pointer!)
  }

  deinit {
    for pointer in pointers { free(pointer) }
  }
}
