import { readFile as fsReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export const menuBundleId = 'com.pablo.alfred.menubar';

export function menuSigningDirectory(home = homedir()) {
  return join(home, 'Library', 'Application Support', 'Alfred', 'MenuBar', 'signing');
}

export function menuSigningConfigPath(home = homedir()) {
  return join(home, 'Library', 'Application Support', 'Alfred', 'MenuBar', 'signing.json');
}

export async function loadMenuSigningConfig(options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? fsReadFile;
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(await readFile(menuSigningConfigPath(home), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return {
    identity: clean(env.ALFRED_SIGNING_IDENTITY) || clean(fileConfig.identity) || '-',
    keychain: clean(env.ALFRED_SIGNING_KEYCHAIN) || clean(fileConfig.keychain),
    passwordFile: clean(fileConfig.passwordFile),
  };
}

export function buildCodesignArgs(appPath, config = {}) {
  const identity = clean(config.identity) || '-';
  const args = ['--force', '--sign', identity];
  const keychain = identity === '-' ? undefined : clean(config.keychain);
  if (keychain) args.push('--keychain', keychain);
  args.push('--identifier', menuBundleId, appPath);
  return args;
}

export async function unlockConfiguredKeychain(config, options = {}) {
  if ((clean(config.identity) || '-') === '-') return;
  const passwordFile = clean(config.passwordFile);
  if (!passwordFile) return;
  const keychain = clean(config.keychain);
  if (!keychain) throw new Error('Signing config includes passwordFile but no keychain.');
  const home = options.home ?? homedir();
  requireAlfredSigningPath(keychain, home, 'keychain');
  requireAlfredSigningPath(passwordFile, home, 'password file');
  const readFile = options.readFile ?? fsReadFile;
  const password = String(await readFile(passwordFile, 'utf8')).replace(/[\r\n]+$/, '');
  if (options.run) await options.run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain]);
  else runSecurityUnlock(password, keychain);
}

export async function withTemporaryMenuKeychainSearchList(config, action, options = {}) {
  if ((clean(config.identity) || '-') === '-') return action();
  const keychain = clean(config.keychain);
  const home = options.home ?? homedir();
  if (!keychain || !isAlfredSigningPath(keychain, home)) return action();
  const runner = options.run ?? runAsync;
  const target = resolve(keychain);
  const before = await listUserKeychains(runner);
  if (before.some((item) => samePath(item, target))) return action();
  await setUserKeychains(runner, [...before, keychain]);
  try {
    return await action();
  } finally {
    const current = await listUserKeychains(runner);
    const next = current.filter((item) => !samePath(item, target));
    if (next.length !== current.length) await setUserKeychains(runner, next);
  }
}

export function inspectCodesignOutput(output) {
  const details = output.details ?? '';
  const requirement = output.requirement ?? '';
  return {
    identifier: match(details, /^Identifier=(.+)$/m),
    signature: match(details, /^Signature=(.+)$/m),
    infoBound: !details.includes('Info.plist=not bound') && (/Info\.plist entries=\d+/.test(details) || details.includes('Info.plist=bound')),
    requirement,
  };
}

export function validateMenuSignature(signature, options = {}) {
  if (signature.identifier !== menuBundleId) throw new Error(`Menu app is signed as ${signature.identifier || 'unknown'}, not ${menuBundleId}.`);
  if (!signature.infoBound) throw new Error('Menu app signature does not bind Info.plist.');
  if (signature.signature === 'adhoc') {
    if (options.allowAdHoc) return;
    throw new Error('Menu app install requires a stable certificate-backed signature, not ad-hoc signing.');
  }
  const requirement = signature.requirement.trim();
  const hasCertificateTerm = requirement.includes('anchor ') || /\bcertificate\s+(?:leaf|root)(?:\[[^\]]+\])?\s*=\s*H"/.test(requirement);
  if (/\bcdhash\b/.test(requirement) || !hasCertificateTerm || !requirement.includes(`identifier "${menuBundleId}"`)) {
    throw new Error('Menu app install requires a stable certificate-backed signature, not a cdhash-only designated requirement.');
  }
}

export function verifyMenuBundleSignature(appPath, options = {}) {
  const runner = options.run ?? run;
  runner('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', appPath]);
  const details = runner('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { capture: true }).stderr;
  const result = runner('/usr/bin/codesign', ['-d', '-r-', appPath], { capture: true });
  const requirement = result.stdout + result.stderr;
  const signature = inspectCodesignOutput({ details, requirement });
  validateMenuSignature(signature, options);
  return signature;
}

function requireAlfredSigningPath(path, home, label) {
  if (isAlfredSigningPath(path, home)) return;
  throw new Error(`Refusing to unlock a ${label} outside Alfred signing storage.`);
}

function isAlfredSigningPath(path, home) {
  if (!isAbsolute(path)) return false;
  const root = resolve(menuSigningDirectory(home));
  const target = resolve(path);
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && rel !== '..' && !rel.includes(`..${sep}`));
}

async function listUserKeychains(runner) {
  const result = await runner('/usr/bin/security', ['list-keychains', '-d', 'user'], { capture: true });
  return parseKeychainList(result?.stdout ?? '');
}

async function setUserKeychains(runner, keychains) {
  await runner('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...keychains]);
}

function parseKeychainList(output) {
  return output.split('\n').map((line) => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

function samePath(a, b) {
  return resolve(a) === resolve(b);
}

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function match(text, pattern) {
  return text.match(pattern)?.[1]?.trim() ?? '';
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, timeout: 30_000, stdio: options.capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status ?? 'unknown status'}.`);
  }
  return result;
}

async function runAsync(command, args, options = {}) {
  return run(command, args, options);
}

function runSecurityUnlock(password, keychain) {
  const result = spawnSync('/usr/bin/security', ['unlock-keychain', '-p', password, keychain], { encoding: 'utf8', shell: false, stdio: 'pipe', timeout: 30_000 });
  if (result.error) throw new Error(result.error.code === 'ETIMEDOUT' ? 'Timed out unlocking Alfred signing keychain.' : 'Could not unlock Alfred signing keychain.');
  if (result.status !== 0) throw new Error(`Could not unlock Alfred signing keychain; security exited with ${result.status ?? 'unknown status'}.`);
}
