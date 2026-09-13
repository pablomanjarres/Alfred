import { chmodSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildCodesignArgs, loadMenuSigningConfig, menuBundleId, unlockConfiguredKeychain, verifyMenuBundleSignature, withTemporaryMenuKeychainSearchList } from './menu-signing.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const menuRoot = join(root, 'native', 'MenuBar');
const appRoot = join(root, 'dist', 'Alfred.app');
const contents = join(appRoot, 'Contents');
const macos = join(contents, 'MacOS');

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
if (plistValue(builtPlist, 'CFBundleIdentifier') !== menuBundleId) throw new Error('Built menu app has the wrong bundle identifier.');
if (!plistValue(builtPlist, 'NSMicrophoneUsageDescription')) throw new Error('Built menu app is missing NSMicrophoneUsageDescription.');
const signing = await loadMenuSigningConfig();
await withTemporaryMenuKeychainSearchList(signing, async () => {
  await unlockConfiguredKeychain(signing);
  run('/usr/bin/codesign', buildCodesignArgs(appRoot, signing));
  verifyMenuBundleSignature(appRoot, { allowAdHoc: signing.identity === '-' });
});
console.log(`Built ${appRoot}`);
