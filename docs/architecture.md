# Alfred's first version

Alfred lives beside the user in Codex desktop. A custom pet supplies the character;
the Alfred skill supplies the manner and working habits. Codex supplies voice input,
tasks, tools, account access, and the execution environment.

The optional local CLI accepts a typed order or one transcript from a macOS helper.
It launches the installed Codex CLI with the existing user configuration, waits for
the result, records a private receipt, and can read the answer aloud. One order runs
at a time. Cancellation and a configurable deadline stop the child process group.

Native audio uses Apple Speech and AVAudioEngine. The helper listens for one order,
or waits for a double clap before listening. It closes the microphone before Codex
runs. Spoken output therefore cannot become the next instruction. Audio-file input
supports saved voice messages without adding a messaging service.

The default local execution mode is full machine access, matching the owner's
request. Workspace and read-only modes are also available. Local config and account
credentials stay on the machine. This version has no public command endpoint.

The computer must be awake for its microphone helper to hear a clap. Waking from
system sleep requires an always-on external sensor and a supported wake transport.
That extension is documented separately; it is not simulated by waking the display.

## Verification

Automated checks cover configuration, process arguments, literal prompt transport,
timeouts, cancellation, failures, local receipts, and voice helper behavior. A
harmless live Codex order checks the account-backed route. Pet validation checks
atlas dimensions, alpha, frame counts, and visual state consistency. The portfolio
build and preview checks cover both public project routes.
