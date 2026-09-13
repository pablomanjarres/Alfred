import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig, saveCueOutput } from '../src/config.js';

test('defaults preserve the installed Codex account and requested full access', () => {
  const value = parseConfig({}, '/tmp/alfred-home');
  assert.equal(value.codex, 'codex');
  assert.equal(value.permission, 'full');
  assert.equal(value.model, undefined);
  assert.equal(value.timeoutMs, 600_000);
});

test('rejects malformed permissions, timeouts, and paths before spawning', () => {
  for (const value of [{ permission: 'yes' }, { timeoutMs: 0 }, { timeoutMs: Infinity },
    { cwd: '' }, { model: 12 }, { locale: false }, { speak: 'yes' }, { secret: 'bad' }]) {
    assert.throws(() => parseConfig(value, '/tmp/home'));
  }
});

test('expands the user home without treating a command as shell input', () => {
  const value = parseConfig({ cwd: '~/Projects', codex: '/tmp/path with spaces/codex' }, '/tmp/home');
  assert.equal(value.cwd, '/tmp/home/Projects');
  assert.equal(value.codex, '/tmp/path with spaces/codex');
});


test('cue output defaults to current and only accepts known routes', () => {
  assert.equal(parseConfig({}, '/tmp/home').cueOutput, 'current');
  assert.equal(parseConfig({ cueOutput: 'speakers' }, '/tmp/home').cueOutput, 'speakers');
  assert.throws(() => parseConfig({ cueOutput: 'headphones' }, '/tmp/home'), /cueOutput/);
  assert.throws(() => parseConfig({ cueOutput: ['speakers'] }, '/tmp/home'), /cueOutput/);
  assert.throws(() => parseConfig({ cueOutput: { toString: () => 'speakers' } }, '/tmp/home'), /cueOutput/);
});

test('saving cue output is atomic and preserves existing raw config fields', async () => {
  const home = await mkdtemp(join(tmpdir(), 'alfred-config-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({ cwd: '~/Projects', unknownFutureField: { keep: true } }) + '\n');

  await saveCueOutput('speakers', home);

  const saved = JSON.parse(await readFile(config, 'utf8'));
  assert.equal(saved.cueOutput, 'speakers');
  assert.deepEqual(saved.unknownFutureField, { keep: true });
  assert.equal(saved.cwd, '~/Projects');
});
