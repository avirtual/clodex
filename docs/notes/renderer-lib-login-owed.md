# renderer/lib/login-owed.js

## loginOwedView

`proxy.auth_refresh.stalled` (wirescope v0.6.59+) means the OAuth REFRESH token
is dead: the proxy cannot renew the access token by itself and a human must run
`claude login`. Until then every keep-warm hold dies at the next token lapse and
the following turn pays a full cold re-cache — the failure is otherwise silent,
which is why it gets a banner rather than a bar segment.

The readout is account-wide, not per session, so any one payload carrying
`stalled` is enough; a proxy older than v0.6.59 sends no block at all and
`authRefresh` arrives `null`, which reads as not owed.
