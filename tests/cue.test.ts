import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { cueSummary, testCue } from '../src/cue.ts';

test('cue test pauses a running standby and restores it after cue failure', async () => {
  const calls: string[] = [];
  await assert.rejects(testCue({
    mode: 'speakers', helper: '/fake/helper',
    serviceStatus: async () => ({ running: true }),
    stopService: async () => { calls.push('stop'); },
    startService: async () => { calls.push('start'); },
    waitStopped: async () => { calls.push('wait-stopped'); },
    runner: async (_binary, args) => {
      calls.push(args.join(' '));
      return { code: 1, stdout: '', stderr: 'speaker route unavailable' };
    },
  }), /speaker route unavailable/);
  assert.deepEqual(calls, ['stop', 'wait-stopped', 'wake-cue --cue-output speakers', 'start']);
});

test('cue test does not restart standby when it was stopped', async () => {
  const calls: string[] = [];
  await testCue({
    mode: 'current', helper: '/fake/helper',
    serviceStatus: async () => ({ running: false }),
    stopService: async () => { calls.push('stop'); },
    startService: async () => { calls.push('start'); },
    waitStopped: async () => { calls.push('wait-stopped'); },
    runner: async (_binary, args) => {
      calls.push(args.join(' '));
      return { code: 0, stdout: '{"type":"cue","status":"played"}\n', stderr: '' };
    },
  });
  assert.deepEqual(calls, ['wake-cue --cue-output current']);
});


test('cue test restores standby when stop fails after leaving standby down', async () => {
  const calls: string[] = [];
  const statuses = [{ running: true }, { running: false }];
  await assert.rejects(testCue({
    mode: 'speakers', helper: '/fake/helper',
    serviceStatus: async () => statuses.shift() ?? { running: false },
    stopService: async () => { calls.push('stop'); throw new Error('stop failed after unloading'); },
    startService: async () => { calls.push('start'); },
    waitStopped: async () => { calls.push('wait-stopped'); },
    runner: async () => { calls.push('cue'); return { code: 0, stdout: '{"type":"cue","status":"played"}\n', stderr: '' }; },
  }), /stop failed/);
  assert.deepEqual(calls, ['stop', 'start']);
});

test('cue test restores standby when waiting for stop fails before playback', async () => {
  const calls: string[] = [];
  await assert.rejects(testCue({
    mode: 'speakers', helper: '/fake/helper',
    serviceStatus: async () => ({ running: true }),
    stopService: async () => { calls.push('stop'); },
    startService: async () => { calls.push('start'); },
    waitStopped: async () => { calls.push('wait-stopped'); throw new Error('standby did not stop'); },
    runner: async () => { calls.push('cue'); return { code: 0, stdout: '{\"type\":\"cue\",\"status\":\"played\"}\n', stderr: '' }; },
  }), /standby did not stop/);
  assert.deepEqual(calls, ['stop', 'wait-stopped', 'start']);
});


test('cue test waits for the original standby pid after launchd unloads before playback', async () => {
  const calls: string[] = [];
  const statuses = [{ running: true, pid: process.pid }, { running: false }];
  await assert.rejects(testCue({
    mode: 'speakers', helper: '/fake/helper', waitTimeoutMs: 25, pollMs: 1,
    serviceStatus: async () => statuses.shift() ?? { running: false },
    processIsAlive: (pid) => { calls.push(`pid:${pid}`); return pid === process.pid; },
    stopService: async () => { calls.push('stop'); },
    startService: async () => { calls.push('start'); },
    runner: async () => { calls.push('cue'); throw new Error('cue must wait for the old pid to exit'); },
  }), /pid.*exit|stop/i);
  assert.equal(calls.includes('cue'), false);
  assert.deepEqual(calls.filter((call) => call === 'stop' || call === 'start'), ['stop', 'start']);
  assert.equal(calls.includes(`pid:${process.pid}`), true);
});

test('cue test restores standby after cancellation', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  await assert.rejects(testCue({
    mode: 'speakers', helper: '/fake/helper', signal: controller.signal,
    serviceStatus: async () => ({ running: true }),
    stopService: async () => { calls.push('stop'); },
    startService: async () => { calls.push('start'); },
    waitStopped: async () => { calls.push('wait-stopped'); },
    runner: async (_binary, args, options) => {
      calls.push(args.join(' '));
      controller.abort();
      options.signal?.throwIfAborted();
      return { code: 0, stdout: '', stderr: '' };
    },
  }), /abort/i);
  assert.deepEqual(calls, ['stop', 'wait-stopped', 'wake-cue --cue-output speakers', 'start']);
});


test('cue test fails if the helper exits without a played cue event', async () => {
  await assert.rejects(testCue({
    mode: 'current', helper: '/fake/helper',
    serviceStatus: async () => ({ running: false }),
    runner: async () => ({ code: 0, stdout: '', stderr: '' }),
  }), /cue.*played/i);
});

test('cue test returns native output diagnostics from the helper', async () => {
  const result = await testCue({
    mode: 'speakers', helper: '/fake/helper',
    serviceStatus: async () => ({ running: false }),
    runner: async () => ({ code: 0, stdout: JSON.stringify({ type: 'cue', status: 'played', detail: { device: 'MacBook Pro Speakers', deviceVolume: 0.62, deviceMuted: false, peakDb: -9.4, elapsedMs: 1046, output: 'speakers' } }) + '\n', stderr: '' }),
  });
  assert.equal(result.mode, 'speakers');
  assert.equal(result.device, 'MacBook Pro Speakers');
  assert.equal(result.deviceVolume, 0.62);
  assert.equal(result.deviceMuted, false);
  assert.equal(result.peakDb, -9.4);
  assert.equal(result.elapsedMs, 1046);
  assert.equal(result.output, 'speakers');
});

test('cue summary prints native output device and volume without launching services', () => {
  assert.equal(cueSummary({ mode: 'current', device: 'WF-C510', deviceVolume: 31, deviceMuted: false, elapsedMs: 1067, output: 'current' }), 'WF-C510, 31%, unmuted, 1067 ms, current');
  assert.equal(cueSummary({ mode: 'speakers', device: 'MacBook Pro Speakers', deviceVolume: 0.62, deviceMuted: true, output: 'speakers' }), 'MacBook Pro Speakers, 62%, muted, speakers');
});

test('cue output command saves the selected route', async () => {
  const home = await mkdtemp(join(tmpdir(), 'alfred-cue-cli-'));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli, 'cue', 'output', 'speakers'], {
    encoding: 'utf8', env: { ...process.env, ALFRED_HOME: home }, timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /speakers/);
  assert.equal(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).cueOutput, 'speakers');
});
