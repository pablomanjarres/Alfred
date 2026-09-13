import { chmodSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const menuRoot = join(root, 'native', 'MenuBar');
const appRoot = join(root, 'dist', 'Alfred.app');
const contents = join(appRoot, 'Contents');
const macos = join(contents, 'MacOS');
const bundleId = 'com.pablo.alfred.menubar';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: false, stdio: options.capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }
  return result;
}

function plistValue(path, key) {
  return run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path], { capture: true }).stdout.trim();
}

function requireSignedBundle(path) {
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', path]);
  const details = run('/usr/bin/codesign', ['-dv', '--verbose=4', path], { capture: true }).stderr;
  if (!details.includes(`Identifier=${bundleId}`)) throw new Error(`Built menu app was signed with the wrong identifier.\n${details}`);
  if (details.includes('Info.plist=not bound') || !/Info\.plist entries=\d+/.test(details)) throw new Error(`Built menu app signature did not bind Info.plist.\n${details}`);
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
const builtPlist = join(contents, 'Info.plist');
if (plistValue(builtPlist, 'CFBundleIdentifier') !== bundleId) throw new Error('Built menu app has the wrong bundle identifier.');
if (!plistValue(builtPlist, 'NSMicrophoneUsageDescription')) throw new Error('Built menu app is missing NSMicrophoneUsageDescription.');
run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', bundleId, appRoot]);
requireSignedBundle(appRoot);
console.log(`Built ${appRoot}`);
