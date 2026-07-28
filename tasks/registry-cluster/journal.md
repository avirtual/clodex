# registry cluster (t75-t78) — implementation journal

Branch `registry-cluster`, off master `9c977b3`. Worktree
`/Users/bogdan/projects/tmux/wb-wrap-ui-hand`, mine alone.

**One artifact, one branch, one report** — clodex's framing (msg-55910-98):
t75-t78 share `agent-transport.js` and the same underlying question, so four
separate passes would re-read the same code four times.

Note the tickets each carry their own `taskDir` (`tasks/registry-ghost-discovery`,
`tasks/registry-cleanup-revalidate`, `tasks/cleanup-ordering-pins`,
`tasks/census-scanner-comments`). Those fields predate the batching decision;
clodex's later instruction is explicit that the artifact is
`tasks/registry-cluster/`, so this file is it. Recording the divergence so the
per-ticket dirs being empty is not read later as work never done.

## Order (clodex's, not mine)

1. **t76** — cheapest, fix already exists in-tree; port it or write why not.
2. **t77** — pure test work, no product change; pins ordering t75 might disturb.
3. **t75** — the only one needing design judgment.
4. **t78** — last and independently: different file, different hazard, and its
   revert discipline must not be rushed to finish a batch.

## Dispatch verification (a lesson applied immediately)

clodex's first framing message said four tickets were assigned. Only t75 was —
Clodex fires only ONE `[agent:task assign]` intent per turn, so three of four
emitted intents silently did nothing, and the board showed `open` /
`assignee=None`, which is byte-identical to "never dispatched" because that is
what it was.

Before starting I read `~/.clodex/teams/clodex/tickets.json` myself rather than
trusting the dm. All four now show `state=open assignee=clodex-hand`. The
operational rule, which binds me too: **verify a dispatch landed by reading
tickets.json, not by having emitted the intent.** Records are a flat list; `id`
is the string `"t75"`.

I also pulled t77's and t78's full specs out of `tickets.json` rather than
waiting on their dms, since the store is the authority and the dms are a copy.

## Carried in from t96 (clodex's instruction, and my own finding)

- **Cross-turn/cross-request is the instrument shape.** My t96 tests each
  examined ONE request and a cross-turn flap is invisible within one request. I
  had the right shape in Phase B (measurement 3 joined consecutive requests) and
  stopped applying it when the task changed from measuring to proving. Applies
  directly to t77: a `_cleanup` ordering property is only observable ACROSS the
  teardown, not within one statement.
- **A check that detects vs. a check that explains.** My t96 equivalence check
  fired on the narrowed scope but could only say "boundary mismatch". A pin
  whose failure does not teach the reader WHY gets deleted by whoever trips it.
  t77 requires failure BY MESSAGE naming the consequence.
- **Code right, comment wrong is the dangerous direction** — it invites a tidy
  that reintroduces the defect. t77 is that situation BEFORE the tidy. Write the
  comment as carefully as the assertion.

---

## t76 — cleanup() read-then-unlink, no re-validation

### Spec premises checked at source

| Spec claim | At source | Verdict |
|---|---|---|
| `cleanup()` reads then unlinks with no re-validation, `agent-transport.js:100-104` | `regEntries()` loop at :100, `JSON.parse(readFileSync)` :102, verdict :103, `fs.unlinkSync(regPath)` :104 | **CONFIRMED**, line numbers exact |
| t57 correctly stopped unlinking the socket; :105-117 explains why re-adding it would be worse | comment block :105-117, verbatim on that point | **CONFIRMED** |
| The guard is already written at `session-manager.js:1350-1353` | :1350-1353 is COMMENT PROSE about bind ordering. The actual guard is **:1379-1385**: re-read `existingRaw`, then `if (existingRaw !== blockerRaw) blockerLive = null;` | **substance CONFIRMED, line ref WRONG** |

The guard's substance is exactly as described — read raw bytes, act, re-read raw
bytes, discard the verdict if the bytes changed — and it is one function away in
a different file. Only the line number is off; not a false premise.

### The race, spelled out

`register()` links atomically and throws `EEXIST` if the entry exists, so a
concurrent registration cannot quietly overwrite. The damaging interleaving is:

1. `cleanup()` reads entry X (dead pid) → verdict: remove.
2. concurrently, `create()` for the same name: `register()` → EEXIST →
   force-clean (unlinks X) → `register()` again → entry Y, LIVE pid.
3. `cleanup()` executes its `unlinkSync(regPath)` → **deletes Y**, the live one.

Recoverable rather than permanent (the socket is not unlinked, so the agent
keeps listening), but the live agent loses its registration and goes
undiscoverable.

### The open question, to be measured next turn

Is this reachable in the shipped single-engine app, or only cross-process?
`registry.cleanup()` has ONE production call site: **`engine.js:1810`** (the
spec and the older audit both say `:1724` — drifted, verify before quoting).
If that runs strictly before any `create()` within a process, the in-process gap
is empty and the hazard is cross-process only (second engine sharing
`~/.clodex`, or a Docker box without a private volume).

That does not decide the ticket by itself — clodex's actual requirement is that
the ASYMMETRY not be left looking intentional. Either port the guard or comment
why cleanup() does not need it. Reachability determines which, and it is a
reading question, not a judgment call, so it gets read.

### The reachability answer — stronger than the ordering question I asked

I set out to check whether `cleanup()` runs before any `create()` at bootstrap.
The ordering turned out to be the wrong question. **`cleanup()` and `regEntries()`
contain no `await`, no promise, no callback** (grepped: zero hits). The loop is
therefore atomic against the JS event loop, so no `create()` can interleave
in-process *at all* — irrespective of where the call sits in bootstrap.

That also explains the asymmetry cleanly: `session-manager.js:1379-1385` needs
its guard because `await Transport.isSocketLive()` suspends between read and
act. `cleanup()` has no suspension point. The difference was never considered;
it just never mattered.

Cross-process the gap is real today (two engines sharing `~/.clodex`; the
single-instance lock at `main.js:492` is per-app, not per-volume).

### Decision: port the guard

Ported, not commented-away. Three reasons, in order of weight:

1. **t75 — the next ticket in this batch — proposes putting the async probe
   into `cleanup()`'s liveness test.** The precondition that makes the guard
   inert is scheduled for removal by work already assigned to me.
2. clodex's requirement: the asymmetry must not read as intentional.
3. Cross-process reachability is not hypothetical.

Per clodex's instruction, the comment states **why it is unreachable and what
would make it reachable again** — synchronous today; an `await` in this function
(t75) or a second caller off the bootstrap path flips it. "Currently
unreachable" without its preconditions is the rationale that decays silently.

The comment also states the limit honestly: re-read and unlink are two syscalls,
so this NARROWS the window rather than closing it. Closing it needs an atomic
compare-and-unlink the filesystem does not offer. Same bargain :1385 strikes.

### Tests (2, in `test/agent-transport.test.js`)

The property is only observable ACROSS the gap — at every individual instant the
file is perfectly consistent — so the replacement is injected AT cleanup's own
`readFileSync`. This is the t96 lesson applied: a single-snapshot check cannot
see this defect, exactly as a single-request check could not see the flap.

The two are each other's discriminator:
- replaced-entry-survives alone passes for a guard that skips EVERYTHING;
- unchanged-entry-still-pruned alone passes for NO guard at all.

Both assert they **entered** their window (`reads >= 1`), because test 2's
outcome is identical whether or not the harness fired — a dead harness
simulates precisely the no-race case it tests.

### Revert proofs (pristine `t76-at.pristine`, md5 `2ea113d1…`)

| Revert | Parses? | Result |
|---|---|---|
| A: guard removed entirely | clean | **1 fails BY MESSAGE** — "cleanup deleted a registration that was re-registered LIVE… the agent is now undiscoverable" |
| B: guard on the wrong signal (`mtimeMs >= 0`, i.e. not the bytes) | clean | **2 fail BY MESSAGE**, incl. the pre-existing t57 prune test — "a guard that skips it turns cleanup into a no-op" |
| C: harness disabled (`if (false && …)`) | clean | **2 fail BY MESSAGE** — both entry assertions fire, naming "proved nothing about the read-to-unlink gap" |

No crashes, no timeouts, no no-ops. md5 restored to `2ea113d1…` after each;
`git diff` checked. Revert B is the one that matters: it is the failure mode the
first test cannot see alone, and it takes down a t57 test too.

### Status: DONE

`deda936` (product) · `c7f97b4` (tests + journal + taskDir stubs). Suite file
9/9. Full suite deferred to the end of the batch.

Also created the four `taskDir` stubs per clodex's ruling — one README each
pointing here, so a reader landing on an empty dir learns where the work is
rather than inferring it never happened.

---

## Next: t77

Line references to verify at source first (clodex has NOT verified t75-t78 at
source — filed 16h ago, dispatched on their own text, and two references in t76
had already drifted): `engine.js:1293`, `engine.js:1451`, `ipc-handlers.js:351`,
`session-manager.js:2366` + `:2368`, `engine.js:1253-1257`,
`test/plugin-host-engine.test.js:138-151`.

---

## t77 — BLOCKED. Property (2) is false at source.

Verified every reference before building. Property (1) holds; **property (2)
does not**, and it is the one the ticket turns on — the spec itself says (2) is
what makes (1) sufficient.

### Reference audit

| Spec | At source | Verdict |
|---|---|---|
| kill+create awaits `waitForSessionExit` — `engine.js:1293` | `engine.js:1343` | drifted, claim TRUE |
| … `engine.js:1451` | `engine.js:1501` | drifted, claim TRUE |
| … `ipc-handlers.js:351` | `ipc-handlers.js:351` | **exact**, claim TRUE |
| 300ms sleep "lost the session entirely" — `engine.js:1253-1257` | `engine.js:1303-1307` | drifted, claim TRUE verbatim |
| indexOf-ordering technique — `test/plugin-host-engine.test.js:138-151` | :138-151 | **exact**, technique reusable as described |
| **`rmSync` at `session-manager.js:2366`** | **no `rmSync` anywhere in `_cleanup`** | **FALSE** |
| **`sessions.delete` is the LAST statement, `:2368`** | `:2403`, with **three statements after it** (`:2404-2406`) | **FALSE** |

### Why (2) is false, and it is not a drift

The `rmSync` was **deliberately removed**, and the removal is documented at
`session-manager.js:1198`: the `_cleanup` rm "used to enforce the same thing
destructively — and wrongly, since restart routes through kill() too." It was
replaced by the mint-vs-restore axis. The same reasoning appears at :2362-2393
for both the parked-DM store and the frozen prompt: **nothing is deleted on
exit**, and the staleness it guarded is handled at read time via the `born`
stamp / unconditional mint.

So the consequence the pin is required to name — "teardown returns while the run
dir is still being deleted" — describes a deletion that no longer happens. A pin
asserting it would encode a hazard the code has already designed away.

And `sessions.delete` is not last. After it:
```
:2404  const live = new Set(this.sessions.keys());
:2405  this._intentDeduper.prune(live); this._activity.prune(live);
:2406  getRemoteServer().notifySessions();
```
Writing the spec's "three lines pin sessions.delete as last" would fail on
current, correct code.

### The property that IS real (my proposal, not a ruling)

`waitForSessionExit` polls `manager.sessions.has(name)` (`engine.js:1310`), so
the map slot is the respawn's go-signal. What must precede the map drop is every
statement releasing a resource a respawn COLLIDES with:

- `:2400 registry.unregister(name)` — else `create()` hits `EEXIST` and takes
  the force-clean path against a live entry;
- `:2399 transport.stop()` — else the new bind races the old listener;
- `:2401-2402` hook cleanup — else generated hook files are removed *after* the
  successor wrote its own.

The three trailing statements are in-process bookkeeping that no respawn touches,
which is why "last" is the wrong formulation and "after the resource releases" is
the right one. That version is load-bearing, fails on the tidy the ticket
worries about (grouping the map mutations upward), and is true of the code.

**Not building it without a ruling.** Choosing which property to pin is a design
decision, and the spec's stated one is wrong rather than ambiguous — the
difference between flag-and-proceed and stop-and-report.

### Ruling and delivery

clodex verified all three at source and ruled: **build my formulation, "after the
resource releases", not "last".** Property (1) kept as specced. Its framing of
the correction is worth keeping: "last" was never the real property — it was a
proxy that happened to be true while `_cleanup` still did an `rmSync`, and it
stopped being true when the rm correctly went away.

**The ticket's own framing was the defect.** It said "not a bug, a correctness
property held by call-site discipline alone" — and the property it named had
already been deleted as incorrect. A ticket asserting an invariant makes a claim
about current code exactly like a comment does, and decays the same way. That is
now four instances today of prose asserting something the code had moved past
(the t96 header, two drifted line refs, this).

### Pins (2, in `test/session-manager.test.js`, no product change)

Structural, via `indexOf` over source — the technique at
`plugin-host-engine.test.js:138-151`, since a unit test cannot execute
`_cleanup`'s PTY-driven path.

1. **Ordering.** Four landmarks must precede `sessions.delete`, each with its own
   consequence in the message: `registry.unregister` (EEXIST force-clean against
   a live entry — t76's bug by a second route), `transport.stop()` (respawn binds
   while the old listener holds the name-derived path; `Transport.start` unlinks
   before binding, so the old server survives on an unlinked inode), and both
   hook cleanups (successor's generated files deleted after it wrote them).
2. **Companion grep pin.** Per-file `await manager.kill(` count must not exceed
   `await waitForSessionExit(` count, plus an exact total of 3.

The comment states the exclusion of `:2404-2406` as **deliberate, not
overlooked** — in-process bookkeeping a respawn re-registers on the way up. Per
clodex: otherwise the next reader tightens it back to "last" and we are in the
t96 situation, a correct guard whose rationale invites its own reversal.

### Revert proofs (pristine `t77-sm.pristine` md5 `ed433aee…`, `t77-engine.pristine` md5 `6ecbdc38…`)

| Revert | Parses? | Result |
|---|---|---|
| A: **the tidy itself** — group map mutations, move `sessions.delete` above the releases | clean | **fails BY MESSAGE** on the registry collision |
| B: move ONLY `transport.stop()` below the drop (subtler tidy) | clean | **fails BY MESSAGE** on the unlinked-inode listener |
| C: add a 4th kill+create caller with no wait | clean | **fails BY MESSAGE** — "3 kill call(s) but only 2 waitForSessionExit" |

No crashes, no no-ops. Both product files restored to pristine md5; `git diff`
after restore shows the test file only, confirming t77 stayed test-only.

### Status: DONE — `5f746a9`. Suite file 352/352.

---

## Next: t75

The only ticket needing design judgment. clodex's read, explicitly overturnable:
the **identity field** beats the async probe, because it closes the hole for
callers that cannot await and `listPeers` being synchronous is a real constraint
rather than an accident. To measure rather than assume — and note t76's guard
comment already flags that an async probe in `cleanup()` would open the
in-process gap that guard currently sits inert against.

Premises to verify at source first: `agent-transport.js:86` (listPeers liveness),
`:103` (cleanup liveness), `:34-37` (isAlive), `:64` (record with nothing
identifying), `:211` (send resolves false), and that the probe has exactly one
production call site.
