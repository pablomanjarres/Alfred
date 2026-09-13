# Alfred Voice

Alfred voice is a local macOS helper for one-shot spoken commands. The Node API starts the helper, waits for one transcript, then lets the caller run Codex and speak the answer after the microphone process has exited.

## Build

```sh
node scripts/build-voice.mjs
```

The script builds the Swift package in `native/` and assembles `dist/AlfredVoice.app`. It also runs:

- `AlfredVoice selftest`, which tests double-clap detection without the microphone.
- `AlfredVoice doctor`, which checks recognizer, microphone authorization state, and audio input availability without prompting. First-use permission state is reported but does not fail the build script.

The helper can also run from `native/.build/release/AlfredVoice`. `src/voice.ts` discovers both locations relative to the compiled `dist/voice.js`; `ALFRED_VOICE_HELPER=/path/to/AlfredVoice` overrides discovery for tests and development.

## Node API

```ts
import { speak, transcribe, voiceStatus } from './voice.js';

const status = await voiceStatus();
const order = await transcribe({ mode: 'clap', locale: 'en-US' });
await speak(`Right away. I heard: ${order}`);
```

Exports:

- `transcribe({ mode, file, locale, signal, onStatus }): Promise<string>`
- `speak(text, signal): Promise<void>`
- `voiceStatus(): Promise<{ available: boolean; detail: string }>`

`mode: 'listen'` records one spoken command. `mode: 'file'` transcribes one audio file and requires `file`. `mode: 'clap'` waits for a deliberate double clap, wakes the display with `caffeinate -u -t 3`, records one spoken command, emits one transcript, and exits.

Run `alfred clap --loop` to stay on call. It rearms after each two-minute idle window and completed order. Ctrl-C, a permission failure, or another real error stops it. The microphone closes between windows and while Alfred acts or speaks.

Live capture lasts up to 12 seconds, then allows five seconds for Apple Speech to finish. Only a final transcript becomes an order; incomplete results are rejected.

## Permissions

The first real listening action may trigger macOS prompts for Microphone and Speech Recognition. `voiceStatus()` and `AlfredVoice doctor` do not prompt; they only report the current state. `voiceStatus()` returns `available: false` until Speech Recognition and Microphone are authorized.

The bundled app plist explains the privacy reasons:

- Microphone: Alfred listens only when asked, so it can transcribe one local command.
- Speech Recognition: Alfred uses Apple on-device speech recognition to turn that command into text.

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

The event types are `ready`, `listening`, `transcript`, `error`, and `idle`. An `idle` event means the clap window ended without a double clap; it contains no order.

## Verification Limits

The no-microphone checks compile the helper, test clap detection and main-queue callback delivery, and run the non-prompting doctor command. They do not prove real microphone transcription quality; that requires speaking into the Mac after granting permissions.
