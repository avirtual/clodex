# docs/notes/session-manager.md

## writeBundles

`writeBundlePlugins` and `getPluginBundles` are taken BOTH-or-NEITHER: a partial
deps object (a test, the plugin harness) supplying only the catalog read would
call an absent writer, which throws before any `args.push` and surfaces as a
spurious operator-facing warning about scaffolding. Same asymmetry as `tiersOf`,
and the safe direction is the same — contribute nothing.
