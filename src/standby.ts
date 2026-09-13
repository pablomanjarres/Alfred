import { setTimeout as delay } from 'node:timers/promises';
import { constants as fsConstants } from 'node:fs';
import { access, appendFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { runProcess } from './process.js';
import { cueOutput, stateDirectory } from './config.js';

export const LABEL = 'com.pablo.alfred.standby';
const LOG_LIMIT = 128 * 1024;
const WAKE_WATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const AUDIO_INTERRUPTION = 'microphone stopped delivering audio; wake buffers cleared';
const AUDIO_INTERRUPTION_RETRIES = 2;

type Event = { type: 'ready' | 'listening' | 'idle' | 'clap' | 'wake' | 'paused' | 'cue' | 'error'; status?: string; detail?: unknown; message?: string };
export type Launchctl = (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
type Runner = typeof runProcess;
export type StandbyPaths = ReturnType<typeof servicePaths>;
export type StandbyState = { status: string; detail: string; updatedAt: string; lastAlertAt?: string };
export type StandbyRunOptions = { helper?: string; maxCycles?: number; cue?: () => Promise<void>; runner?: Runner; signal?: AbortSignal; recoveryBackoffMs?: number };
export type ReadinessOptions = { paths?: StandbyPaths; helper?: string; runner?: Runner; signal?: AbortSignal; updateState?: boolean };
export function servicePaths(home = stateDirectory()) {
  const standby = join(home, 'standby');
  const launchAgents = process.env.ALFRED_LAUNCH_AGENTS_HOME || join(homedir(), 'Library', 'LaunchAgents');
  return { home, standby, state: join(standby, 'state.json'), log: join(standby, 'standby.log'), plist: join(launchAgents, `${LABEL}.plist`) };
}
export function buildPlist(input: { node: string; script: string; alfredHome: string; workingDirectory: string; alfredVoiceHelper?: string }): string {
  const args = [input.node, input.script];
  const env = [["ALFRED_HOME", input.alfredHome], ...(input.alfredVoiceHelper ? [["ALFRED_VOICE_HELPER", input.alfredVoiceHelper]] : [])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${escapeXml(arg)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key><dict>${env.map(([key, value]) => `<key>${key}</key><string>${escapeXml(value)}</string>`).join('')}</dict>
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
  return { loaded, running, pid, state, cueOutput: await cueOutput(paths.home), detail: state?.detail || launch.stderr || (running ? `running pid ${pid}` : loaded ? 'loaded' : 'not loaded') };
}
export async function installService(options: { paths?: StandbyPaths } = {}): Promise<StandbyPaths> {
  const paths = options.paths ?? servicePaths();
  await ensurePrivate(paths);
  await mkdir(dirname(paths.plist), { recursive: true });
  await writeFile(paths.plist, buildPlist({ node: process.execPath, script: standbyScript(), alfredHome: paths.home, workingDirectory: projectRoot(), alfredVoiceHelper: process.env.ALFRED_VOICE_HELPER }), 'utf8');
  await chmod(paths.plist, 0o600);
  await writeState(paths, 'installed', 'LaunchAgent installed.');
  return paths;
}

export async function startService(options: { paths?: StandbyPaths; launchctl?: Launchctl; helper?: string; runner?: Runner; signal?: AbortSignal } = {}) {
  const paths = await installService({ paths: options.paths });
  const helper = options.helper ?? await helperPath();
  const runner = options.runner ?? runProcess;
  await ensureMicrophoneReady({ paths, helper, runner, signal: options.signal, updateState: true });
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
  if (options.signal?.aborted) stop();
  try {
    if (controller.signal.aborted) { await writeState(paths, 'stopped', 'Standby stopped.'); return 0; }
    let ready = await microphoneReadiness({ paths, helper, runner, signal: controller.signal, updateState: true });
    if (!ready.ok) { await alert(paths, `Alfred standby blocked: ${ready.detail}`); return 0; }
    let cycles = 0;
    let scheduleCueNext = false;
    while (!controller.signal.aborted && (options.maxCycles === undefined || cycles < options.maxCycles)) {
      cycles += 1;
      try {
        await writeState(paths, 'starting', 'Preparing local clap and Alfred wake detection.');
        const output = await cueOutput(paths.home);
        const trigger = await runWakeWatchWithRetry(paths, helper, runner, controller.signal, options.cue ? false : scheduleCueNext, output, options.recoveryBackoffMs ?? 1000);
        scheduleCueNext = false;
        if (trigger) {
          await writeState(paths, 'starting', `${trigger} heard; microphone stopped for the cue.`);
          if (options.cue) {
            try {
              await options.cue();
              await logEvent(paths, { type: 'cue', status: 'played', detail: 'custom cue completed' });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              await logEvent(paths, { type: 'cue', status: 'failed', detail });
              throw new Error(`cue failed: ${detail}`);
            }
          } else {
            scheduleCueNext = true;
          }
        }
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

export async function ensureMicrophoneReady(options: ReadinessOptions = {}): Promise<{ detail: string }> {
  const ready = await microphoneReadiness(options);
  if (!ready.ok) throw new Error(ready.detail);
  return { detail: ready.detail };
}

async function microphoneReadiness(options: ReadinessOptions = {}): Promise<{ ok: boolean; detail: string }> {
  const paths = options.paths ?? servicePaths();
  const helper = options.helper ?? await helperPath();
  const runner = options.runner ?? runProcess;
  let ready = await clapStatus(paths, helper, runner, options.signal, options.updateState !== false);
  if (!ready.ok && ready.detail.includes('notDetermined')) ready = await clapAuthorize(paths, helper, runner, options.signal, options.updateState !== false);
  return ready;
}

async function clapAuthorize(paths: StandbyPaths, helper: string | undefined = undefined, runner: Runner = runProcess, signal?: AbortSignal, updateState = true): Promise<{ ok: boolean; detail: string }> {
  const resolvedHelper = helper ?? await helperPath();
  try {
    const result = await runner(resolvedHelper, ['clap-authorize'], { timeoutMs: 75_000, signal });
    await appendLog(paths, result.stdout + result.stderr);
    const event = parseEvents(result.stdout).find((item) => item.type === 'ready' || item.type === 'error');
    if (result.code === 0 && event?.type === 'ready') return { ok: true, detail: detailText(event.message ?? event.detail ?? 'microphone authorized for clap standby') };
    const detail = readinessFailure('clap-authorize', result, event);
    if (updateState) await writeBlockedState(paths, detail);
    return { ok: false, detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (updateState) await writeBlockedState(paths, detail);
    return { ok: false, detail };
  }
}

async function clapStatus(paths: StandbyPaths, helper: string | undefined = undefined, runner: Runner = runProcess, signal?: AbortSignal, updateState = true): Promise<{ ok: boolean; detail: string }> {
  try {
    const resolvedHelper = helper ?? await helperPath();
    const result = await runner(resolvedHelper, ['clap-doctor'], { timeoutMs: 10_000, signal });
    await appendLog(paths, result.stdout + result.stderr);
    const event = parseEvents(result.stdout).find((item) => item.type === 'ready' || item.type === 'error');
    if (result.code === 0 && event?.type === 'ready') return { ok: true, detail: detailText(event.message ?? event.detail ?? 'clap detector ready') };
    const detail = readinessFailure('clap-doctor', result, event);
    if (updateState) await writeBlockedState(paths, detail);
    return { ok: false, detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (updateState) await writeBlockedState(paths, detail);
    return { ok: false, detail };
  }
}

function readinessFailure(command: string, result: { code: number; stdout: string; stderr: string }, event: Event | undefined): string {
  const detail = detailText(event?.message ?? event?.detail ?? result.stderr);
  if (detail) return detail;
  if (result.code !== 0) return `${command} exited with code ${result.code}.`;
  return `${command} did not report ready.`;
}

async function runWakeWatchWithRetry(paths: StandbyPaths, helper: string, runner: Runner, signal?: AbortSignal, playCue = false, output = 'current', recoveryBackoffMs = 1000): Promise<string | undefined> {
  let timeoutRetried = false;
  let audioRetries = 0;
  for (;;) {
    try {
      return await runWakeWatch(paths, helper, runner, signal, playCue, output);
    } catch (error) {
      if (audioInterruption(error) && audioRetries < AUDIO_INTERRUPTION_RETRIES) {
        audioRetries += 1;
        await writeState(paths, 'starting', `Microphone input paused; recovering wake detector (${audioRetries}/${AUDIO_INTERRUPTION_RETRIES}).`);
        await delay(recoveryBackoffMs, undefined, { signal });
        continue;
      }
      if (sleepTimeout(error) && !timeoutRetried) {
        timeoutRetried = true;
        await writeState(paths, 'starting', 'Wake watch timed out after 24 hours; retrying once.');
        continue;
      }
      throw error;
    }
  }
}

async function runWakeWatch(paths: StandbyPaths, helper: string, runner: Runner, signal?: AbortSignal, playCue = false, output = 'current'): Promise<string | undefined> {
  let updates = Promise.resolve();
  let updateError: unknown;
  const handled = new Set<string>();
  let result: Awaited<ReturnType<Runner>>;
  try {
    result = await runner(helper, ['wake-watch', ...(playCue ? ['--cue'] : []), '--cue-output', output], {
      timeoutMs: WAKE_WATCH_TIMEOUT_MS, signal,
      onLine: (line) => {
        const trimmed = line.trim();
        const event = parseEvents(line)[0];
        if (!event) return;
        handled.add(trimmed);
        updates = updates.then(() => logHelperEvent(paths, event)).catch((error) => { updateError = error; });
      },
    });
  } finally { await updates; }
  if (updateError) throw updateError;
  const events = parseEvents(result.stdout);
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    const event = parseEvents(line)[0];
    if (event && !handled.has(trimmed)) await logHelperEvent(paths, event);
  }
  const error = events.find((item) => item.type === 'error');
  if (error) throw new Error(detailText(error.message ?? error.detail ?? 'wake watch failed'));
  if (result.code !== 0) throw new Error(result.stderr || `wake watch exited with code ${result.code}`);
  const unhandled = result.stdout.split('\n').filter((line) => line.trim() && !parseEvents(line)[0]).join('\n');
  await appendLog(paths, (unhandled ? `${unhandled}\n` : '') + result.stderr);
  const wake = events.find((item) => item.type === 'wake');
  return wake ? wake.status || 'wake' : undefined;
}

export async function helperPath(): Promise<string> {
  const candidates = process.env.ALFRED_VOICE_HELPER ? [process.env.ALFRED_VOICE_HELPER] : [join(projectRoot(), 'dist/AlfredVoice.app/Contents/MacOS/AlfredVoice')];
  for (const candidate of candidates) { try { await access(candidate, fsConstants.X_OK); return candidate; } catch {} }
  throw new Error(`Alfred voice helper not found. Checked: ${candidates.join(', ')}`);
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
async function logEvent(paths: StandbyPaths, event: { type: string; status?: string; detail?: string }): Promise<void> {
  await appendLog(paths, JSON.stringify({ ...event, at: new Date().toISOString() }) + '\n');
}
async function logHelperEvent(paths: StandbyPaths, event: Event): Promise<void> {
  const detail = detailText(event.detail ?? event.message);
  if (event.type === 'ready') await writeState(paths, 'running', detail);
  else if (event.type === 'paused') await writeState(paths, 'paused', detail);
  if (event.type === 'ready' || event.type === 'paused' || event.type === 'cue' || event.type === 'wake' || event.type === 'idle' || event.type === 'error') {
    await logEvent(paths, { type: event.type, status: event.status ?? event.type, detail });
  }
}
async function alert(paths: StandbyPaths, message: string): Promise<void> {
  const state = await readState(paths);
  const last = state?.lastAlertAt ? Date.parse(state.lastAlertAt) : 0;
  if (Date.now() - last < 30 * 60_000) return;
  await runProcess('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(message)} with title "Alfred"`], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  if (state) await writeFile(paths.state, JSON.stringify({ ...state, lastAlertAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
}
function detailText(value: unknown): string { return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value); }
function sleepTimeout(error: unknown): boolean { return error instanceof Error && /timed out after 86400000 ms|timeout/i.test(error.message); }
function audioInterruption(error: unknown): boolean { return error instanceof Error && error.message === AUDIO_INTERRUPTION; }
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
