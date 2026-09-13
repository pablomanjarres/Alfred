import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const macTest = process.platform === 'darwin' ? test : test.skip;
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

async function disabledClap(loop: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-standby-'));
  try {
    await run(process.execPath, ['--import', 'tsx', cli, 'clap', ...(loop ? ['--loop'] : [])], {
      env: { ...process.env, ALFRED_HOME: root, ALFRED_VOICE_HELPER: '/should/not/start' }, timeout: 5_000,
    });
    assert.fail('clap should be disabled before starting a helper');
  } catch (error) {
    assert.equal((error as { killed?: boolean }).killed, false);
    return String((error as { stderr?: string }).stderr ?? '');
  } finally { await rm(root, { recursive: true, force: true }); }
}

macTest('legacy clap command no longer starts Alfred-owned microphone transcription', async () => {
  assert.match(await disabledClap(false), /Codex voice button/);
});

macTest('legacy clap loop no longer rearms into microphone transcription', async () => {
  assert.match(await disabledClap(true), /Codex voice button/);
});
