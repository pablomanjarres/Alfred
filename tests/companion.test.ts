import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareCompanion, readCompanion } from '../src/companion.ts';
import { parseConfig } from '../src/config.ts';

const threadId = 'a1dd3451-6be9-4043-981a-fac11483f5a4';

test('generated controls preserve custom state and literal executable paths', async () => {
  const home = await mkdtemp(join(tmpdir(), "alfred companion's $()-"));
  const executable = join(home, "fake alfred's cli");
  try {
    await writeFile(executable, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ home: process.env.ALFRED_HOME, args: process.argv.slice(2) }));\n');
    await chmod(executable, 0o755);
    const companion = await prepareCompanion(parseConfig({}), {
      home, executable, create: async () => ({ answer: 'Ready', sessionId: threadId }),
    });
    const profile = await readFile(join(companion.cwd, 'AGENTS.md'), 'utf8');
    const control = profile.match(/run `([^`]+ voice end)`/)?.[1];
    assert.ok(control?.includes('ALFRED_HOME='));
    assert.ok(control.includes('fake alfred'));
    const result = spawnSync('/bin/sh', ['-c', control], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { home, args: ['voice', 'end'] });
  } finally { await rm(home, { recursive: true, force: true }); }
});

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
