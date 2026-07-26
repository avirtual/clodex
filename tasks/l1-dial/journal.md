# t42 — L1: one dial

Branch `l1-dial` off master `026111c`. Worktree
`/Users/bogdan/projects/tmux/wb-wrap-ui-hand`. Baseline 2732 pass / ESCAPES: 0.

Behaviour-preserving refactor of the DIAL only. Not the supervisor (L2), not the
wire client (L3), not the stores.

## Phase 1 — survey (done)

Read at source on this branch: `peer-tunnel.js`, `web-tunnel.js`,
`cli/src/transport.js`, plus the tests that pin them (`test/peer-tunnel.test.js`,
`test/web-tunnel.test.js`, `cli/test/transport.test.js`,
`cli/test/cloud-transports.test.js`) and `test/free-identifier-leaks.test.js`.

### Placement — CONFIRMED, not challenged

The ticket's constraint holds and my t40 evidence already supports it. `cli/` is
a strict leaf: zero upward imports, three downward (`peer-tunnel.js:35`,
`web-tunnel.js:73`, `peer-client.js` since t41). The shared dial goes under
`cli/src/`, imported by the two GUI supervisors. Same direction, same shape as
three imports that already exist. No stop-and-ask needed.

### The three copies, cell by cell

Line numbers are this branch (`026111c`).

| aspect | peer-tunnel `_spawnTunnel`/`_killChild` | web-tunnel `_spawnOn`/`_killChild` | cli `openTransport` |
|---|---|---|---|
| stdio | `['ignore','ignore','pipe']` :205 | same :261 | same :291 |
| `detached` | cloud kinds ONLY (`_detached()` :170) | cloud kinds ONLY :212 | **ALWAYS :291** |
| stderr accumulation | tail, `.slice(-500)` :217 | tail, `.slice(-500)` :271 | **UNBOUNDED** `stderrBuf +=` :292 |
| ENOENT copy | `` `${cmdName}: command not found — is ${cmdName} installed and on PATH?` `` :224 | identical :279 | same sentence, `cmd` not `cmdName`, PREFIXED `\n` :299 |
| ENOENT destination | **assigned** to `lastError` (replaces) | assigned to `lastError` | **appended** to `stderrBuf` |
| non-ENOENT spawn error | `lastError = e.message` :225 | same :280 | `stderrBuf += '\n' + e.message` :301 |
| group-kill guard | `_detached() && child.pid > 0` :177 | same :219 | **`child.pid > 0` alone** :313 |
| fallback when guard fails | `else { child.kill() }` :181 | same :222 | **no else — nothing is killed** :313 |
| name used in errors before argv() | `this.cloud.kind` :200 | same :256 | n/a (argv built before spawn, throws out) |

### DRIFTS — the ticket's most-valued deliverable

Four confirmed. Two were already recorded in t40; two are new this phase. All
four are stated as findings; **none is fixed in this ticket** — fixing any of
them is a behaviour change.

**D1 (t40, confirmed) — `detached` is cloud-only in the GUI, always in the CLI.**
Both GUI supervisors keep the ssh child non-detached and say so in a comment
("ssh needs none of that and keeps its original non-detached spawn"); the CLI
detaches every child including ssh. Pinned on BOTH sides by tests
(`peer-tunnel.test.js:173` / `web-tunnel.test.js:280` assert `!('detached' in
opts)` for ssh; `cli/test/transport.test.js:61` asserts `detached === true`), so
this is a deliberate divergence that is TESTED, not an accident. It is a real
parameter of the dial, and that is how the shared primitive must take it.

**D2 (t40, confirmed) — the stderr bound.** The GUI keeps a 500-byte TAIL; the
CLI accumulates without limit. The CLI's is bounded in PRACTICE by process
lifetime (a failed dial is torn down within `WAIT_PORT_MS`), so it is not a live
leak — but a long-lived `port-forward` hold keeps the same buffer growing for the
whole session with nothing trimming it. Difference in kind, not just size.

**D3 (NEW) — the kill has no fallback in the CLI.** The GUI's `_killChild` is a
complete if/else: group-kill when detached with a real pid, `child.kill()`
otherwise. `openTransport`'s `close()` has only the `if (child.pid > 0)` arm and
no else, so a child whose pid is 0/null/undefined is **never signalled at all**.
The CLI's own test comment names this ("child no pid, so openTransport's teardown
is skipped — safe in-process", `cli/test/transport.test.js:39`) — so the hole is
known to the test that relies on it, but it is not stated anywhere in the product
code, and the guard's comment justifies only the `> 0` (kill(-0) would signal our
own group) without mentioning that the else is missing. In production every CLI
child is really spawned so pid is real; the gap is reachable only through the
injectable `spawnFn` seam. Worth naming: two of three copies handle a case the
third silently drops.

**D4 (NEW, and the one I would escalate) — the CLI's ssh argv has no keepalive.**
`peer-tunnel.js:66-74` and `web-tunnel.js:96-104` are byte-identical
`SSH_BASE_ARGS` including `ServerAliveInterval=15` + `ServerAliveCountMax=2`.
`cli/src/transport.js:30-40`'s `sshArgv` has **neither**. Same four other options,
same BatchMode/ExitOnForwardFailure/StrictHostKeyChecking/ConnectTimeout posture
— the two keepalive options are simply absent on the CLI side.

Consequence: a CLI ssh tunnel whose far end dies without closing the TCP
connection has nothing probing it, so the child stays alive and the forward stays
"open" while carrying nothing. That is the SAME failure shape as t41's half-open
SSE — a connection that is dead above the socket layer with no liveness probe to
notice. The GUI grew the keepalive; the CLI never did.

I am NOT fixing it here: adding two ssh options changes what the CLI spawns,
which is a behaviour change and outside a move-only refactor. Flagged for clodex
as its own decision.

### What the GUI COULD show but must not yet (per the ticket)

Once the dial returns structured failure, the GUI has access to the full stderr
(not just the last line) and — for ssm — the `diagnoseSsmInstance` verdict that
today only the CLI renders. The GUI's `lastError` stays exactly
`stderrTail.trim().split('\n').pop()` in this ticket.

### Gate note

`test/free-identifier-leaks.test.js` scans SCANNED_MODULES against **main.js**
scope. Neither `peer-tunnel.js` nor `web-tunnel.js` is on that list today (they
were never extracted from main.js). The new `cli/src/dial.js` goes on the list as
the ticket requires; I will say plainly in the report that for a `cli/` leaf this
is a WEAK gate (it can only catch the new module accidentally using a name that
main.js happens to define) rather than claim it proves the extraction safe.

## Phase 2 — implement (done, `79a7536`)

`cli/src/dial.js`, 165 lines. Exports `spawnDial`, `killDial`,
`classifySpawnError`, `sshTunnelArgv`, `SSH_BASE_ARGS`, `STDERR_TAIL_BYTES`.

Every divergence entered as a PARAMETER with each caller passing its current
value, so all three keep today's behaviour exactly:

| parameter | peer-tunnel | web-tunnel | openTransport |
|---|---|---|---|
| `detached` | `!!this.cloud` | `!!this.cloud` | `true` (D1) |
| `stderrLimit` | `STDERR_TAIL_BYTES` | `STDERR_TAIL_BYTES` | `0` = unbounded (D2) |
| `fallbackKill` | default `true` | default `true` | `false` (D3) |

The dial takes BYTES, not a destination — no cloud-kind table crosses into it,
so it stays a leaf and the DATA/CODE partition is untouched (argv is still built
at spawn time from typed reach data by each supervisor, never persisted).

Deliberately NOT moved: retry, backoff, deadlines, port pinning, the give-up cap,
`waitForPort`, the SSM post-mortem, and every rendering decision. The three
callers differ in POLICY far more than in mechanism.

### One bug I introduced and caught before the suite

Removing the now-unused `require('child_process')` from both supervisors left
`spawnFn || spawn` behind in each constructor — a free identifier that throws
only at construction. Fixed by having `spawnDial` own the fallback
(`spawnFn || spawn` internally, not a default parameter: the supervisors hold a
non-injected spawn as `null`, and a default parameter fires on `undefined`
alone). Neither supervisor requires `child_process` any more.

### What the GUI could now show, and does not

`dial.failure(e)` returns `{reason, message, diagnosis, stderr}` and
`dial.stderr()` is the full buffer. The GUI still renders exactly
`stderrTail.trim().split('\n').pop()` and `diagnosis || message`. Available but
unrendered: the full stderr rather than its last line, and `reason` as a
machine-readable class the UI could branch on (a missing binary is a
misconfiguration to fix, a spawn failure is a condition to retry — the UI shows
both as one grey error line today).

## Phase 3 — tests (done)

`cli/test/dial.test.js`, 14 tests. The module exists because three copies
drifted, so the tests pin each drift AS A PARAMETER — a parameter test that
exercises only one side is green while asserting nothing.

### Windows (each stated separately from its revert proof)

1. **`detached` both sides in one test** — asserts KEY PRESENCE, not truthiness,
   because `peer-tunnel.test.js:173` / `web-tunnel.test.js:280` pin
   `!('detached' in opts)` and `detached: false` would satisfy a falsy check.
2. **stdio** — the one shape no caller passes, so no caller's test would notice
   it changing for all three at once.
3. **argv split**, including a one-element argv (the off-by-one edge).
4. **`stderrLimit` both sides, past the boundary** — feeds 800 bytes and asserts
   WHICH end survives. A few bytes would pass under either policy.
5. **no stderr stream** — every caller guarded `if (child.stderr)`.
6. **`appendStderr` under a bound** — pins the contract for the caller that does
   not use it (only openTransport does, unbounded).
7. **ENOENT by `code` AND by message-regex** — the regex arm all three copies
   carried; a code-only classifier renders a bare `spawn kubectl ENOENT`.
8. **`failure()` carrying prior stderr** alongside the diagnosis.
9. **the full kill matrix** — {group, fallback} x {usable pid, no pid}, including
   `pid: 0` (the `kill(-0)` trap) and the D3 cell where NOTHING is signalled.
10. **group-kill throwing** → falls through to a direct SIGTERM.
11. **killDial totality** — null child, throwing kill; both happen during
    teardown where an escape would strand the supervisor.
12. **ssh argv pinned literally**; 13. **the keepalive as its own statement**, so
    a future unification with `sshArgv` shows its direction in a test name;
14. **the `-L` mapping order** (a transposed local/remote forwards the wrong way
    and is silent until nothing answers).

### Revert proofs — all BY MESSAGE, none by crash

| revert | result | failing test |
|---|---|---|
| A: `detached: true` unconditionally | dial 13/1 **+ GUI tunnel suites 43/2** | the detached parameter test |
| B: stream bound ignored | dial 13/1 | the stderrLimit test |
| C: `fallbackKill` default → false | dial 13/1 **+ GUI tunnel suites 40/5** | the kill matrix |
| D: `pid > 0` weakened to `!= null` | dial 13/1 | kill matrix — `AssertionError: pid 0 never reaches kill(-0)`, `actual: [[-0,'SIGTERM']]` |
| E: keepalive dropped | dial 12/2 | both ssh-argv tests |
| F: ENOENT by `code` only | dial 13/1 | the classifier test |

A and C are the important pair: they fail the EXISTING GUI tunnel tests too,
which is the behaviour-preservation claim proven from the other direction — the
parameters are load-bearing, not decoration. D was verified to be a genuine
assertion failure, not a crash.

## Verification

`TOTALS: 2747 pass, 0 fail` / `ESCAPES: 0`, read from `npm test` directly.
2732 → 2747 = +14 dial tests +1 leak-scanner entry.

**Every existing test passed UNCHANGED — none was edited.** GUI tunnel suites
45/45, CLI transport suites 83/83.

`npm run build:web` run: `web-dist/index.html` bundles these modules
(`SSH_BASE_ARGS` was visible in the bundle).

Leaf property: `grep` for upward requires from `cli/src/` → none. `cli/` still
imports nothing from the app; the app now imports `cli/src/dial` from
peer-tunnel.js and web-tunnel.js, the same direction as the three existing
downward imports.

## Line count

| file | before | after | delta |
|---|---|---|---|
| peer-tunnel.js | 342 | 320 | −22 |
| web-tunnel.js | 505 | 478 | −27 |
| cli/src/transport.js | 343 | 337 | −6 |
| **the three callers** | | | **−55** |
| cli/src/dial.js (new) | — | 165 | +165 |

Net +110 lines of source. The refactor does NOT save lines and was never going
to: roughly half of dial.js is the reasoning for each parameter — why a drift
exists, which caller passes what, and what a reader must not "tidy up". The three
copies carried that reasoning three times in fragments; it is now stated once,
completely, next to the code it governs. What actually collapsed is three spawn
bodies, three stderr accumulators, three ENOENT sentences, three group-kills and
two byte-identical `SSH_BASE_ARGS` blocks → one of each.

## Drifts — final

D1–D3 preserved as parameters (see the table above). **D4 is NOT fixed and needs
a decision.**

D4 grew during phase 2: `cli/src/transport.js`'s `sshArgv` is not merely missing
the keepalive relative to the two GUI supervisors — `ssh-run.js:34` and
`cli/src/deploy.js:60` carry `ServerAliveInterval=15` + `ServerAliveCountMax=2`
as well. It is the **only ssh invocation in the repo without them**. A CLI ssh
tunnel whose far end dies without closing TCP has nothing probing it: the child
stays alive, the forward reads as open, and it carries nothing — the same shape
as t41's half-open SSE, one layer down.

Not fixed here because adding two options changes what the CLI spawns.

## Progress

- [x] survey, placement confirmed, drift table
- [x] cli/src/dial.js + three callers wired (`79a7536`)
- [x] 14 tests, 6 reverts, window statements
- [x] leak scanner: cli/src/dial.js added, 80/80
- [x] suite green at 2747, ESCAPES: 0, no existing test edited
