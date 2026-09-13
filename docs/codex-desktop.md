# Use Alfred through Codex desktop

Codex desktop supplies the pet surface, voice button, task view, tools, and account.
Alfred adds the character and the behavior skill. Use the desktop flow for everyday
orders; the CLI is useful for saved recordings or a clap sensor.

1. Build Alfred and run `npm run setup`.
2. Run `alfred voice setup` once to create his dedicated Codex task.
3. Choose Alfred under Settings > Pets. If needed, restart the app to reload pets.
4. Wake Alfred and speak your order. His task carries the personality and voice controls.

The skill runs in the current task and uses its tools. It does not recursively
launch another agent. The optional CLI calls `codex exec` and stores that session's
ID to continue the conversation on the next order in the same workspace.

The pet package is a visual companion. It has no credentials, microphone recorder,
or permission policy. The existing Codex task retains its normal access settings.
Selecting a pet does not select a skill; invoke `$alfred` to use the behavior.

## Local runner

`alfred desktop` opens the current workspace using the supported `codex app`
command. `alfred ask` uses the supported `codex exec` command with the normal user
configuration. Both use your installed Codex. No private desktop database or
undocumented interface is required.

Run `alfred doctor` to check the ChatGPT login, enabled MCP server names, optional
voice helper, and installed pet package. It does not reveal credentials or ask
for microphone permission.

## Wake into voice

With the menu app installed and **Enable voice control** allowed, a double clap or
“Alfred” opens his dedicated task through a supported Codex task link. The task ID
stays in `~/.alfred/companion.json`; its editable personality profile is
`~/.alfred/companion/AGENTS.md`. Setup reuses the same task and preserves edits.
Without companion setup, wake still uses the current task and its instructions.

Alfred stops its microphone before sending **Control-Shift-V** to Codex. It sends
the shortcut once and checks that Codex has opened input. Say “Goodbye, Alfred” to
request the end of the call and restore wake listening. “Alfred, switch off” stops
both. If you end a call with Codex's button, choose **Start listening** in Alfred.
Microphone inactivity alone does not prove a call ended, so it never triggers rearming.

This uses the documented [voice control](https://learn.chatgpt.com/docs/reference/commands)
and [Codex voice chat](https://learn.chatgpt.com/docs/features/voice).

References: [Codex CLI](https://developers.openai.com/codex/cli/) and
[official custom pet contract](https://github.com/openai/skills/blob/main/skills/.curated/hatch-pet/references/codex-pet-contract.md).
