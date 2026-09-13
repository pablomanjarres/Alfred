import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock, saveReceipt, receipts } from '../src/history.js';

test('the live lock rejects concurrent orders and releases after failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alfred-lock-'));
  try {
    await assert.rejects(withLock(dir, async () => {
      await assert.rejects(withLock(dir, async () => {}), /already handling/);
      throw new Error('task failed');
    }), /task failed/);
    assert.equal(await withLock(dir, async () => 'next'), 'next');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('receipts remain private, survive reload, and sort newest first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alfred-history-'));
  try {
    const first = { id: 'first', order: 'one', cwd: dir, startedAt: '2026-01-01', finishedAt: '2026-01-01', status: 'completed' as const, answer: 'done' };
    await saveReceipt(dir, first);
    await saveReceipt(dir, { ...first, id: 'second', startedAt: '2026-01-02' });
    assert.equal((await receipts(dir, 1))[0].id, 'second');
    assert.equal((await stat(join(dir, 'history', 'first.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'history'))).mode & 0o777, 0o700);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
