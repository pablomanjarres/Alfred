import CSherpaOnnx
import Darwin
import Foundation

final class AlfredKeywordSpotter: WakeKeywordSpotting {
  static let modelDirectoryName = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
  static let keywordFileName = "alfred-keywords.txt"

  private let lock = NSLock()
  private let cstrings = CStringArena()
  private var spotter: OpaquePointer?
  private var stream: OpaquePointer?
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
    guard let createdStream = SherpaOnnxCreateKeywordStream(createdSpotter) else {
      SherpaOnnxDestroyKeywordSpotter(createdSpotter)
      throw WakeAudioError(description: "could not create Alfred keyword stream")
    }
    spotter = createdSpotter
    stream = createdStream
  }

  func accept(_ samples: UnsafeBufferPointer<Float>) throws {
    lock.lock()
    defer { lock.unlock() }
    guard !isClosed, let stream else { throw WakeAudioError(description: "Alfred keyword spotter is closed") }
    guard !samples.isEmpty, samples.count <= Int(ALFRED_KWS_MAX_CHUNK_SAMPLES), let baseAddress = samples.baseAddress else {
      throw WakeAudioError(description: "Alfred keyword chunk must be 1...1600 samples at 16 kHz")
    }
    for sample in samples where !sample.isFinite {
      throw WakeAudioError(description: "Alfred keyword chunk contains an invalid sample")
    }
    let status = AlfredKwsAccept16k100ms(stream, baseAddress, Int32(samples.count))
    guard status == ALFRED_KWS_OK else {
      throw WakeAudioError(description: "Alfred keyword accept failed: \(Self.statusName(status))")
    }
  }

  func decode() throws -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !isClosed, let spotter, let stream else { throw WakeAudioError(description: "Alfred keyword spotter is closed") }
    while SherpaOnnxIsKeywordStreamReady(spotter, stream) == 1 {
      SherpaOnnxDecodeKeywordStream(spotter, stream)
      guard let result = SherpaOnnxGetKeywordResult(spotter, stream) else { continue }
      defer { SherpaOnnxDestroyKeywordResult(result) }
      guard let keywordPointer = result.pointee.keyword else { continue }
      let keyword = String(cString: keywordPointer)
      if keyword == "ALFRED" { return true }
    }
    return false
  }

  func close() {
    lock.lock()
    defer { lock.unlock() }
    guard !isClosed else { return }
    isClosed = true
    if let stream { AlfredKwsFinishAndDestroyStream(stream) }
    if let spotter { SherpaOnnxDestroyKeywordSpotter(spotter) }
    stream = nil
    spotter = nil
  }

  deinit {
    close()
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
