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

t925: a record that reaches here with an unreadable url has no `url` field to
call unreadable — an incomplete cloud block falls through `destinationOf` into
this branch too. So the refusal names the situation rather than a field: neither
tunnel nor direct reach is configured.

## resolvePeerUrls

t925: each resolved entry carries `direct`, computed from the same
`destinationOf` `openPeerWeb` routes a click with, and `peer-client.js` relays it
through `status()` to the renderer. The renderer has no peer record and its only
other transport signal is the tunnel ROW, which `peers-ui.js` seeds from the
`peerList()` reply — after `onPeerState` has already repainted. In that window a
forwardable peer looks row-less, and reading that miss as "url peer" composed a
direct address from a `url` this function had just rewritten to the forward's own
loopback: an enabled button promising "no tunnel needed" at a port on the
operator's machine that nothing binds.

`direct` tracks KIND, not reachability — a peer whose tunnel is merely down is
still not direct, which is why it is derived from the settings record here rather
than from `TunnelManager.urlFor` two lines below.

## openPeerWeb

The `webHost` check runs ahead of the `destinationOf` check (t923), so a url peer
whose hello reports no web frontend is told that, rather than being told
something about transports.
