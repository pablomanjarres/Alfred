import { setTimeout as delay } from 'node:timers/promises';
import { runProcess } from './process.js';
import { cueOutput, type CueOutput } from './config.js';
import { helperPath, servicePaths, serviceStatus as defaultServiceStatus, startService as defaultStartService, stopService as defaultStopService, type Launchctl, type StandbyPaths } from './standby.js';

type Runner = typeof runProcess;
type Status = { running: boolean; pid?: number };
type CueEvent = { type?: string; status?: string; message?: unknown; detail?: unknown };

export interface CueDiagnostics {
  mode: CueOutput;
  device?: string;
  deviceVolume?: number;
  deviceMuted?: boolean;
  peakDb?: number;
  elapsedMs?: number;
  output?: string;
  detail?: unknown;
}

export interface CueTestOptions {
  mode?: CueOutput;
  helper?: string;
  paths?: StandbyPaths;
  launchctl?: Launchctl;
  runner?: Runner;
  signal?: AbortSignal;
  serviceStatus?: () => Promise<Status>;
  stopService?: () => Promise<void>;
  startService?: () => Promise<unknown>;
  waitStopped?: () => Promise<void>;
  waitTimeoutMs?: number;
  pollMs?: number;
  processIsAlive?: (pid: number) => boolean;
}

export async function testCue(options: CueTestOptions = {}): Promise<CueDiagnostics> {
  const paths = options.paths ?? servicePaths();
  const mode = options.mode ?? await cueOutput(paths.home);
  const helper = options.helper ?? await helperPath();
  const runner = options.runner ?? runProcess;
  const getStatus = options.serviceStatus ?? (() => defaultServiceStatus({ paths, launchctl: options.launchctl }));
  const status = await getStatus();
  const wasRunning = status.running;
  let shouldRestore = false;
  try {
    if (wasRunning) {
      try {
        await (options.stopService ?? (() => defaultStopService({ paths, launchctl: options.launchctl })))();
        shouldRestore = true;
        await (options.waitStopped ?? (() => waitForStopped({ paths, launchctl: options.launchctl, signal: options.signal, status: getStatus, originalPid: status.pid, processIsAlive: options.processIsAlive, timeoutMs: options.waitTimeoutMs, pollMs: options.pollMs })))();
      } catch (error) {
        if (!shouldRestore && !await isRunning(getStatus)) shouldRestore = true;
        throw error;
      }
    }
    const result = await runner(helper, ['wake-cue', '--cue-output', mode], { timeoutMs: 10_000, signal: options.signal });
    const events = parseEvents(result.stdout);
    const error = events.find((event) => event.type === 'error');
    if (error) throw new Error(String(error.message ?? error.detail ?? 'wake cue failed'));
    if (result.code !== 0) throw new Error(result.stderr || `wake cue exited with code ${result.code}`);
    const played = events.find((event) => event.type === 'cue' && event.status === 'played');
    if (!played) throw new Error('wake cue did not report a played cue event.');
    return cueDiagnostics(mode, played);
  } finally {
    if (wasRunning && shouldRestore) await (options.startService ?? (() => defaultStartService({ paths, launchctl: options.launchctl })))();
  }
}

async function isRunning(status: () => Promise<Status>): Promise<boolean> {
  try { return (await status()).running; } catch { return false; }
}

async function waitForStopped(options: { paths: StandbyPaths; launchctl?: Launchctl; signal?: AbortSignal; status?: () => Promise<Status>; originalPid?: number; processIsAlive?: (pid: number) => boolean; timeoutMs?: number; pollMs?: number }): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  const status = options.status ?? (() => defaultServiceStatus({ paths: options.paths, launchctl: options.launchctl }));
  const processIsAlive = options.processIsAlive ?? isProcessAlive;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    const current = await status();
    const oldProcessGone = options.originalPid === undefined || !processIsAlive(options.originalPid);
    if (!current.running && oldProcessGone) return;
    await delay(options.pollMs ?? 100, undefined, { signal: options.signal });
  }
  const suffix = options.originalPid === undefined ? '' : ` and pid ${options.originalPid} to exit`;
  throw new Error(`Timed out waiting for Alfred standby to stop${suffix} before cue test.`);
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function cueDiagnostics(mode: CueOutput, event: CueEvent): CueDiagnostics {
  const detail = event.detail;
  const diagnostics: CueDiagnostics = { mode, detail };
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const record = detail as Record<string, unknown>;
    if (typeof record.device === 'string' && record.device.trim()) diagnostics.device = record.device;
    if (typeof record.deviceVolume === 'number' && Number.isFinite(record.deviceVolume)) diagnostics.deviceVolume = record.deviceVolume;
    if (typeof record.deviceMuted === 'boolean') diagnostics.deviceMuted = record.deviceMuted;
    if (typeof record.peakDb === 'number' && Number.isFinite(record.peakDb)) diagnostics.peakDb = record.peakDb;
    if (typeof record.elapsedMs === 'number' && Number.isFinite(record.elapsedMs)) diagnostics.elapsedMs = record.elapsedMs;
    if (typeof record.output === 'string' && record.output.trim()) diagnostics.output = record.output;
  }
  return diagnostics;
}


export function cueSummary(cue: CueDiagnostics): string {
  const device = cue.device ?? 'unknown output device';
  const volume = cue.deviceVolume === undefined ? 'unknown volume' : `${Math.round(cue.deviceVolume <= 1 ? cue.deviceVolume * 100 : cue.deviceVolume)}%`;
  const muted = cue.deviceMuted === undefined ? '' : cue.deviceMuted ? ', muted' : ', unmuted';
  const elapsed = cue.elapsedMs === undefined ? '' : `, ${Math.round(cue.elapsedMs)} ms`;
  const output = cue.output ? `, ${cue.output}` : '';
  return `${device}, ${volume}${muted}${elapsed}${output}`;
}

function parseEvents(output: string): CueEvent[] {
  return output.split('\n').flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line) as CueEvent] : []; } catch { return []; }
  });
}
