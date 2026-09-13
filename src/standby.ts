import { constants as fsConstants } from 'node:fs';
import { access, appendFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { runProcess } from './process.js';
import { stateDirectory } from './config.js';

export const LABEL = 'com.pablo.alfred.standby';
const LOG_LIMIT = 128 * 1024;

type Event = { type: 'ready' | 'listening' | 'idle' | 'clap' | 'error'; status?: string; detail?: string; message?: string };
export type Launchctl = (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
type Runner = typeof runProcess;
export type StandbyPaths = ReturnType<typeof servicePaths>;
export type StandbyState = { status: string; detail: string; updatedAt: string; lastAlertAt?: string };
export type StandbyRunOptions = { helper?: string; maxCycles?: number; cue?: () => Promise<void>; runner?: Runner; signal?: AbortSignal };
export function servicePaths(home = stateDirectory()) {
  const standby = join(home, 'standby');
  const launchAgents = process.env.ALFRED_LAUNCH_AGENTS_HOME || join(homedir(), 'Library', 'LaunchAgents');
  return { home, standby, state: join(standby, 'state.json'), log: join(standby, 'standby.log'), plist: join(launchAgents, `${LABEL}.plist`) };
}
export function buildPlist(input: { node: string; script: string; alfredHome: string; workingDirectory: string }): string {
  const args = [input.node, input.script];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${escapeXml(arg)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key><dict><key>ALFRED_HOME</key><string>${escapeXml(input.alfredHome)}</string></dict>
  <key>WorkingDirectory</key><string>${escapeXml(input.workingDirectory)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}
export async function writeBlockedState(paths: StandbyPaths, detail: string): Promise<void> { await writeState(paths, 'blocked', detail); }
export async function serviceStatus(options: { paths?: StandbyPaths; launchctl?: Launchctl } = {}) {
  const paths = options.paths ?? servicePaths();
  const launchctl = options.launchctl ?? defaultLaunchctl;
  const launch = await launchctl('/bin/launchctl', ['print', `${domain()}/${LABEL}`]).catch((error) => ({ code: 1, stdout: '', stderr: String(error) }));
  const state = await readState(paths);
  const loaded = launch.code === 0;
  const pid = parseLaunchdPid(launch.stdout);
  const running = pid !== undefined && processIsRunning(pid);
  return { loaded, running, pid, state, detail: state?.detail || launch.stderr || (running ? `running pid ${pid}` : loaded ? 'loaded' : 'not loaded') };
}
export async function installService(options: { paths?: StandbyPaths } = {}): Promise<StandbyPaths> {
  const paths = options.paths ?? servicePaths();
  await ensurePrivate(paths);
  await mkdir(dirname(paths.plist), { recursive: true });
  await writeFile(paths.plist, buildPlist({ node: process.execPath, script: standbyScript(), alfredHome: paths.home, workingDirectory: projectRoot() }), 'utf8');
  await chmod(paths.plist, 0o600);
  await writeState(paths, 'installed', 'LaunchAgent installed.');
  return paths;
}

export async function startService(options: { paths?: StandbyPaths; launchctl?: Launchctl } = {}) {
  const paths = await installService({ paths: options.paths });
  let ready = await clapStatus(paths);
  if (!ready.ok && ready.detail.includes('notDetermined')) ready = await clapAuthorize(paths);
  if (!ready.ok) return serviceStatus({ paths, launchctl: options.launchctl });
  const launchctl = options.launchctl ?? defaultLaunchctl;
  await launchctl('/bin/launchctl', ['bootout', serviceTarget()]).catch(() => ({ code: 0, stdout: '', stderr: '' }));
  const boot = await launchctl('/bin/launchctl', ['bootstrap', domain(), paths.plist]);
  if (boot.code !== 0) throw new Error(boot.stderr || 'launchctl bootstrap failed');
  await writeState(paths, 'starting', 'LaunchAgent loaded; waiting for launchd to run clap standby.');
  return serviceStatus({ paths, launchctl });
}

export async function stopService(options: { paths?: StandbyPaths; launchctl?: Launchctl } = {}): Promise<void> {
  const paths = options.paths ?? servicePaths();
  const launchctl = options.launchctl ?? defaultLaunchctl;
  await launchctl('/bin/launchctl', ['bootout', serviceTarget()]).catch(() => ({ code: 0, stdout: '', stderr: '' }));
  const status = await serviceStatus({ paths, launchctl });
  await writeState(paths, 'stopped', status.running ? `LaunchAgent stop requested; pid ${status.pid} is still running.` : 'LaunchAgent stopped.');
}

export async function runStandby(paths = servicePaths(), options: StandbyRunOptions = {}): Promise<number> {
  await ensurePrivate(paths);
  const helper = options.helper ?? await helperPath();
  const runner = options.runner ?? runProcess;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    let ready = await clapStatus(paths, helper, runner);
    if (!ready.ok && ready.detail.includes('notDetermined')) ready = await clapAuthorize(paths, helper, runner, controller.signal);
    if (!ready.ok) { await alert(paths, `Alfred standby blocked: ${ready.detail}`); return 0; }
    await writeState(paths, 'running', 'Waiting for deliberate double clap. Speech recognition is not used by standby.');
    let cycles = 0;
    while (!controller.signal.aborted && (options.maxCycles === undefined || cycles < options.maxCycles)) {
      cycles += 1;
      try {
        const heard = await runClapWatch(paths, helper, runner, controller.signal);
        if (heard) { await (options.cue ?? playCue)(); await writeState(paths, 'running', 'Double clap heard; re-arming clap standby.'); }
        else await writeState(paths, 'running', 'No double clap heard; re-arming clap standby.');
      } catch (error) {
        if (controller.signal.aborted) break;
        const detail = error instanceof Error ? error.message : String(error);
        await writeState(paths, 'blocked', detail);
        await alert(paths, `Alfred standby blocked: ${detail}`);
        return 0;
      }
    }
    await writeState(paths, 'stopped', 'Standby stopped.');
    return 0;
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    options.signal?.removeEventListener('abort', stop);
  }
}

async function clapAuthorize(paths: StandbyPaths, helper: string | undefined = undefined, runner: Runner = runProcess, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
  const resolvedHelper = helper ?? await helperPath();
  try {
    const result = await runner(resolvedHelper, ['clap-authorize'], { timeoutMs: 75_000, signal });
    await appendLog(paths, result.stdout + result.stderr);
    const event = parseEvents(result.stdout).find((item) => item.type === 'ready' || item.type === 'error');
    const detail = event?.message || event?.detail || result.stderr || 'microphone authorized for clap standby';
    if (result.code === 0 && event?.type !== 'error') return { ok: true, detail };
    await writeBlockedState(paths, detail);
    return { ok: false, detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await writeBlockedState(paths, detail);
    return { ok: false, detail };
  }
}

async function clapStatus(paths: StandbyPaths, helper: string | undefined = undefined, runner: Runner = runProcess): Promise<{ ok: boolean; detail: string }> {
  try {
    const resolvedHelper = helper ?? await helperPath();
    const result = await runner(resolvedHelper, ['clap-doctor'], { timeoutMs: 10_000 });
    await appendLog(paths, result.stdout + result.stderr);
    const event = parseEvents(result.stdout).find((item) => item.type === 'ready' || item.type === 'error');
    const detail = event?.message || event?.detail || result.stderr || 'clap detector ready';
    if (result.code === 0 && event?.type !== 'error') return { ok: true, detail };
    await writeBlockedState(paths, detail);
    return { ok: false, detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await writeBlockedState(paths, detail);
    return { ok: false, detail };
  }
}

async function runClapWatch(paths: StandbyPaths, helper: string, runner: Runner, signal?: AbortSignal): Promise<boolean> {
  const result = await runner(helper, ['clap-watch'], { timeoutMs: 130_000, signal });
  await appendLog(paths, result.stdout + result.stderr);
  const events = parseEvents(result.stdout);
  const error = events.find((item) => item.type === 'error');
  if (error) throw new Error(error.message || error.detail || 'clap watch failed');
  if (result.code !== 0) throw new Error(result.stderr || `clap watch exited with code ${result.code}`);
  return events.some((item) => item.type === 'clap');
}

async function helperPath(): Promise<string> {
  const candidates = process.env.ALFRED_VOICE_HELPER ? [process.env.ALFRED_VOICE_HELPER] : [join(projectRoot(), 'dist/AlfredVoice.app/Contents/MacOS/AlfredVoice')];
  for (const candidate of candidates) { try { await access(candidate, fsConstants.X_OK); return candidate; } catch {} }
  throw new Error(`Alfred clap helper not found. Checked: ${candidates.join(', ')}`);
}

async function ensurePrivate(paths: StandbyPaths): Promise<void> { await mkdir(paths.standby, { recursive: true, mode: 0o700 }); await chmod(paths.standby, 0o700); }
async function writeState(paths: StandbyPaths, status: string, detail: string): Promise<void> { await ensurePrivate(paths); await writeFile(paths.state, JSON.stringify({ status, detail, updatedAt: new Date().toISOString() }) + '\n', { mode: 0o600 }); }
async function readState(paths: StandbyPaths): Promise<StandbyState | undefined> { try { return JSON.parse(await readFile(paths.state, 'utf8')) as StandbyState; } catch { return undefined; } }
async function appendLog(paths: StandbyPaths, chunk: string): Promise<void> {
  if (!chunk) return;
  await ensurePrivate(paths);
  await appendFile(paths.log, chunk, { mode: 0o600 });
  if ((await stat(paths.log)).size > LOG_LIMIT) await writeFile(paths.log, (await readFile(paths.log, 'utf8')).slice(-LOG_LIMIT), { mode: 0o600 });
}
async function alert(paths: StandbyPaths, message: string): Promise<void> {
  const state = await readState(paths);
  const last = state?.lastAlertAt ? Date.parse(state.lastAlertAt) : 0;
  if (Date.now() - last < 30 * 60_000) return;
  await runProcess('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(message)} with title "Alfred"`], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  if (state) await writeFile(paths.state, JSON.stringify({ ...state, lastAlertAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
}
async function playCue(): Promise<void> { await runProcess('/usr/bin/afplay', ['/System/Library/Sounds/Ping.aiff'], { timeoutMs: 3_000 }).catch(() => ({ code: 1, stdout: '', stderr: '' })); }
function parseEvents(output: string): Event[] { return output.split('\n').flatMap((line) => { try { return line.trim() ? [JSON.parse(line) as Event] : []; } catch { return []; } }); }
function domain(): string { return `gui/${process.getuid?.() ?? 0}`; }
function serviceTarget(): string { return `${domain()}/${LABEL}`; }
function projectRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), '..'); }
function standbyScript(): string { return join(projectRoot(), 'dist/standby.js'); }
function parseLaunchdPid(output: string): number | undefined { const match = output.match(/\bpid\s*=\s*(\d+)/); return match ? Number(match[1]) : undefined; }
function processIsRunning(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function defaultLaunchctl(command: string, args: string[]) { return runProcess(command, args, { timeoutMs: 10_000 }); }
function escapeXml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runStandby().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
