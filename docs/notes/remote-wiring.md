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

## importCreate

`createdAt` is upserted into persistence BEFORE `manager.create`, not seeded
after it with the other preserved fields. `create()` reads
`(existingEntry && existingEntry.createdAt) || Date.now()` and BAKES that value
into the generated pending-drain hook, so a post-create seed leaves the hook
expecting the far box's now. The `pending/` mail seat-import just installed
carries the SOURCE box's stamp, and the drainers are directional:
`born < expected` is discarded with no restore, `born > expected` is parked
forever. A failed spawn removes the record again, or the retry through
`POST /api/sessions` would find the name taken.

`_preserveAcrossRestart` is deliberately NOT used here: its always-preserve set
carries `worktree`/`ticketId`/`wireLabel`/`pluginGrants`/`holdUntil`, which name
things on the source box.
