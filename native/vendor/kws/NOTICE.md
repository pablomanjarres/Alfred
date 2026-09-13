# Alfred KWS vendor notice

Alfred builds a local keyword spotting dependency from pinned upstream source. No upstream source trees, model files, or compiled libraries are committed here.

Pinned sources used by `scripts/build-keyword.mjs`:

- sherpa-onnx v1.13.8, Apache-2.0, https://github.com/k2-fsa/sherpa-onnx
- kaldi-native-fbank v1.22.3, Apache-2.0, https://github.com/csukuangfj/kaldi-native-fbank
- ONNX Runtime v1.28.2 static library, MIT, https://github.com/microsoft/onnxruntime

Generated output under `native/.build/alfred-deps/` includes the upstream license texts copied or downloaded during the build.

Alfred's wrapper exposes only `AlfredKwsAccept16k100ms`, a 16 kHz mono float32 chunk entry point capped at 1600 samples. Standby code should not call sherpa's generic waveform accept API directly.
