# docs/notes/session-manager.md

## writeBundles

`writeBundlePlugins` and `getPluginBundles` are taken BOTH-or-NEITHER: a partial
deps object (a test, the plugin harness) that supplies only the catalog read
would push a `--plugin-dir` at a path nothing ever wrote. Same asymmetry as
`tiersOf`, and the safe direction is the same — contribute nothing.
