# suite-snapshot.js

## snapshotTree
The snapshot commit's message carries `index-tree <sha>`, so the same working tree over a different staged state mints a different `snap`; the commit dates are fixed in `SNAP_IDENT`, so the same tree, index and HEAD always mint the same `snap`.

## materialize
The far index is the near index's tree (`read-tree -m <indexTree>`), not a reset to HEAD: far `git status --porcelain` equals the near one, staged-only changes included. A near index with unmerged entries cannot `write-tree`; `indexTree` falls back to HEAD's tree.

## ingestPack
`git index-pack --strict` refuses a pack whose prerequisites are missing with "did not receive expected object", indistinguishable by exit code from a corrupt pack; `--fsck-objects` plus the `rev-list --objects` connectivity check separates `bad-pack` from `incomplete` (git 2.52).
