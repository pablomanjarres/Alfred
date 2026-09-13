<p align="center">
  <a href="https://pablomanjarres.com/oss/alfred"><img src=".github/banner.webp" alt="Alfred in his midnight study" width="100%" /></a>
</p>

<h1 align="center">Alfred</h1>

<p align="center"><em>A personal butler for Codex, Cortex, and the rest of your tools.</em></p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white" />
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js_22+-5FA04E?style=flat&logo=node.js&logoColor=white" />
  <img alt="Swift" src="https://img.shields.io/badge/Swift-F05138?style=flat&logo=swift&logoColor=white" />
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-c8542a?style=flat" />
  <img alt="status prototype" src="https://img.shields.io/badge/status-prototype-e0a642?style=flat" />
  <a href="https://pablomanjarres.com/portfolio/projects/alfred"><img alt="Portfolio" src="https://img.shields.io/badge/portfolio-pablomanjarres.com-c8542a?style=flat" /></a>
  <a href="https://pablomanjarres.com/oss/alfred"><img alt="Landing" src="https://img.shields.io/badge/landing-pablo--oss-c8542a?style=flat" /></a>
</p>

Alfred is a personal assistant inspired by Alfred Pennyworth: composed, attentive,
and ready to handle the next request. He lives in Codex desktop as a custom pet and
a reusable skill. Codex supplies the voice input, tasks, account, and tools. A small
local CLI adds saved voice messages, spoken replies, and double-clap activation.

## Highlights

- **Works in Codex desktop.** The skill in [`.agents/skills/alfred`](.agents/skills/alfred/SKILL.md)
  runs in your current task. The optional CLI gives you a second way to send orders.
- **Uses your Codex account.** [`src/codex.ts`](src/codex.ts) calls the installed CLI,
  preserves configured MCP tools, and resumes the previous conversation for the
  workspace. It requires a ChatGPT login and adds zero API-key dependencies.
- **Keeps access explicit.** [`src/config.ts`](src/config.ts) supports 3 modes: full,
  workspace, and read-only. Full access is the default for the owner's local runner.
- **Stops when a task cannot finish.** [`src/process.ts`](src/process.ts) enforces a
  10-minute default deadline and handles cancellation. [`src/history.ts`](src/history.ts)
  allows 1 active order and saves private receipts for completed and failed runs.
- **Accepts speech in two forms.** [`src/voice.ts`](src/voice.ts) accepts microphone
  input or an audio file. The macOS helper can wait for 2 claps before listening.
  Audio capture closes before a command runs or Alfred speaks.
- **Keeps your tools together.** Cortex and your other MCP servers come from the
  existing Codex configuration. Alfred adds 0 duplicate personal-data stores or
  new public command endpoints.

## Getting started

Install [Codex](https://developers.openai.com/codex/cli/) and sign in with your
ChatGPT account. Codex usage remains subject to your plan's limits.

```bash
git clone https://github.com/pablomanjarres/Alfred.git
cd Alfred
npm ci
npm run build
npm run setup
alfred doctor
alfred desktop
```

In a new Codex task, invoke `$alfred` and give your order using the existing voice
button or composer. The installer adds the CLI to `~/.local/bin` and the skill to
your Codex skills folder. It preserves existing files. Add `~/.local/bin` to your
shell's `PATH` if it is not already there.

Choose **Alfred** in **Codex Settings > Pets** after copying the package:

```bash
mkdir -p ~/.codex/pets/alfred
cp assets/pet/pet.json assets/pet/spritesheet.webp ~/.codex/pets/alfred/
```

If you set `CODEX_HOME`, use its `pets/alfred` folder instead.

### Optional local orders and voice

```bash
alfred ask "Read my calendar through Cortex and tell me what is next"
alfred ask --new --permission read-only "Summarize this project"
npm run build:voice
alfred listen --locale es-CO --speak
alfred transcribe /path/to/message.m4a --speak
alfred clap --loop --speak
```

Native voice requires macOS and the Xcode command-line tools to build. First use
requires Speech Recognition and microphone permission. See [voice setup](docs/voice.md)
for device requirements, supported speech locales, and the external sensor path.

Double claps can activate Alfred while the computer is awake and wake a sleeping
display. Waking the computer from system sleep requires an external listening
device. That hardware integration is not included in this prototype.

### Configuration

Copy [`config.example.json`](config.example.json) to `~/.alfred/config.json`, then
adjust the workspace, locale, speech output, deadline, and access mode. Set
`ALFRED_HOME` to put the private configuration and receipts elsewhere. Receipt
files include your orders and answers and stay outside the repository.

Keep Cortex running when a request needs it. Alfred uses the MCP servers already
registered in Codex; it does not install or replace their credentials.

```bash
npm run check
alfred history
```

## License

MIT. See [LICENSE](LICENSE).

---

<p align="center">
  <a href="https://pablomanjarres.com/oss/alfred">Landing</a> ·
  <a href="https://pablomanjarres.com/portfolio/projects/alfred">Portfolio write-up</a> ·
  Built by Pablo Manjarres
</p>
