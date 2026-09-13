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
alfred standby start
alfred standby status
alfred standby stop
npm run setup:menubar-signing
npm run build:menubar
npm run install:menubar
```

`npm run install:menubar` installs `~/Applications/Alfred.app`. Its menu shows listening status, controls standby, and lets you test the wake sound or choose Mac speakers. Quitting the menu app leaves the listener running.

Use Codex desktop's voice button for spoken orders. The optional macOS helper can
transcribe an existing audio file, and `alfred standby start` runs login wake
standby for double clap or the local “Alfred” keyword: it does not record,
transcribe, or send standby audio to Codex.

- Local commands use full access by default. Set `--permission read-only` to limit it.
- Double clap and “Alfred” work while the computer is awake. Waking from system sleep needs an external sensor.
- Your orders and answers stay in `~/.alfred/`. Codex plan limits still apply.

[Voice setup](docs/voice.md) · [Desktop setup](docs/codex-desktop.md) · [Configuration](config.example.json)

Node.js 22+ required. Run `npm run check` to verify the build and tests.
