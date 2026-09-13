import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const helper = join(root, 'dist/AlfredVoice.app/Contents/MacOS/AlfredVoice');
const fixtureRoot = join(root, 'tests/fixtures/wake');
const manifestPath = join(fixtureRoot, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const archive = join(fixtureRoot, manifest.archive);
const fixtures = mkdtempSync(join(tmpdir(), 'alfred-synthetic-wake-'));
const expectedNames = manifest.cases.map((item) => item.name).sort();

function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, shell: false });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || `${command} failed`);
  return result.stdout;
}
function assertSafeName(name) {
  if (basename(name) !== name || !/^\d{2}\.aiff$/.test(name)) throw new Error(`Unsafe fixture name: ${name}`);
}
function listArchive() {
  return run('/usr/bin/tar', ['-tzf', archive]).trim().split('\n').filter(Boolean).sort();
}

try {
  if (manifest.version !== 1) throw new Error(`Unsupported wake manifest version: ${manifest.version}`);
  if (sha256(archive) !== manifest.archiveSha256) throw new Error('Wake fixture archive checksum mismatch.');
  for (const name of expectedNames) assertSafeName(name);
  const archivedNames = listArchive();
  if (JSON.stringify(archivedNames) !== JSON.stringify(expectedNames)) throw new Error(`Wake fixture archive contents mismatch: ${archivedNames.join(', ')}`);
  run('/usr/bin/tar', ['-xzf', archive, '-C', fixtures, ...expectedNames]);
  for (const item of manifest.cases) {
    assertSafeName(item.name);
    const file = join(fixtures, item.name);
    if (!existsSync(file)) throw new Error(`Missing wake fixture ${item.name}`);
    if (sha256(file) !== item.sha256) throw new Error(`Checksum mismatch for wake fixture ${item.name}`);
    const output = run(helper, ['wake-file', '--file', file]);
    const result = output.trim().split('\n').map((line) => JSON.parse(line))
      .find((event) => event.type === 'wake-test');
    if (!result || result.detected !== item.expected || result.streaming !== true) {
      throw new Error(`Wake fixture ${item.voice} ${JSON.stringify(item.phrase)}: expected ${item.expected}, got ${output}`);
    }
    console.log(`Wake fixture passed: ${item.voice} ${JSON.stringify(item.phrase)} (${item.expected ? 'trigger' : 'quiet'})`);
  }
} finally {
  // These are generated test voices. No microphone is opened or recorded.
  rmSync(fixtures, { recursive: true, force: true });
}
