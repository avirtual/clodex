# seat-layout.js

## DEFERRED_KINDS

Empty. The membership criterion, for the next kind that needs it: a kind belongs
here while ANY operator over its shared parent dir refuses or destroys a
symlink. Adding an entry is cheap; removing one ships that operator's
misbehaviour to every migrated seat, silently, so each removal goes in the same
release as its reader's repair. The three original entries — `memory`,
`messages`, `pending` — were closed as follows.

`memory` and `messages` MOVED, with their readers repaired in the same release.
`memory-store.agents()` and `sweepSpilledMessages` both filtered `readdirSync`
Dirents on `isDirectory()`, FALSE for a symlink. All three readers now take a
symlink under ONE rule: its realpath is the migrated seat spelling for that same
name, `sessions/<n>/<kind>` — not the weaker "its target is a directory", too
wide a door for the sweep, the only reader that DELETES. Any seat with a
shell can write `messages/<x> -> ~/Desktop`, and the wide rule had the 5-minute
timer unlink every file directly inside whatever it named; under the narrow rule
such an entry falls to the unlink else-branch, whose blast radius is the link
name, since `unlink` does not follow. The two original failures were not
symmetric and both are pinned: `agents()` is the ONLY caller feeding the
engine's `liveKeys` union and `hint-embed`'s `flush` deletes every vector key
outside that set, so an empty list pruned the whole cache and re-embedded it
forever; the sweep's else-branch `statSync` FOLLOWED the link and
`unlinkSync`'d the SPELLING on a 5-minute timer. The memory viewer's
realpath-equals-self check is the third reader — see `resolveAgentDir` there.

`pending` is RULED OUT and stays at the shared root permanently. It is a
transient delivery queue, not seat state. Two independent claimers —
`drainPending` and the `pending.sh` hook body — claim by `renameSync(dir,
claim)` and finish by removing the claim, which on a symlink moves and then
deletes the LINK while every already-delivered `.json` survives inside the
target, to be re-delivered the day anything re-points the name. One of the two
is bash inside a byte-pinned hook, so it cannot be taught to claim through the
link without breaking the pin, and a second copy of the claim rule in two
languages is the drift this program exists to remove. `seatPathFor(root, n,
'pending')` therefore throws like any unknown kind, and a move-to-peer DRAINS
the queue rather than carrying it.

## migrateSeatLayout

Direction is load-bearing: where a kind has moved, `sessions/<seat>/<kind>` is
the real directory and the old spelling is the symlink, never the reverse. Three
generated hook bodies
(`pending.sh`, `ipcdelta.sh`, `notices.sh`) build the shared-root path in bash
and are byte-pinned, and every transcript and memory already written teaches
agents `~/.clodex/messages/<seat>/`.

`run` is the one kind DELETED rather than moved. It is regenerated at every spawn
and `rm -rf`'d at every exit, so it is residue; moving it would carry a dead
socket and a stale registry entry into the home nothing cleans; the migration
drops it at BOTH spellings, in either link direction (see seat-layout-run.md).

The marker is PER-KIND, and that is what makes un-deferring a kind a real
migration rather than a green suite. Under the original global one-shot marker, a
release that dropped a `DEFERRED_KINDS` entry migrated the kind on fresh tmp
roots in tests and did NOTHING on a box that had already launched:
`migrateSeatLayout` short-circuited on the marker and `ensureSeatLink` correctly
refuses a legacy path that is a real dir, which is exactly what those seats hold.
So the loop is kind-OUTERMOST: every kind not yet stamped runs over ALL names and
is stamped when its loop completes, and the record is rewritten each launch.

A kind is stamped even when a seat inside its loop threw. The alternative re-runs
that kind at every launch forever on a box with one bad seat, and buys nothing: a
per-kind failure is logged and skipped, whatever did not move is still readable
at its old spelling, and a seat that never migrates keeps working unchanged. A
seat absent from the name list when its kind was stamped is likewise never
migrated and never adopted after, so a mixed tree is the steady state.

A marker whose whole content is one ISO timestamp is the shape L-A wrote and
every box that ran it holds. It is read as `{ notices, promptcache, spill,
monitors, run }` stamped with that timestamp — the kinds L-A actually moved —
and rewritten in the record shape. Read as "nothing is stamped" it would re-run
those five; read as "everything is stamped" `memory` and `messages` would never
move on a box that had already launched. Anything else unparseable is ABSENT: a
marker we cannot read says nothing about what moved, and re-running is safe
because every kind skips a legacy path that is already a symlink.

## ensureSeatLink

Inert until the marker exists, and inert for a `DEFERRED_KINDS` kind always.
Before migration the old spelling is still the real dir everywhere, and minting a
link there would race the rename that is about to claim it.

A legacy path that is a real dir is refused BEFORE either mkdir, so an exempt
seat mints no empty `sessions/<seat>/<kind>` nothing will write to. A path that
is already a LINK still falls through the mkdirs: cleanup drops the target at
every exit while the link survives, so the target must be re-made or the next
spawn writes through a dangling name.

A legacy path that exists and is NOT a symlink is left alone — a seat created
while the marker was absent, or a foreign dir. `run` is reversed: seat-layout-run.md.

## renameSeat

One `renameSync` of the home, then the legacy spellings: old links UNLINKED,
fresh ones minted at the new name. Rename used to move the LINKS, leaving
`library/memory/<new>` → `sessions/<old>/memory` — a shape every L-B1 reader
refuses and the sweep unlinks, so a renamed seat went dark, state intact.

A REAL dir at a legacy path moves as a dir, no link (unmigrated kind; a link over
it would strand the contents) — UNLESS the new name's spelling is taken, when it
is left alone and reported in `failed`. Silence there SPLITS the seat: the home
travels while every reader and writer keeps using the legacy spelling, now naming
a stranger's dir. `rename()` refuses those spellings up front for the same reason
and this is the floor under it; that pre-check is lstat-based, so a DANGLING
`sessions/<new>` cannot slip past and make this throw after `persistence.rename`
ran. `run` is DELETED at both ends per the migration's rule; failures ride
`failed` rather than throwing, the rename having already happened.

## removeSeat

The home AND every legacy spelling, symlink or real dir. Delete Session… is the
one true delete (docs/sessions.md lifecycle table); before this it took `run/`
only, and the messages, promptcache, notices and memory left behind are what
rename's "already owns … a leftover" refusal exists to catch. `pending/<name>`
is untouched, per DEFERRED_KINDS. `spill/<name>` IS taken — a trade against
`clodex-paths.js`'s "outlives the seat": a transcript's spill stub into a
deleted seat renders one missing body, while exempting it leaks a dir per delete.
