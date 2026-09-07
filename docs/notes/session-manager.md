# docs/notes/session-manager.md

## writeBundles

`writeBundlePlugins` and `getPluginBundles` are taken BOTH-or-NEITHER: a partial
deps object (a test, the plugin harness) supplying only the catalog read would
call an absent writer, which throws before any `args.push` and surfaces as a
spurious operator-facing warning about scaffolding. Same asymmetry as `tiersOf`,
and the safe direction is the same — contribute nothing.

## move

`--resume <id>` is NOT confined to the transcript's project directory. Measured
against the real `claude` binary (Claude Code 2.1.261, 2026-09-07): a conversation started in
one directory resumed successfully from an unrelated one, replaying 27,717 cached
tokens, with the transcript left under the ORIGINAL project dir. So a moved seat
keeps its conversation and no transcript is copied. An id that does not exist
anywhere is a different case — the CLI prints "No conversation found with session
ID: <id>" and exits nonzero, which happens AFTER `create()` has returned, so a
move cannot detect a bad resume id and report it.

## _renameDirs

`run/<name>/` is absent from the list on purpose. `cleanupClaudeHook` rm -rf's it
on every exit path, including the kill `rename` performs, and `create()` rebuilds
it under the new name — so moving it would race a delete that is already running.
The six dirs listed are exactly those that live at the `~/.clodex` ROOT precisely
because they must outlive the run dir.
