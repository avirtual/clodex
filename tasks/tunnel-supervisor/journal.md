# t49 — L2: one parameterised tunnel supervisor

Branch `tunnel-supervisor` off master `c81a2e8` (the t48 merge). Baseline 2807 /
ESCAPES 0.

Targets: `peer-tunnel.js` (334 lines, `Tunnel`) and `web-tunnel.js` (492 lines,
`WebTunnel`). Four named parameters: retry x port stability x readiness x error
sink. `withWire` expected to be the NULL configuration.

## Status

- [x] branch created, journal opened
- [x] read docs/peering.md, both supervisors, transport.js, peer-wiring.js
- [x] behavioural diff (below)
- [x] design the parameterisation
- [x] implement — `tunnel-supervisor.js` new; `Tunnel` and `WebTunnel` are now
      subclasses that set policy only. All 63 existing tunnel tests pass
      UNCHANGED (peer-tunnel 13 + web-tunnel 33 + peer-web-open 17).
- [x] tests + revert proofs — `test/tunnel-supervisor.test.js`, 8 tests, 8
      reverts all failing BY MESSAGE
- [x] SCANNED_MODULES — `tunnel-supervisor.js` added
- [ ] suite green, commits, report

## (e) KILL COUNT (code lines, comments and blanks excluded)

| file | before | after | delta |
|---|---|---|---|
| `peer-tunnel.js` | 199 | 68 | **−131** |
| `web-tunnel.js` | 260 | 97 | **−163** |
| **removed per side** | | | **−294** |
| `tunnel-supervisor.js` (new, under its 76-line header) | — | **229** | +229 |
| **net** | | | **−65** |

Raw line counts: 334 → 150 and 492 → 237; the new module is 466 lines, 229 of
them code. The net saving is small because most of what was deleted was the
SECOND COPY of ~90 lines, and the header explaining three parameters costs more
than the header explaining one class did. The deletion was never the point (a):
what 294 duplicated lines were buying was three silent disagreements.

## Tests — `test/tunnel-supervisor.test.js` (8)

The existing 63 (peer-tunnel 13, web-tunnel 33, peer-web-open 17) are the real
regression guard for the merge and NONE was edited. The new file pins only what
the merge newly decides: the three resolved drifts, the unified status row, the
probe teardown, and the two policy parameters that used to be guarded by the
mere absence of a mechanism.

### Revert proof — 8, all by message, none by crash, none hung

| revert | fails with |
|---|---|
| D1 re-check back to `_stopped`-only | `reports port 61614 but its child forwards 61613…` |
| `mine()` out of the exit handler | `a third child was spawned on top of a live forward (spawns: 3)` |
| `_releasePort()` out of the ERROR handler | `the status row still names a local port, but the child never bound it` |
| `_releasePort()` made unconditional (pin ignored) | `the pinned port was released…the browser tab is stranded` |
| `url` out of `status()` | `the wire status row must carry url, like the web one` |
| the wake out of `stop()` | `the probe loop is still parked on a sleep whose timer stop() cleared` |
| `giveUpMs: null` → `300` in peer-tunnel | `a forward nobody is watching gave up` |
| `readiness: null` → a probe in peer-tunnel | `a wire tunnel announced firstUp` |

Restored from a pristine copy between each; all-green re-verified after
(154/154 across the five affected files).

### TWO tests were green over the defect they named — both caught by RUNNING the revert

This is the fifth and sixth occurrence of the pattern, and neither would have
been visible any other way.

1. **D1 was asserting the wrong consequence.** Written as "two starts spawn
   exactly ONE child" — which passes with the guard reverted, because
   `_spawnOn` has a `_child` guard of its own that stops the second spawn. A
   probe showed what the second pass DOES do: it runs `this.localPort = port`
   before reaching that guard, so the live child forwards one port while
   `status()`/`url()` name another (measured: child 61442, status 61443). On
   the wire side that dead URL goes straight to `PeerManager.sync`. The test
   now asserts AGREEMENT between the reported port and the child's argv.
2. **The retry test was pinning its own argument.** It drove
   `SupervisedTunnel` directly with `giveUpMs: null` passed in, so capping the
   real `Tunnel` left it green — it was checking that the supervisor honours a
   parameter, not that peer-tunnel.js chooses it. Now the unbounded arm is the
   shipped `Tunnel`.

A third, smaller one: D3 originally led with a `state === 'up'` assertion that
was flaky in the other direction (the spurious restart lands inside the settle
window and the state reads 'up' again). Now it leads with the spawn count, which
is the symptom that survives.

## Implementation as built

`tunnel-supervisor.js` — `SupervisedTunnel` + the destination vocabulary
(`CLOUD_KINDS`, `sameCloud`, `destinationOf`, `hasCloudTransport`,
`pickFreePort`). Three parameters, each named by the CONSUMER property that
decides it (D7: no error-sink parameter, it was never a difference).

`peer-tunnel.js`: `Tunnel extends SupervisedTunnel` setting `giveUpMs: null`,
`pinPort: false`, `readiness: null` + its three constants. `TunnelManager.sync`
now asks `destinationOf` instead of carrying its own copy of the required-field
loop. Re-exports `CLOUD_KINDS`/`sameCloud`/`hasCloudTransport` (t47's
`parseSseBlock` precedent) so peer-import.js, web-tunnel.js, peer-wiring.js and
the existing tests need no edit.

`web-tunnel.js`: `WebTunnel extends SupervisedTunnel` setting `pinPort: true`,
`giveUpMs`, and `readiness: {probe, timeoutMs, pollMs}`. Re-exports
`destinationOf`. Both managers unchanged in behaviour.

**Structural refusal (c), the shape clodex asked for:** `SupervisedTunnel` holds
no map and has no reference to anything that does. It supervises one child and
reports. It cannot grow supervision-of-supervision without being handed a
collection it currently has no way to obtain — the same move as t47's decoder
owning no socket. Both managers stayed in their own files.

### Resolutions

- **D1** (post-async re-entry) — resolved toward web: the `pickFreePort`
  callback re-checks `_stopped || _child`. Strict superset of the peer side's
  `_stopped`-only check.
- **D2** (`bornAt` per-child) — resolved toward peer: closure `const`, never a
  field. Superset: identical for one child, correct for two.
- **D3** (a dead child's handler acting on a live one) — closed for both by
  `mine()`, an identity check on every child callback. Neither side had it.
- **D5** (`localPort` cleared on exit but not on spawn-error) — closed by
  `_releasePort()` on both paths. Also now the *pin* seam: the same call is the
  no-op that keeps a pinned port alive, so "unpinned ports die with their child"
  and "pinned ports don't" are one line rather than two conventions.
- **D8** (`url` on the status row) — unified additively; the peer row gains it.
  No test asserts the row's exact shape (checked), and peers-ui reads
  `tun.state`/`tun.error` only.
- **D4** (60s vs 30s ceiling), **D9** (remote-port default) — POLICY, preserved
  at the parameter with the reason at the parameter.
- **The `stop()`-during-probe leak** (web-only, flagged in the diff as
  fix-if-free) — it was free: `stop()` now resolves the pending sleep through
  `_probeWake` and the loop re-checks ownership on wake. Without it the await
  never settles, because `stop()` clears the very timer that would have
  resolved it.

---

## (a) THE BEHAVIOURAL DIFF

Read side by side: `peer-tunnel.js:90-246` (`Tunnel`) against
`web-tunnel.js:110-358` (`WebTunnel`).

**Byte-identical already** (nothing to decide): `url()`, `args()`, `argv()`,
`_detached()`, `_killChild()`, `_setState()`, the cloud-kind normalisation in
both constructors, the `argv`-throws try/catch, the `child.on('error')` arm, the
stderr-tail-to-`lastError` line in `child.on('exit')`, and the backoff-double
tail of `_scheduleRestart`.

### D1 — the post-async re-entry guard: WebTunnel has it, Tunnel does not

`_spawnTunnel` guards `if (this._stopped || this._child) return;` on BOTH sides,
then goes async through `pickFreePort`. In the callback:

- **web** (`web-tunnel.js:235-241` → `_spawnOn:244`) re-checks
  **`this._stopped || this._child`**.
- **peer** (`peer-tunnel.js:188-189`) re-checks **`this._stopped` only**.

The gap is a real `net.createServer().listen()` round trip, and `_child` is null
throughout it. A second `_spawnTunnel` landing in that window spawns a second
child on the peer side and the first is orphaned — `this._child` is overwritten,
so `_killChild` can never reach it.

**Which is right:** web. **Live or latent:** LATENT. Reaching it needs
`_spawnTunnel` called twice inside the window, and today's only callers are
`start()` (TunnelManager calls it exactly once, at construction) and the backoff
timer (which only exists when there is no child). No live path.

### D2 — `bornAt` is per-CHILD on the peer side, per-INSTANCE on the web side

- **peer** (`peer-tunnel.js:209`): `const bornAt = Date.now();` — a closure
  variable, one per spawn. The exit handler reads *its own* child's birth.
- **web** (`web-tunnel.js:272`): `this._bornAt = Date.now();` — one slot for the
  instance. A newer spawn overwrites it before an older child's exit fires, and
  the older exit then measures the WRONG lifetime.

On the web side that decides two things, not one: the backoff reset *and*
retiring the give-up deadline (`web-tunnel.js:280-283`).

> **CORRECTED in t51 — the stated harm was inverted.** This paragraph originally
> read "mis-measuring it can retire the give-up clock on a box that never
> worked". It cannot: `_bornAt` is assigned at SPAWN time, so the field only ever
> moves forward, and a stale exit therefore reads a NEWER birth and
> **under**-measures the lifetime. Under-measuring fails the `> stableMs` test,
> so the reachable direction is the opposite one — the clock is NOT retired for a
> box that did work, and the cap later fires on a tunnel that was genuinely
> serving. Still worth fixing, and still the direction the give-up clock exists
> to get right; the sentence naming which way it goes was simply backwards.

**Which is right:** peer. **Live or latent:** LATENT, for the same reason as D1
(it needs two overlapping children on one instance).

> **CORRECTED in t51 — the closure is belt-and-braces, not load-bearing.**
> Reverting `bornAt` to a field in the merged supervisor leaves all 71 tests
> green, and correctly so: D3's `mine()` means only the CURRENT child's exit
> handler runs at all, so the stale exit that would read the wrong birth never
> reaches the measurement. D2 is subsumed by D3. Keeping the closure is right —
> it removes the shared slot rather than guarding it, and it costs nothing — but
> the claim that it fixes a live defect on top of `mine()` was untested and is
> false. (t51 found the SAME reasoning does not save `_probeWake` / `_probeTimer`
> / `_probing`, which are read from outside the callbacks `mine()` guards; see
> `tasks/tunnel-supervisor-rework/`.)

Both D1 and D2 are the same underlying hole — *a handler that assumes it still
owns the tunnel* — and each side plugged a different half of it. Neither is
reachable today, which is precisely why neither was noticed.

### D3 — `_killChild` nulls `_child` before the kill lands (BOTH sides)

`_killChild` sets `this._child = null` and *then* signals
(`peer-tunnel.js:174-178`, `web-tunnel.js:212-217`). The dying child's `exit`
handler still fires afterwards and runs `this._child = null` + `_scheduleRestart`
against whatever is in the slot by then. Guarded today only by `_stopped`, which
`stop()` sets — so it is safe for `stop()`, and unreachable for anything else.

**Not a drift** (both sides identical) but it is the mechanism that makes D1/D2
dangerous if anyone adds a restart-in-place. The unified supervisor closes all
three at once with one rule: **every child callback is a no-op unless
`this._child === child`.** That is a strict superset of both existing guards.

### D4 — retry ceiling: 60s (peer) vs 30s (web)

`BACKOFF_MAX_MS` 60000 vs 30000. Real POLICY, not a defect, and the two are
coupled: the web side gives up after 120s, so a 60s ceiling would allow it about
three attempts inside its own window. Preserved AT THE PARAMETER.

### D5 — `localPort` is cleared on exit, but only on ONE of the two exit paths

`peer-tunnel.js:224` clears `this.localPort` in the `exit` handler. The
`error` handler (`:213-221`, spawn failure / ENOENT) does **not** — so after a
missing-binary failure `status().localPort` reports a port that was never bound.
`url()` is unaffected (it also tests `state === 'up'`), so nothing downstream
lies; the renderer's status row does.

**Which is right:** clearing on both. **Live or latent:** LIVE, but cosmetic and
confined to a status field nobody currently renders. Fixed by the merge, which
routes both paths through one place.

### D6 — readiness, and the finding underneath it

- **peer** (`peer-tunnel.js:230-234`): `up` is emitted the moment `spawnDial`
  returns a child object — before it has been observed to survive a single tick.
  With `ExitOnForwardFailure=yes`, a port collision or dead host exits the child
  immediately after, so `up` → `down` in quick succession and
  `resolvePeerUrls` will have pointed the peer client at a port that never bound.
- **web** (`web-tunnel.js:295-296`, `_probeThenPop:319`): the same cheap `up`
  for SUPERVISION, plus a real TCP probe of `127.0.0.1:<port>` gating exactly one
  emit (`firstUp`), bounded by `WAIT_PORT_MS` and popping unconfirmed with
  `ready:false` on lapse.

The standing rule says the peer side's `up` proves nothing — and it does not.
But it is not a defect there, because **the consumer re-derives the truth
itself**: the peer client's 15s hello loop discovers the dead port and stays
calmly offline, self-correcting on the next `onState`. A browser tab has no such
loop, which is why the web side had to buy the stronger fact.

That reframes parameters 2 and 3 into one classifying question (below).

### D7 — the error sink is NOT a parameter

The audit predicted four; there are three. Both sides use the identical
mechanism: `this.lastError` carried on the `status()` row, delivered through
`onState(id, status)`. The difference is entirely in the *consumer* —
`peer-wiring.js:117-121` broadcasts `peer-tunnel` and logs nothing (offline is
calm), `:220-247` broadcasts `peer-web-tunnel` and logs, and both of those live
ABOVE the supervisor and stay there per (c). One fewer parameter than predicted.

### D8 — `status()` shape: web carries `url`, peer does not

`web-tunnel.js:175` adds `url: this.url()`; the peer row omits it although
`url()` is identical on both. Additive to unify. Deferred to implementation
pending a check of what reads the `peer-tunnel` broadcast.

### D9 — `remotePort` default: `|| 7900` (peer) vs none (web)

Consumer-derived: the wire port is a known constant, the web port comes from the
peer's hello and a guess would be the lie t30a exists to prevent. Parameter with
an optional default.

### Not drifts, checked and cleared

- `start()`'s extra `if (!this._stopped && this._child) return` on the web side
  is equivalent to the peer side's behaviour via `_spawnTunnel`'s own guard; it
  exists to protect `_deadline` from being reset, which the peer side has not
  got.
- `_stableMs` scaling with `giveUpMs` (`web-tunnel.js:130`) is a test seam that
  collapses to the shared 30s constant in production.

### One defect in code being MOVED (not a drift — web-only, no peer analogue)

`stop()` clears `_probeTimer` (`web-tunnel.js:157-158`) while `_probeThenPop`
is awaiting the promise **that timer was going to resolve**
(`web-tunnel.js:334`). The promise never settles, so the async frame is retained
forever. Bounded and invisible (the timer is gone, so nothing wakes), but it is
a leak. Flagged; fix only if it falls out of the extraction for free.

---

## The classifying property (parameters 2 + 3)

Not "peers do X, web does Y". Both fall out of one question about the CONSUMER:

> **Once the supervisor has handed over a URL, can that URL be corrected later?**

| consumer | re-pointable? | port | readiness |
|---|---|---|---|
| `PeerConnection` (re-pointed by `sync()`, verified by its own hello loop) | yes | re-pick | supervisor need not probe |
| a browser tab (holds a dead string, no loop) | no | **pin** | **probe before the one emit it rides** |

A future third consumer is classified by that alone.

They are nonetheless INDEPENDENT parameters, and the CLI proves it by occupying
the fourth corner: `openTransport` (`cli/src/transport.js:277`) **re-picks** its
port (`localPort` optional) **and probes** (`waitForPort:251`), because it is
one-shot — no consumer to re-point, but also nothing to hold a stale string.

## `withWire` is the NULL configuration in POLICY but not in SHAPE

Retry 0, so yes, it is this supervisor with supervision switched off. But it
**returns a settled value** (`await openTransport(...)` → `{ baseUrl, close }`)
where the supervisors **emit state over time**. A thing that can respawn cannot
hand back one settled URL; a one-shot that must produce a URL cannot be
event-driven. That is a shape difference, not a parameter setting — folding it
in means either giving the CLI an event loop it has no use for, or giving the
supervisors a promise that can only resolve once.

So: reported as NOT the null configuration, per the spec's invitation to say so
rather than force it. It stays where it is.
