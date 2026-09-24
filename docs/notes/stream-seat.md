# stream-seat.js

## spawnStreamSeat

Spawned `detached: true` so the child leads its own process group: `groupKill` signals `-pid`, which reaches the CLI's tool children without ever reaching Clodex's own group. A pipe child gets no SIGHUP when Clodex dies (unlike a pty), and SIGKILL to the leader alone leaves its tool children running (measured, headless-seats.md §0.5).

## groupKill

Refuses a non-positive pid before negating it: `-0` and `-(-1)` would be broadcasts. Censused in test/sigkill-pid-census.test.js.
