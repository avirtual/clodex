# docs/notes/plugin-update-watch.md

## createPluginUpdateWatch

`libraryCatalog`'s `upToDate` is not a per-plugin answer: `plugin-loader.js`
computes it against the LIBRARY REPO's head commit, so it goes false for every
installed plugin whenever any plugin in that repo moves. It is a candidate
filter only; `resolveUpdate(id)` fetches the plugin's own subpath and is the
confirmation. Badging on the flag alone puts a permanent false badge on every
installed row, which is worse than no feature.

## start

The first sweep is DEFERRED, not immediate: engine.js calls this at the
bootstrap tail, and a fetch there would sit on every launch's critical path —
and on every test that builds the real engine, which would then hit the
network.

## run

`resolveUpdate` is a tarball fetch and extract per plugin, so it cannot run on
a dialog paint and cannot run over an unbounded candidate set. Hence the cap
and the rotating cursor: a fixed first-N window would starve the tail forever.
A candidate not answered this run keeps its PRIOR verdict rather than
disappearing — an offline tick must not clear a real badge — while a row that
stops being a candidate is dropped without a fetch.

## drop

What makes a badge clear the moment the operator acts, rather than up to one
poll interval later: `run()` alone would leave the row reading
`Update available (1.2.0 → 1.2.0)` and the menu counting it until the next
tick. `plugin-host-engine.js` calls this from `plugins.applyUpdate` and
`plugins.removeSourcePlugin` after each succeeds. Dropping is correct at both:
`applyUpdate` refuses unless the freshly fetched commit matches the one the
operator accepted, so on success the tree is upstream by construction, and a
removed plugin has nothing left to update. It routes through `publish()`, so
the menu's `onChange` refires.
