# Alfred Voice

Alfred voice uses Codex desktop's voice button for spoken commands. The local macOS helper still supports explicit transcription of an existing audio file and wake standby for double clap or the local “Alfred” keyword.

## Build

```sh
node scripts/build-voice.mjs
```

The script builds the Swift package in `native/` and assembles `dist/AlfredVoice.app`. It also runs:

- `AlfredVoice selftest`, which tests double-clap detection without the microphone.
- `AlfredVoice clap-selftest`, which proves the clap watch event path and PCM buffer wiping without the microphone or Speech Recognition.
- `AlfredVoice cue-selftest`, which checks output selection and muted devices without playing sound or opening the microphone.
- Packaged keyword checks with pinned, generated voices, including similar names that must stay quiet. Extracted test copies are deleted afterward; the fixtures contain no microphone recordings.
- `AlfredVoice doctor`, which checks recognizer, microphone authorization state, and audio input availability without prompting. First-use permission state is reported but does not fail the build script.

The helper can also run from `native/.build/release/AlfredVoice`. `src/voice.ts` discovers both locations relative to the compiled `dist/voice.js`; `ALFRED_VOICE_HELPER=/path/to/AlfredVoice` overrides discovery for tests and development.

## Node API

```ts
import { speak, transcribe, voiceStatus } from './voice.js';

const status = await voiceStatus();
const order = await transcribe({ mode: 'file', file: '/path/message.m4a', locale: 'en-US' });
await speak(`Right away. I read: ${order}`);
```

Exports:

- `transcribe({ mode, file, locale, signal, onStatus }): Promise<string>`
- `speak(text, signal): Promise<void>`
- `voiceStatus(): Promise<{ available: boolean; detail: string }>`

`mode: 'file'` transcribes one existing audio file and requires `file`. `mode: 'listen'` and `mode: 'clap'` are disabled for Alfred-owned live microphone transcription; use the Codex voice button for spoken orders. The native helper also refuses direct `listen` and legacy `clap` commands so there is no hidden live-ASR path.

## Wake standby

`alfred standby start` installs and starts `~/Library/LaunchAgents/com.pablo.alfred.standby.plist`. It waits for a double clap or “Alfred” and wakes the display. After a trigger, it prepares the next listener, plays a short cue through your current audio output, then starts capture. Wait for the cue to finish before another attempt. It never invokes Apple Speech, Codex, or transcription from standby. Use `alfred standby stop` to unload it and `alfred standby status` to check it.

Standby state and bounded logs live under `~/.alfred/standby/` with user-only permissions. Logs contain timestamps, trigger/cue outcomes, frame counts, maximum buffer duration, and `rawAudio: erased`. They never contain raw samples. The native tap rejects buffers over 250 ms, computes local wake features, and wipes PCM buffers before neural decoding. Playback failures are reported instead of being hidden.

Before capture, the keyword detector warms up with generated silence. A competing “Alfredo” entry helps reject that similar name; it never activates Alfred. After a short quiet pause, a fresh recognition stream starts while the previous stream finishes the word ending. At most two streams share the model, and both receive only the same short, erased audio chunks.

## Wake sound

Use **Test wake sound** in the menu to check playback without clapping. It pauses standby for the sound and restores listening afterward, including when playback fails. **Wake sound output** chooses your current audio output or the Mac's built-in speakers. It leaves the system's default output unchanged.

```sh
alfred cue output speakers
alfred cue test
alfred cue output current
```

The default is `current`. The choice is saved in `~/.alfred/config.json` as `cueOutput`. A muted or zero-volume device produces a clear error; Alfred does not change its volume. The test reports the device and playback level. Playback completion confirms the device received the sound, but cannot prove you heard it.

The wake cue follows model preparation, which can take a few seconds after detection. Its end marks the point when the next listener starts. Wait for the sound to finish before calling Alfred again.

## Permissions

Explicit file transcription may require Speech Recognition permission. `voiceStatus()` and `AlfredVoice doctor` do not prompt; they only report the current state. `voiceStatus()` returns `available: false` until Speech Recognition and Microphone are authorized for optional file transcription. Wake standby is separate: it gates only on Microphone authorization and live audio input because it does not use Speech Recognition.

The bundled app plist explains the privacy reasons:

- Microphone: Alfred uses short live input only for wake standby.
- Speech Recognition: Alfred uses Apple on-device speech recognition only for explicit existing-file transcription.

Recognition is configured with `requiresOnDeviceRecognition = true`. There is no speech API key and no remote speech service in this helper.

## Sleep Behavior

macOS cannot keep this helper listening while the machine is fully asleep because the microphone and user process are suspended. Double clap and “Alfred” activation work while the helper is already running and the Mac is awake enough to deliver audio. Before system sleep, the native watcher stops microphone capture and clears local wake buffers; after wake it exits idle so the service can rearm.

For full-system sleep wake, Alfred needs an external trigger path, such as a small sensor, keyboard, Shortcut automation, or hardware button that wakes the Mac first and then launches the normal one-shot helper.

## Events

The native helper writes UTF-8 JSON lines to stdout:

```json
{"type":"ready","status":"ready"}
{"type":"listening","status":"listening"}
{"type":"transcript","text":"turn on the office lights"}
{"type":"error","message":"microphone permission was not granted"}
```

The event types are `ready`, `listening`, `transcript`, `error`, `clap`, `wake`, `cue`, `paused`, and `idle`. A `wake` event has status `clap` or `Alfred`. A `cue` event with status `played` confirms playback ended; its detail includes the output device, volume, mute state, peak level, and elapsed time. `ready` follows when capture starts. A `paused` event means capture stopped for system sleep. An `idle` event ends a window without a trigger; it contains no order.

## Verification Limits

The no-microphone checks compile the helper, test clap detection and main-queue callback delivery, run the clap privacy selftest, and run the non-prompting doctor command. These checks do not claim anything about Codex desktop's separate voice capture.
