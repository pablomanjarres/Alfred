# Alfred Voice

Alfred voice uses Codex desktop's voice button for spoken commands. The local macOS helper still supports explicit transcription of an existing audio file and clap-only standby.

## Build

```sh
node scripts/build-voice.mjs
```

The script builds the Swift package in `native/` and assembles `dist/AlfredVoice.app`. It also runs:

- `AlfredVoice selftest`, which tests double-clap detection without the microphone.
- `AlfredVoice clap-selftest`, which proves the clap watch event path and PCM buffer wiping without the microphone or Speech Recognition.
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

## Clap standby

`alfred standby start` installs and starts `~/Library/LaunchAgents/com.pablo.alfred.standby.plist`. The standby service is clap-only: it waits for a deliberate double clap, wakes the display, plays a short cue, and immediately rearms. It never invokes Apple Speech, Codex, or transcription from the background service. Use `alfred standby stop` to unload it and `alfred standby status` to inspect the LaunchAgent plus the private state file.

Standby state and bounded logs live under `~/.alfred/standby/` with user-only permissions. The log contains JSON status lines and scalar proof such as frame counts, last-frame timestamps, and maximum buffer duration. It never logs raw samples. The native tap uses 1024-frame chunks, rejects buffers over one second, computes only RMS/peak clap features, and wipes all float PCM channels before returning from the tap.

## Permissions

Explicit file transcription may require Speech Recognition permission. `voiceStatus()` and `AlfredVoice doctor` do not prompt; they only report the current state. `voiceStatus()` returns `available: false` until Speech Recognition and Microphone are authorized for optional file transcription. Clap standby is separate: it gates only on Microphone authorization and live audio input because it does not use Speech Recognition.

The bundled app plist explains the privacy reasons:

- Microphone: Alfred uses short live input only for clap standby.
- Speech Recognition: Alfred uses Apple on-device speech recognition only for explicit existing-file transcription.

Recognition is configured with `requiresOnDeviceRecognition = true`. There is no speech API key and no remote speech service in this helper.

## Sleep Behavior

macOS cannot keep this helper listening while the machine is fully asleep because the microphone and user process are suspended. Clap activation works while the helper is already running and the Mac is awake enough to deliver audio.

For full-system sleep wake, Alfred needs an external trigger path, such as a small sensor, keyboard, Shortcut automation, or hardware button that wakes the Mac first and then launches the normal one-shot helper.

## Events

The native helper writes UTF-8 JSON lines to stdout:

```json
{"type":"ready","status":"ready"}
{"type":"listening","status":"listening"}
{"type":"transcript","text":"turn on the office lights"}
{"type":"error","message":"microphone permission was not granted"}
```

The event types are `ready`, `listening`, `transcript`, `error`, `clap`, and `idle`. An `idle` event means the clap window ended without a double clap; it contains no order.

## Verification Limits

The no-microphone checks compile the helper, test clap detection and main-queue callback delivery, run the clap privacy selftest, and run the non-prompting doctor command. They do not claim anything about Codex desktop's separate voice capture.
