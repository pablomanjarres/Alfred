import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeRoot = join(root, 'native');
const appRoot = join(root, 'dist', 'AlfredVoice.app');
const contents = join(appRoot, 'Contents');
const macos = join(contents, 'MacOS');
const resources = join(contents, 'Resources');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status ?? 1);
  }
  return result;
}

if (process.platform !== 'darwin') {
  console.error('AlfredVoice builds only on macOS because it links Speech and AVFoundation.');
  process.exit(1);
}

run('/usr/bin/swift', ['build', '-c', 'release', '--package-path', nativeRoot]);

rmSync(appRoot, { force: true, recursive: true });
mkdirSync(macos, { recursive: true });
mkdirSync(resources, { recursive: true });
cpSync(join(nativeRoot, '.build', 'release', 'AlfredVoice'), join(macos, 'AlfredVoice'));
cpSync(join(nativeRoot, 'Resources', 'Info.plist'), join(contents, 'Info.plist'));

run(join(macos, 'AlfredVoice'), ['selftest']);
run(join(macos, 'AlfredVoice'), ['clap-selftest']);
run(join(macos, 'AlfredVoice'), ['doctor'], { allowFailure: true });

console.log(`Built ${appRoot}`);
