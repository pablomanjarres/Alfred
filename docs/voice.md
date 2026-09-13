# Alfred Voice

Alfred uses Codex for conversation and a local helper for the “Alfred” keyword and double clap. His dedicated task carries the instructions for Codex's work.

## Start

```sh
npm run setup
alfred voice setup
npm run build:voice
npm run setup:menubar-signing
npm run build:menubar
npm run install:menubar
alfred standby start
```

Allow Alfred's microphone and Accessibility permissions when macOS asks. Wake him, wait for the cue and Codex voice, then speak.

| Command | Result |
| --- | --- |
| `alfred voice end` | End the owned call and return to wake listening |
| `alfred off` | End the owned call and leave wake listening off |

The task profile maps goodbye and switch-off requests to these commands. Codex's speaking layer may handle a farewell itself, so spoken invocation is not guaranteed. The menu sends one stop toggle while Codex is capturing input, then checks that input was released before rearming. An unknown or already inactive input blocks the toggle. Choosing Codex's stop button manually still requires **Start listening** in Alfred afterward.

## Personality and voice

Codex's built-in live voice uses a separate speaking prompt. The dedicated task's
`AGENTS.md` controls task execution; it does not set the live voice's identity.
Task navigation and a typed Alfred greeting do not verify spoken personality.

Choose a stock voice in **Codex Settings > Voice**. That choice applies to new
voice calls across the account. The inspected app has no supported persistent
voice persona or custom voice for one task. A separate local Alfred voice layer
would need its own speech recognizer and the same raw-audio privacy checks.

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

`alfred standby start` installs and starts `~/Library/LaunchAgents/com.pablo.alfred.standby.plist`. It waits for a double clap or “Alfred” and wakes the display. After a trigger, capture stops and its raw buffers are erased. Alfred plays the cue, then asks the signed menu app to open Codex voice in his configured task. It never forwards standby audio to Codex or transcription. Use `alfred standby stop` to unload it and `alfred standby status` to check it.

Wake detection stays paused during the handoff. Before starting voice in a configured task, the menu confirms the selected task through Codex's **Copy chat deep link** command. It preserves clipboard contents and blocks if selection cannot be confirmed. Opening the app alone is not confirmation. Codex exposes no reliable external call-ended signal, so rearming requires an explicit end request or **Start listening**. A private request expires after 30 seconds and can be claimed only once. Cancelling standby invalidates it. Permission failures and a voice session that never opens the microphone produce a blocked state.

Standby state and bounded logs live under `~/.alfred/standby/` with user-only permissions. Logs contain timestamps, trigger/cue outcomes, frame counts, maximum buffer duration, and `rawAudio: erased`. They never contain raw samples. The native tap rejects buffers over 250 ms, computes local wake features, and wipes PCM buffers before neural decoding. Playback failures are reported instead of being hidden.

If audio input pauses or a cleared processing delay occurs, standby waits for the helper to exit and tries a fresh input engine up to twice. Cancellation stops the retry. Repeated interruptions, permission errors, and privacy failures leave a visible blocked state. Real failure alerts are limited to one per 30 minutes; tests use a separate notification sender.

Before capture, the keyword detector warms up with generated silence. A competing “Alfredo” entry helps reject that similar name; it never activates Alfred. After a short quiet pause, a fresh recognition stream starts while the previous stream finishes the word ending. At most two streams share the model, and both receive only the same short, erased audio chunks.

## Wake sound

Use **Test wake sound** in the menu to check playback without clapping. It checks microphone permission before pausing an active listener, then waits for listening to return after playback. A denied permission leaves the existing listener running. **Wake sound output** chooses your current audio output or the Mac's built-in speakers. It leaves the system's default output unchanged.

```sh
alfred cue output speakers
alfred cue test
alfred cue output current
```

The default is `current`. The choice is saved in `~/.alfred/config.json` as `cueOutput`. A muted or zero-volume device produces a clear error; Alfred does not change its volume. The test reports the device and playback level. Playback completion confirms the device received the sound, but cannot prove you heard it.

The wake cue plays after detection stops, before the handoff to Codex. The menu confirms microphone activity before reporting the handoff complete. That check reads process metadata only; it captures no audio.

## Permissions

Explicit file transcription may require Speech Recognition permission. `voiceStatus()` and `AlfredVoice doctor` do not prompt; they only report the current state. `voiceStatus()` returns `available: false` until Speech Recognition and Microphone are authorized for optional file transcription. Wake standby is separate: it gates only on Microphone authorization and live audio input because it does not use Speech Recognition.

macOS can ask for Alfred's microphone permission even when Codex already has access. Allow it when using the menu's listening controls. The installed Alfred app includes the required microphone explanation and a signed bundle identity.

Choose **Enable voice control** in Alfred's menu, then allow Alfred under **System Settings > Privacy & Security > Accessibility**. Keep Codex's default **Control-Shift-V** voice shortcut and **Command-Option-L** for **Copy chat deep link**. Codex needs its own microphone access and an open task. The handoff requires macOS 14.2 or later; wake detection still supports macOS 13.

Run `npm run setup:menubar-signing` once before building the menu app. It creates Alfred's own local signing key and reuses it for later builds. Its private files stay under `~/Library/Application Support/Alfred/MenuBar/signing/`; no password entry is needed for normal builds. The installer rejects ad-hoc builds, which remain available for CI checks.

An existing certificate can instead be selected with `ALFRED_SIGNING_IDENTITY` and `ALFRED_SIGNING_KEYCHAIN`. Keep the same signer across updates so the app's [macOS signing requirement](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) remains stable.

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
