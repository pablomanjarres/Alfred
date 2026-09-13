import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { menuSigningConfigPath } from './menu-signing.mjs';

if (process.platform !== 'darwin') throw new Error('Menu signing setup requires macOS.');
process.umask(0o077);
const configPath = menuSigningConfigPath();
const privateDir = join(dirname(configPath), 'signing');
const keychain = join(privateDir, 'alfred-signing.keychain-db');
const passwordFile = join(privateDir, 'keychain-password');
const name = 'Alfred Local Signing';

function run(label, command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, shell: false });
  // Security arguments include the new keychain password; never print them.
  if (result.error || result.status !== 0) throw new Error(`${label} failed (${result.error?.code ?? result.status}).`);
  return result.stdout;
}
function security(label, args) { return run(label, '/usr/bin/security', args); }
function identityHash() {
  const identities = security('Find Alfred signing identity', ['find-identity', '-p', 'codesigning', keychain]);
  const hash = identities.match(/\b([A-Fa-f0-9]{40}) "Alfred Local Signing"/)?.[1];
  if (!hash) throw new Error('The Alfred keychain has no Alfred Local Signing identity.');
  return hash;
}

if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (config.keychain !== keychain || config.passwordFile !== passwordFile) {
    throw new Error('A different signer is already configured. Existing signing settings were preserved.');
  }
  security('Unlock Alfred signing keychain', ['unlock-keychain', '-p', readFileSync(passwordFile, 'utf8').trim(), keychain]);
  if (identityHash() !== config.identity) throw new Error('The configured Alfred signing identity changed.');
  console.log('Alfred signing identity is ready.');
  process.exit(0);
}
if (existsSync(keychain) && existsSync(passwordFile)) {
  const password = readFileSync(passwordFile, 'utf8').trim();
  security('Unlock Alfred signing keychain', ['unlock-keychain', '-p', password, keychain]);
  security('Allow local code signing', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
  writeFileSync(configPath, JSON.stringify({ identity: identityHash(), keychain, passwordFile }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Restored Alfred’s local signing config.');
  process.exit(0);
}
if (existsSync(keychain) || existsSync(passwordFile)) throw new Error('Incomplete Alfred signing files were preserved. Restore the matching keychain and password before continuing.');

mkdirSync(privateDir, { recursive: true, mode: 0o700 });
chmodSync(privateDir, 0o700);
const password = randomBytes(32).toString('hex');
writeFileSync(passwordFile, password + '\n', { mode: 0o600, flag: 'wx' });
const temp = mkdtempSync(join(privateDir, 'setup-'));
try {
  const certificateConfig = join(temp, 'certificate.conf');
  const privateKey = join(temp, 'key.pem');
  const certificate = join(temp, 'certificate.pem');
  const bundle = join(temp, 'identity.p12');
  writeFileSync(certificateConfig, `[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=${name}\n[extensions]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n`);
  run('Create Alfred signing certificate', '/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', privateKey, '-out', certificate, '-days', '3650', '-config', certificateConfig]);
  run('Package Alfred signing identity', '/usr/bin/openssl', ['pkcs12', '-export', '-out', bundle, '-inkey', privateKey, '-in', certificate, '-name', name, '-passout', `file:${passwordFile}`, '-certpbe', 'PBE-SHA1-3DES', '-keypbe', 'PBE-SHA1-3DES', '-macalg', 'sha1']);
  security('Create Alfred signing keychain', ['create-keychain', '-p', password, keychain]);
  // Keep this private signing keychain out of the user's global search list.
  const current = security('Read keychain search list', ['list-keychains', '-d', 'user']);
  const paths = [...current.matchAll(/^\s*"(.*)"\s*$/gm)].map(match => match[1]);
  if (paths.includes(keychain)) security('Preserve keychain search list', ['list-keychains', '-d', 'user', '-s', ...paths.filter(path => path !== keychain)]);
  security('Unlock Alfred signing keychain', ['unlock-keychain', '-p', password, keychain]);
  security('Import Alfred signing identity', ['import', bundle, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign']);
  security('Allow local code signing', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
  const identity = identityHash();
  writeFileSync(configPath, JSON.stringify({ identity, keychain, passwordFile }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Created Alfred’s own local signing identity. Private signing files stay on this Mac.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
