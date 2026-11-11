# suite-snapshot.js

## snapshotTree
The snapshot commit's message carries `index-tree <sha>`, so the same working tree over a different staged state mints a different `snap`; the commit dates are fixed in `SNAP_IDENT`, so the same tree, index and HEAD always mint the same `snap`.
The index copies keep the real index's mtime: git re-reads an entry whose mtime is not older than the index file's (racy-clean), and a copy stamped "now" would trust a stale stat and snapshot old content.
What does not travel: gitignored files, empty directories, submodule contents, LFS payloads, local branches other than the trunk and the current one, `.git/info/exclude`.

## materialize
The far index is the near index's tree (`read-tree -m <indexTree>`), not a reset to HEAD: far `git status --porcelain` equals the near one, staged-only changes included. A near index with unmerged entries cannot `write-tree`; `indexTree` falls back to HEAD's tree.

## ingestPack
`git index-pack --strict` refuses a pack whose prerequisites are missing with "did not receive expected object", indistinguishable by exit code from a corrupt pack; `--fsck-objects` plus the `rev-list --objects` connectivity check separates `bad-pack` from `incomplete` (git 2.52).

## keepRefs
Each job keeps `refs/keep/job/<stamp>-<id>` (the snapshot commit) and `refs/keep/index/<stamp>-<id>` (its index tree), plus `refs/keep/trunk`; the stamp is zero-padded so a name sort is age order and the oldest beyond `KEEP_JOBS` are dropped. `mirrorHave` answers only commits reachable from these refs: a commit left by a failed ingest may lack its history.
