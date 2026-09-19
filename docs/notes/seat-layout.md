# seat-layout.js

## migrateSeatLayout

Direction is load-bearing: `sessions/<seat>/<kind>` is the real directory and
each old spelling is the symlink, never the reverse. Three generated hook bodies
(`pending.sh`, `ipcdelta.sh`, `notices.sh`) build the shared-root path in bash
and are byte-pinned, and every transcript and memory already written teaches
agents `~/.clodex/messages/<seat>/`.

`memory` is DEFERRED and not migrated at all. `memory-store.agents()` filters
`readdirSync` Dirents on `isDirectory()`, which is FALSE for a symlink, and it is
the only caller feeding the engine's `liveKeys` union; `hint-embed`'s `flush`
deletes every vector key outside that set, so a linked `library/memory/<seat>`
prunes the whole cache and re-embeds it on the next backfill, forever — the
measured pathology `hint-embed.js` says it already fixed once. That reader and
the memory viewer's realpath-equals-self check are repaired together, so the move
goes with them rather than ahead of them.

`run` is the one kind that is DELETED rather than moved. It is regenerated at
every spawn and `rm -rf`'d at every exit, so at bootstrap — the only time this
runs — it is residue from the last exit; moving it would carry a dead socket and
a stale registry entry into the home nothing cleans.

The marker is GLOBAL and written AFTER the per-seat loop, so a throw before that
point leaves it absent and the next launch retries. A per-kind failure is logged and
skipped instead: whatever did not move is still readable at its old spelling,
and a seat that never migrates keeps working unchanged. A seat absent from the
name list at that single boot is likewise never migrated and never adopted
afterwards — `ensureSeatLink` correctly leaves its real dir alone — so a mixed
tree is the expected steady state, not a transient.

## ensureSeatLink

Inert until the marker exists, and inert for a `DEFERRED_KINDS` kind always.
Before migration the old spelling is still the real dir everywhere, and minting a
link there would race the rename that is about to claim it.

A legacy path that is a real dir is refused BEFORE either mkdir, so an exempt
seat mints no empty `sessions/<seat>/<kind>` nothing will write to. A path that
is already a LINK still falls through the mkdirs: cleanup drops the target at
every exit while the link survives, so the target must be re-made or the next
spawn writes through a dangling name. Not every `run/`
mint site calls this — `session-manager.js`'s `--settings` path and
`agent-transport.js` still `ensureDir(runDirFor(...))` bare — so such a seat gets
a real `run/<seat>` and stays exempt; harmless while `cleanupClaudeHook` names
both spellings, but nothing may assume `run/` is a link.

A legacy path that exists and is NOT a symlink is left alone — it is either a
seat created while the marker was absent or a foreign directory, and replacing
it would destroy state nothing has copied yet.
