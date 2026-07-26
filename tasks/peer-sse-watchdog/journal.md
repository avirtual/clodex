# t41 — port the sse-guard staleness watchdog to peer-client

Branch `peer-sse-watchdog` off master `1ff7fbc` (v4.3.2). Worktree
`/Users/bogdan/projects/tmux/wb-wrap-ui-hand`. Baseline 2729, ESCAPES: 0.

Standalone defect fix found during t40. NOT unification work: the stores are
untouched, and nothing here refactors toward a shared client.

## Timing evidence — checked the server, as asked

`remote.js:34` — `SSE_HEARTBEAT_MS = 25000`. `:163-172` writes `': ping\n\n'` on
one interval to BOTH feeds: `this._clients` (the events stream) and every
response in `this._attach` (each attach stream). **One cadence, both call sites,
no per-stream variation** — so sse-guard's 60s (>2x 25s) transfers exactly, and
`STALE_MS` is imported rather than restated. Nothing found suggesting the peer
stream heartbeats differently.

## Reuse vs port — REUSE, with the reasoning

**Imported `makeWatchdog` + `STALE_MS` from `cli/src/sse-guard.js`.**

The wall clodex asked about is real but it does not run where the question
assumed. The established direction is app → `cli/` as a LEAF: `peer-tunnel.js:35`
and `web-tunnel.js:73` already require `cli/src/transport`, `cli/` never requires
an app file, and `cli/` ships in the DMG (`build.files`, pinned by t39's layer 1).
This import is the same direction and the same shape as two that already exist.

What made it safe to take now rather than after an L3 design:

- `makeWatchdog` is a **pure timer leaf** — 10 lines, closes over nothing, no
  `CliError`, no client, no transport. Requiring it does not pull sse-guard's
  reconnect policy (`openGuarded`) across, which is the part that would have
  pre-judged L3. `require('./cli/src/sse-guard')` does load `./errors` — 40
  lines, zero requires of its own, so the closure stays trivial.
- `STALE_MS` is the piece I actually wanted single-sourced. It is a number whose
  correctness depends on a constant in a THIRD file (`remote.js`'s 25s). Two
  copies of that relationship is the drift this fix is about.

**What a port would have drifted:** the 60s/25s relationship, silently — a change
to the server heartbeat would be reconciled against the CLI's copy and not the
GUI's, which is precisely how the original defect survived (the fix existed, on
the other side, for the whole time the bug was live).

**What I did NOT reuse:** `openGuarded`. It owns bounded reconnect (3 tries then
give up), and peer-client's policy is the opposite by design — offline is calm
and retries are unbounded (`peer-client.js:8-9`). Taking it would have changed
supervision under cover of a defect fix. The watchdog fires into peer-client's
OWN existing `onClose`, so a watchdog-driven reconnect lands in exactly the same
place a socket-error one does. That was the ticket's requirement and it is what
made the small import sufficient.

## The change (`peer-client.js`, +62/-4)

- Import `makeWatchdog, STALE_MS`.
- Constructor takes `staleMs` + `timers`, both test-only seams; production uses
  `STALE_MS` and the global timers.
- `_sse` gains a **one-shot `close()` door** and arms a watchdog after the 200,
  petting it on **every chunk before framing**.

Both call sites are covered because both go through `_sse`: `_openEvents` (:223)
and `_openAttach` (:288). Neither consumer's onClose changed — the events path
still resyncs sessions on reopen, the attach path still emits `peer-control null`
and re-acquires.

## Verification

`TOTALS: 2732 pass, 0 fail` / `ESCAPES: 0` (2729 → 2732, +3). Read from
`npm test` directly. `npm run build:web` not run — no bundled source touched.

### Revert proofs — all BY MESSAGE, none by crash

| revert | result | message |
|---|---|---|
| A: no watchdog armed (the pre-fix state) | all 3 fail | `timed out waiting for: the … events stream to open and arm its staleness timer` |
| B: pet on PARSED EVENTS instead of on chunks | **test 2 only** | `timed out waiting for: the heartbeat chunk to re-arm the watchdog` |
| C: drop the one-shot `closed` guard | **test 3 only** | `one stale attach stream produced exactly one peer-control(null) emit — 2 !== 1` |
| D: watchdog destroys but does not call `close()` | **all pass** | see below |

Every `waitFor` carries a label, so a failure names the condition that never
arrived rather than reading `Error: timeout`. That was not the first draft — the
first run of revert A produced three bare timeouts, which is a failure nobody
could diagnose.

### Window statements (each test proven to enter its own window, separately)

- **Test 1 — a live stream delivering nothing, past the deadline.** Unreachable
  by any pre-fix path: `end`/`error` never fire, which is why the bug survived.
  Revert A is the pre-fix state and it fails here.
- **Test 2 — bytes carrying NO parsed event, arriving inside the bound, twice.**
  Proven separate by **revert B, where test 2 fails ALONE and 1 + 3 stay green**.
  That is the test's whole reason to exist: an implementation that petted on
  parsed events would pass test 1 and kill every idle session every 60s.
- **Test 3 — the attach call site, with both death paths racing.** Proven
  separate by **revert C, where test 3 fails ALONE**.

### Two corrections I made rather than shipping

1. **The silent server initially never armed anything.** Node holds headers back
   until the first body write, so a truly silent response leaves the client
   *pending*, not half-open — the test would have passed for the wrong reason.
   Fixed with `res.flushHeaders()`: a live 200 with zero body bytes, which is the
   actual condition. Caught because I asserted `clock.pending() === 1` rather
   than trusting that arming had happened.
2. **Test 3 first asserted on a reconnect COUNT, and revert C passed.** A double
   close is invisible in a reconnect count: both `_openEvents` and `_openAttach`
   re-entry-guard themselves, so the second close's reconnect finds a live
   request and returns. I instrumented `onClose` directly to check whether the
   guard was doing anything at all — **it is: without it the door is walked
   twice.** What is not absorbed is everything onClose does *before* scheduling,
   so the test now asserts on the attach path's `peer-control null` emit and the
   doubled backoff. This is the ticket's "green while asserting nothing" case,
   and it was live in my own first draft.

### Revert D — stated honestly rather than papered over

Removing the watchdog's explicit `close()` keeps all three tests green: in
practice `req.destroy()` raises `'error'`, which reaches the door on its own. So
that line is **not independently proven** by this suite. I kept it as the
guarantee for the case where the destroy raises nothing (a request already past
its own teardown), and the module comment now says exactly this rather than
implying it is load-bearing. The redundancy is also why the one-shot guard is
mandatory rather than tidiness — and the guard IS proven, by revert C.

## Progress

- [x] server-side heartbeat evidence
- [x] reuse-vs-port decision
- [x] implement (both call sites, existing reconnect path)
- [x] 3 tests, 4 reverts, window statements
- [x] suite green at 2732, ESCAPES: 0
