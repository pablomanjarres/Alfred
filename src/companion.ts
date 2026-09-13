import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Config } from './config.js';
import { stateDirectory } from './config.js';
import { runCodex } from './codex.js';
import { withLock } from './history.js';

export type Companion = { threadId: string; cwd: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readCompanion(home = stateDirectory()): Promise<Companion | undefined> {
  let saved: Companion;
  try { saved = JSON.parse(await readFile(join(home, 'companion.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!saved || !uuid.test(saved.threadId) || typeof saved.cwd !== 'string' || !isAbsolute(saved.cwd)) {
    throw new Error('Alfred companion settings are invalid. Run alfred voice setup.');
  }
  return saved;
}

export async function prepareCompanion(config: Config, options: { home?: string; create?: typeof runCodex; signal?: AbortSignal } = {}): Promise<Companion> {
  const home = options.home ?? stateDirectory();
  return withLock(home, async () => {
    const existing = await readCompanion(home);
    if (existing) return existing;
    const cwd = join(home, 'companion');
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await chmod(cwd, 0o700);
    const template = await readFile(new URL('../assets/companion/AGENTS.md', import.meta.url), 'utf8');
    const command = `'${join(homedir(), '.local/bin/alfred').replaceAll("'", "'\\''")}'`;
    try { await writeFile(join(cwd, 'AGENTS.md'), template.replaceAll('{{ALFRED_COMMAND}}', command), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const result = await (options.create ?? runCodex)(
      'This is Alfred\'s dedicated personal assistant task. Read the workspace instructions. Introduce yourself to Pablo in one short sentence. This is setup only: do not run commands, use external tools, modify files, or end voice. Wait for his next order.',
      { ...config, cwd }, home, undefined, options.signal,
    );
    if (!result.sessionId || !uuid.test(result.sessionId)) throw new Error('Codex did not return a valid task ID.');
    const companion = { threadId: result.sessionId, cwd };
    const target = join(home, 'companion.json');
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(companion, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, target);
    return companion;
  });
}
