import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodex, codexArgs } from '../src/codex.js';
import { parseConfig } from '../src/config.js';

test('Codex inherits configured tools and applies the selected access policy', () => {
  const args = codexArgs(parseConfig({}, '/tmp'), '/tmp/answer');
  assert.ok(args.includes('sandbox_mode="danger-full-access"'));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(!args.includes('--ignore-user-config'));
  assert.ok(!args.includes('--ephemeral'));
  assert.equal(args.at(-1), '-');
  const resume = codexArgs(parseConfig({ permission: 'read-only' }, '/tmp'), '/tmp/a', 'session-id');
  assert.ok(resume.includes('resume'));
  assert.ok(resume.includes('session-id'));
  assert.ok(resume.includes('sandbox_mode="read-only"'));
});

test('sends literal stdin, reads the answer, and extracts session and usage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alfred-test-'));
  try {
    const binary = join(dir, 'fake codex');
    await writeFile(binary, `#!/usr/bin/env node\nconst fs=require('node:fs');\nconst a=process.argv;\nfs.writeFileSync(${JSON.stringify(join(dir, 'stdin'))},fs.readFileSync(0));\nfs.writeFileSync(a[a.indexOf('-o')+1],'At your service.');\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'abc-123'}));\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:5,cached_input_tokens:10}}));\n`, { mode: 0o700 });
    const prompt = 'literal `echo bad` $(touch nope) and español';
    const result = await runCodex(prompt, parseConfig({ codex: binary, cwd: dir }, dir), dir);
    assert.equal(await readFile(join(dir, 'stdin'), 'utf8'), prompt);
    assert.equal(result.answer, 'At your service.');
    assert.equal(result.sessionId, 'abc-123');
    assert.equal(result.usage?.input_tokens, 20);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('timeouts and cancellation end the child instead of reporting success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alfred-timeout-'));
  try {
    const binary = join(dir, 'hung');
    await writeFile(binary, '#!/usr/bin/env node\nprocess.stdin.resume(); setInterval(()=>{},1000);', { mode: 0o700 });
    const config = { ...parseConfig({ codex: binary, cwd: dir }, dir), timeoutMs: 60 };
    await assert.rejects(runCodex('hello', config, dir), /timed out/i);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    await assert.rejects(runCodex('hello', { ...config, timeoutMs: 5000 }, dir, undefined, controller.signal), /cancel/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('surfaces JSON errors even when stderr is empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alfred-error-'));
  try {
    const binary = join(dir, 'error');
    await writeFile(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"error",message:"Account limit reached"}));process.exitCode=1;', { mode: 0o700 });
    await assert.rejects(runCodex('hello', parseConfig({ codex: binary, cwd: dir }, dir), dir), /Account limit reached/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
