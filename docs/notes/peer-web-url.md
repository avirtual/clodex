# peer-web-url.js

## directWebUrl

t923. Required by both `peer-wiring.js` (the main-side pop) and
`renderer/lib/peer-web-view.js` (the tip that promises it), so the sentence in
the tooltip and the address the browser is sent to have one producer and cannot
drift apart. That drift is what made the previous version of this tip false
(`test/peer-web-view.test.js` records it as "true when written").

It sits at the repo root rather than under `renderer/lib/` because main requires
it; the web bundle picks it up anyway, since `build/build-web.js` follows the
require graph from `renderer/web/boot.js` (same mechanism as `drawer-avail.js`).

Path and query on the peer record are dropped, not carried: the record's url is
the wire endpoint Clodex dials for `/api/peer/*`, and its path is that API's
prefix, not a location in the web frontend served on a different port. The
scheme is kept from the record, so an https peer gets an https link — the port
moves, nothing else does.

`new URL` normalises an IPv6 host to bracketed form in `hostname`, which is
already the form a URL needs, so recomposition is safe for those too.
