# test/free-identifier-leaks.test.js

## SCANNED_MODULES

`cli/bin/clodex-mcp.js` (t1648) has the same standing as `cli/src/dial.js` and `cli/src/sse-frame.js`: a cli/ leaf never carved out of main.js, so the forward scan only catches it by accident. Its real guard is the leaf property — its only non-builtin require is the sideways `./clodex.js`, pinned in test/clodex-mcp.test.js.
