import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const name = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';
const checksum = 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a';
const cache = join(root, 'native/.build/wake-model');
const archive = join(cache, `${name}.tar.bz2`);
const output = join(cache, 'ready');
mkdirSync(cache, { recursive: true });
if (!existsSync(archive)) {
  const response = await fetch(
    `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${name}.tar.bz2`,
    { signal: AbortSignal.timeout(120_000) }
  );
  if (!response.ok) throw new Error(`Wake model download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== checksum) {
    throw new Error('Wake model checksum does not match the pinned version.');
  }
  writeFileSync(archive, bytes);
}
if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== checksum) {
  throw new Error('Cached wake model checksum does not match the pinned version.');
}
const extracted = join(cache, name);
const extract = spawnSync('/usr/bin/tar', ['-xjf', archive, '-C', cache], { stdio: 'inherit' });
if (extract.status !== 0) throw new Error('Could not extract the wake model.');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const file of [
  'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
  'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx', 'tokens.txt'
]) cpSync(join(extracted, file), join(output, file));
cpSync(join(root, 'native/Resources/alfred-keywords.txt'), join(output, 'alfred-keywords.txt'));
writeFileSync(join(output, 'source.json'), JSON.stringify({ name, sha256: checksum }) + '\n');
rmSync(extracted, { recursive: true, force: true });
console.log('Prepared the pinned local Alfred wake model.');
