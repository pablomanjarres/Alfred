import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';

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
