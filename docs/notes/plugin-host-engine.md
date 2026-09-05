# plugin-host-engine notes

## register

`opts.shipped` is the LOADER's root (`plugin-loader.js` passes
`rec.root === 'core'`), never a manifest field. Only the loader may widen a
plugin's reach to the seats that have no plugin list — a plugin that could call
itself shipped would grant itself exactly that.

## catalog

`shipped` is a BOOLEAN rather than the loader's root id: every renderer question
off it is "does an absent seat list reach this", which the boolean answers
directly.

## updateBundle

The bundle a seat gets is served from the `registered` record, written at
`register()` time — not re-read from disk at spawn. `rescan()` does not
re-register a plugin that is already running, so without this an edited skill
would ship its old body until the app restarted. Content only: refreshing the
MODULE this way would launder stale require-cached code into looking fresh,
which is exactly what the restart-required badge exists to prevent.
