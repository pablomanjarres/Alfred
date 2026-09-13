import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runStandby, servicePaths, type StandbyRunOptions } from '../src/standby.ts';

const noopNotifier = async () => {};

const processingDelay = 'wake audio processing exceeded its time limit';
const inputPause = 'microphone stopped delivering audio; wake buffers cleared';

test('a cleared processing delay restarts the helper and accepts the next wake', async () => {
  await scenario([processingDelay], async ({ calls, cues, state, log }) => {
    assert.equal(calls, 2);
    assert.equal(cues, 1);
    assert.equal(state.status, 'stopped');
    assert.match(log, /"type":"wake"/);
  });
});

test('processing delays and input pauses share a bounded retry budget', async () => {
  await scenario([processingDelay, inputPause, processingDelay], async ({ calls, cues, state }) => {
    assert.equal(calls, 3);
    assert.equal(cues, 0);
    assert.equal(state.status, 'blocked');
    assert.equal(state.detail, processingDelay);
  });
});

test('stop during processing-delay backoff prevents another helper launch', async () => {
  const controller = new AbortController();
  await scenario([processingDelay], async ({ calls, cues, state }) => {
    assert.equal(calls, 1);
    assert.equal(cues, 0);
    assert.equal(state.status, 'stopped');
  }, { signal: controller.signal, onFailure: () => queueMicrotask(() => controller.abort()) });
});

test('raw-buffer and permission errors remain fatal', async () => {
  for (const error of ['wake audio buffer exceeds the privacy limit', 'microphone is not authorized']) {
    await scenario([error], async ({ calls, cues, state }) => {
      assert.equal(calls, 1);
      assert.equal(cues, 0);
      assert.equal(state.status, 'blocked');
      assert.equal(state.detail, error);
    });
  }
});

type Result = { calls: number; cues: number; state: { status: string; detail: string }; log: string };
async function scenario(errors: string[], verify: (result: Result) => Promise<void>, options: { signal?: AbortSignal; onFailure?: () => void } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'alfred-audio-recovery-'));
  const paths = { ...servicePaths(home), plist: join(home, 'agent.plist') };
  let calls = 0;
  let cues = 0;
  const runner: NonNullable<StandbyRunOptions['runner']> = async (_command, args) => {
    if (args[0] === 'clap-doctor') return event({ type: 'ready' });
    assert.equal(args[0], 'wake-watch');
    const error = errors[calls++];
    if (error) {
      options.onFailure?.();
      return event({ type: 'error', message: error }, 1);
    }
    return event({ type: 'wake', status: 'Alfred', detail: { rawAudio: 'erased' } });
  };
  try {
    assert.equal(await runStandby(paths, { notifier: noopNotifier,
      helper: '/fake/helper', maxCycles: 1, recoveryBackoffMs: 10,
      runner, cue: async () => { cues += 1; }, signal: options.signal,
    }), 0);
    await verify({ calls, cues, state: JSON.parse(await readFile(paths.state, 'utf8')), log: await readFile(paths.log, 'utf8') });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function event(value: unknown, code = 0) {
  return { code, stdout: JSON.stringify(value) + '\n', stderr: '' };
}
