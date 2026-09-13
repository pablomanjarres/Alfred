import { accessSync, chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { verifyMenuBundleSignature } from './menu-signing.mjs';

const label = 'com.pablo.alfred.menubar';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = homedir();
const sourceApp = join(root, 'dist', 'Alfred.app');
const targetApp = join(home, 'Applications', 'Alfred.app');
const targetExe = join(targetApp, 'Contents', 'MacOS', 'AlfredMenuBar');
const configPath = join(home, 'Library', 'Application Support', 'Alfred', 'MenuBar', 'config.json');
const plistPath = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
const domain = `gui/${process.getuid()}`;
const service = `${domain}/${label}`;
const cliPath = resolve(process.env.ALFRED_CLI_PATH || join(root, 'dist', 'cli.js'));

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
  if (!options.quiet && result.stdout) process.stdout.write(result.stdout);
  if (!options.quiet && result.stderr) process.stderr.write(result.stderr);
  if (!options.allowFailure && result.status !== 0) process.exit(result.status ?? 1);
  return result;
}
function launchctl(args, options = {}) { return run('/bin/launchctl', args, options); }
function bundleId(appPath) {
  const plist = join(appPath, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return undefined;
  const result = run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { allowFailure: true, quiet: true });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
function xml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function servicePid() {
  const result = launchctl(['print', service], { allowFailure: true, quiet: true });
  if (result.status !== 0) return undefined;
  return Number(result.stdout.match(/\bpid\s*=\s*(\d+)/)?.[1]);
}
function waitUnloaded() {
  for (let i = 0; i < 30; i += 1) { if (!servicePid()) return; sleep(100); }
}
function waitRunning() {
  for (let i = 0; i < 50; i += 1) { const pid = servicePid(); if (pid) return pid; sleep(100); }
  console.error(`Alfred menu bar did not report a running launchd pid for ${service}.`);
  process.exit(1);
}

accessSync(sourceApp, constants.R_OK);
accessSync(cliPath, constants.R_OK);
try {
  verifyMenuBundleSignature(sourceApp, { allowAdHoc: false });
} catch (error) {
  console.error(`Refusing to install Alfred menu bar: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
mkdirSync(dirname(targetApp), { recursive: true });
if (existsSync(targetApp)) {
  const existing = bundleId(targetApp);
  if (existing !== label) {
    console.error(`Refusing to replace ${targetApp}; bundle id is ${existing || 'unknown'}, not ${label}.`);
    process.exit(1);
  }
}
launchctl(['bootout', service], { allowFailure: true, quiet: true });
waitUnloaded();
if (existsSync(targetApp)) rmSync(targetApp, { recursive: true, force: true });
cpSync(sourceApp, targetApp, { recursive: true, force: true });
chmodSync(targetExe, 0o755);
run('/usr/bin/codesign', ['--verify', '--strict', targetApp]);
run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', targetApp]);
mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
writeFileSync(configPath, JSON.stringify({ nodePath: process.execPath, cliPath, stateHome: resolve(process.env.ALFRED_HOME || join(home, '.alfred')) }, null, 2) + '\n', { mode: 0o600 });
mkdirSync(dirname(plistPath), { recursive: true });
writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(targetExe)}</string></array><key>RunAtLoad</key><true/></dict></plist>
`, { mode: 0o600 });
let boot = launchctl(['bootstrap', domain, plistPath], { allowFailure: true });
if (boot.status !== 0) { sleep(500); boot = launchctl(['bootstrap', domain, plistPath], { allowFailure: true }); }
if (boot.status !== 0) process.exit(boot.status ?? 1);
const pid = waitRunning();
console.log(`Installed ${targetApp}`);
console.log(`Configured CLI ${cliPath}`);
console.log(`Alfred menu bar running pid ${pid}`);
