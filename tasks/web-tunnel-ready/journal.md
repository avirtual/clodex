# t37 — pop the browser only once the port ACCEPTS

Branch `web-tunnel-ready` off master `2daf24e` (has t36). Worktree
`/Users/bogdan/projects/tmux/wb-wrap-ui-hand`. Baseline 2714, ESCAPES: 0.

## The report

Operator, live against a real kubectl peer: "a quick blip when opening browser,
it opens it before the tunnel is fully formed, so there is an invalid page for
about half a second, but then the browser refreshes on its own."

## Diagnosis (given)

`_setState('up')` fires on "child alive". True enough for `ssh -N`; for
`kubectl port-forward` the process lives well before the forward accepts.
`firstUp` rides that emit and `peer-wiring.js:227` pops on it.

My own t36 comment anticipated this and left it, arguing the give-up cap
covered it. **That was right about correctness and wrong about this**: the cap
catches a tunnel that never comes up, not one that comes up 500ms late.

## Design

TCP-probe `127.0.0.1:<localPort>` until it accepts; gate ONLY `firstUp` on it.
Chosen over parsing vendor success lines (a per-kind pattern table is exactly
the vendor knowledge this layer avoids, and needs its own never-matched
fallback). Kind-agnostic, and tests the thing we care about: can a browser
connect yet.

### Constraints and how each is met

- **Only `firstUp` gates.** `_setState('up')` keeps firing on child-alive, so
  the UI phase, `sync()`, `_stableMs` and the give-up clock are all untouched.
  Consequence worth naming: `_setState` only emits ON CHANGE, so a deferred
  `firstUp` cannot ride it — the ready emit is its own `_onState` call carrying
  `{...status(), firstUp: true}`. Same shape the wiring already reads.
- **Bounded.** Reuse `WAIT_PORT_MS` (10s) from `cli/src/transport` — the bound
  the CLI already uses for this exact question. Injectable as `probeMs`.
- **Never outlives its child.** Each probe loop is tied to the child that
  started it; after every await it re-checks `this._stopped` and
  `this._child === child`. A child that exits mid-probe abandons the loop, and
  the respawn probes again (because `_opened` is still false).
- **'gave-up' still reachable.** The probe is alongside, never blocking; the cap
  fires off child exits as before.
- **No new dependency.** `portAccepts` is already exported by
  `cli/src/transport` — imported, not rewritten. Injectable as `probeFn`.

### The decision I had to make myself: what happens on probe TIMEOUT

The bound can lapse with the child still alive and the port still not accepting.
Two options:

(a) **pop anyway** — the operator asked for a browser; after 10s of trying, give
    them what they clicked. Worst case is today's behaviour (a page they can
    reload).
(b) **never pop** — the click produces nothing visible at all.

**Chose (a).** (b) turns a cosmetic blip into a silently swallowed request,
which is a worse failure than the one this ticket fixes. The emit carries
`ready: true|false` so peer-wiring can LOG which one happened — popping
unconfirmed is a fallback, and a fallback that cannot be told apart from the
happy path in the log is the "liveness signal that costs nothing to emit"
mistake in another costume.

### ssh: the honest tick

ssh does NOT pop synchronously any more — it pops on the FIRST probe attempt,
which is one async turn later. No polling delay (no `setTimeout` on the success
path), but it is not zero. Stated rather than claimed away, and pinned by a test
asserting the ssh pop needs exactly ONE probe call.

## Phase 2 — implemented

- `web-tunnel.js`
  - imports `portAccepts` + `WAIT_PORT_MS` from `cli/src/transport` (leaf
    direction unchanged); `PROBE_MS = WAIT_PORT_MS` (10s), `PROBE_POLL_MS = 100`.
  - constructor takes `probeFn` / `probeMs`; `WebTunnelManager` forwards both.
  - header gains **inversion 4** describing the pop/supervision split.
  - `_spawnOn` ends with `this._setState('up')` then
    `if (!this._opened) this._probeThenPop(child, port)`.
  - **`_probeThenPop(child, port)`** — loops `probe → sleep(100ms)` until accept
    or bound; `mine()` re-check after EVERY await (`!_stopped &&
    _child === child && !_opened`); emits `{...status(), firstUp, ready}`.
  - `_setState` lost its `extra` parameter — nothing passes one now, and leaving
    a parameter no caller uses is a trap for the next reader.
  - `stop()` clears `_probeTimer`.
- `peer-wiring.js` — the pop log distinguishes `ready: false`
  ("port never confirmed — opening anyway").

### Answers to the constraints, as shipped

- **Bound: 10s** (`WAIT_PORT_MS`, reused not invented).
- **UI phase NOT delayed.** `state:'up'` still fires on child-alive, so the
  button turns 'open' exactly as fast as before. Only the pop waits.
- **`_opened` is set at POP time, not spawn time.** So a child that dies
  mid-probe leaves the pop still owed and the respawn probes again. This is a
  real behaviour change vs t30b, where `_opened` was set the moment the child
  was alive — and it is the correct one: the operator's single pop should not be
  spent on a tunnel that never served.

### Existing tests that needed updating (2, both mechanical)

Both `firstUp` tests used fake children, so no real port ever accepted and the
pop never fired. Fixed by injecting `okProbe` (resolves true) — the ssh case.
The first test's shape changed: there are now **two** `state:'up'` emits (the
supervision one and the pop), so it asserts on `firstUp === true` count rather
than on up-emit count. That is the stronger assertion anyway.

## Phase 3 — tests + suite. DONE.

`TOTALS: 2722 pass, 0 fail, 2722 tests` / `ESCAPES: 0` (2714 → 2722, +8).
Verified with `npm test` directly; the subagent again paraphrased instead of
quoting even when asked verbatim (third time — treat its digest as a signal to
check, not as the answer).

`npm run build:web` re-run; bundle byte-identical (no renderer source touched).

### Tests added (8)

web-tunnel (6): pop waits for accept and is flagged `ready:true`; ssh pops on
the FIRST probe (one call, no timer tick); a child dying mid-probe never pops
and the respawn still owes it; the bound lapses → pops `ready:false`; the cap
still fires with a probe that never succeeds; `stop()` abandons a pending probe.
peer-web-open (2): an unconfirmed pop opens the browser but logs "never
confirmed"; a confirmed pop logs plainly.

### Revert proofs — 6, all BY MESSAGE

| revert | test that failed |
|---|---|
| pop immediately on child-alive (the t30b behaviour) | 6 tests, incl. "but nothing has popped: the port is not accepting yet" |
| `mine()` drops the child-ownership check | "the abandoned probe never popped a browser at a forward whose child is dead" |
| probe bound removed (`if (false)`) | "the bounded fallback pop" |
| `ready: false` → always true | "flagged UNCONFIRMED — a fallback the log can tell apart" |
| peer-wiring logs both cases identically | "and says the port was never confirmed" |

**One test was rewritten because a revert exposed it as blind.** The mid-probe
test originally kept the port refusing until after the respawn, so it passed
even with the ownership check removed — it asserted the right words about a
window it never entered. Now the probe ACCEPTS during the gap between the
child's exit and its respawn, which is the only window where a loop that
outlived its child would misfire. Same pattern as t36's `/ssh/i`: green while
proving nothing.

Also, removing the bound HANGS `node --test` (a probe timer that never clears
keeps the loop alive), so that revert was proven in an isolated harness rather
than under the runner. Worth knowing: an unbounded async retry in this module
shows up as a suite that never exits, not as a failure.

## Progress

- [x] Phase 1 — read + design
- [x] Phase 2 — implement
- [x] Phase 3 — tests + full suite green at 2722
