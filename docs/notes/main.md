# main.js

## openInTerminal

execFile with an argv, never exec: the cwd is agent-supplied, and exec routes it
through /bin/sh, where `$(...)` runs.
