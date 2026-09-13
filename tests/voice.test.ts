import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { speak, transcribe, voiceStatus } from '../src/voice.ts';

const macTest = process.platform === 'darwin' ? test : test.skip;
const nonMacTest = process.platform === 'darwin' ? test.skip : test;

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

function withEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => restoreEnv(name, previous);
}

nonMacTest('voice APIs explain that native voice requires macOS', async () => {
  const status = await voiceStatus();
  assert.equal(status.available, false);
  assert.match(status.detail, /macOS/i);
  await assert.rejects(transcribe({ mode: 'listen' }), /macOS/i);
  await assert.rejects(speak('hello'), /macOS/i);
});


macTest('live microphone transcription modes are disabled', async () => {
  await assert.rejects(transcribe({ mode: 'listen' }), /Codex voice button/);
  await assert.rejects(transcribe({ mode: 'clap' }), /Codex voice button/);
});

macTest('voiceStatus reports a missing helper without prompting', async () => {
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

macTest('transcribe reads JSON-line statuses and preserves UTF-8 transcript text', async () => {
  const helper = await fakeHelper(`#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes('file') || !args.includes('--file') || !args.includes('/tmp/message.m4a') || !args.includes('--locale') || !args.includes('es-CO')) {
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
      mode: 'file',
      file: '/tmp/message.m4a',
      locale: 'es-CO',
      onStatus: (status) => statuses.push(status),
    });

    assert.equal(transcript, 'enciende la luz ñ');
    assert.deepEqual(statuses, ['ready', 'listening']);
  } finally {
    restoreEnv('ALFRED_VOICE_HELPER', previous);
  }
});

macTest('transcribe abort kills a still-listening helper', async () => {
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
      mode: 'file',
      file: '/tmp/message.m4a',
      signal: controller.signal,
      onStatus: () => controller.abort(),
    });

    await assert.rejects(promise, /aborted/i);
    await waitForFile(marker);
  } finally {
    restoreEnv('ALFRED_VOICE_HELPER', previous);
  }
});

macTest('transcribe resolves only after the helper process has exited', async () => {
  const marker = join(await mkdtemp(join(tmpdir(), 'alfred-voice-')), 'closed.txt');
  const helper = await fakeHelper(`#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
console.log(JSON.stringify({ type: 'transcript', text: 'stand by' }));
setTimeout(() => {
  writeFileSync(${JSON.stringify(marker)}, 'closed', 'utf8');
  process.exit(0);
}, 150);
`);
  const restore = withEnv('ALFRED_VOICE_HELPER', helper);

  try {
    assert.equal(await transcribe({ mode: 'file', file: '/tmp/message.m4a' }), 'stand by');
    await access(marker);
  } finally {
    restore();
  }
});

macTest('transcribe stops a helper that stays open after transcript', async () => {
  const marker = join(await mkdtemp(join(tmpdir(), 'alfred-voice-')), 'stopped.txt');
  const helper = await fakeHelper(`#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {
  setTimeout(() => {
    writeFileSync(${JSON.stringify(marker)}, 'stopped', 'utf8');
    process.exit(0);
  }, 75);
});
console.log(JSON.stringify({ type: 'transcript', text: 'yes sir' }));
setInterval(() => {}, 1000);
`);
  const restoreHelper = withEnv('ALFRED_VOICE_HELPER', helper);
  const restoreGrace = withEnv('ALFRED_VOICE_TRANSCRIPT_CLOSE_MS', '25');

  try {
    assert.equal(await transcribe({ mode: 'file', file: '/tmp/message.m4a' }), 'yes sir');
    await access(marker);
  } finally {
    restoreGrace();
    restoreHelper();
  }
});

macTest('voiceStatus reports a doctor helper that hangs', async () => {
  const helper = await fakeHelper(`#!/usr/bin/env node
console.log(JSON.stringify({ type: 'ready', detail: 'started' }));
setInterval(() => {}, 1000);
`);
  const restoreHelper = withEnv('ALFRED_VOICE_HELPER', helper);
  const restoreTimeout = withEnv('ALFRED_VOICE_TIMEOUT_MS', '75');

  try {
    const status = await voiceStatus();
    assert.equal(status.available, false);
    assert.match(status.detail, /timed out/i);
  } finally {
    restoreTimeout();
    restoreHelper();
  }
});

macTest('speak sends leading-dash text through stdin', async () => {
  const marker = join(await mkdtemp(join(tmpdir(), 'alfred-voice-')), 'say.json');
  const helper = await fakeHelper(`#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), input }), 'utf8');
});
`);
  const restore = withEnv('ALFRED_SAY_BINARY', helper);

  try {
    await speak('-danger ñ');
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
      argv: ['-f', '-'],
      input: '-danger ñ',
    });
  } finally {
    restore();
  }
});
