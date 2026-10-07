# intent-socket notes

## createIntentRequestHandler

A subagent drives the browser as its seat; two subagents of one seat share the seat's lease and queue, its held windows, downloads dir and read-file dir. That is why `release` is refused to a subagent (the browser pane is the example; the rule is the plugin's `refuse`).

`replyTo` returning true means accepted into the reply, not received: the write happens later in `respond`, and a hang-up in between is undetectable to the dispatcher. That is why the term waiter does not fall back to the DM after acceptance.

A plugin's reply comes from the handle `_dispatchPluginIntent` wraps for this call, not from AsyncLocalStorage: the browser scheduler replies from timers and child IPC, and a queued job starts in the previous job's async context.

A tool call's grant check runs before the plugin's `toIntent`, so a plugin's mapper never runs on a seat that has not enabled it: `mcp-tools.json` is advisory, the live persistence entry is authoritative. Identity fields on a tool call are ignored because the MCP server stamps nothing, so a forged stamp on a tool call must not widen policy.

## isMainThread

Codex sets `CODEX_THREAD_ID` (a bare uuid) on the main thread's shell too, while a Codex seat's `sessionId` is the rollout basename `rollout-<ts>-<uuid>`; so the main agent is an `agentId` equal to the `sessionId` or to its `-<uuid>` tail.

## seatOfAgentTag

A subagent's dm is refused at the socket (`not available to a subagent: dm`): no plugin policy allows it, and a subagent has no inbox to receive a reply. A `<seat>/agent` name that still reaches `_isDmReachable` or the dm arm as a sender or target maps back to the seat, so a reply lands in the seat's main conversation.

## callerIsSubagent

Claude Code 2.1.289 exports no agent-id env var to a subagent's shell, so a Claude caller's identity comes only from the hook stamp; the main agent's calls always pass the hook, so an unstamped call is a subagent.

The seat credential is also in every shell's env, a subagent's included: the HMAC stops a guessed or copied stamp, not a subagent that reads the credential and computes one.

## identToken

Before t1589 the mac covered only `agent_id + session_id`, so one `main.<mac>` held for a whole session; zsh's `time` echoed it into the seat's own context and anyone who saw a transcript could replay it. The per-call nonce makes each stamp single-use.

## rememberIdentNonce

The seen-nonce set is bounded FIFO at `IDENT_SEEN_MAX` (512) and drops entries older than `IDENT_SEEN_MS` (10 min); a nonce evicted by either bound would verify again, which the file-backed stamp (consumed on first read) covers.

## hookIdentOutput

Measured on Claude Code 2.1.289: a PreToolUse `updatedInput` with no `permissionDecision` rewrites the Bash command, and replaces the whole `tool_input` — so the output spreads the original input to keep `timeout` and `run_in_background`.

A stamp file is consumed by its first read, so one stamped segment the shell runs more than once (a loop body, a function) is main only on its first run; later runs go unstamped as a subagent.

The SubagentStart brief comes from the seat's catalog file (`catalogPath`), not a constant, so a plugin's sentence reaches the subagent without a core edit.

## createIntentSocketServer

The socket is chmod 0600 right after `listen`; the credential, not the mode, is the gate during that window.

The seat's socket is bound after `pty.spawn`, so a `clodex` call in the first milliseconds of a seat answers exit 4. Keep the env minted before the spawn.

The materialized `~/.clodex/bin/clodex` runs on `#!/usr/bin/env node` (ambient node), like the exec defs; it does not bake `nodeInterp` the way cli-hooks.js's hook scripts do.
