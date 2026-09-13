import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const macTest = process.platform === 'darwin' ? test : test.skip;
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

async function standby(loop: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-standby-'));
  const marker = join(root, 'calls');
  const helper = join(root, 'helper.mjs');
  await writeFile(helper, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const path = ${JSON.stringify(marker)};
const calls = existsSync(path) ? Number(readFileSync(path, 'utf8')) + 1 : 1;
writeFileSync(path, String(calls));
console.log(JSON.stringify(calls === 1
  ? { type: 'idle', status: 'clap' }
  : { type: 'error', message: 'sentinel: real error ends standby' }));
process.exit(calls === 1 ? 0 : 1);
`);
  await chmod(helper, 0o755);
  try {
    let stderr = '';
    try {
      await run(process.execPath, ['--import', 'tsx', cli, 'clap', ...(loop ? ['--loop'] : [])], {
        env: { ...process.env, ALFRED_HOME: root, ALFRED_VOICE_HELPER: helper }, timeout: 5_000,
      });
      assert.fail('idle or helper failure must end with an error');
    } catch (error) {
      assert.equal((error as { killed?: boolean }).killed, false, 'must not retry real errors');
      stderr = String((error as { stderr?: string }).stderr ?? '');
    }
    return { calls: Number(await readFile(marker, 'utf8')), stderr };
  } finally { await rm(root, { recursive: true, force: true }); }
}

macTest('clap standby rearms after idle and stops on a real helper failure', async () => {
  const result = await standby(true);
  assert.equal(result.calls, 2);
  assert.match(result.stderr, /sentinel: real error ends standby/);
});

macTest('one-shot clap returns a clear idle result without rearming', async () => {
  const result = await standby(false);
  assert.equal(result.calls, 1);
  assert.match(result.stderr, /no double clap/i);
});
