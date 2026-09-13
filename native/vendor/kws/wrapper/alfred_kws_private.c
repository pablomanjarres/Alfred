#include "alfred_kws_private.h"

AlfredKwsStatus AlfredKwsAccept16k100ms(
    const SherpaOnnxOnlineStream *stream, const float *samples, int32_t n) {
  if (stream == 0) return ALFRED_KWS_NULL_STREAM;
  if (samples == 0 && n != 0) return ALFRED_KWS_NULL_SAMPLES;
  if (n < 0 || n > ALFRED_KWS_MAX_CHUNK_SAMPLES) {
    return ALFRED_KWS_BAD_CHUNK_SIZE;
  }

  SherpaOnnxOnlineStreamAcceptWaveform(
      stream, ALFRED_KWS_SAMPLE_RATE, samples, n);
  return ALFRED_KWS_OK;
}

void AlfredKwsFinishAndDestroyStream(const SherpaOnnxOnlineStream *stream) {
  if (stream == 0) return;
  SherpaOnnxOnlineStreamInputFinished(stream);
  SherpaOnnxDestroyOnlineStream(stream);
}
