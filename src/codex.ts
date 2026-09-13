import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import { runProcess } from './process.js';

export interface CodexResult { answer: string; sessionId?: string; usage?: Record<string, number> }

export function codexArgs(config: Config, answerFile: string, sessionId?: string): string[] {
  const sandbox = { full: 'danger-full-access', workspace: 'workspace-write', 'read-only': 'read-only' }[config.permission];
  const args = ['exec', ...(sessionId ? ['resume', sessionId] : []), '--json', '--skip-git-repo-check',
    '-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"',
    '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', '-o', answerFile];
  if (config.model) args.push('-m', config.model);
  return [...args, '-'];
}

export function codexEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT', 'CODEX_API_KEY']) delete env[key];
  return env;
}

export async function runCodex(prompt: string, config: Config, stateDir: string, sessionId?: string, signal?: AbortSignal): Promise<CodexResult> {
  const temp = await mkdtemp(join(stateDir, 'run-'));
  await chmod(temp, 0o700);
  const answerFile = join(temp, 'answer.txt');
  let thread = sessionId;
  let usage: Record<string, number> | undefined;
  let protocolError = '';
  try {
    const result = await runProcess(config.codex, codexArgs(config, answerFile, sessionId), {
      cwd: config.cwd, env: codexEnvironment(), input: prompt, timeoutMs: config.timeoutMs, signal,
      onLine: (line) => {
        let event: Record<string, unknown>;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') thread = event.thread_id;
        if (event.type === 'turn.completed' && event.usage && typeof event.usage === 'object') usage = event.usage as Record<string, number>;
        if (event.type === 'error' || event.type === 'turn.failed') {
          const detail = event.error as { message?: string } | undefined;
          protocolError = String(event.message || detail?.message || 'Codex could not complete this request.');
        }
      },
    });
    if (result.code !== 0) throw new Error(protocolError || result.stderr.trim() || `Codex exited with status ${result.code}.`);
    if (protocolError) throw new Error(protocolError);
    let answer = '';
    try { answer = (await readFile(answerFile, 'utf8')).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!answer) throw new Error('Codex finished without an answer.');
    return { answer, sessionId: thread, usage };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
