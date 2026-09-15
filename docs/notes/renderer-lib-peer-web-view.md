# renderer/lib/peer-web-view.js

## webViewAffordance

t923: a url-kind peer's arm returns an ENABLED 'open' button whose tip carries
the address, composed by `directWebUrl` — the same function `peer-wiring.js`
pops. One producer on purpose: the previous version of this tip promised
something main did not do, which is the rot `test/peer-web-view.test.js` records
as "true when written".

The disabled arm survives only for a peer whose own url cannot be read, where
there is genuinely no address to offer. It stays a shown-but-disabled button
rather than a hidden one for the original t30 reason: a missing button reads as
"this box has no web UI", a different and false claim.

The address in the tip is NOT written into the result's `url` field. That field
means "a live forward reports this", which the renderer's own `phase === 'open'`
close-tip reads; widening it would make the two meanings indistinguishable to
every consumer.

t925: which arm a closed-phase peer takes is read from `status.direct`, set by
`peer-wiring.js`'s `resolvePeerUrls` from the same `destinationOf` main routes a
click with. The tunnel ROW cannot answer it: `peers-ui.js`'s `onPeerState` paints
before `peerList()` seeds the rows, so a row's absence means "not yet" as often
as "no transport" — and reading a miss as "url peer" gave an ssh peer an enabled
button pointing at our own loopback. `isForwardablePeer` was that miss-read and
is gone; `isSshPeer` remains for the deploy flow, which is genuinely ssh-only.

## transportPhrase

Names the forward being opened, so it is asked of the tunnel row and not of
`status.direct` — by the time any arm using it renders, a row exists.
