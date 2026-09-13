import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
export type TranscribeOptions = {
  mode: 'listen' | 'clap' | 'file';
  file?: string;
  locale?: string;
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
};
export type VoiceStatus = { available: boolean; detail: string };
type HelperEvent =
  | { type: 'ready' | 'listening'; status?: string; detail?: string }
  | { type: 'transcript'; text?: string }
  | { type: 'error'; message?: string; detail?: string };
type ChildResult = { code: number; stderr: string };
const KILL_GRACE_MS = 1_500;
export async function transcribe(options: TranscribeOptions): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('Alfred voice requires macOS Speech and AVAudioEngine.');
  }
  if (options.mode === 'file' && !options.file) {
    throw new Error('transcribe file mode requires a file path.');
  }

  const helper = await findHelper();
  const args: string[] = [options.mode];
  if (options.locale) args.push('--locale', options.locale);
  if (options.file) args.push('--file', options.file);

  return runHelperForTranscript(helper, args, options);
}
export async function speak(text: string, signal?: AbortSignal): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Alfred speech output requires macOS say.');
  }
  if (signal?.aborted) throw new Error('speech aborted');

  const say = process.env.ALFRED_SAY_BINARY ?? '/usr/bin/say';
  const result = await runChild(say, ['-f', '-'], {
    input: text,
    signal,
    timeoutMs: envMs('ALFRED_SAY_TIMEOUT_MS', 30_000),
  });
  if (result.code !== 0) throw new Error(result.stderr || `say exited with code ${result.code}`);
}
export async function voiceStatus(): Promise<VoiceStatus> {
  if (process.platform !== 'darwin') {
    return { available: false, detail: 'Alfred voice requires macOS.' };
  }

  let helper: string;
  try {
    helper = await findHelper();
  } catch (error) {
    return { available: false, detail: errorMessage(error) };
  }
  try {
    const detail = await runHelperForStatus(helper, ['doctor']);
    return { available: true, detail };
  } catch (error) {
    return { available: false, detail: errorMessage(error) };
  }
}
async function findHelper(): Promise<string> {
  const candidates = helperCandidates();
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`Alfred voice helper not found. Checked: ${candidates.join(', ')}`);
}
function helperCandidates(): string[] {
  if (process.env.ALFRED_VOICE_HELPER) {
    return [process.env.ALFRED_VOICE_HELPER];
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [resolve(here), resolve(here, '..'), resolve(here, '..', '..'), process.cwd()];
  const relative = [
    'dist/AlfredVoice.app/Contents/MacOS/AlfredVoice',
    'native/.build/release/AlfredVoice',
    'native/.build/debug/AlfredVoice',
  ];

  return [...new Set(roots.flatMap((root) => relative.map((item) => join(root, item))))];
}
async function runHelperForTranscript(
  helper: string,
  args: string[],
  options: Pick<TranscribeOptions, 'signal' | 'onStatus'>,
): Promise<string> {
  let transcript: string | undefined;
  let helperError: string | undefined;
  const result = await runChild(helper, args, {
    signal: options.signal,
    timeoutMs: envMs('ALFRED_VOICE_TIMEOUT_MS', args[0] === 'clap' ? 180_000 : 45_000),
    transcriptCloseMs: envMs('ALFRED_VOICE_TRANSCRIPT_CLOSE_MS', 750),
    onLine: (line, child) => {
      const event = JSON.parse(line) as HelperEvent;
      if (event.type === 'ready' || event.type === 'listening') options.onStatus?.(event.status ?? event.type);
      else if (event.type === 'transcript' && event.text !== undefined) {
        transcript = event.text;
        child.closeAfterTranscript();
      } else if (event.type === 'error') helperError = event.message ?? event.detail ?? 'voice helper error';
    },
  });
  if (helperError) throw new Error(helperError);
  if (transcript !== undefined) return transcript;
  if (result.code !== 0) throw new Error(result.stderr || `voice helper exited with code ${result.code}`);
  throw new Error('voice helper exited without a transcript');
}
function runHelperForStatus(helper: string, args: string[]): Promise<string> {
  let detail = 'voice helper is available';
  let helperError: string | undefined;
  return runChild(helper, args, {
    timeoutMs: envMs('ALFRED_VOICE_TIMEOUT_MS', 10_000),
    onLine: (line) => {
      const event = JSON.parse(line) as HelperEvent;
      if (event.type === 'ready') detail = event.detail ?? event.status ?? detail;
      if (event.type === 'error') helperError = event.message ?? event.detail ?? detail;
    },
  }).then((result) => {
    if (helperError) throw new Error(helperError);
    if (result.code === 0) return detail;
    throw new Error(result.stderr || detail || `voice helper exited with code ${result.code}`);
  });
}
function runChild(
  binary: string,
  args: string[],
  options: { input?: string; signal?: AbortSignal; timeoutMs: number; transcriptCloseMs?: number; onLine?: (line: string, child: { closeAfterTranscript: () => void }) => void },
): Promise<ChildResult> {
  if (options.signal?.aborted) throw new Error('voice process aborted');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { detached: process.platform !== 'win32', shell: false, stdio: 'pipe' });
    let stderr = '', pending = '', failure = '', closing = false;
    let killTimer: NodeJS.Timeout | undefined, closeTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal); }
    };
    const stop = (reason: string) => {
      if (failure) return;
      failure = reason;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    };
    const closeAfterTranscript = () => {
      if (closing) return;
      closing = true;
      const grace = options.transcriptCloseMs ?? 750;
      closeTimer = setTimeout(() => kill('SIGTERM'), grace); closeTimer.unref();
      killTimer = setTimeout(() => kill('SIGKILL'), grace + KILL_GRACE_MS); killTimer.unref();
    };
    const lineControls = { closeAfterTranscript };
    const abort = () => stop('voice process aborted');
    const timeout = setTimeout(() => stop(`voice process timed out after ${options.timeoutMs} ms`), options.timeoutMs);
    timeout.unref();
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      try { pending = consumeLines(pending, (line) => options.onLine?.(line, lineControls)); }
      catch (error) { stop(errorMessage(error)); }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16_384); });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') stop(error.message); });
    child.on('error', (error) => { cleanup(); reject(new Error(`could not start ${binary}: ${error.message}`)); });
    child.on('close', (code, signal) => {
      cleanup();
      try { if (pending.trim()) options.onLine?.(pending.trim(), lineControls); }
      catch (error) { reject(error); return; }
      if (failure) reject(new Error(failure));
      else resolvePromise({ code: code ?? (signal ? 1 : 0), stderr: stderr.trim() });
    });
    child.stdin.end(options.input ?? '');
    function cleanup() {
      clearTimeout(timeout);
      if (closeTimer) clearTimeout(closeTimer); if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
    }
  });
}
function consumeLines(pending: string, onLine: (line: string) => void): string {
  for (;;) {
    const newline = pending.indexOf('\n');
    if (newline === -1) return pending;
    const line = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (line) onLine(line);
  }
}
function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? value : fallback;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
