import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodexResult } from './codex.js';

export interface Receipt extends Partial<CodexResult> {
  id: string; order: string; cwd: string; startedAt: string; finishedAt: string;
  status: 'completed' | 'failed' | 'cancelled'; error?: string;
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await stat(path);
  if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) {
    throw new Error(`Alfred state directory must belong to you and be private (mode 700): ${path}`);
  }
}

export async function withLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
  await privateDirectory(dir);
  const path = join(dir, 'active.lock');
  let lock;
  try { lock = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(`Alfred is already handling an order, or a previous process stopped unexpectedly. Check ${path} before removing a stale lock.`);
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await work();
  } finally { await lock.close(); await rm(path, { force: true }); }
}

export async function saveReceipt(dir: string, receipt: Receipt): Promise<void> {
  if (!/^[a-zA-Z0-9-]+$/.test(receipt.id)) throw new Error('Invalid receipt ID.');
  const folder = join(dir, 'history');
  await privateDirectory(folder);
  const path = join(folder, `${receipt.id}.json`);
  const temp = `${path}.${process.pid}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(receipt, null, 2) + '\n'); }
  finally { await file.close(); }
  await rename(temp, path);
}

export async function receipts(dir: string, limit = 10): Promise<Receipt[]> {
  let files: string[];
  try { files = await readdir(join(dir, 'history')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const rows = await Promise.all(files.filter((name) => /^[a-zA-Z0-9-]+\.json$/.test(name))
    .map(async (name) => JSON.parse(await readFile(join(dir, 'history', name), 'utf8')) as Receipt));
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}
