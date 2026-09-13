#define private public
#include "kaldi-native-fbank/csrc/online-feature.h"
#undef private

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

static bool IsZeroBytes(const std::vector<float> &v, size_t from, size_t to) {
  if (to <= from) return true;
  const auto *bytes = reinterpret_cast<const unsigned char *>(v.data());
  for (size_t i = from; i != to; ++i) {
    if (bytes[i] != 0) return false;
  }
  return true;
}

int main() {
  knf::FbankOptions opts;
  opts.frame_opts.samp_freq = 16000;
  opts.frame_opts.frame_shift_ms = 10.0f;
  opts.frame_opts.frame_length_ms = 25.0f;
  opts.frame_opts.snip_edges = false;
  opts.mel_opts.num_bins = 80;

  size_t capacity = 0;
  {
    knf::OnlineFbank fbank(opts);
    capacity = fbank.waveform_remainder_.capacity();
    if (capacity < 4096) return 10;

    std::vector<float> chunk(1600);
    for (int32_t round = 0; round != 300; ++round) {
      for (size_t i = 0; i != chunk.size(); ++i) {
        chunk[i] = std::sin(static_cast<float>(round + i) * 0.01f) * 0.01f;
      }
      const size_t old_size = fbank.waveform_remainder_.size();
      fbank.AcceptWaveform(16000, chunk.data(), static_cast<int32_t>(chunk.size()));
      const size_t new_size = fbank.waveform_remainder_.size();
      const size_t written_bytes = (old_size + chunk.size()) * sizeof(float);
      const size_t live_bytes = new_size * sizeof(float);
      if (fbank.waveform_remainder_.capacity() != capacity) return 20;
      if (new_size > 400) return 30;
      if (fbank.features_.items_.size() > 256) return 40;
      if (!IsZeroBytes(fbank.waveform_remainder_, live_bytes, written_bytes)) return 45;
    }
    fbank.InputFinished();
    if (fbank.waveform_remainder_.capacity() != capacity) return 50;
    if (fbank.features_.items_.size() > 256) return 60;
  }

  return capacity >= 4096 ? 0 : 70;
}
