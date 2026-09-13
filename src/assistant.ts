import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { stateDirectory } from './config.js';
import { runCodex } from './codex.js';
import { withLock, saveReceipt, receipts, type Receipt } from './history.js';
import { orderPrompt } from './persona.js';

export async function executeOrder(order: string, config: Config, options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<Receipt> {
  const prompt = orderPrompt(order);
  const dir = stateDirectory();
  return withLock(dir, async () => {
    const previous = options.fresh ? undefined : (await receipts(dir, 100)).find((row) => row.cwd === config.cwd && row.status === 'completed' && row.sessionId);
    const receipt: Receipt = {
      id: randomUUID(), order, cwd: config.cwd, startedAt: new Date().toISOString(),
      finishedAt: '', status: 'failed',
    };
    try {
      Object.assign(receipt, await runCodex(prompt, config, dir, previous?.sessionId, options.signal));
      receipt.status = 'completed';
    } catch (error) {
      receipt.error = error instanceof Error ? error.message : String(error);
      receipt.status = options.signal?.aborted ? 'cancelled' : 'failed';
    }
    receipt.finishedAt = new Date().toISOString();
    await saveReceipt(dir, receipt);
    if (receipt.status !== 'completed') throw new Error(receipt.error);
    return receipt;
  });
}
