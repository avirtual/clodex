# cli/bin/clodex-mcp notes

## createServer

`process.stdout` on a pipe is asynchronous on macOS (synchronous only on Linux and Windows), so the stdio entry point exits through `process.stdout.write('', cb)` rather than a bare `process.exit`, or the last response line can be lost.

The server sends `{cred, tool, args, ident?}`; `ident` is the PreToolUse hook's stamp. A plugin tool row ignores it and runs as a subagent request (intent-socket.js): main's `click --confirm` over MCP is refused too; main confirms through the intent or the CLI. A core tool row (`term_exec`) is main only on a verified stamp.

The catalog path is derived from `CLODEX_INTENT_SOCK`'s directory, not passed: `mcp.json` carries no seat-specific env and must not (the cred is inherited, never written). `tools/list` re-reads the file on every call; a missing or malformed file is an empty list — a seat with no tool-declaring plugin has `tools: []`, which is correct, not an error.

`notifications/tools/list_changed` fires on a `rev` change seen by a 2 s poll, only after `initialize` was answered. The poll bounds detection, not staleness: the socket's live grant check bounds authorisation, so a stale list is at worst a refused call. `fs.watch` was rejected: it misses rename-replace writes on macOS.

`run/<seat>/mcp.log` has no caller column: main's and subagents' calls interleave in one file.

## callTool

Every tools/call answer is a plain text result — never `isError` — because Claude Code elides a prior failed tool call from the model's transcript once another call follows (`[Tool error elided: resolved in a later turn]`, apometre run 57), and an elided refusal is retried forever; `-32602` is kept only for a non-string tool name or non-object arguments. The server validates nothing else: the plugin's mapper rejects bad arguments main-side as `status:'invalid'`, rendered `invalid: <message>` and excluded from the loop ring, exactly as the old local validation was.

The loop ring is per server process: a seat's main agent and its subagents share it, so a refusal the main agent provoked twice stops a subagent's identical third call too. Keyed by tool name plus canonicalised args (object keys sorted), byte-identical repeats only: `{bracket:[]}` and an absent `bracket` are different keys. 60 s window; a success clears the key.

`ident` is lifted out of `args` for every tool before the key is built and sent top-level: each call carries a fresh nonce, so a key holding it could never repeat and the breaker could never trip. A non-string `ident` is dropped.
