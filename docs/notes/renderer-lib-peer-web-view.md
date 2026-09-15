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

## isForwardablePeer

Still the routing question for the tunnel arms, but no longer a gate on whether
the button works at all — since t923 both answers open something.
