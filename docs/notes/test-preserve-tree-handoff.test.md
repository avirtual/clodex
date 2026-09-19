# test/preserve-tree-handoff.test.js

## reuseSeed

Gives `createEngine` a `registryDir` it finds ALREADY SEEDED. The first engine
in the process pays the shipped-library seed; every later world gets a byte copy
of the result, and `stores.js`'s seeder then hashes each dest against its
recorded stamp, matches, and writes nothing.

Measured: the seed is 27 files through `atomicWriteFileSync`, 312 ms of the
386 ms a fresh `createEngine` costs, and all of it fsync. fsync queues behind
every other writer on the box, so three worlds re-seeding put this file's
subjects at 7.1 s under a concurrent suite against 0.8 s alone — past
`scripts/run-tests.js`'s 6 s bar, having measured the disk rather than the
guard.

Copied rather than shared: each world's engine WRITES its own records into the
registry, and one shared directory would leak one subject's rows into the next.

## captureSeed

Snapshots the first world's registry the moment its engine is built, before
anything else touches it, so the template holds the seeded library and nothing
world-specific. `team.json` is rewritten by every `mkWorld` at the same path
after the copy lands, and the per-project `tasks/` tree does not exist yet at
capture time.
