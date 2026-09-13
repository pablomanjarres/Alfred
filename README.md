<p align="center">
  <a href="https://pablomanjarres.com/oss/alfred"><img src=".github/banner.webp" alt="Alfred in his midnight study" width="100%" /></a>
</p>

# Alfred

Your personal butler, inside Codex.

Give him an order by voice or text. Alfred uses your Codex account and connected
tools, including Cortex, to carry it out. Inspired by Alfred Pennyworth, with a
custom desktop pet to match.

**Prototype** · [MIT](LICENSE) · [Project page](https://pablomanjarres.com/oss/alfred)

## Start

Sign in to [Codex](https://developers.openai.com/codex/cli/) with your ChatGPT account.

```bash
git clone https://github.com/pablomanjarres/Alfred.git
cd Alfred
npm ci
npm run build
npm run setup
alfred voice setup
```

Install the [menu app and voice helper](docs/voice.md), then allow Alfred in macOS
Accessibility settings. [Choose the Alfred pet](docs/pet.md) under **Settings > Pets**.

## Local commands

```bash
alfred ask "Check my calendar through Cortex"
alfred doctor
alfred standby start
alfred off
```

Say “Alfred” or double clap. After the cue, give your order in his dedicated Codex
task. Say “Goodbye, Alfred” to end the call and resume wake listening. Say “Alfred,
switch off” to stop both. Standby audio is never recorded or sent to Codex.

- Local commands use full access by default; read-only mode is available.
- Double clap and “Alfred” work while the computer is awake. Waking from system sleep needs an external sensor.
- Local CLI history stays in `~/.alfred/`. Voice conversations use Codex. Plan limits still apply.

[Voice setup](docs/voice.md) · [Desktop setup](docs/codex-desktop.md) · [Configuration](config.example.json)

Node.js 22+ required. Run `npm run check` to verify the build and tests.
