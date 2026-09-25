# stream-codec-codex.js

## onServerRequest

`decline` is accepted as an approval answer although `availableDecisions` never lists it (proxy-lab codex-app-server case D, codex-cli 0.155.1). The approval request arrives right after `item/started` for the same item, never before it.

## encodeUser

The first `commandExecution/outputDelta` line of a command was lost once (case F): only lines 2 and 3 reached the wire and `aggregatedOutput` lacked line 1, while the model saw all three. A stream seat's view of command output can miss its start.

The schema documents an `{type:'image', url}` input; no capture exercised it, so images are dropped with a warning.

## transcriptPathOf

Clodex's project-level `<cwd>/.codex/hooks.json` SessionStart hook did not fire under `codex app-server` (codex-cli 0.156.1, cwd trusted or not), while a user-level `~/.codex/hooks.json` one did; so the rollout path from the thread object is what links the transcript. The proxy-lab captures show that path as `~/…` only because the probe redacted the home directory; a live run returns it absolute.
