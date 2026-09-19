# seat-layout.js

## migrateSeatLayout

Direction is load-bearing: `sessions/<seat>/<kind>` is the real directory and
each old spelling is the symlink, never the reverse. Three generated hook bodies
(`pending.sh`, `ipcdelta.sh`, `notices.sh`) build the shared-root path in bash
and are byte-pinned, and every transcript and memory already written teaches
agents `~/.clodex/messages/<seat>/`.

`run` is the one kind that is DELETED rather than moved. It is regenerated at
every spawn and `rm -rf`'d at every exit, so at bootstrap — the only time this
runs — it is residue from the last exit; moving it would carry a dead socket and
a stale registry entry into the home nothing cleans.

The marker is written AFTER the per-seat loop, so a throw before that point
leaves it absent and the next launch retries. A per-kind failure is logged and
skipped instead: whatever did not move is still readable at its old spelling,
and a seat that never migrates keeps working unchanged.

## ensureSeatLink

Inert until the marker exists. Before migration the old spelling is still the
real dir everywhere, and minting a link there would race the rename that is
about to claim it.

A legacy path that exists and is NOT a symlink is left alone — it is either a
seat created while the marker was absent or a foreign directory, and replacing
it would destroy state nothing has copied yet.
