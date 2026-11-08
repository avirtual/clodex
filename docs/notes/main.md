# main.js

## openInTerminal

execFile with an argv, never exec: the cwd is agent-supplied, and exec routes it
through /bin/sh, where `$(...)` runs.

## sandboxedChildWindow

Both window-open handlers allow a `blob:` child only when `blobChildAllowed` says it is from the opener's own http(s) origin: the web UI's Open on a remote file is `window.open` on a blob url, which the remote window otherwise denied silently. The child gets the sandboxed webPreferences, never the main window's nodeIntegration.
