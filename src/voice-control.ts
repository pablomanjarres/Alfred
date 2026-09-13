import { requestVoiceHandoff, type HandoffRecord, type RequestVoiceHandoffOptions } from './handoff.js';
import { servicePaths, startService, stopService, type StandbyPaths } from './standby.js';

type ServiceAction = () => Promise<unknown>;

export async function endVoice(options: {
  paths?: StandbyPaths;
  off?: boolean;
  threadId?: string;
  runner?: RequestVoiceHandoffOptions['runner'];
  signal?: AbortSignal;
  id?: () => string;
  now?: () => Date;
  ttlMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  requestHandoff?: typeof requestVoiceHandoff;
  startStandby?: ServiceAction;
  stopStandby?: ServiceAction;
} = {}): Promise<HandoffRecord> {
  const paths = options.paths ?? servicePaths();
  const requestHandoff = options.requestHandoff ?? requestVoiceHandoff;
  const stopStandbyAction = options.stopStandby ?? (() => stopService({ paths }));
  const startStandbyAction = options.startStandby ?? (() => startService({ paths, runner: options.runner, signal: options.signal }));
  if (options.off) await stopStandbyAction();
  const result = await requestHandoff({
    paths, action: 'end', threadId: options.threadId, runner: options.runner, signal: options.signal,
    id: options.id, now: options.now, ttlMs: options.ttlMs, timeoutMs: options.timeoutMs, pollMs: options.pollMs,
  });
  if (!options.off) await startStandbyAction();
  return result;
}
