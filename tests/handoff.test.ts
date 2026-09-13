import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cancelHandoff, claimHandoff, handoffCancelledPath, handoffPath, markHandoff, requestVoiceHandoff, type HandoffRecord } from '../src/handoff.ts';
import { LABEL, servicePaths } from '../src/standby.ts';

test('voice handoff writes a private pending request, opens the menu, and waits for started', async () => {
  const paths = isolatedServicePaths(await mkdtemp(join(tmpdir(), 'alfred-handoff-')));
  const opened: string[][] = [];
  try {
    const result = await requestVoiceHandoff({
      paths, id: () => 'req-1', ttlMs: 30_000, timeoutMs: 100, pollMs: 1,
      runner: async (binary, args) => {
        opened.push([binary, ...args]);
        await markHandoff(paths, 'req-1', 'started', 'Codex voice input active');
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    assert.equal(result.status, 'started');
    assert.deepEqual(opened, [['/usr/bin/open', '-b', 'com.pablo.alfred.menubar']]);
    assert.equal((await stat(handoffPath(paths))).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(handoffPath(paths), 'utf8')) as HandoffRecord;
    assert.equal(saved.id, 'req-1');
    assert.equal(saved.status, 'started');
  } finally {
    await rm(paths.home, { recursive: true, force: true });
  }
});


test('already-aborted handoff does not publish a pending request or open the menu', async () => {
  const paths = isolatedServicePaths(await mkdtemp(join(tmpdir(), 'alfred-handoff-')));
  const controller = new AbortController();
  controller.abort();
  let opened = false;
  try {
    await assert.rejects(requestVoiceHandoff({
      paths, signal: controller.signal, id: () => 'aborted',
      runner: async () => { opened = true; return { code: 0, stdout: '', stderr: '' }; },
    }), /abort/i);

    assert.equal(opened, false);
    await assert.rejects(readFile(handoffPath(paths), 'utf8'), /ENOENT/);
  } finally {
    await rm(paths.home, { recursive: true, force: true });
  }
});

test('voice handoff rejects promptly when the request is replaced', async () => {
  const paths = isolatedServicePaths(await mkdtemp(join(tmpdir(), 'alfred-handoff-')));
  try {
    await assert.rejects(requestVoiceHandoff({
      paths, id: () => 'stale', timeoutMs: 1000, pollMs: 1,
      runner: async () => {
        await writeFile(handoffPath(paths), JSON.stringify(handoff('newer')) + '\n', { mode: 0o600 });
        return { code: 0, stdout: '', stderr: '' };
      },
    }), /replaced/);
  } finally {
    await rm(paths.home, { recursive: true, force: true });
  }
});

test('voice handoff refuses a late started outcome after cancellation tombstone', async () => {
  const paths = isolatedServicePaths(await mkdtemp(join(tmpdir(), 'alfred-handoff-')));
  try {
    await assert.rejects(requestVoiceHandoff({
      paths, id: () => 'late-cancel', timeoutMs: 100, pollMs: 1,
      runner: async () => {
        await cancelHandoff(paths, 'late-cancel');
        await writeFile(handoffPath(paths), JSON.stringify({ ...handoff('late-cancel'), status: 'started' }) + '\n', { mode: 0o600 });
        return { code: 0, stdout: '', stderr: '' };
      },
    }), /cancelled/);
  } finally {
    await rm(paths.home, { recursive: true, force: true });
  }
});

test('cancelling handoff rereads after tombstone before marking cancelled', async () => {
  const paths = isolatedServicePaths(await mkdtemp(join(tmpdir(), 'alfred-handoff-')));
  const newer = handoff('newer-after-tombstone');
  try {
    await mkdir(paths.standby, { recursive: true });
    await writeFile(handoffPath(paths), JSON.stringify(handoff('stale-cancel')) + '\n', { mode: 0o600 });

    await cancelHandoff(paths, 'stale-cancel', {
      afterTombstone: async () => {
        await writeFile(handoffPath(paths), JSON.stringify(newer) + '\n', { mode: 0o600 });
      },
    });

    assert.deepEqual(JSON.parse(await readFile(handoffCancelledPath(paths), 'utf8')), { id: 'stale-cancel' });
    assert.deepEqual(JSON.parse(await readFile(handoffPath(paths), 'utf8')), newer);
  } finally {
    await rm(paths.home, { recursive: true, force: true });
  }
});

test('voice handoff reports blocked menu outcomes', async () => {
  const paths = isolatedServicePaths(await mkdtemp(join(tmpdir(), 'alfred-handoff-')));
  await assert.rejects(requestVoiceHandoff({
    paths, id: () => 'req-2', timeoutMs: 100, pollMs: 1,
    runner: async () => {
      await markHandoff(paths, 'req-2', 'blocked', 'Codex input was not active');
      return { code: 0, stdout: '', stderr: '' };
    },
  }), /Codex input was not active/);
});

test('voice handoff does not overwrite an active newer request', async () => {
  const paths = isolatedServicePaths(await mkdtemp(join(tmpdir(), 'alfred-handoff-')));
  const existing = { id: 'newer', status: 'pending', requestedAt: new Date(Date.now() + 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await mkdir(paths.standby, { recursive: true });
  await writeFile(handoffPath(paths), JSON.stringify(existing) + '\n', { mode: 0o600 });

  await assert.rejects(requestVoiceHandoff({
    paths, id: () => 'older', runner: async () => { throw new Error('must not open menu'); },
  }), /handoff request already pending/);
  assert.deepEqual(JSON.parse(await readFile(handoffPath(paths), 'utf8')), existing);
});

test('claim handoff atomically claims only the matching pending request', async () => {
  const paths = isolatedServicePaths(await mkdtemp(join(tmpdir(), 'alfred-handoff-')));
  await mkdir(paths.standby, { recursive: true });
  await writeFile(handoffPath(paths), JSON.stringify({ id: 'req-3', status: 'pending', requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }) + '\n', { mode: 0o600 });

  assert.equal(await claimHandoff(paths, 'wrong'), undefined);
  const claimed = await claimHandoff(paths, 'req-3');
  assert.equal(claimed?.status, 'claimed');
  assert.equal((JSON.parse(await readFile(handoffPath(paths), 'utf8')) as HandoffRecord).status, 'claimed');
});

test('cancelling handoff writes the tombstone before marking the request cancelled', async () => {
  const paths = isolatedServicePaths(await mkdtemp(join(tmpdir(), 'alfred-handoff-')));
  await mkdir(paths.standby, { recursive: true });
  await writeFile(handoffPath(paths), JSON.stringify({ id: 'req-4', status: 'pending', requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }) + '\n', { mode: 0o600 });

  await cancelHandoff(paths, 'req-4');

  assert.deepEqual(JSON.parse(await readFile(handoffCancelledPath(paths), 'utf8')), { id: 'req-4' });
  assert.equal((await stat(handoffCancelledPath(paths))).mode & 0o777, 0o600);
  assert.equal((JSON.parse(await readFile(handoffPath(paths), 'utf8')) as HandoffRecord).status, 'cancelled');
});


function handoff(id: string): HandoffRecord {
  return { id, status: 'pending', requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
}

function isolatedServicePaths(root: string): ReturnType<typeof servicePaths> {
  return { ...servicePaths(root), plist: join(root, `${LABEL}.plist`) };
}
