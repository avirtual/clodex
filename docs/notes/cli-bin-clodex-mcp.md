# cli/bin/clodex-mcp notes

## createServer

`process.stdout` on a pipe is asynchronous on macOS (synchronous only on Linux and Windows), so the stdio entry point exits through `process.stdout.write('', cb)` rather than a bare `process.exit`, or the last response line can be lost.
