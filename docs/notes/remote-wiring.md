# remote-wiring.js

## watchInbox

Armed once per PROCESS, not once per RemoteServer, because the store's
`onChange` list has no unsubscribe: a per-instance subscription would strand a
listener holding a dead server on every port change and every remote
disable/enable. It therefore reads `getRemoteServer()` per call rather than
capturing one.

Called at the top of `syncRemoteServer`, ahead of the `enabled` bail, so the
desktop half (the `notifications:changed` IPC that keeps a second window's badge
honest) does not depend on the phone server being switched on.

## syncRemoteServer

The restart comparison is against `resolveRemoteBasePath(s.remoteBasePath)`, not
the stored string, and against the server's `basePath` getter rather than its
`_basePath` field. Both halves matter: a restart drops every SSE client on the
box, so `c`, `/c` and `/c/` — one prefix in three spellings — must compare equal
or an unrelated settings save costs a phone its stream. A field this comparison
does NOT cover cannot be applied to a running server at all; the operator token
is the other such field, and `refreshRemoteToken` exists to force the teardown
that gives it effect.

The boot log fires in `start()`'s `then`, gated on the server having just been
constructed. `syncRemoteServer` runs on every settings write on the box, so an
ungated line would log on writes that started nothing.

`log` is injected, so `log.info` can throw. It is wrapped in its own
`try {} catch {}` because the surrounding `.catch` is the BIND-failure handler:
it records a remote error and nulls the server, which under a live socket makes
the next sync bind the same port again and get EADDRINUSE.
