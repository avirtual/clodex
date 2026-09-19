# test/hint-arm.test.js

## mkUnits

Builds the composite subject's 841-unit corpus in memory instead of through 841
`store.remember()` calls. `listUnits` is an injected seam on both retrievers, so
the store was never the subject in `composite: pooling lets a big corpus SILENCE
a small one` — only corpus SIZE is, and size is what `rank`'s two cuts read.

Each `remember()` is an fsync'd `writeFileSync` and each `list()` a readdir plus
841 reads: ~100 ms of real work on an idle box, but fsync queues behind every
other writer. Measured under a concurrent suite the subject took 19.5 s, past
`scripts/run-tests.js`'s 6 s bar, as a test of pure arithmetic. After: 11 ms
loaded.

`learned_at` is stamped monotonic and distinct so `list()`'s `learned_at` sort
is reproduced exactly. The store's own stamps are millisecond-resolution, tie in
bulk, and fall back through V8's stable sort to insertion order — which is the
order `mkUnits` already emits.

Shape parity with `store.list()` is pinned by the test `the in-memory corpus
builder carries the same unit shape store.list() returns`, not assumed: a field
`mkUnits` omits that `rank` later starts reading would otherwise make the fast
fixture quietly stop matching the real one.
