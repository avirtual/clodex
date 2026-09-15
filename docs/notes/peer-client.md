# peer-client.js

## status

t925: `direct` is main's verdict on which route this peer's web view takes,
relayed for the renderer. It is not a wire field and nothing on this side reads
it — `peer-wiring.js`'s `resolvePeerUrls` computes it, `status()` carries it, and
`renderer/lib/peer-web-view.js` is its only consumer.

Read strictly (`=== true`), because the direct arm is the one that PRODUCES an
address: a status from a main that predates the field must fall to the tunnel
arms rather than compose one.

## sync

A `direct` change alone updates the connection IN PLACE and re-announces, rather
than joining the url/label/token list that restarts it. Nothing on the wire
depends on the flag, so a restart would shed every live attachment to carry one
boolean; but a silent no-op would leave the sidebar offering a direct address for
a peer main now tunnels to. Adding an `sshHost` to a url peer is exactly that
edit: it moves the route while leaving every restart field untouched.
