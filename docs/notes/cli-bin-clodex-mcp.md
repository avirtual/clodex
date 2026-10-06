# cli/bin/clodex-mcp notes

## createServer

`process.stdout` on a pipe is asynchronous on macOS (synchronous only on Linux and Windows), so the stdio entry point exits through `process.stdout.write('', cb)` rather than a bare `process.exit`, or the last response line can be lost.

The server sends `{cred, intent}` with no caller identity, so the socket's `callerIsSubagent` (intent-socket.js) treats every caller — the seat's main agent included — as a subagent: main's `click --confirm` over MCP is refused too; main confirms through the intent or the CLI.

`run/<seat>/mcp.log` has no caller column: main's and subagents' calls interleave in one file.

## callTool

An argument error is answered as an `isError` tool result because Claude Code elides a JSON-RPC error from the model's transcript (`[Tool error elided: …]`, apometre run 56); `-32602` is kept only for an unknown tool name or non-object arguments.
