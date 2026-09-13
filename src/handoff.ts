import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from './process.js';
import type { StandbyPaths } from './standby.js';

type Runner = typeof runProcess;
export type HandoffAction = 'start' | 'end';
export type HandoffStatus = 'pending' | 'claimed' | 'started' | 'ended' | 'blocked' | 'cancelled';
export type HandoffRecord = { id: string; status: HandoffStatus; requestedAt: string; expiresAt: string; action?: HandoffAction; threadId?: string; detail?: string };
export type RequestVoiceHandoffOptions = { paths: StandbyPaths; action?: HandoffAction; threadId?: string; runner?: Runner; signal?: AbortSignal; id?: () => string; now?: () => Date; ttlMs?: number; timeoutMs?: number; pollMs?: number };

export function handoffPath(paths: StandbyPaths): string { return join(paths.standby, 'handoff.json'); }
export function handoffCancelledPath(paths: StandbyPaths): string { return join(paths.standby, 'handoff-cancelled.json'); }

export async function requestVoiceHandoff(options: RequestVoiceHandoffOptions): Promise<HandoffRecord> {
  options.signal?.throwIfAborted();
  const runner = options.runner ?? runProcess;
  const now = options.now?.() ?? new Date();
  const id = options.id?.() ?? randomUUID();
  const action = options.action ?? 'start';
  const request: HandoffRecord = { id, status: 'pending', requestedAt: now.toISOString(), expiresAt: new Date(now.getTime() + (options.ttlMs ?? 30_000)).toISOString(), ...(options.action ? { action } : {}), ...(options.threadId ? { threadId: options.threadId } : {}) };
  await rejectActiveNewer(options.paths, request);
  await writeRecord(handoffPath(options.paths), request);
  try {
    const opened = await runner('/usr/bin/open', ['-b', 'com.pablo.alfred.menubar'], { timeoutMs: 10_000, signal: options.signal });
    if (opened.code !== 0) throw new Error(opened.stderr || `open exited with code ${opened.code}`);
    return await waitForOutcome(options.paths, id, action === 'end' ? 'ended' : 'started', options.signal, options.timeoutMs ?? 30_000, options.pollMs ?? 1000);
  } catch (error) {
    await cancelHandoff(options.paths, id);
    throw error;
  }
}

export async function claimHandoff(paths: StandbyPaths, id: string): Promise<HandoffRecord | undefined> {
  const current = await readHandoff(paths);
  if (!current || current.id !== id || current.status !== 'pending' || expired(current) || await tombstoned(paths, id)) return undefined;
  const claimed = { ...current, status: 'claimed' as const };
  await writeRecord(handoffPath(paths), claimed);
  return claimed;
}

export async function markHandoff(paths: StandbyPaths, id: string, status: 'started' | 'ended' | 'blocked', detail?: string): Promise<HandoffRecord | undefined> {
  const current = await readHandoff(paths);
  if (!current || current.id !== id || current.status === 'cancelled' || await tombstoned(paths, id)) return undefined;
  const next = { ...current, status, ...(detail ? { detail } : {}) };
  await writeRecord(handoffPath(paths), next);
  return next;
}

export async function cancelHandoff(paths: StandbyPaths, id?: string, options: { afterTombstone?: () => Promise<void> } = {}): Promise<void> {
  const current = await readHandoff(paths);
  const target = id ?? current?.id;
  if (!target) return;
  await writeRecord(handoffCancelledPath(paths), { id: target });
  await options.afterTombstone?.();
  const latest = await readHandoff(paths);
  if (latest?.id === target && (latest.status === 'pending' || latest.status === 'claimed')) {
    await writeRecord(handoffPath(paths), { ...latest, status: 'cancelled' });
  }
}

async function waitForOutcome(paths: StandbyPaths, id: string, expected: 'started' | 'ended', signal: AbortSignal | undefined, timeoutMs: number, pollMs: number): Promise<HandoffRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await tombstoned(paths, id)) throw new Error('Codex voice handoff was cancelled.');
    const current = await readHandoff(paths);
    if (current && current.id !== id) throw new Error('Codex voice handoff request was replaced.');
    if (current?.id === id) {
      if (current.status === expected) return current;
      if (current.status === 'started' || current.status === 'ended') throw new Error(`Codex voice handoff expected ${expected} but got ${current.status}.`);
      if (current.status === 'blocked') throw new Error(current.detail || 'Codex voice handoff blocked.');
      if (current.status === 'cancelled') throw new Error('Codex voice handoff was cancelled.');
      if (expired(current)) throw new Error('Codex voice handoff expired.');
    }
    await delay(pollMs, undefined, { signal });
  }
  throw new Error(`Timed out waiting for Codex voice handoff to ${expected === 'ended' ? 'end' : 'start'}.`);
}

async function rejectActiveNewer(paths: StandbyPaths, request: HandoffRecord): Promise<void> {
  const current = await readHandoff(paths);
  if (!current) return;
  if (Date.parse(current.requestedAt) > Date.parse(request.requestedAt)) throw new Error('Codex voice handoff request already pending.');
  if ((current.status === 'pending' || current.status === 'claimed') && !expired(current)) throw new Error('Codex voice handoff request already pending.');
}

async function readHandoff(paths: StandbyPaths): Promise<HandoffRecord | undefined> {
  try { return JSON.parse(await readFile(handoffPath(paths), 'utf8')) as HandoffRecord; } catch { return undefined; }
}

async function tombstoned(paths: StandbyPaths, id: string): Promise<boolean> {
  try { return (JSON.parse(await readFile(handoffCancelledPath(paths), 'utf8')) as { id?: string }).id === id; } catch { return false; }
}

async function writeRecord(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}

function expired(record: HandoffRecord): boolean { return Date.parse(record.expiresAt) <= Date.now(); }
