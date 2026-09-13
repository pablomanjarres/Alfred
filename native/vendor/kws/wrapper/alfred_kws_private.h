#ifndef ALFRED_KWS_PRIVATE_H_
#define ALFRED_KWS_PRIVATE_H_

#include <stdint.h>
#include "sherpa-onnx/c-api/c-api.h"

#ifdef __cplusplus
extern "C" {
#endif

#define ALFRED_KWS_SAMPLE_RATE 16000
#define ALFRED_KWS_MAX_CHUNK_SAMPLES 1600

typedef enum AlfredKwsStatus {
  ALFRED_KWS_OK = 0,
  ALFRED_KWS_NULL_STREAM = 1,
  ALFRED_KWS_NULL_SAMPLES = 2,
  ALFRED_KWS_BAD_CHUNK_SIZE = 3
} AlfredKwsStatus;

// Accept one synchronous 16 kHz mono float32 PCM chunk.
// n must be 0..1600 samples, i.e. at most 100 ms at 16 kHz.
// This wrapper intentionally has no sample-rate parameter, so callers cannot
// enter sherpa-onnx's resampler path through Alfred's standby detector.
AlfredKwsStatus AlfredKwsAccept16k100ms(
    const SherpaOnnxOnlineStream *stream, const float *samples, int32_t n);

// Flush and release the stream on hit, idle, stalled capture, suspend, or stop.
void AlfredKwsFinishAndDestroyStream(const SherpaOnnxOnlineStream *stream);

#ifdef __cplusplus
}
#endif

#endif  // ALFRED_KWS_PRIVATE_H_
