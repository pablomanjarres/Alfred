#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { loadConfig, saveCueOutput, stateDirectory, type Config, type CueOutput } from './config.js';
import { executeOrder } from './assistant.js';
import { receipts } from './history.js';
import { runProcess } from './process.js';
import { ClapIdleError, transcribe, speak } from './voice.js';
import { doctor } from './doctor.js';
import { installService, serviceStatus, startService, stopService } from './standby.js';
import { cueSummary, testCue } from './cue.js';
import { prepareCompanion, readCompanion } from './companion.js';
import { endVoice } from './voice-control.js';

const HELP = `Alfred, at your service.

  alfred desktop                     Open this workspace in Codex desktop
  alfred ask "your order"             Run an order through your Codex account
  alfred transcribe /path/message.m4a Execute a saved voice message
  alfred history                     Show the ten latest local receipts
  alfred standby start|stop|status    Manage login wake standby
  alfred voice setup                 Create Alfred's dedicated Codex task
  alfred voice end                   End voice and resume wake listening
  alfred off                         End voice and switch wake listening off
  alfred cue output current|speakers   Choose where Alfred plays wake cues
  alfred cue test                      Play one wake cue safely
  alfred doctor                      Check account, tools, voice, and pet

Options: --cwd PATH, --permission full|workspace|read-only, --model NAME,
         --locale en-US|es-CO, --speak, --new, --loop, --help
--new starts a fresh Codex conversation.
Use Codex desktop's voice button for spoken orders. Alfred standby detects double claps or “Alfred”.
Config: ~/.alfred/config.json. Local receipts: ~/.alfred/history/.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, cwd: { type: 'string' }, permission: { type: 'string' },
    model: { type: 'string' }, locale: { type: 'string' }, speak: { type: 'boolean' },
    new: { type: 'boolean' }, loop: { type: 'boolean' },
  } });
  const command = positionals.shift();
  if (!command || values.help) { console.log(HELP); return; }
  const overrides: Partial<Config> = {};
  if (values.cwd) overrides.cwd = values.cwd;
  if (values.permission) overrides.permission = values.permission as Config['permission'];
  if (values.model) overrides.model = values.model;
  if (values.locale) overrides.locale = values.locale;
  if (values.speak !== undefined) overrides.speak = values.speak;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const { signal } = controller;
  try {
    if (command === 'cue') {
      const action = positionals.shift();
      if (action === 'output') {
        const mode = positionals.shift();
        if (!mode || positionals.length || !['current', 'speakers'].includes(mode)) throw new Error('Use cue output current or speakers.');
        await saveCueOutput(mode as CueOutput);
        console.log(`Alfred wake cues will use ${mode}.`);
        return;
      }
      if (action === 'test' && positionals.length === 0) {
        const config = await loadConfig(overrides);
        const cue = await testCue({ mode: config.cueOutput, signal });
        console.log(`Alfred wake cue played through ${config.cueOutput}: ${cueSummary(cue)}.`);
        return;
      }
      throw new Error('Use cue output current|speakers or cue test.');
    }
    const config = await loadConfig(overrides);
    if (command === 'voice' || command === 'off') {
      const action = command === 'off' ? 'off' : positionals.shift();
      if (positionals.length || !action || !['setup', 'end', 'off'].includes(action)) throw new Error('Use voice setup, voice end, or off.');
      if (action === 'setup') {
        console.log(JSON.stringify(await prepareCompanion(config, { signal })));
      } else {
        const companion = await readCompanion();
        await endVoice({ off: action === 'off', threadId: companion?.threadId, signal });
        console.log(action === 'off' ? 'Alfred is off.' : 'Codex released its microphone. Alfred is returning to wake listening.');
      }
      return;
    }
    if (values.loop && command !== 'clap') throw new Error('--loop is available only with clap.');
    if (command === 'standby') {
      const action = positionals.shift();
      if (!action || !['install', 'start', 'stop', 'status'].includes(action)) throw new Error('Use standby install, start, stop, or status.');
      if (action === 'install') { const paths = await installService(); console.log(`Installed ${paths.plist}`); return; }
      if (action === 'start') { console.log(JSON.stringify(await startService())); return; }
      if (action === 'stop') { await stopService(); console.log('Alfred standby stopped.'); return; }
      console.log(JSON.stringify(await serviceStatus()));
      return;
    }
    if (command === 'doctor') { if (!await doctor(config)) process.exitCode = 1; return; }
    if (command === 'history') {
      const rows = await receipts(stateDirectory());
      console.log(rows.length ? rows.map((row) => `${row.startedAt}  ${row.status}  ${row.order.replace(/\s+/g, ' ').slice(0, 100)}`).join('\n') : 'No orders yet.');
      return;
    }
    if (command === 'desktop') {
      const result = await runProcess(config.codex, ['app', config.cwd], { timeoutMs: 30_000, signal });
      if (result.code) throw new Error(result.stderr || 'Could not open Codex desktop.');
      console.log('Codex desktop opened. Use $alfred with its voice input or composer.');
      return;
    }
    if (!['ask', 'listen', 'clap', 'transcribe'].includes(command)) throw new Error(`Unknown command: ${command}`);
    if (command === 'ask' && !positionals.length) throw new Error('Give Alfred an order after ask.');
    if (command === 'transcribe' && positionals.length !== 1) throw new Error('Provide one audio file path.');
    if (['listen', 'clap'].includes(command) && positionals.length) throw new Error(`${command} does not take text arguments.`);
    do {
      let order: string;
      try {
        order = command === 'ask' ? positionals.join(' ') : await transcribe({
          mode: command === 'transcribe' ? 'file' : command as 'listen' | 'clap',
          file: command === 'transcribe' ? resolve(positionals[0]) : undefined,
          locale: config.locale, signal, onStatus: (status) => console.error(status),
        });
      } catch (error) {
        if (error instanceof ClapIdleError && values.loop) continue;
        throw error;
      }
      if (signal.aborted) break;
      console.error(command === 'ask' ? 'On it.' : `Heard: ${order}`);
      const receipt = await executeOrder(order, config, { fresh: values.new, signal });
      console.log(receipt.answer);
      if (config.speak && receipt.answer) await speak(receipt.answer, signal);
    } while (values.loop && !signal.aborted);
    if (signal.aborted) process.exitCode = 130;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}


main().catch((error) => {
  console.error(`Alfred: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = /cancel/i.test(String(error)) ? 130 : 1;
});
