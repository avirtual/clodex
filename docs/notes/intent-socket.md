# intent-socket notes

## createIntentRequestHandler

Until ticket B's PreToolUse hook stamps `agentId`, the subagent filter trusts the caller's claim. A main agent that claims to be a subagent only loses rights; a subagent that omits the id gets the seat's catalog.

A subagent drives the browser as its seat; two subagents of one seat share the seat's lease and queue, its held windows, downloads dir and read-file dir. That is why `release` is refused to a subagent.

A plugin's reply comes from the handle `_dispatchPluginIntent` wraps for this call, not from AsyncLocalStorage: the browser scheduler replies from timers and child IPC, and a queued job starts in the previous job's async context.

## isMainThread

Codex sets `CODEX_THREAD_ID` (a bare uuid) on the main thread's shell too, while a Codex seat's `sessionId` is the rollout basename `rollout-<ts>-<uuid>`; so the main agent is an `agentId` equal to the `sessionId` or to its `-<uuid>` tail.

## seatOfAgentTag

A subagent's dm is delivered as `[agent:from <seat>/agent]`; `_isDmReachable` and the dm arm map that tag back to the seat, so a reply lands in the seat's main conversation (ticket B hands it to the still-running subagent).

## createIntentSocketServer

The socket is chmod 0600 right after `listen`; the credential, not the mode, is the gate during that window.

The seat's socket is bound after `pty.spawn`, so a `clodex` call in the first milliseconds of a seat answers exit 4. Keep the env minted before the spawn.

The materialized `~/.clodex/bin/clodex` runs on `#!/usr/bin/env node` (ambient node), like the exec defs; it does not bake `nodeInterp` the way cli-hooks.js's hook scripts do.
