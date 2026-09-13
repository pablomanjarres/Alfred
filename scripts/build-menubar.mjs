import { chmodSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const menuRoot = join(root, 'native', 'MenuBar');
const appRoot = join(root, 'dist', 'Alfred.app');
const contents = join(appRoot, 'Contents');
const macos = join(contents, 'MacOS');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform !== 'darwin') {
  console.error('Alfred menu bar builds only on macOS because it links AppKit.');
  process.exit(1);
}

run('/usr/bin/swift', ['run', '-c', 'release', '--package-path', menuRoot, 'AlfredMenuTests']);
run('/usr/bin/swift', ['build', '-c', 'release', '--package-path', menuRoot, '--product', 'AlfredMenuBar']);
rmSync(appRoot, { force: true, recursive: true });
mkdirSync(macos, { recursive: true });
cpSync(join(menuRoot, '.build', 'release', 'AlfredMenuBar'), join(macos, 'AlfredMenuBar'));
cpSync(join(menuRoot, 'Resources', 'Info.plist'), join(contents, 'Info.plist'));
chmodSync(join(macos, 'AlfredMenuBar'), 0o755);
console.log(`Built ${appRoot}`);
