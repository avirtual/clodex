# peer-wiring.js

## openPeerWebDirect

t923. A url-kind peer is reached over somebody else's network path, so there is
nothing to forward — which is exactly why the operator's own browser can reach
its web UI unaided, at the same host. The arrow used to refuse *because*
`destinationOf` returned null; it now takes this branch.

The address is composed from the record's own scheme and hostname plus the
hello's advertised `webHost.port`. Never a loopback literal: "url-kind" does not
mean local (`ios` on the dev box is `http://localhost:7902`, but the field is a
URL and another box's may be anywhere), and never a guessed port — no `webHost`
still refuses, ahead of this branch.

Neither the wirescope companion forward nor `pageUrl`'s query params apply here,
and both are deliberately skipped. `?wirescope=<port>` is read by the served page
as a port on *our* loopback, which for a url peer is the wrong machine;
`via=tunnel` exists to tell a page its viewer is not on the box, a question
`browserSharesEngineHost` in `renderer/web/api-shim.js` already answers from the
origin once the tab is served from the peer's own address rather than a local
forward.

The token gate is honoured by the same rule as the tunnel path — a gated box
returns its address and pops no window — but not through `webPopAllowed`, which
gates the supervisor's `firstUp` emit. This open rides no emit.

## openPeerWeb

The `webHost` check runs ahead of the `destinationOf` check (t923), so a url peer
whose hello reports no web frontend is told that, rather than being told
something about transports.
