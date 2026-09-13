import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const helper = join(root, 'dist/AlfredVoice.app/Contents/MacOS/AlfredVoice');
const fixtures = mkdtempSync(join(tmpdir(), 'alfred-synthetic-wake-'));
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || result.stdout || `${command} failed`);
  }
  return result.stdout;
}
try {
  for (const [index, [phrase, expected]] of [
    ['Alfred', true], ['Hey Alfred', true], ['Alfred can you help', true],
    ['Jarvis', false], ['Albert', false], ['already', false],
    ['all right', false], ['hello there', false], ['Alfredo', false],
  ].entries()) {
    const file = join(fixtures, `${index}.aiff`);
    run('/usr/bin/say', ['-v', 'Daniel', '-o', file, phrase]);
    const output = run(helper, ['wake-file', '--file', file]);
    const result = output.trim().split('\n').map((line) => JSON.parse(line))
      .find((event) => event.type === 'wake-test');
    if (!result || result.detected !== expected || result.streaming !== true) {
      throw new Error(`Wake fixture ${JSON.stringify(phrase)}: expected ${expected}, got ${output}`);
    }
    console.log(`Wake fixture passed: ${JSON.stringify(phrase)} (${expected ? 'trigger' : 'quiet'})`);
  }
} finally {
  // These are generated test voices. No microphone is opened or recorded.
  rmSync(fixtures, { recursive: true, force: true });
}
