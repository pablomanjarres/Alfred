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
alfred desktop
```

In a new Codex task, use `$alfred` with the existing voice button or composer.
[Install the pet](docs/pet.md), then choose **Alfred** in **Settings > Pets**.

## Local commands

```bash
alfred ask "Check my calendar through Cortex"
alfred doctor
npm run build:voice
alfred listen --speak
alfred standby start
```

The optional macOS helper accepts one-shot microphone input and saved voice messages.
It closes the microphone before Alfred acts or speaks. `alfred standby start` runs a
login clap watcher only: it does not record, transcribe, or send standby audio to Codex.

- Local commands use full access by default. Set `--permission read-only` to limit it.
- Claps work while the computer is awake. Waking from system sleep needs an external sensor.
- Your orders and answers stay in `~/.alfred/`. Codex plan limits still apply.

[Voice setup](docs/voice.md) · [Desktop setup](docs/codex-desktop.md) · [Configuration](config.example.json)

Node.js 22+ required. Run `npm run check` to verify the build and tests.
