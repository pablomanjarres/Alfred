import { spawn } from 'node:child_process';

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

export async function runProcess(binary: string, args: string[], options: ProcessOptions): Promise<{stdout: string; stderr: string; code: number}> {
  if (options.signal?.aborted) throw new Error('Request cancelled.');
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd, env: options.env, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', pending = '', failure = '';
    let killTimer: NodeJS.Timeout | undefined;
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
      killTimer = setTimeout(() => kill('SIGKILL'), 1500);
      killTimer.unref();
    };
    const abort = () => stop('Request cancelled.');
    const timer = setTimeout(() => stop(`Process timed out after ${options.timeoutMs} ms.`), options.timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      // Kill any subprocesses that outlived a cancelled group leader.
      if (failure) kill('SIGKILL');
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-131072);
      pending += chunk;
      if (pending.length > 2_000_000) { stop('Process emitted an oversized event.'); return; }
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      try { for (const line of lines) options.onLine?.(line); }
      catch (error) { stop(String(error)); }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16384); });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') stop(error.message); });
    child.on('error', (error) => { cleanup(); reject(new Error(`Could not start ${binary}: ${error.message}`)); });
    child.on('close', (code, signal) => {
      cleanup();
      if (failure) { reject(new Error(failure)); return; }
      try { if (pending) options.onLine?.(pending); }
      catch (error) { reject(error); return; }
      resolve({ stdout, stderr, code: code ?? (signal ? 1 : 0) });
    });
    child.stdin.end(options.input ?? '');
  });
}
