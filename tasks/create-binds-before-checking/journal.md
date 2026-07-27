# t58 — a refused create has already destroyed the socket it refused to

Branch `create-binds-before-checking` off master `ea79cc7`.

The defect is stated in `test/session-manager.test.js:5280-5288` and
`tasks/registry-liveness/journal.md`; not re-derived here.

## Phase 1 — the ordering, as it exists

Everything inside `if (agentType)` (`session-manager.js:1218-1299`), between
`ensureDir` and the session record at `:1301`. "Outlives a failure" = the step
leaves state behind that a later throw does not undo.

| # | Step | Line | Side effect | Outlives a failure? |
|---|---|---|---|---|
| 1 | `ensureDir(runDirFor(...))` | 1222 | creates `run/<name>/` | yes — idempotent, harmless |
| 2 | `socketPath = pathFor(...)` | 1223 | none (pure) | — |
| 3 | probe → `blockerLive` (t57) | 1245-1253 | none — connect-and-close, inert by construction | no |
| 4 | `new Transport(socketPath, cb)` | 1255 | none (construction only) | no |
| 5 | **`await transport.start()`** | 1258 | **unlinks `socketPath`**, binds a listening server, chmods it | **yes, destructively — this is the bug** |
| 6 | `registry.register(name, ...)` | 1261 | atomic-link `agent.json`; throws EEXIST if taken | on success yes; on EEXIST nothing (tmp unlinked in the catch) |
| 7a | EEXIST, name is free (`blockerLive === false \|\| isStaleRegistration`) | 1281-1283 | `unregister` + `unlink(existing.socket)` + re-`register` | yes |
| 7b | EEXIST, name is genuinely taken | 1285-1288 | `await transport.stop()` (unlinks `socketPath` **again**), throw | yes |
| 8 | any other register error | 1291-1296 | `await transport.stop()`, rethrow | yes |

Two consequences fall straight out of the table, both from step 5 running
before step 6:

- **7b, the ticket's defect.** `socketPath` is name-derived and therefore
  byte-identical to the victim's `existing.socket`. Step 5 has already unlinked
  it before we ever ask whether the name is ours; step 7b unlinks it a second
  time. The victim's `net.Server` keeps listening on a detached inode with no
  error and no event. The refusal that exists to protect it is what kills it.
- **7a, found while tabulating and NOT in the ticket.** On the ghost self-heal
  path `existing.socket` is *also* that same path — so the force-clean at
  `:1282` unlinks the socket **our own transport is already listening on**, one
  step after binding it. The session starts, the registry says it is reachable,
  and it is not: the same silent-unreachability shape, on the success path.
  t57's ghost test only asserts `rec.pid`, so nothing caught it. Flagged to
  clodex; the reorder below fixes it for free (unlink lands before the bind),
  and pin (d) is strengthened to dial the healed session rather than trust it.

## Phase 1 — the ordering, as it should be

The change is a move, not a restructure: steps 4+5 travel below step 7, and one
new guard appears because a bind can now fail after a successful register.

1. `ensureDir` — unchanged.
2. `socketPath = pathFor(...)` — unchanged.
3. probe → `blockerLive` — unchanged (t57 already put it pre-bind).
4. **`registry.register(...)`**, with the whole EEXIST verdict — moved up, ahead
   of any bind. Force-clean (7a) unlinks `existing.socket` while nothing of ours
   is bound to it. Refusal (7b) throws with **no transport in existence**, so
   there is nothing to `stop()` and nothing has touched the victim's socket.
5. **`transport = new Transport(...)`; `await transport.start()`** — moved down,
   reached only once the name is concluded ours.
6. **New:** if the bind throws, `registry.unregister(name)` before rethrowing —
   otherwise the entry written at step 4 outlives the failure and advertises a
   socket nobody listens on. This is pin (e).

`transport` and `socketPath` still hold their values by the time the session
record is built at `:1301`, so that record is untouched.

Out of scope and confirmed unchanged: `isStaleRegistration` and its comment,
t57's probe, `registry.cleanup`, bash sessions (`agentType` null skips the whole
block). Pre-existing and deliberately left: none of these failure paths kill the
already-spawned `ptyProc` — true before this change and after it, so not t58's.

## Phase 2 — implementation

| Change | Where | Why |
|---|---|---|
| register + EEXIST verdict moved above the bind | `session-manager.js:1255-1305` | the ticket |
| bind moved below, wrapped in try → `registry.unregister(name)`, `transport = null`, rethrow | `:1309-1321` | the registration is now what outlives a bind failure |
| three `await transport.stop()` calls dropped from the throw paths | `:1294`, `:1299`, `:1303` (old) | nothing is bound on those paths any more; a `stop()` there would be on an unstarted transport |
| inner `try { … } catch (retryErr) { throw retryErr }` removed | old `:1275-1301` | its only job was that `stop()`; with it gone the wrapper rethrew what it caught |

`transport` / `socketPath` still hold their values at the session record
(`:1301`+), and `transport` is null only on paths that throw before reaching it.

## Phase 3 — pins

In `test/session-manager.test.js`, reusing `mkAgentCreateProbe` / `seedGhost`
and the `closeAll()` discipline. `mkAgentCreateProbe` gained one option,
`wrapTransport`, so a test can hand create() a Transport whose bind fails; the
returned `Transport` stays real, so victim servers are still genuine.

- **(a)+(b)+(c)** — folded into t57's existing refusal test plus one new test.
  t57's deliberately-absent assertion (its `:5280-5288` comment) is replaced by
  `isSocketLive(sock) === true`. The new test goes further: `Transport.send` +
  the victim's `onMessage`, because `isSocketLive` proves a server *accepts*
  while what the victim actually loses is *delivery*. (b) and (c) were already
  pinned by t57 and still pass unchanged.
- **(d)** — t57's ghost test now dials the healed session's recorded socket.
- **(e)** — new test: a bind rejecting after the registry check must leave no
  entry and no session.

## Phase 4 — reverts (each fails BY MESSAGE; pristine restored between)

| Revert | Failing pins | Message |
|---|---|---|
| A: `git checkout ea79cc7 -- session-manager.js` (whole old ordering) | (d), (a), (a-delivery), (e) | "the self-healed session must actually answer…", "the refused-against agent must still ANSWER…", "a dm to the refused-against agent must still be accepted…", "the bind must run AFTER the registration…" |
| B: drop only `registry.unregister(name)` from the new bind-failure catch | (e) alone | "a create that registered and then failed to bind must leave NO registry entry…" |

**The ENTER question, asked separately.** Revert A's first pass exposed a
false-pass: (e) *passed* under the old ordering, because a bind that fails
before anything registers also leaves no entry — the assertion held for the bug
as well as the fix. Fixed by recording, inside the failing stub, whether the
registration existed at bind time (`registeredAtBindTime`) and asserting it.
(e) now fails under revert A too, by that message. (d) enters the probe branch,
not `isStaleRegistration`'s — `seedGhost` still asserts the seeded pid reads
NOT-stale to the pid-only check, unchanged from t57.

## Phase 5 — result

- `test/session-manager.test.js`: 311 pass, exits cleanly (no hang).
- `test/free-identifier-leaks.test.js`: 83 pass.
- Full suite via test-runner: **2882 pass, 0 fail, ESCAPES: 0** (baseline 2880 + 2).

## Deviations / flags

1. **A second instance of the defect, on the SUCCESS path** — not in the ticket,
   found while tabulating phase 1. The force-clean at old `:1282` unlinked
   `existing.socket`, which is the same name-derived path the transport had
   bound one step earlier: create() deleted its own socket and the session came
   up on a detached inode. Registry entry looked perfect. The reorder fixes it
   with no extra code, and revert A confirms it independently — t57's ghost test
   fails there on the new dial assertion. Strictly this widens what the ticket
   describes (refusal path only); it does not widen the change.
2. **t57's ghost test was modified**, not just added to. Its `rec.pid` assertion
   could never have seen defect #1; the dial can.
3. `mkAgentCreateProbe` gained the `wrapTransport` option. Existing callers pass
   nothing and are unaffected.
