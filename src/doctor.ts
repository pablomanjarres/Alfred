import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './config.js';
import { codexEnvironment } from './codex.js';
import { runProcess } from './process.js';
import { voiceStatus } from './voice.js';

export async function doctor(config: Config): Promise<boolean> {
  let healthy = true;
  const check = async (label: string, action: () => Promise<string>, required = true) => {
    try { console.log(`${label}: ${await action()}`); }
    catch (error) { console.log(`${label}: ${error instanceof Error ? error.message : String(error)}`); if (required) healthy = false; }
  };
  await check('Workspace', async () => {
    if (!(await stat(config.cwd)).isDirectory()) throw new Error('not a directory');
    return config.cwd;
  });
  await check('Codex', async () => {
    const result = await runProcess(config.codex, ['--version'], { timeoutMs: 10_000 });
    if (result.code) throw new Error(result.stderr || 'unavailable');
    return result.stdout.trim();
  });
  await check('Account', async () => {
    const result = await runProcess(config.codex, ['login', 'status'], { env: codexEnvironment(), timeoutMs: 10_000 });
    const text = (result.stdout + result.stderr).trim();
    if (result.code || !/ChatGPT/i.test(text)) throw new Error('Sign in using codex login with your ChatGPT account.');
    return 'ChatGPT login available';
  });
  await check('Codex tools', async () => {
    const result = await runProcess(config.codex, ['mcp', 'list', '--json'], { timeoutMs: 15_000 });
    if (result.code) throw new Error('Could not inspect configured MCP tools.');
    const servers = JSON.parse(result.stdout) as {name: string; enabled: boolean}[];
    return servers.filter((server) => server.enabled).map((server) => server.name).join(', ') || 'No MCP servers configured';
  }, false);
  await check('Native voice (optional)', async () => (await voiceStatus()).detail, false);
  await check('Alfred pet', async () => {
    const root = process.env.CODEX_HOME || join(homedir(), '.codex');
    await access(join(root, 'pets', 'alfred', 'pet.json'), constants.R_OK);
    return 'installed; choose Alfred in Codex Settings > Pets';
  }, false);
  console.log(`Access: ${config.permission}; deadline: ${config.timeoutMs / 1000}s`);
  return healthy;
}
