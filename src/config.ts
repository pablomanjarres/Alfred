import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  codex: string;
  cwd: string;
  permission: 'full' | 'workspace' | 'read-only';
  timeoutMs: number;
  model?: string;
  locale: string;
  speak: boolean;
}

export function stateDirectory(): string {
  return resolve(process.env.ALFRED_HOME || join(homedir(), '.alfred'));
}

export function parseConfig(input: unknown, home = homedir()): Config {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be an object.');
  const raw = input as Record<string, unknown>;
  const allowed = ['codex', 'cwd', 'permission', 'timeoutMs', 'model', 'locale', 'speak'];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new Error(`Unknown config field: ${key}`);
  for (const key of ['codex', 'cwd', 'model', 'locale']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !(raw[key] as string).trim())) {
      throw new Error(`${key} must be a non-empty string.`);
    }
  }
  if (raw.permission !== undefined && !['full', 'workspace', 'read-only'].includes(String(raw.permission))) {
    throw new Error('permission must be full, workspace, or read-only.');
  }
  if (raw.timeoutMs !== undefined && (!Number.isSafeInteger(raw.timeoutMs) || Number(raw.timeoutMs) < 1000 || Number(raw.timeoutMs) > 3_600_000)) {
    throw new Error('timeoutMs must be an integer between 1000 and 3600000.');
  }
  if (raw.speak !== undefined && typeof raw.speak !== 'boolean') throw new Error('speak must be true or false.');
  const expand = (path: string) => path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
  return {
    codex: expand(String(raw.codex ?? 'codex')),
    cwd: resolve(expand(String(raw.cwd ?? process.cwd()))),
    permission: (raw.permission ?? 'full') as Config['permission'],
    timeoutMs: Number(raw.timeoutMs ?? 600_000),
    model: raw.model as string | undefined,
    locale: String(raw.locale ?? 'en-US'),
    speak: Boolean(raw.speak ?? false),
  };
}

export async function loadConfig(overrides: Partial<Config> = {}): Promise<Config> {
  let raw: unknown = {};
  try { raw = JSON.parse(await readFile(join(stateDirectory(), 'config.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const config = parseConfig(raw);
  return parseConfig({ ...config, ...overrides });
}
