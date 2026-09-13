import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareCompanion, readCompanion } from '../src/companion.ts';
import { parseConfig } from '../src/config.ts';

const threadId = 'a1dd3451-6be9-4043-981a-fac11483f5a4';

test('companion setup uses a private workspace and reuses its task', async () => {
  const home = await mkdtemp(join(tmpdir(), 'alfred-companion-'));
  let calls = 0;
  try {
    const create = async (_prompt: string, config: { cwd: string }) => {
      calls += 1;
      assert.equal(config.cwd, join(home, 'companion'));
      assert.match(await readFile(join(config.cwd, 'AGENTS.md'), 'utf8'), /Alfred/);
      return { answer: 'At your service, Pablo.', sessionId: threadId };
    };
    const first = await prepareCompanion(parseConfig({}), { home, create });
    assert.equal(first.threadId, threadId);
    assert.equal((await stat(join(home, 'companion.json'))).mode & 0o777, 0o600);
    await writeFile(join(first.cwd, 'AGENTS.md'), 'My edited Alfred profile.');
    assert.deepEqual(await prepareCompanion(parseConfig({}), { home, create }), first);
    assert.equal(calls, 1);
    assert.equal(await readFile(join(first.cwd, 'AGENTS.md'), 'utf8'), 'My edited Alfred profile.');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('invalid task IDs cannot become wake destinations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'alfred-companion-'));
  try {
    assert.equal(await readCompanion(home), undefined);
    await assert.rejects(prepareCompanion(parseConfig({}), {
      home, create: async () => ({ answer: 'Ready', sessionId: '../../settings' }),
    }), /task ID/);
    assert.equal(await readCompanion(home), undefined);
    await writeFile(join(home, 'companion.json'), JSON.stringify({ threadId: 'bad', cwd: '/tmp' }));
    await assert.rejects(readCompanion(home), /companion/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
