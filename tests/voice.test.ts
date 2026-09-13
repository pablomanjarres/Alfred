import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { transcribe, voiceStatus } from '../src/voice.ts';

async function fakeHelper(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'alfred-voice-'));
  const path = join(dir, 'helper.mjs');
  await writeFile(path, source, 'utf8');
  await chmod(path, 0o755);
  return path;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('voiceStatus reports a missing helper without prompting', async () => {
  const previous = process.env.ALFRED_VOICE_HELPER;
  process.env.ALFRED_VOICE_HELPER = '/missing/AlfredVoice';

  try {
    const status = await voiceStatus();
    assert.equal(status.available, false);
    assert.match(status.detail, /helper/i);
  } finally {
    restoreEnv('ALFRED_VOICE_HELPER', previous);
  }
});

test('transcribe reads JSON-line statuses and preserves UTF-8 transcript text', async () => {
  const helper = await fakeHelper(`#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes('listen') || !args.includes('--locale') || !args.includes('es-CO')) {
  console.log(JSON.stringify({ type: 'error', message: 'wrong arguments: ' + args.join(' ') }));
  process.exit(1);
}
console.log(JSON.stringify({ type: 'ready', status: 'ready' }));
console.log(JSON.stringify({ type: 'listening', status: 'listening' }));
console.log(JSON.stringify({ type: 'transcript', text: 'enciende la luz ñ' }));
`);
  const previous = process.env.ALFRED_VOICE_HELPER;
  process.env.ALFRED_VOICE_HELPER = helper;
  const statuses: string[] = [];

  try {
    const transcript = await transcribe({
      mode: 'listen',
      locale: 'es-CO',
      onStatus: (status) => statuses.push(status),
    });

    assert.equal(transcript, 'enciende la luz ñ');
    assert.deepEqual(statuses, ['ready', 'listening']);
  } finally {
    restoreEnv('ALFRED_VOICE_HELPER', previous);
  }
});

test('transcribe abort kills a still-listening helper', async () => {
  const marker = join(await mkdtemp(join(tmpdir(), 'alfred-voice-')), 'aborted.txt');
  const helper = await fakeHelper(`#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {
  writeFileSync(${JSON.stringify(marker)}, 'terminated', 'utf8');
  process.exit(0);
});
console.log(JSON.stringify({ type: 'listening', status: 'listening' }));
setInterval(() => {}, 1000);
`);
  const previous = process.env.ALFRED_VOICE_HELPER;
  process.env.ALFRED_VOICE_HELPER = helper;
  const controller = new AbortController();

  try {
    const promise = transcribe({
      mode: 'listen',
      signal: controller.signal,
      onStatus: () => controller.abort(),
    });

    await assert.rejects(promise, /aborted/i);
    await waitForFile(marker);
  } finally {
    restoreEnv('ALFRED_VOICE_HELPER', previous);
  }
});
