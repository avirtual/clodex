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
