# t59 — the probe proves an agent alive and we force-clean it anyway

Branch `probe-verdict-authority` off master `5edde7d`.

Three findings from the cold review of t57/t58. All predate t57; all are the
silent-unreachability class.

## Phase 1 — the gating verification (nit A's Docker question)

clodex: *"Verify, do not assume, that this preserves the Docker case… If you
find a path where a legitimate Docker force-clean probes `true`, STOP and
report."*

**No such path exists.** The argument, at source:

1. The listening server is owned by the **engine's main process** — `Transport`
   is constructed and `start()`ed inside `create()` in `session-manager.js`,
   which runs in main. It is not owned by the spawned CLI child.
2. So `blockerLive === true` means *some live process* is accepting on that
   path. Combined with `existing.pid === process.pid` (the own-pid clause's
   trigger), the only process it can be is **this one**.
3. This process holds a live transport for that name in exactly two states:
   - the session is in `this.sessions` → `create()` already threw at `:823`
     (`Session "X" already exists`), so we never reach the EEXIST branch;
   - a concurrent `create()` for the same name is **in flight** — bound at
     `:1309`, not yet in the map at `:1366`. That is nit A itself, and
     refusing is the correct outcome.
4. A genuine Docker restart has neither: the previous engine is dead, and the
   PTY children that survive it never inherited the listening fd (node-pty
   passes no listen fd; Node sets `FD_CLOEXEC` on sockets). Nothing accepts, so
   the probe returns `false` (socket file survived, nothing bound) or `null`
   (no file). **Never `true`.**

So gating the own-pid clause on `blockerLive !== true` cannot block a
legitimate Docker force-clean: in that scenario the gate is never closed. Pin
(b) exercises it empirically rather than leaving this as argument.

## Phase 2 — the three changes

| Nit | Change | Where |
|---|---|---|
| A | own-pid clause gated: `blockerLive === false \|\| (blockerLive !== true && isStaleRegistration(...))` | `session-manager.js:1293` |
| B | capture the raw record bytes at probe time; null `blockerLive` at the re-read if they changed | `:1246-1253`, `:1279` |
| C | comment only — name the entry-before-socket window the reorder creates | `:1267`-ish |

Out of scope, confirmed untouched: `cleanup()`, `isSocketLive`, the probe's
pre-bind placement (clodex explicitly declined moving it back into the EEXIST
branch — pre-bind is correct for a reason that survives refactoring), and any
further restructuring of `create()`.

## Phase 3 — pins

- **(a)** two concurrent same-name creates. The first is parked *inside*
  `start()` — genuinely bound and registered, not yet in the sessions map, which
  is precisely the window `sessions.has()` cannot see. Second must refuse by
  message; first must still **deliver** (`Transport.send` + `_onIncoming`), not
  merely accept. ENTER instrumented: `isSocketLive` is wrapped and the test
  asserts the last verdict was `true`, so it cannot silently stop exercising the
  veto.
- **(b)** the Docker own-pid force-clean, three shapes (see the finding below).
- **(c)** a record swapped during the probe's await → refusal, and the agent
  that arrived must still receive a dm.
- **(d)** t57's ghost test and both t58 tests pass **unmodified**.

## Phase 4 — reverts (each fails BY MESSAGE; pristine restored between)

| Revert | Fails | Message |
|---|---|---|
| A: drop the `blockerLive !== true` veto | (a) | "a name this process is already bound to must be refused, not force-cleaned…" |
| B: drop `if (existingRaw !== blockerRaw) blockerLive = null;` | (c) | "a verdict about bytes that are no longer there must not decide the fate of the record that replaced them…" |
| C: drop the pid clause entirely (`if (blockerLive === false)`) | (b) | "a restarted engine must reclaim its own name (docker-nosocketfield)…" |

### Two self-caught defects in my own tests

1. **(a) first failed revert A by HANGING**, not by message — the forbidden
   shape. Under the revert both creates succeed and the second overwrites the
   first in the sessions map, so `closeAll()` (which iterates the map) left a
   real server listening and held the event loop open. Fixed by tracking every
   transport that actually binds and closing all of them in `finally`. Revert A
   now fails in 73ms with its assertion message.
2. **(b) initially passed under revert C**, i.e. it did not test the veto at
   all. Cause: `isSocketLive` answers **`false` for ENOENT**, not `null` —
   verified at source — so both socket-file variants are decided by the
   `blockerLive === false` clause and never consult the pid. Only a record the
   probe can form no verdict about reaches `isStaleRegistration`, so a third
   case was added (a record with no `socket` field → `null`), and each case now
   asserts which verdict it arrived with. This is the ENTER question catching a
   test that would have passed with the code deleted.

Also switched (b) to `assert.doesNotReject` with a message: under revert C it
was failing with the product's raw "already running elsewhere" error rather than
a sentence stating the expectation.

## Phase 5 — result

- `test/session-manager.test.js`: 314 pass, exits clean (no hang).
- `test/free-identifier-leaks.test.js`: 83 pass.
- Full suite: **2885 pass, 0 fail, ESCAPES: 0** (baseline 2882 + 3).

## Flags

- The Docker verification came out clean (phase 1) — no path where a legitimate
  Docker force-clean probes `true`, so no STOP-and-report was triggered.
- Nit C is comment-only as instructed; no code added for the
  entry-before-socket window.
- No deviations from the spec this time. The two corrections above were to my
  own tests, not to clodex's design.
