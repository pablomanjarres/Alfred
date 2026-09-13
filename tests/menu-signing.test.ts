import test from 'node:test';
import { verifyMenuBundleSignature } from '../scripts/menu-signing.mjs';
import assert from 'node:assert/strict';
import {
  buildCodesignArgs,
  inspectCodesignOutput,
  loadMenuSigningConfig,
  unlockConfiguredKeychain,
  validateMenuSignature,
  withTemporaryMenuKeychainSearchList,
} from '../scripts/menu-signing.mjs';

const home = '/Users/tester';

test('bundle verification reads the designated requirement from codesign stdout', () => {
  const requirement = 'designated => identifier "com.pablo.alfred.menubar" and certificate leaf = H"1234"';
  const signature = verifyMenuBundleSignature('/fake/Alfred.app', { run: (_command: string, args: string[]) => {
    if (args.includes('-r-')) return { stdout: requirement, stderr: 'Executable=/fake/Alfred.app' };
    return { stdout: '', stderr: 'Identifier=com.pablo.alfred.menubar\nInfo.plist entries=10\nAuthority=Alfred Local Signing' };
  } });
  assert.match(signature.requirement, /certificate leaf/);
});
const readFile = async (path: string) => {
  assert.equal(path, '/Users/tester/Library/Application Support/Alfred/MenuBar/signing.json');
  return JSON.stringify({ identity: 'Developer ID Application: Pablo Example (TEAM12345)', keychain: '/Users/tester/Library/Keychains/alfred.keychain-db' });
};

test('signing config prefers environment over persistent local file', async () => {
  const config = await loadMenuSigningConfig({
    home,
    env: { ALFRED_SIGNING_IDENTITY: 'Apple Development: Local Override', ALFRED_SIGNING_KEYCHAIN: '/tmp/override.keychain-db' },
    readFile,
  });

  assert.equal(config.identity, 'Apple Development: Local Override');
  assert.equal(config.keychain, '/tmp/override.keychain-db');
});

test('build codesign args use persistent local signing config when environment is empty', async () => {
  const config = await loadMenuSigningConfig({ home, env: {}, readFile });
  assert.deepEqual(buildCodesignArgs('/tmp/Alfred.app', config), [
    '--force', '--sign', 'Developer ID Application: Pablo Example (TEAM12345)', '--keychain', '/Users/tester/Library/Keychains/alfred.keychain-db', '--identifier', 'com.pablo.alfred.menubar', '/tmp/Alfred.app',
  ]);
});

test('installer rejects ad-hoc cdhash-only menu app signatures', () => {
  const signature = inspectCodesignOutput({
    details: 'Identifier=com.pablo.alfred.menubar\nSignature=adhoc\nInfo.plist entries=10\n',
    requirement: 'designated => cdhash H"0123456789abcdef"',
  });

  assert.throws(() => validateMenuSignature(signature, { allowAdHoc: false }), /stable certificate-backed signature/);
});

test('installer accepts certificate-backed menu app signatures', () => {
  const signature = inspectCodesignOutput({
    details: 'Identifier=com.pablo.alfred.menubar\nAuthority=Developer ID Application: Pablo Example (TEAM12345)\nInfo.plist entries=10\n',
    requirement: 'designated => anchor apple generic and identifier "com.pablo.alfred.menubar" and certificate leaf[subject.CN] = "Developer ID Application: Pablo Example (TEAM12345)"',
  });

  assert.doesNotThrow(() => validateMenuSignature(signature, { allowAdHoc: false }));
});

test('installer rejects cdhash-only designated requirements even with a certificate authority', () => {
  const signature = inspectCodesignOutput({
    details: 'Identifier=com.pablo.alfred.menubar\nAuthority=Developer ID Application: Pablo Example (TEAM12345)\nInfo.plist entries=10\n',
    requirement: 'designated => cdhash H"0123456789abcdef"',
  });

  assert.throws(() => validateMenuSignature(signature, { allowAdHoc: false }), /cdhash-only designated requirement/);
});

test('builder unlocks only the configured Alfred-owned signing keychain', async () => {
  const calls: string[][] = [];
  const config = await loadMenuSigningConfig({
    home,
    env: {},
    readFile: async (path: string) => path.endsWith('signing.json')
      ? JSON.stringify({ identity: 'Developer ID Application: Pablo Example (TEAM12345)', keychain: '/Users/tester/Library/Application Support/Alfred/MenuBar/signing/alfred-signing.keychain-db', passwordFile: '/Users/tester/Library/Application Support/Alfred/MenuBar/signing/keychain-password' })
      : 'secret\n',
  });

  await unlockConfiguredKeychain(config, { home, readFile: async () => 'secret\n', run: async (_command: string, args: string[]) => { calls.push(args); } });

  assert.deepEqual(calls, [['unlock-keychain', '-p', 'secret', '/Users/tester/Library/Application Support/Alfred/MenuBar/signing/alfred-signing.keychain-db']]);
});

test('builder refuses to unlock keychains outside Alfred signing storage', async () => {
  const config = { identity: 'Developer ID Application: Pablo Example (TEAM12345)', keychain: '/Users/tester/Library/Keychains/login.keychain-db', passwordFile: '/Users/tester/Library/Application Support/Alfred/MenuBar/signing/keychain-password' };

  await assert.rejects(() => unlockConfiguredKeychain(config, { home, readFile: async () => 'secret', run: async () => {} }), /Refusing to unlock a keychain outside Alfred signing storage/);
});

test('installer accepts certificate-hash designated requirements without anchor text', () => {
  const signature = inspectCodesignOutput({
    details: 'Identifier=com.pablo.alfred.menubar\nAuthority=Alfred Menu Local Signing\nInfo.plist entries=10\n',
    requirement: 'designated => identifier "com.pablo.alfred.menubar" and certificate leaf = H"abcdef0123456789"',
  });

  assert.doesNotThrow(() => validateMenuSignature(signature, { allowAdHoc: false }));
});

test('installer rejects cdhash even when it is not the first requirement term', () => {
  const signature = inspectCodesignOutput({
    details: 'Identifier=com.pablo.alfred.menubar\nAuthority=Alfred Menu Local Signing\nInfo.plist entries=10\n',
    requirement: 'designated => identifier "com.pablo.alfred.menubar" and cdhash H"0123456789abcdef"',
  });

  assert.throws(() => validateMenuSignature(signature, { allowAdHoc: false }), /cdhash-only designated requirement/);
});


test('builder temporarily registers own keychain and removes only that path after signing fails', async () => {
  const own = '/Users/tester/Library/Application Support/Alfred/MenuBar/signing/alfred-signing.keychain-db';
  const concurrent = '/Users/tester/Library/Keychains/concurrent.keychain-db';
  const calls: string[][] = [];
  let listed = ['/Users/tester/Library/Keychains/login.keychain-db'];
  const run = async (_command: string, args: string[], options?: { capture?: boolean }) => {
    calls.push(args);
    if (args[0] === 'list-keychains' && options?.capture) return { stdout: listed.map((item) => `    "${item}"`).join('\n') + '\n', stderr: '', code: 0 };
    if (args[0] === 'list-keychains' && args[3] === '-s') {
      listed = args.slice(4);
      if (listed.includes(own) && !listed.includes(concurrent)) listed.push(concurrent);
      return { stdout: '', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  await assert.rejects(() => withTemporaryMenuKeychainSearchList(
    { identity: 'Alfred Menu Local Signing', keychain: own },
    async () => { throw new Error('sign failed'); },
    { home, run },
  ), /sign failed/);

  assert.deepEqual(listed, ['/Users/tester/Library/Keychains/login.keychain-db', concurrent]);
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [
    ['list-keychains', '-d', 'user'],
    ['list-keychains', '-d', 'user'],
    ['list-keychains', '-d', 'user'],
    ['list-keychains', '-d', 'user'],
  ]);
});

test('builder does not register external env keychains automatically', async () => {
  const calls: string[][] = [];
  await withTemporaryMenuKeychainSearchList(
    { identity: 'Developer ID Application: External', keychain: '/Users/tester/Library/Keychains/login.keychain-db' },
    async () => { calls.push(['signed']); },
    { home, run: async (_command: string, args: string[]) => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; } },
  );

  assert.deepEqual(calls, [['signed']]);
});

test('ad-hoc build skips unlock and search-list registration even with private signing config', async () => {
  const config = { identity: '-', keychain: '/Users/tester/Library/Application Support/Alfred/MenuBar/signing/alfred-signing.keychain-db', passwordFile: '/Users/tester/Library/Application Support/Alfred/MenuBar/signing/keychain-password' };
  const calls: string[][] = [];

  await unlockConfiguredKeychain(config, { home, readFile: async () => 'secret', run: async (_command: string, args: string[]) => { calls.push(args); } });
  await withTemporaryMenuKeychainSearchList(config, async () => { calls.push(['signed']); }, { home, run: async (_command: string, args: string[]) => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; } });

  assert.deepEqual(calls, [['signed']]);
});
