# plugin-host-engine notes

## register

`opts.shipped` is the LOADER's root (`plugin-loader.js` passes
`rec.root === 'core'`), never a manifest field — a plugin that could call
itself shipped would grant itself reach to seats with no plugin list.

## catalog

`shipped` is a BOOLEAN rather than the loader's root id: every renderer
question off it is "does an absent seat list reach this".

## updateBundle

The bundle a seat gets is served from the `registered` record, written at
`register()` time — not re-read from disk at spawn. `rescan()` does not
re-register a plugin that is already running, so without this an edited skill
would ship its old body until the app restarted. Content only: refreshing the
MODULE this way would launder stale require-cached code into looking fresh,
which is exactly what the restart-required badge exists to prevent. The loader
decides WHEN to call it — a moved or unreadable plugin is skipped, see
docs/notes/plugin-loader.md.

## catalog

Carries names and the plugin's `dir`, never a content BODY: this row is read by
every renderer at startup, and a body here would broadcast every plugin's whole
bundle to each window. The drawers read a body they are about to edit through
`file:peek` against `dir` instead. Pinned by test/plugin-prompt-bundles.test.js.

## hostMethods

The five `plugins.*Source*` rows each wrap their own `await` in try/catch:
dispatch's `_host` branch try/catches `hf(...args)` synchronously, which
cannot catch a later promise rejection. `installFromSource`/`applyUpdate`/
`removeSourcePlugin` call the shared `rescanAndAnnounce()` on success, same
helper `plugins.rescan` uses, instead of hand-rolling `announceState`. A
running plugin's `applyUpdate` still announces nothing: that is `rescan`'s
CHANGED case (restart-required), not a fresh load.
