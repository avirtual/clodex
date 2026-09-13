# remote.js

## notifyInbox

The `/api/inbox` handlers deliberately broadcast NOTHING. The `inbox` SSE frame
is emitted from the notifications store's `onChange` (remote-wiring subscribes
`notifyInbox` to it), which is what makes a desktop-side mutation reach the
phone at all. A route that also broadcast would double every frame a phone-side
mutation produces.

The `POST /api/inbox/read/:id` handler re-reads the note after `markRead`
because `markRead` returns only whether the id exists: an already-read note must
answer with its ORIGINAL `readAt`, which is what makes the route idempotent in
the sense the app relies on.

## resolveRemoteBasePath

`DEFAULT_REMOTE_BASE_PATH` is the EMPTY STRING, not `'/'`. `'/'` would make
`p === base` true for the root and 301 `/` to itself, and `p.startsWith('/')`
is true of every path, so the strip would eat the leading slash off all of them.
The empty string makes `if (base)` in `_route` the whole off-switch.

A refused value falls back rather than being sanitised: `/c/../etc` must not
become `/etc`, because an operator reading the env would then believe the mount
is somewhere it is not. The fallback is the caller's `fallback` argument, which
is how `resolveRemoteBasePathSetting` makes a garbage env keep the PERSISTED
prefix rather than dropping to no prefix.

## _route

`before` is parsed with `parseInt`, not `Number()`: an absent query param is
`null` and `Number(null)` is `0`, a finite cutoff that pages every note away.
`GET /api/inbox` with no `before` in test/remote-inbox.test.js is what holds it.
