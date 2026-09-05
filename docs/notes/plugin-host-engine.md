# plugin-host-engine notes

## register

`opts.shipped` is the LOADER's root (`plugin-loader.js` passes
`rec.root === 'core'`), never a manifest field — a plugin that could call
itself shipped would grant itself reach to seats with no plugin list.

## catalog

`shipped` is a BOOLEAN rather than the loader's root id: every renderer
question off it is "does an absent seat list reach this?".

## updateBundle

The bundle a seat gets is served from the `registered` record, written at
`register()` time — not re-read from disk at spawn. `rescan()` does not
re-register a plugin that is already running, so without this an edited skill
would ship its old body until the app restarted. Content only: refreshing the
MODULE this way would launder stale require-cached code into looking fresh.
The loader decides WHEN to call it — see docs/notes/plugin-loader.md.

## catalog

Carries names and the plugin's `dir`, never a content BODY: this row is read by
every renderer at startup, and a body here would broadcast every plugin's whole
bundle to each window. The drawers read a body they are about to edit through
`file:peek` against `dir` instead. Pinned by test/plugin-prompt-bundles.test.js.

## hostMethods

`installFromSource`/`applyUpdate`/`removeSourcePlugin` call the shared
`rescanAndAnnounce()` on success, same helper `plugins.rescan` uses, instead
of hand-rolling `announceState`. Its own try/catch is SEPARATE from the
loader call's: a rescan throwing after the disk change already committed
must not report the install/update itself as failed, so that path answers
`ok:true` with a `rescanError` field instead of an error envelope. A running
plugin's `applyUpdate` still announces nothing on success: that is `rescan`'s
CHANGED case (restart-required), not a fresh load.
