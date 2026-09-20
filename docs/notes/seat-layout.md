# seat-layout.js

## DEFERRED_KINDS

The membership criterion: a kind belongs here while ANY operator over its shared
parent dir refuses or destroys a symlink. Removing an entry is not a tidying
edit — it ships that operator's misbehaviour to every migrated seat, silently,
so each removal goes in the same release as its reader's repair.

`memory` — `memory-store.agents()` filters `readdirSync` Dirents on
`isDirectory()`, FALSE for a symlink, and it is the only caller feeding the
engine's `liveKeys` union; `hint-embed`'s `flush` deletes every vector key
outside that set, so a linked `library/memory/<seat>` prunes the whole cache and
re-embeds it on the next backfill, forever — the measured pathology
`hint-embed.js` says it already fixed once. The memory viewer's
realpath-equals-self check refuses the same link.

`messages` — `sweepSpilledMessages` takes the same `isDirectory()` Dirent
branch, and its else-branch `statSync` FOLLOWS the link to a directory whose
mtime is almost always past `MSG_MAX_AGE`, so the 5-minute sweep `unlinkSync`s
the SPELLING: the migrated files strand under `sessions/<seat>/messages`, the
next spill mkdirs a fresh real dir, and every pointer already delivered to a seat
dangles. While the link does survive, the per-seat GC is off entirely.

`pending` — `drainPending` claims with `renameSync(dir, claim)` and ends with
`rmSync(claim)`. On a symlink both act on the LINK: the seat un-migrates itself
at the first drain and every delivered `.json` survives inside
`sessions/<seat>/pending`, against the destructive-claim invariant. Its repair
must land BEFORE anything mints a `pending` link — claim through
`realpathSync`, or rename the target rather than the name — or the day the link
appears it points at a directory of already-delivered mail and re-delivers all
of it.

## migrateSeatLayout

Direction is load-bearing: where a kind has moved, `sessions/<seat>/<kind>` is
the real directory and the old spelling is the symlink, never the reverse. Three
generated hook bodies
(`pending.sh`, `ipcdelta.sh`, `notices.sh`) build the shared-root path in bash
and are byte-pinned, and every transcript and memory already written teaches
agents `~/.clodex/messages/<seat>/`.

`run` is the one kind that is DELETED rather than moved. It is regenerated at
every spawn and `rm -rf`'d at every exit, so at bootstrap — the only time this
runs — it is residue from the last exit; moving it would carry a dead socket and
a stale registry entry into the home nothing cleans.

The marker is GLOBAL and written AFTER the per-seat loop, so a throw before that
point leaves it absent and the next launch retries. A per-kind failure is logged
and skipped instead: whatever did not move is still readable at its old spelling,
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
spawn writes through a dangling name. Not every `run/` mint site calls this —
`session-manager.js`'s `--settings` path and `agent-transport.js` still
`ensureDir(runDirFor(...))` bare — so such a seat gets a real `run/<seat>` and
stays exempt; harmless while `cleanupClaudeHook` names both spellings, but
nothing may assume `run/` is a link.

A legacy path that exists and is NOT a symlink is left alone — it is either a
seat created while the marker was absent or a foreign directory, and replacing
it would destroy state nothing has copied yet.
