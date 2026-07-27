# t51 — tunnel-supervisor rework (REWORK on t49)

Branch `tunnel-supervisor-rework` off master `6f97a8d`. Follow-up commit; the
t49 merge (`803233d`) stays.

---

## MUST-FIX — per-child async work on per-instance slots

Confirmed on the tree. `_probeWake` (`:211`) and `_probing` (`:215`) are single
slots, and `_spawnOn` (`:395-397`) starts one `_probeThenAnnounce` PER CHILD.
Two loops alive at once make both slots lie.

**A third slot has the same defect and is not in the ticket: `_probeTimer`**
(`:210`). L2's sleep overwrites it, so `stop()` clears only the last loop's
timer and every earlier loop's timer survives teardown — a live handle holding
the event loop open past `stop()`. Same class, same fix, so it is taken in the
same pass rather than left as the one member of the family still standing.

### The judgement (the reviewer proposed a `Set` of wakes + identity-checked
### `.finally`; the ticket said judge it, don't copy it)

The property to implement is the one the `bornAt` closure gave D2: **per-child
async state lives with the child.** Two observations decide the shape.

1. **A pure closure cannot work here, and the reason is not cost.** `bornAt` is
   read only by the loop that owns it, so a closure suffices. `_probeWake` is
   read from OUTSIDE the loop — `stop()` must reach every sleeping loop. A
   supervisor that wakes N loops must hold N references; there is no closure
   arrangement that lets `stop()` reach a variable it has no name for. So a
   collection is forced on the wake side. That is the one place the reviewer's
   instinct and mine agree, and it agrees for a reason rather than by taste.

2. **An identity-checked `.finally` does NOT satisfy `settled()`'s contract.**
   It fixes only the direction the reviewer measured — L1 finishing after L2
   started no longer nulls a slot holding L2. Run the loops the other way and
   the wrong answer comes straight back: `_probing` holds L2, L2 finishes,
   `settled()` resolves, L1 is still probing. The contract at `:243-248` is
   "resolves when no readiness announcement is outstanding", which is a
   statement about ALL of them. One slot cannot express it however carefully it
   is guarded. So the promise side needs a collection too.

Both collections are keyed by the same thing — one live probe loop — so they
are ONE collection of per-loop records, not two parallel sets that can drift:

```js
this._probes = new Set();   // { wake, timer, done } per live loop
```

`_probeWake`, `_probeTimer` and `_probing` are deleted outright. That is the
part worth stating: the fix is not three guards added, it is three shared slots
removed. A slot that no longer exists cannot be clobbered by the next child,
which is the same argument the closure made for `bornAt` — reached by the only
route open to state something outside the loop must read.

`settled()` becomes `Promise.all([...this._probes].map((p) => p.done))`. It
snapshots at call time, exactly as the single slot did: a loop STARTED after the
call is not awaited. Unchanged semantics, now stated in the comment.

---

## NITs

1. **`giveUpMs: 0`** (`:221`) — `if (this._giveUpMs)` → `if (this._giveUpMs != null)`.
   Behaviour lost in a move; the pre-merge web side used `Number.isInteger`.
2. **`_spawnOn`'s catch** (`:349-352`) — add `this._releasePort()`. Third death
   path, and D5's whole point was "both paths or neither"; this makes it three
   of three.
3. **`child.on('error')`'s `mine()`** (`:364`) — untested. Mirrors the D3 test.
4. **`pickFreePort` export** (`:465`) — DROPPED. Nothing consumes it, it was not
   on the pre-merge surface, and `cli/src/transport.js:221` already exports a
   `pickFreePort` with a DIFFERENT signature (promise-returning, no callback).
   Two same-named exports of different shapes in one repo is a miswire waiting
   for someone to import the wrong one. See NIT 7 for why the test does not need
   it either.
5. **Docs** — `docs/architecture.md:205` and `docs/peering.md:11,96`.
6. **Two journal corrections** into `tasks/tunnel-supervisor/journal.md`.
7. **The D1 test's vacuity risk** — real, but the export is not the seam. Even
   exported, `_spawnTunnel` closes over the module-local `const`, so reassigning
   `exports.pickFreePort` would change nothing; the reviewer's proposal could not
   have worked as written. The seam that DOES work is `net.createServer`, looked
   up on the required module object at call time. The test stubs that and hands
   out two known-distinct ports.

---

## Journal (write-ahead)

- **Phase 1 — read + judge.** Done. Shape above; `_probeTimer` found as a third
  instance of the same class and folded in.
- **Phase 2 — product edits.** `tunnel-supervisor.js` (MUST-FIX + NITs 1, 2, 4),
  docs (NIT 5), t49 journal corrections (NIT 6).
- **Phase 3 — tests.** DONE (written): `test/tunnel-supervisor-overlap.test.js`,
  4 tests. Overlapping loops (both defects, one test — see below); stale `error`
  (NIT 3); `giveUpMs: 0` (NIT 1); D1 de-vacuumed (NIT 7).
- **Phase 4 — DONE.** Six revert proofs, all failing BY MESSAGE, pristine copy
  restored between each. Table below. Then full suite, two commits, report.

### Revert proofs

| # | reverted | fails | message |
|---|---|---|---|
| A | `_probeWake` back to a single slot (set-of-records kept) | overlap test, 2nd assertion | "the live loop is still parked on a sleep whose timer stop() cleared" |
| B | `_probing` back to a single slot | overlap test, 1st assertion | "settled() resolved while a readiness loop is still outstanding" |
| C | `if (this._giveUpMs)` | giveUpMs-0 | "asked for a bound of zero and got an unbounded retry instead — the tunnel is state 'up'" |
| D | `mine()` dropped from `child.on('error')` | stale-ERROR | "a third child was spawned on top of a live forward (spawns: 3)" |
| E | `_releasePort()` dropped from `_spawnOn`'s catch | sync-throw | "the spawn threw before anything bound it" |
| F | D1's `|| this._child` re-check | BOTH D1 tests (new + t49's) | "reports port 40002 but its child forwards 40001" |

A and B each isolate ONE assertion of the overlap test, which is what makes it a
two-defect test rather than one test wearing two labels. F fires on the t49 test
too, and the new one names the ports it was handed — 40001/40002, the stub's —
so the assertion is visibly not the trivial one.

### The window check caught a green-over-the-defect, and it was mine

**Revert A initially PASSED.** The overlap test as first written (`BACKOFF_MS`
300) was green with the wake defect fully restored. A direct trace showed why:
the window in which one loop is finished and the other ASLEEP has width
`BACKOFF_MS`, and the pending-assertion spends 200ms of real time inside it. At
300 the clock ran past L2's own wake before `stop()` landed, so L2 resolved for
its own reasons and the wake was never exercised. Fixed by widening the window
to 800 — the width, not the entry point, is the number that matters — and by
re-asserting `probed.length === 2` immediately before `stop()`, which is the
moment it has to hold. Revert A then failed by message.

Worth naming plainly: this is the eighth occurrence this run of a test that
would have shipped green over the very defect it names, and the FIRST one that
the revert proof alone would not have caught — the proof caught it only because
the proof was run. A window bound checked at entry and not at the moment of the
assertion is not a bound.

### Ticket item taken beyond its text, flagged

NIT 2 (`_spawnOn`'s catch has no `_releasePort()`) was marked cosmetic and
one line. It got a test as well (`D5: … SYNCHRONOUSLY too`), because it is the
THIRD member of a family whose other two are individually pinned, and D5's whole
content is "both paths or neither". Two pinned and one not is how it comes back.

### Why the overlap test carries TWO assertions rather than being two tests

The ticket's path A (a wake taken from the live loop) is invisible from outside
except through `settled()` — the t49 journal said so itself: "Bounded and
invisible: no timer remains, so nothing fires and no behaviour changes." So a
test of A alone, written against the PRE-fix code, would find `settled()`
already resolved (path B nulled the slot) and pass while parked. A is only
observable once B is fixed. Hence one test, in one window, with two assertions:
`settled()` must be PENDING before `stop()` (pins B) and must RESOLVE after it
(pins A). Each is revert-proofed separately in phase 4 — B by restoring the
single `_probing` slot, A by restoring the single `_probeWake` slot.

### Deviation from the ticket's test sketch, flagged

The ticket said "assert `settled()` does not resolve until both are done". The
test asserts it does not resolve while ONE is done and the other is outstanding,
which is the reachable half — the pre-fix code's wrong answer is exactly "the
first finished, so nothing is outstanding". Waiting for both to genuinely finish
and then asserting resolution is the second assertion, reached through `stop()`
rather than by letting a 60s probe timeout run.

### Window arithmetic (both bounds machine-checked, not hoped for)

`pollMs` 1000 > `backoffMinMs` 300, per the ticket. L1 sleeps [0,1000]; child1
killed at ~0 mid-sleep; child2 at ~300 starts L2, which sleeps [300,1300].
Assertions are taken at ~1100 — inside (1000, 1300). Lower bound asserted as
`Date.now() - firstProbeAt > POLL_MS` (L1 has finished), upper as
`probed.length === 2` (L2 has not re-woken). A slow machine fails one of the two
by message naming which side went wrong, rather than passing vacuously.
