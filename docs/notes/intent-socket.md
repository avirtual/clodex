# intent-socket notes

## createIntentRequestHandler

A subagent drives the browser as its seat; two subagents of one seat share the seat's lease and queue, its held windows, downloads dir and read-file dir. That is why `release` is refused to a subagent (the browser pane is the example; the rule is the plugin's `refuse`).

`replyTo` returning true means accepted into the reply, not received: the write happens later in `respond`, and a hang-up in between is undetectable to the dispatcher. That is why the term waiter does not fall back to the DM after acceptance.

A plugin's reply comes from the handle `_dispatchPluginIntent` wraps for this call, not from AsyncLocalStorage: the browser scheduler replies from timers and child IPC, and a queued job starts in the previous job's async context.

A tool call's grant check runs before the plugin's `toIntent`, so a plugin's mapper never runs on a seat that has not enabled it: `mcp-tools.json` is advisory, the live persistence entry is authoritative. A plugin tool row ignores identity fields and always runs as a subagent call: the browser pane's `release`/`close`/`--confirm` refusals rely on main's MCP calls being subagent-shaped. A core tool row (`term_exec`) has no subagent policy, so the verified one-shot `main.` stamp decides; a failed stamp answers the catalog's `unknown tool` text rather than `run`'s subagent refusal, so a subagent cannot learn from the refusal that the tool exists. The grant check runs before identity, so an ungranted call consumes no nonce.

With no captured acknowledgement, a verified subagent's dm answers that the reply arrives as a note after its next tool call (its note queue), not in the seat's main conversation.

## isMainThread

Codex sets `CODEX_THREAD_ID` (a bare uuid) on the main thread's shell too, while a Codex seat's `sessionId` is the rollout basename `rollout-<ts>-<uuid>`; so the main agent is an `agentId` equal to the `sessionId` or to its `-<uuid>` tail.

## splitAgentTarget

`agent` is a reserved suffix even though `SUBQ_NAME_RE` admits it as a name: `<seat>/agent` is the shared plugin tag, so it must always be the seat, and a parent that names a subagent `agent` reaches the seat. The dm arm never calls `_gatedDeliver` for a live subagent: a park would deliver to the seat's main conversation, the wrong reader.

## subagentTrustLine

The `[dm <nonce> from <name>]` sentence rides the trust line, not the `dm` tool brief: the brief is per-tool and absent on a seat without `dm`, while any subagent can receive a dm reply.

## callerIsSubagent

Claude Code 2.1.289 exports no agent-id env var to a subagent's shell, so a Claude caller's identity comes only from the hook stamp; the main agent's calls always pass the hook, so an unstamped call is a subagent.

The seat credential is also in every shell's env, a subagent's included: the HMAC stops a guessed or copied stamp, not a subagent that reads the credential and computes one.

The subagent lift for a core tool is a per-tool `subagentOk` flag, not a core `subagent` policy: `row.subagent` is what routes a row into the plugin branch of the tool handler and what `subagentCatalogFor` filters plugin briefs on, so a core row carrying it would run every caller as an unidentified subagent.

A verified sub's label rides `fromIdent`, never `fromLabel`: `_dispatchPluginIntent` copies `fromLabel` to `handle.from`, which browser-pane stamps on open, note and close and owns tabs by, so a per-subagent value would change note stamps and split sibling tab ownership.

## subagentLabel

The fallback is `<seat>/agent-<id8>`, never `<seat>/agent`: the shared tag names every subagent of the seat, so a recipient could not tell callers apart. `subq/names/` is writable by the subagent's own shell, so subq.js `nameOfSubagent` re-checks each entry against `SUBQ_NAME_RE` on read; a planted `@`, `[` or newline never reaches a label. `nameOfSubagent` also drops a reserved `agent`/`agent-…` name, so a label can never collide with the shared tag or an unnamed sibling's fallback.

## identToken

Before t1589 the mac covered only `agent_id + session_id`, so one `main.<mac>` held for a whole session; zsh's `time` echoed it into the seat's own context and anyone who saw a transcript could replay it. The per-call nonce makes each stamp single-use.

## rememberIdentNonce

The seen-nonce set is bounded FIFO at `IDENT_SEEN_MAX` (512) and drops entries older than `IDENT_SEEN_MS` (10 min); a nonce evicted by either bound would verify again, which the file-backed stamp (consumed on first read) covers.

## hookIdentOutput

Measured on Claude Code 2.1.289: a PreToolUse `updatedInput` with no `permissionDecision` rewrites the Bash command, and replaces the whole `tool_input` — so the output spreads the original input to keep `timeout` and `run_in_background`.

A stamp file is consumed by its first read, so one stamped segment the shell runs more than once (a loop body, a function) is main only on its first run; later runs go unstamped as a subagent.

The `mcp__clodex__` branch writes no stamp file: an MCP input has no argv or shell history to keep the stamp out of, and a stamp seen in a transcript is already spent. `ident` is spread after the input, so a caller-supplied `ident` is overwritten. Measured on CLI 2.1.292 (t1708 probe): the rewrite replaces the whole input and is not re-validated against `additionalProperties: false`.

The SubagentStart brief comes from the seat's catalog file (`catalogPath`), not a constant, so a plugin's sentence reaches the subagent without a core edit.

## createIntentSocketServer

The socket is chmod 0600 right after `listen`; the credential, not the mode, is the gate during that window.

The seat's socket is bound after `pty.spawn`, so a `clodex-send` call in the first milliseconds of a seat answers exit 4. Keep the env minted before the spawn.

The materialized `~/.clodex/bin/clodex-send` runs on `#!/usr/bin/env node` (ambient node), like the exec defs; it does not bake `nodeInterp` the way cli-hooks.js's hook scripts do.
