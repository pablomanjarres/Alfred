import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type CueOutput = 'current' | 'speakers';

export interface Config {
  codex: string;
  cwd: string;
  permission: 'full' | 'workspace' | 'read-only';
  timeoutMs: number;
  model?: string;
  locale: string;
  speak: boolean;
  cueOutput: CueOutput;
}

export function stateDirectory(): string {
  return resolve(process.env.ALFRED_HOME || join(homedir(), '.alfred'));
}

export function parseConfig(input: unknown, home = homedir()): Config {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be an object.');
  const raw = input as Record<string, unknown>;
  const allowed = ['codex', 'cwd', 'permission', 'timeoutMs', 'model', 'locale', 'speak', 'cueOutput'];
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
  if (raw.cueOutput !== undefined) parseCueOutput(raw.cueOutput);
  const expand = (path: string) => path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
  return {
    codex: expand(String(raw.codex ?? 'codex')),
    cwd: resolve(expand(String(raw.cwd ?? process.cwd()))),
    permission: (raw.permission ?? 'full') as Config['permission'],
    timeoutMs: Number(raw.timeoutMs ?? 600_000),
    model: raw.model as string | undefined,
    locale: String(raw.locale ?? 'en-US'),
    speak: Boolean(raw.speak ?? false),
    cueOutput: parseCueOutput(raw.cueOutput),
  };
}

export async function loadConfig(overrides: Partial<Config> = {}, home = stateDirectory()): Promise<Config> {
  const config = parseConfig(await readRawConfig(home));
  return parseConfig({ ...config, ...overrides });
}

export async function cueOutput(home = stateDirectory()): Promise<CueOutput> {
  const raw = await readRawConfig(home);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Config must be an object.');
  return parseCueOutput((raw as Record<string, unknown>).cueOutput);
}

export async function saveCueOutput(value: CueOutput, home = stateDirectory()): Promise<void> {
  parseCueOutput(value);
  const raw = await readRawConfig(home);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Config must be an object.');
  const configPath = join(home, 'config.json');
  const tmp = join(home, `config.json.${process.pid}.${Date.now()}.tmp`);
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(tmp, JSON.stringify({ ...(raw as Record<string, unknown>), cueOutput: value }, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, configPath);
  await chmod(configPath, 0o600);
}

async function readRawConfig(home: string): Promise<unknown> {
  try { return JSON.parse(await readFile(join(home, 'config.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return {};
}


function parseCueOutput(value: unknown): CueOutput {
  if (value === undefined) return 'current';
  if (value === 'current' || value === 'speakers') return value;
  throw new Error('cueOutput must be current or speakers.');
}
