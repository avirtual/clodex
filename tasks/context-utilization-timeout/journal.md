# t62 — context popover timeout budget

Branch `context-utilization-timeout` off master `47008ce`. Do not touch master,
do not push.

## The bug (given, measured by clodex — not re-derived)

`fetchProxyContext` (engine.js:1087) calls `ProxyClient._getJson(base, q)` with
no timeout, so it falls to `PROXY_HTTP_TIMEOUT = 4000` ("keeps polling/handshake
snappy"). With `opts.utilization` the query adds `&utilization=1`, which makes
wirescope disk-scan the session's capture files. Measured on a session with
18,012 captures / 1.5 GB: plain 2.5 ms, utilization 10.5 s (response 7.9 KB).
Wall time scales with RETAINED CAPTURES, not payload.

## Phase 1 — read the seam (done)

- `ProxyClient._req(base, pathname, method='GET', timeout=PROXY_HTTP_TIMEOUT)`
  (wirescope-proxy.js:44); `_getJson(base, pathname, timeout)` is a thin
  forwarder at :63. So the third argument IS the seam clodex named.
- `PROXY_REPORT_TIMEOUT = 20000` (wirescope-proxy.js:26) is already imported into
  engine.js (:588) and already used at engine.js:1108 (`fetchProxyReport`). No
  new import needed.
- Existing heavy reads passing it: `/_bust` (:193), `/_pot` (:204), `/_prune`
  (:225, :231). The utilization scan is the same class.
- Test seam: `createEngine` returns `manager`, `proxyPoller` and `ProxyClient`
  (engine.js:1863). `ProxyClient` is the module-level singleton, so stubbing
  `_getJson` on it captures the timeout the real `fetchProxyContext` passes.
  `test/engine-web-info-seam.test.js` stubs one level up (`fetchProxyContext`
  itself), so this is a new stub shape — built here.

## Phase 2 — THE DECISION: conditional, not unconditional

Raise the budget **only when `opts.utilization` is set**. Reasoning:

A timeout is not a latency allowance, it is a liveness signal, and it is only
informative when it sits near the expected duration of the work. The two queries
behind this one endpoint differ by ~4000x in measured expected time (2.5 ms vs
10.5 s). One constant therefore cannot serve both: sized for the scan, the plain
call's 20 s budget stops distinguishing "hung proxy" from "slow proxy" — the
operator watches a spinner for 20 s to learn something the current code tells
them in 4.

The simplicity argument for one constant is real but buys less than it looks:
the plain call never approaches EITHER budget, so unconditional 20 s changes
nothing in the healthy case and only degrades the failure case. The cost of the
distinction is a ternary and a comment; the comment is the actual deliverable,
since the 4000 got there by defaulting and this ticket exists because nobody
wrote down why.

## Phase 3 — implement (done)

- `engine.js:1087` — `_getJson(..., wantUtil ? PROXY_REPORT_TIMEOUT : undefined)`,
  with the tradeoff recorded at the call site. `undefined` (not
  `PROXY_HTTP_TIMEOUT`) keeps the plain path on `_req`'s own default so there is
  one owner of that number.
- `engine.js:1091` — the allowed one-line error-text fix: a bare `timeout` now
  names the request and the budget it blew. Engine-only; the popover renders the
  raw string, so no renderer change (scope fence honoured).

## Phase 4 — tests (done)

`test/engine-context-timeout.test.js`, 6 tests. Stub shape: build a real engine,
plant a session with a `proxyBase`, force `proxyPoller.snapshot` to report
linked, and swap `ProxyClient._getJson` for a capture (restored in `finally`).

ENTER guards, asked separately per test:
- the utilization test asserts the captured query actually contains
  `utilization=1` BEFORE asserting on the timeout — otherwise it would be
  asserting a default on the plain path and pass vacuously (the shape that has
  bitten four tickets running);
- the plain test asserts the query does NOT contain `utilization=1`;
- both assert `calls.length === 1`, so a `fetchProxyContext` that returned early
  on an unlinked snapshot (never reaching the call at all) fails by message
  instead of silently satisfying "no wrong timeout was passed".

## Phase 5 — reverts

Each must fail BY ASSERTION MESSAGE, not crash/hang. Restore from pristine
copies between reverts.

- A: drop the timeout argument entirely (the pre-t62 line) → utilization pin.
- B: pass the budget unconditionally → plain-path pin.
- C: revert the error text to `String(e.message)` → error-naming pins.
- D: stub the ENTER guard — make the "linked" snapshot report unlinked → the
  `calls.length === 1` guards must fire, proving the tests reach the call.

## Result

Branch `context-utilization-timeout` off `47008ce`. Commits: `045a3a0`
(product), `64abd49` (tests + journal). Suite **2915 / 0 / ESCAPES 0** via the
test-runner subagent (2909 + 6).

All four reverts fail BY ASSERTION MESSAGE, none by crash/timeout/hang; product
and test files diffed byte-identical against pristine copies afterwards.

## Flags

1. **Decision made conditional, with reasoning at the call site** — clodex asked
   for a deliberate pick, not a specific answer. Reasoning above and in the
   comment.
2. **`PROXY_HTTP_TIMEOUT` is not exported** from wirescope-proxy.js (only
   `PROXY_REPORT_TIMEOUT` is). So the plain-path timeout message names the
   endpoint but NOT the number — naming it would have meant widening that
   module's export surface, which is more than the "one-line improvement in
   engine.js" the ticket allowed. The utilization message names its budget,
   which is the case the operator actually hits.
3. **Scope fence honoured**: `renderer/popovers/context-popover.js` untouched,
   no progressive load, no retention/pruning change. The error-text fix landed
   entirely in engine.js, so no renderer follow-up is owed.
4. **No `build:web`** — no bundled renderer source touched.
5. **Not fixed, not in scope**: the popover still renders whatever string it is
   given with no distinct affordance for a slow-vs-dead proxy. Rendering is
   clodex's held decision.
