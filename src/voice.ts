import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
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

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('/usr/bin/say', [text], { stdio: ['ignore', 'ignore', 'pipe'] });
    const abort = () => {
      child.kill('SIGTERM');
      reject(new Error('speech aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });

    const stderr = collectStderr(child.stderr);
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (code === 0) resolvePromise();
      else reject(new Error(stderr() || `say exited with code ${code}`));
    });
  });
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
function runHelperForTranscript(
  helper: string,
  args: string[],
  options: Pick<TranscribeOptions, 'signal' | 'onStatus'>,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const child = spawn(helper, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      if (!child.killed) child.kill('SIGTERM');
      if (error) reject(error);
      else resolvePromise(value ?? '');
    };
    const abort = () => finish(new Error('voice transcription aborted'));

    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });

    const stderr = collectStderr(child.stderr);
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (!settled && code !== 0) {
        finish(new Error(stderr() || `voice helper exited with code ${code}`));
      }
      if (!settled) finish(new Error('voice helper exited without a transcript'));
    });

    readJsonLines(child.stdout, (event) => {
      if (event.type === 'ready' || event.type === 'listening') {
        options.onStatus?.(event.status ?? event.type);
      } else if (event.type === 'transcript' && event.text !== undefined) {
        finish(null, event.text);
      } else if (event.type === 'error') {
        finish(new Error(event.message ?? event.detail ?? 'voice helper error'));
      }
    });
  });
}
function runHelperForStatus(helper: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(helper, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let detail = 'voice helper is available';
    const stderr = collectStderr(child.stderr);

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(detail);
      else reject(new Error(stderr() || detail || `voice helper exited with code ${code}`));
    });
    readJsonLines(child.stdout, (event) => {
      if (event.type === 'ready') detail = event.detail ?? event.status ?? detail;
      if (event.type === 'error') detail = event.message ?? event.detail ?? detail;
    });
  });
}
function collectStderr(stream: NodeJS.ReadableStream): () => string {
  let text = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    text += chunk;
  });
  return () => text.trim();
}
function readJsonLines(stream: NodeJS.ReadableStream, onEvent: (event: HelperEvent) => void): void {
  const decoder = new StringDecoder('utf8');
  let pending = '';

  const drain = (text: string) => {
    pending += text;
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline === -1) return;
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      onEvent(JSON.parse(line) as HelperEvent);
    }
  };

  stream.on('data', (chunk) => drain(decoder.write(chunk as Buffer)));
  stream.on('end', () => drain(decoder.end() + '\n'));
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
