import { accessSync, chmodSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const label = 'com.pablo.alfred.menubar';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = homedir();
const sourceApp = join(root, 'dist', 'Alfred.app');
const targetApp = join(home, 'Applications', 'Alfred.app');
const targetExe = join(targetApp, 'Contents', 'MacOS', 'AlfredMenuBar');
const configPath = join(home, 'Library', 'Application Support', 'Alfred', 'MenuBar', 'config.json');
const plistPath = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
const cliPath = resolve(process.env.ALFRED_CLI_PATH || join(root, 'dist', 'cli.js'));

function run(command, args, allowFailure = false) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (!allowFailure && result.status !== 0) process.exit(result.status ?? 1);
  return result;
}
function xml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

accessSync(sourceApp, constants.R_OK);
accessSync(cliPath, constants.R_OK);
mkdirSync(dirname(targetApp), { recursive: true });
cpSync(sourceApp, targetApp, { recursive: true, force: true });
chmodSync(targetExe, 0o755);
mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
writeFileSync(configPath, JSON.stringify({ nodePath: process.execPath, cliPath }, null, 2) + '\n', { mode: 0o600 });
mkdirSync(dirname(plistPath), { recursive: true });
writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(targetExe)}</string></array><key>RunAtLoad</key><true/></dict></plist>
`, { mode: 0o600 });
run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`], true);
run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath]);
run('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]);
console.log(`Installed ${targetApp}`);
console.log(`Configured CLI ${cliPath}`);
