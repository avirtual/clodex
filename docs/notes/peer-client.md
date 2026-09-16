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
a peer main now tunnels to.

## _probeDialect

t938: one fetch per hello IDENTITY, not per tick. `identityChanged` already
re-fires on a version or caps change, which is every way the far side's dialect
can move under a live connection, so a per-tick fetch would buy nothing at
fifteen round trips a minute per peer. A hello whose caps omit `resources` is
older than the document itself and is classified without any round trip.

## _openAttach

t938: while `needsUpgrade` is true no SSE is opened at all. Every attach against
such a node 404s, and the reconnect backoff would hammer it indefinitely; the
attach entry carries an error string naming the upgrade instead. Because that
skips arming the backoff timer, the guard needs a clearing edge — see
`_setNeedsUpgrade`.

## _setNeedsUpgrade

t938: clearing the flag re-opens every wanted attachment. `_probeDialect`'s fetch
is async, so on the hello that follows an upgrade the `wasOffline` re-open loop in
`_helloLoop` runs while the flag is still true and is refused; without this edge
the pane stays blank until the user detaches and re-attaches, because `attach()`
returns early for an already-wanted entry.
