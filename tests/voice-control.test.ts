import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { endVoice } from '../src/voice-control.ts';
import { LABEL, servicePaths } from '../src/standby.ts';

test('ending voice asks the menu to end then restarts standby after confirmation', async () => {
  const calls: string[] = [];
  const paths = isolatedServicePaths(await mkdtemp(join(tmpdir(), 'alfred-voice-control-')));
  try {
    const result = await endVoice({
      paths,
      requestHandoff: async (options) => { calls.push(`request:${options.action}`); return { id: 'end-1', action: 'end', status: 'ended', requestedAt: '', expiresAt: '' }; },
      startStandby: async () => { calls.push('start'); },
      stopStandby: async () => { calls.push('stop'); },
    });

    assert.equal(result.status, 'ended');
    assert.deepEqual(calls, ['request:end', 'start']);
  } finally {
    await rm(paths.home, { recursive: true, force: true });
  }
});

test('turning Alfred off stops standby before ending voice and does not restart', async () => {
  const calls: string[] = [];
  const paths = isolatedServicePaths(await mkdtemp(join(tmpdir(), 'alfred-voice-control-')));
  try {
    await endVoice({
      paths, off: true,
      requestHandoff: async (options) => { calls.push(`request:${options.action}`); return { id: 'end-2', action: 'end', status: 'ended', requestedAt: '', expiresAt: '' }; },
      startStandby: async () => { calls.push('start'); },
      stopStandby: async () => { calls.push('stop'); },
    });

    assert.deepEqual(calls, ['stop', 'request:end']);
  } finally {
    await rm(paths.home, { recursive: true, force: true });
  }
});

test('failed voice end does not restart standby', async () => {
  const calls: string[] = [];
  const paths = isolatedServicePaths(await mkdtemp(join(tmpdir(), 'alfred-voice-control-')));
  try {
    await assert.rejects(endVoice({
      paths,
      requestHandoff: async () => { calls.push('request:end'); throw new Error('Codex voice did not end'); },
      startStandby: async () => { calls.push('start'); },
      stopStandby: async () => { calls.push('stop'); },
    }), /did not end/);

    assert.deepEqual(calls, ['request:end']);
  } finally {
    await rm(paths.home, { recursive: true, force: true });
  }
});

function isolatedServicePaths(root: string): ReturnType<typeof servicePaths> {
  return { ...servicePaths(root), plist: join(root, `${LABEL}.plist`) };
}
