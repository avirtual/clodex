# cli/bin/clodex-mcp notes

## createServer

`process.stdout` on a pipe is asynchronous on macOS (synchronous only on Linux and Windows), so the stdio entry point exits through `process.stdout.write('', cb)` rather than a bare `process.exit`, or the last response line can be lost.

The server sends `{cred, intent}` with no caller identity, so the socket's `callerIsSubagent` (intent-socket.js) treats every caller — the seat's main agent included — as a subagent: main's `click --confirm` over MCP is refused too; main confirms through the intent or the CLI.

`run/<seat>/mcp.log` has no caller column: main's and subagents' calls interleave in one file.

## callTool

Every tools/call answer is a plain text result — never `isError` — because Claude Code elides a prior failed tool call from the model's transcript once another call follows (`[Tool error elided: resolved in a later turn]`, apometre run 57), and an elided refusal is retried forever; `-32602` is kept only for an unknown tool name or non-object arguments.

The loop ring is per server process: a seat's main agent and its subagents share it, so a refusal the main agent provoked twice stops a subagent's identical third call too. Keyed by verb+service+bracket+body; 60 s window; a success clears the key.
