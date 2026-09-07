# plugins/ntfy/engine.js

## TOKEN_ENV

The bearer comes from the environment, never from settings: settings are
persisted in `uiSettings` and shown in a renderer, so a token there would be
written to disk in cleartext and read back by every window. It is also never
interpolated into a log line — `test/ntfy-plugin.test.js` pins both the absence
of the header when the variable is unset and the absence of the value in the
captured log.

## parseTopicUrl

The topic is the LAST path segment, not the whole path: ntfy servers are often
reverse-proxied under a prefix (`https://host/ntfy/clodex`). The stream URL is
rebuilt from `origin + pathname`, never `href`: a pasted URL carrying a query or
a fragment would otherwise put `/json?since=` after them, leaving the cursor
inside a fragment that never reaches the server.

## remember

`host.storage.set` replaces the whole file rather than merging, so `lastId` and
`seen` must be written together — writing one alone drops the other.

## scheduleReconnect

ntfy closes an idle stream itself, so `res.on('end')` is the ordinary case, not
an error: `attempt = 0` inside the 200 handler is what stops a long-lived
subscription drifting to the 60s cap through normal churn.

## handleLine

Dedupe is needed even with a cursor: ntfy's `since=<id>` is inclusive of the
boundary id often enough to matter, so a reconnect re-delivers the message it
resumed from.

## noteText

Both the seat and the inbox get the SAME string — a divergence here would mean
the operator's note and the agent's copy differ in exactly the fence.
