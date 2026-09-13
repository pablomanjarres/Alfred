import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

import { LABEL, buildPlist, runStandby, servicePaths, serviceStatus, stopService, writeBlockedState } from '../src/standby.ts';

test('LaunchAgent plist starts standby without restart storms on clean exits', () => {
  const plist = buildPlist({
    node: '/usr/local/bin/node',
    script: '/app/dist/standby.js',
    alfredHome: '/Users/pablo/.alfred',
    workingDirectory: '/app',
  });

  assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>60<\/integer>/);
  assert.match(plist, /<string>\/app\/dist\/standby.js<\/string>/);
});

test('blocked voice state is private and visible to status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alfred-standby-'));
  try {
    await writeBlockedState(servicePaths(root), 'speech recognition is not authorized');
    const status = await serviceStatus({
      paths: servicePaths(root),
      launchctl: async () => ({ code: 113, stdout: '', stderr: 'not loaded' }),
    });

    assert.equal(status.loaded, false);
    assert.equal(status.state?.status, 'blocked');
    assert.match(status.detail, /speech recognition/);
    assert.match(await readFile(join(root, 'standby', 'state.json'), 'utf8'), /blocked/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('start bootstraps without synchronous kickstart hangs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alfred-standby-'));
  const helper = join(root, 'helper.mjs');
  const calls: string[][] = [];
  await writeFile(helper, `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'ready', detail: 'microphone=authorized audioInput=true speech=unused' }));
`, 'utf8');
  await chmod(helper, 0o755);
  const previousHelper = process.env.ALFRED_VOICE_HELPER;
  process.env.ALFRED_VOICE_HELPER = helper;
  try {
    const { startService } = await import('../src/standby.ts');
    await startService({
      paths: servicePaths(root),
      launchctl: async (_command, args) => {
        calls.push(args);
        return { code: args[0] === 'print' ? 113 : 0, stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(calls.map((args) => args[0]), ['bootout', 'bootstrap', 'print']);
  } finally {
    if (previousHelper === undefined) delete process.env.ALFRED_VOICE_HELPER;
    else process.env.ALFRED_VOICE_HELPER = previousHelper;
    await rm(root, { recursive: true, force: true });
  }
});

test('stop unloads launchd and records stopped state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alfred-standby-'));
  const calls: string[][] = [];
  try {
    await stopService({
      paths: servicePaths(root),
      launchctl: async (_command, args) => {
        calls.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    assert.deepEqual(calls[0], ['bootout', `gui/${process.getuid?.() ?? 0}/${LABEL}`]);
    assert.match(await readFile(join(root, 'standby', 'state.json'), 'utf8'), /stopped/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('standby loop watches claps without invoking speech or writing audio', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alfred-standby-'));
  const helper = join(root, 'helper.mjs');
  const calls = join(root, 'calls.jsonl');
  const audio = join(root, 'captured.m4a');
  await writeFile(helper, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const log = ${JSON.stringify(calls)};
const audio = ${JSON.stringify(audio)};
const args = process.argv.slice(2);
appendFileSync(log, JSON.stringify(args) + '\\n');
if (args.some((arg) => ['listen', 'file', 'clap'].includes(arg))) writeFileSync(audio, 'bad');
if (args[0] === 'clap-doctor') console.log(JSON.stringify({ type: 'ready', detail: 'microphone=authorized audioInput=true speech=unused' }));
else if (args[0] === 'clap-watch') console.log(JSON.stringify({ type: existsSync(log + '.once') ? 'clap' : 'idle', status: 'clap' }));
else process.exit(9);
writeFileSync(log + '.once', '1');
`, 'utf8');
  await chmod(helper, 0o755);
  try {
    assert.equal(await runStandby(servicePaths(root), { helper, maxCycles: 2, cue: async () => {} }), 0);
    const invoked = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(invoked, [['clap-doctor'], ['clap-watch'], ['clap-watch']]);
    await assert.rejects(readFile(audio, 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('status verifies the launchd pid is actually running', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const status = await serviceStatus({
      launchctl: async () => ({ code: 0, stdout: `{
  pid = ${child.pid};
}`, stderr: '' }),
    });
    assert.equal(status.loaded, true);
    assert.equal(status.running, true);
    assert.equal(status.pid, child.pid);
  } finally {
    child.kill('SIGTERM');
  }
});

test('standby abort waits for the active clap helper to exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alfred-standby-'));
  const helper = join(root, 'helper.mjs');
  const pidFile = join(root, 'helper.pid');
  const stopped = join(root, 'helper.stopped');
  await writeFile(helper, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'clap-doctor') {
  console.log(JSON.stringify({ type: 'ready', detail: 'microphone=authorized audioInput=true speech=unused' }));
  process.exit(0);
}
if (args[0] !== 'clap-watch') process.exit(9);
process.on('SIGTERM', () => {
  writeFileSync(${JSON.stringify(stopped)}, 'stopped');
  process.exit(0);
});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log(JSON.stringify({ type: 'listening', status: 'clap' }));
setInterval(() => {}, 1000);
`, 'utf8');
  await chmod(helper, 0o755);
  const controller = new AbortController();
  try {
    const running = runStandby(servicePaths(root), { helper, signal: controller.signal, cue: async () => {} });
    await waitForFile(pidFile);
    const childPid = Number(await readFile(pidFile, 'utf8'));
    controller.abort();
    assert.equal(await running, 0);
    await waitForFile(stopped);
    assert.equal(isRunning(childPid), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  await access(path);
}

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
