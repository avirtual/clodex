# t71 — two `_userKilled`-gated defects

Ticket: `~/.clodex/messages/clodex-hand/msg-81580-26.txt`. Not blocked on
anything. Neither is release-blocking.

## 1. The pending rm (this one loses DATA)

session-manager.js:2335 still gates the `pending/<name>` rm on `s._userKilled`
— the exact premise t63 disproved for the promptcache. Restart routes through
`kill()` → `_userKilled` (documented in the onExit comment at :1653-1654), so
an ordinary restart **discards that agent's parked DMs**, contradicting the
zero-loss claim in the comment directly above it.

Same wrong premise as MF3, different blast radius: this loses MESSAGES, not
tokens.

**The judgement IS the deliverable — do not assume symmetry with t63.**
clodex's warning, which I think is right: t63 did not re-gate the rm, it
REMOVED it and moved staleness handling to the read end via the mint axis. That
worked because a stale prompt baseline is repairable by a delta. A parked DM is
a different hazard: "deliver a dead session's DMs to its successor" may be
strictly WORSE than dropping them — it hands a new occupant someone else's
mail, and there is no delta channel that un-delivers a message.

So the question to answer explicitly before touching anything: what is the
correct behaviour for a parked DM whose addressee is (a) restarting, (b) gone
for good, (c) replaced by a new session of the same name? Those may need three
different answers, and the current code answers them with one flag that does
not even distinguish (a) from (b).

Read `tasks/ipc-cache-rework/journal.md` first.

## 2. The missed call site

remote-wiring.js:215 (the remote spawn front door) does not pass `mint`, so it
defaults false. It rejects taken names before creating, so it is only reachable
as a mint; the only way it carries a resumeId is a remote **adopt** — exactly
the adopt-mint case t63 added the axis for.

It lands in the SAFE direction today (a spurious freeze is delta-repairable),
which is why it was not a release blocker — the default was chosen for exactly
this. Fix: pass `mint: true` explicitly and comment it like the other mint
sites.

### My t63 report was wrong on the count — do not inherit it

I classified **9** call sites. There are **11** (10 real + the sandbox box
registry at ipc-handlers.js:1587, which is an unrelated `mgr`). I missed
remote-wiring.js:215 entirely, which is the one this ticket is about.

Per clodex: **re-derive the list from scratch**, trusting neither count. And if
a cheap pin exists, pin the classification — a future call site added without
`mint` is silently wrong in the same way, and a miscounted survey is exactly
how this one got through.

## Sequencing

t69 (measurement) is also open. t71 is small and self-contained; t69 is an
analysis with a real chance of ending in "measured, changes nothing." Neither
blocks the other.

t69 CLOSED (accepted, `4515a5c` + `e8c92e8`). t71 is now the live work.

---

# PHASE 1 — THE JUDGEMENT (no code written; this is the deliverable)

## Answer in one line

**t63's shape does NOT apply. Do not remove the rm, and do not re-gate it on a
better flag — REKEY it.** The correct signal is not "is this session going away
for good", which is what `_userKilled` was reached for and what it does not
mean. It is **"is this store still addressed to the same conversation the
sender wrote to"** — and that is knowable at the READ end, in the same place
t63 put it, but by a different mechanism, because a message is not a baseline.

## Why not symmetry with t63 — stated as the disanalogy, since that was the ask

t63 could delete the *when* and move everything to the *read* end because a
stale prompt baseline has three properties a parked DM does not have:

| | frozen prompt baseline | parked DM |
|---|---|---|
| wrong-value cost | a diff that is too large or too small — **repairable by the next delta** | a message delivered to the wrong reader, or never delivered — **no un-deliver, no re-send** |
| who can repair it | the machine, automatically, on the next submit | nobody; the sender does not know it failed |
| is "regenerate" available | yes — pay one bust and be correct | there is no regenerate for a message nobody kept |

So t63's move — *stop destroying, decide at read time, and let the safe default
be "regenerate"* — imports into t71 as: *stop destroying, decide at read time,
and let the safe default be…* **what?** There is no equivalent of "regenerate".
Both read-time answers are lossy in one direction: deliver → a new occupant
reads someone else's mail; drop → the sender's message evaporates silently.
That asymmetry is exactly why the same shape does not transfer, and it is why
the fix has to establish a fact the current code never records rather than pick
a better default over an unknowable.

## The three cases, answered separately

I asked whether (a) restarting, (b) gone for good, (c) replaced by a same-named
new session need three answers. **They need three answers, but only two
mechanisms** — (a) and (b) turn out to want the *same* action for different
reasons, and (c) is the only case that needs a fact nobody currently writes
down.

### (a) RESTARTING — must KEEP. This is the bug.

Restart is `kill()` → `_userKilled = true` → `create()` under the same name
with the same conversation (`engine.js:1274` `restartSession`, `engine.js:1408`
`applySessionArgs`, and `session-manager.js:5027` `[agent:context reload]` —
all three route through `manager.kill()`). The store is keyed by name and the
name is unchanged, so the parked DMs would drain on the very next
UserPromptSubmit. **The rm throws away mail that was about to be delivered
correctly, seconds later, to the same reader.** No ambiguity here at all: the
comment directly above the rm already says this is what must not happen, and
the code beneath it does it.

### (b) GONE FOR GOOD — should DROP, but the drop is worth nothing.

Delete Session (`ipc-handlers.js:349`), Delete Workspace (`app-menus.js:176`,
`:685`), remote kill (`remote-wiring.js:291`), review-done retire
(`session-manager.js:4519`), team-retire with discard (`session-manager.js:5948`).
The record is removed, nothing resumes, and the store becomes residue.

Dropping it is *nice*. It is **not a correctness requirement**, and this is the
part worth being explicit about, because it is why the whole gate can go: the
cost of NOT dropping is a directory of a few small text files under
`~/.clodex/pending/<name>/` that nothing reads. The module already accepts
exactly this trade one comment below, for the prompt cache: *"Residue for a
never-recreated name is four small texts and is harmless."* The same sentence is
true here, for the same reason. **So (a) and (b) collapse: keep in both cases,
because keeping is free in (b) and load-bearing in (a).**

### (c) REPLACED BY A SAME-NAMED NEW SESSION — must NOT deliver. The real hazard.

This is the case that is not about `_userKilled` at all, and the one the ticket
correctly warned may be worse than what we have. If `agent-7` is deleted while
three DMs sit parked for it, and a week later the operator mints a NEW `agent-7`
in a different project, those three DMs drain into the new seat's first turn.
They are addressed to a conversation that no longer exists, from senders who
have long since moved on, and they arrive as *authoritative context* in a fresh
agent's opening prompt. That is not residue — it is misdelivery, and it is the
one outcome with no repair path.

**Today's code prevents this by accident**, via the `_userKilled` rm: every
path that frees a name for reuse also sets `_userKilled`, so the store is
cleared. Which means the rm is not merely wrong — **it is doing two jobs, one
of which (a) it gets wrong and one of which (c) it gets right.** Any fix that
just deletes the rm (the t63 shape) fixes (a) and *opens* (c). That is the trap
the ticket smelled, and it is real: I checked, and there is no other guard.
`nameConflict` blocks minting over a LIVE or PERSISTED name, but a deleted
name has neither, so a mint under a reused name is legal and unguarded, and
nothing on the drain path knows the store predates the session reading it.

## The fix: give the store an identity, and check it at the read end

**Rekey the pending store from `name` to `name` + a birth stamp**, and have the
drain refuse entries whose stamp is not the current session's. Concretely: the
store dir already exists per name; the session already has a spawn identity
(`spawnedAt`, and the persistence record's `createdAt` which SURVIVES restart
and is dropped exactly when the record is dropped — i.e. precisely on the
name-freeing paths). A park writes the addressee's current stamp; a drain
delivers only matching entries and discards the rest.

That gets all three cases right by construction, without any flag meaning
"going away for good":

- (a) restart — `createdAt` is preserved across `kill()`+`create()` (the record
  is re-seeded; `_preserveAcrossRestart` already exists for exactly this class
  of field), so the stamps match and the mail drains. **Fixed.**
- (b) delete — the record is gone; residue is stamped for a session that will
  never exist, and is inert. Sweep it whenever, or never. **Safe either way.**
- (c) reuse — the new `agent-7` has a NEW `createdAt`, so the old entries do
  not match and are never delivered. **Guarded on purpose rather than by
  accident**, and guarded even if the delete path never ran (a crash, a manual
  `rm` of sessions.json, a restore from backup — all of which defeat today's
  accidental guard).

This is the same *architecture* as t63 — the destructive act goes away, the
decision moves to the read end — while being a different *mechanism*, because
the question at the read end is different. t63 asked "is my baseline stale"
and could answer from the caller's own axis (`mint`). t71 asks "is this
message still addressed to me", which the reader cannot answer from anything it
knows about itself; the sender has to have said so. Hence a stamp, not a flag.

### Cost, stated honestly, because this is wider than the ticket scoped

This touches the park/drain protocol, and the drain is an **out-of-process
shell hook** (`pending.sh` under UserPromptSubmit/PostToolUse), not Node. So
"check the stamp at the read end" means changing generated hook bytes, which
are test-pinned, plus `parkDelivery`/`drainPending`/`countPending`/`peekPending`
/`claimParkedById`/`parkIdInUse` — the whole pending module surface — and a
migration story for entries parked by the previous version. That is
substantially more than "flip a boolean", and clodex's licence to widen is
exactly what I am invoking.

**The cheaper alternative, and why I am recommending against it**, so the
choice is visible rather than made silently: keep an rm, but gate it on
"the persistence record was removed" instead of `_userKilled`. That is one
line, it fixes (a) correctly (restart re-seeds the record, so no rm), and it
keeps (c) closed on the ordinary paths. What it does NOT do is make (c) safe —
it is still a *destructive prophylactic* that has to fire on every name-freeing
path, forever, including ones added later. It is the same class of construction
as `_userKilled` itself: correct today, silently wrong the first time someone
adds a way to free a name without going through it. Given that this is the
second ticket in a row about exactly that failure mode, I do not want to ship a
third instance of it.

**But it is a legitimate call and it is clodex's, not mine** — the one-liner is
maybe 30 minutes and the rekey is a day with a protocol migration in it. If the
answer is "take the one-liner now, file the rekey", I will take that and say so
in the report; I am flagging rather than assuming.

### Recommendation

**Rekey (the wide fix).** Second choice, if clodex wants the cheap one: gate on
record-removal, and file the rekey as its own ticket with this section as its
statement of the hazard.

### One correction to the ticket's framing, offered rather than buried

The ticket says the rm "contradicts the zero-loss claim in the comment right
above it." True, and worth adding: the comment is not merely aspirational
prose that drifted — **it correctly describes the design the rm was added to
serve**, and it even names the exact hazard (`"an unconditional rm would eat
parked DMs on a restart"`). The author knew. The gate was chosen as the
mechanism for "not unconditional", and the gate does not mean what its name
says. So this is not a case of code outrunning its comment; it is a case of one
flag being asked a question it cannot answer — the same root cause as MF3, as
the ticket says, and the reason I think the fix should stop asking flags.

## Not yet started

Defect 2 (remote-wiring.js `mint`) and the call-site re-derivation are phase 2.
The re-derivation is drafted below; the PIN decision is not made yet, so no
code is written either way.

---

# PHASE 3 — BLOCKED ON A MEASUREMENT THAT KILLS THE RULED STAMP

**`createdAt` DOES NOT SURVIVE A RESTART. Measured, not read.** The rekey rests
on it, my judgement asserted it, the ruling accepted it, and the comment at
session-manager.js:1458 states it outright. All four are wrong.

## The measurement

`kill()` calls `getPersistence().remove(name)` (:1885) — the record is GONE
before `create()` runs. `create()` then does:

```js
const existingEntry = getPersistence().get(name);          // → null after a kill
const createdAt = (existingEntry && existingEntry.createdAt) || Date.now();
```

`_preserveAcrossRestart` is the mechanism that re-seeds fields across exactly
this gap, and **`createdAt` is in neither call's field list**:

- `engine.js:1302` → `['ephemeral', 'reviewFor']` + `rosterSentAt` unless fresh
- `engine.js:1452` → `['rosterSentAt', 'ephemeral', 'reviewFor']`
- `session-manager.js:5027` (context reload) → **calls it not at all**

Probe (`scratchpad/probe-createdat.js`) replaying the real store's `upsert`
(spread-merge) and `remove` (drop) semantics against create()'s own two lines:

    CASE 1  first create                        createdAt = …438
    CASE 2  restartSession (kill removes)       createdAt = …439   *** CHANGED ***
    CASE 3  restore-on-launch (record kept)     createdAt = …439   preserved

So `createdAt` is stable across the RESTORE paths and **re-minted on every
`kill()`-based restart** — which is precisely case (a), the case the whole
rekey exists to fix. A stamp that changes on restart fails (a) exactly as the
`_userKilled` flag does: the mail stops matching and is dropped. **The rekey
built on `createdAt` as it stands would reproduce the bug it is fixing, while
looking correct.**

Corroboration that this is real and not my stub: `test/session-manager.test.js:1950`
passes `createdAt: 1` in the prior entry, requests only the other three fields,
and never asserts createdAt survives. The existing test already encodes the
truth.

## This is a PRE-EXISTING defect, wider than t71

session-manager.js:1458 says, in the codebase's own voice:

> createdAt: stamped ONCE, at the session's first create. … preserve any
> existing stamp rather than resetting it — **the sidebar's "created" sort/group
> depends on it being stable across restarts.**

The comment describes the intent correctly and the code does not implement it
across `kill()`. Consumer confirmed: `renderer/renderer.js:524` feeds
`createdAt` into `sidebarMeta` for the toolbar's created-sort/group. **So every
restart silently jumps a session to "just created" in the sidebar ordering.**
Nobody has reported it because the sort is by a value that only ever moves
forward — it looks like activity, not corruption.

Same shape as this whole ticket, for the third time: a comment states the
invariant, and the mechanism chosen to implement it cannot deliver it.

## Options (not mine to choose — the stamp is load-bearing and irreversible-ish)

1. **Add `createdAt` to the preserve lists** (2 sites) and to the context-reload
   path (which preserves nothing today). Makes the existing comment TRUE, fixes
   the sidebar sort, and makes the ruled stamp work as designed. Small, but it
   is a behaviour change in a file t71 did not scope, on a path used by every
   restart.
2. **Stamp explicitly for the mail, not reusing createdAt** — e.g. a `bornAt`
   written by create() and preserved deliberately. Avoids coupling the mail
   protocol to a field the sidebar also reads, at the cost of a second
   near-identical timestamp whose lifetimes must be kept in sync by hand.
3. **A different stable identity** — none exists today that survives restart and
   changes on name reuse. `sessionId` fails both ways (mints on /clear, null
   before the first turn). I looked; there is no third option lying around.

**My recommendation: (1).** It is the smallest change, it makes a stated
invariant true rather than adding a parallel one, it fixes a real user-visible
bug for free, and option (2)'s "two timestamps that must agree" is the same
class of construction we are removing. The risk is that a preserved `createdAt`
is load-bearing for anything that currently benefits from it resetting — I
checked the consumers (renderer sidebar meta, session-restore's echo,
ipc-handlers' meta fold) and found nothing that wants a restart to look like a
birth.

**Not proceeding with the rekey until this is ruled** — the stamp is the
foundation and picking wrong means rewriting the protocol twice.

## RULED (clodex, msg-81580-38): TAKE (1), ALL THREE SITES

Verified at source independently before ruling (kill's remove at :1885 →
existingEntry null at :1462 → re-mint at :1463; neither preserve list carries
the field). The measurement stands independently of my probe.

Why (1) over (2), in the ruling's own terms and better than my version: a
second timestamp whose lifetime must be hand-kept in sync with the first **is
the same construction class we removed twice in this ticket** — something that
must be REMEMBERED at every future site. Adding a parallel field to avoid
touching a stated invariant would be choosing the very artifact we keep calling
a defect. (1) makes an existing comment TRUE instead of adding a new one that
also needs policing.

**On the blast radius** — accepted deliberately, and explicitly NOT scope
creep: *"it is the ticket arriving at its actual root. t71 began as 'a flag is
asked a question it cannot answer' and has now found that the field we would
replace the flag with does not hold either. Fixing the stamp IS fixing t71."*

**The sidebar bug is part of THIS ticket**, not a follow-up — same one-line
fix, same root; splitting it would mean filing a ticket whose fix is already
merged.

### Phase 3a checklist (do this BEFORE the rekey)

1. Add `createdAt` to both `_preserveAcrossRestart` field lists
   (`engine.js:1302`, `engine.js:1452`) **and** to the context-reload path
   (`session-manager.js:5027`), which preserves nothing today.
2. **Pin createdAt's survival across a kill-based restart DIRECTLY** — not as a
   side effect of a pending-store test. It must fail **by a message naming the
   sidebar sort**, so the next reader learns what breaks, not merely that
   something did.
3. **Correct `test/session-manager.test.js:1950`** — it passes `createdAt: 1`
   and never asserts it survives, so it currently encodes the WRONG behaviour.
   Say in the commit that the existing test encoded the bug; that is worth a
   reader's attention.
4. Then the rekey on the now-stable stamp, under the four conditions already
   recorded above.

### Phase 3a progress — PRODUCT COMMITTED as 7d6b991

All three preserve sites are edited, plus a fourth comment correction:

- `engine.js` restartSession — `createdAt` appended to `preserveFields`
  (the list that carries across a FRESH restart too, since birth time is true
  of the SESSION, not of the conversation).
- `engine.js` applySessionArgs — `createdAt` appended to the literal list.
- `session-manager.js` reload respawn — a NEW
  `this._preserveAcrossRestart(name, entry, ['createdAt'])` before `create()`.
  This path preserved nothing at all before; `rosterSentAt` deliberately still
  does not carry (it is a fresh conversation and the roster must re-deliver).
- `session-manager.js:1458` — the comment that asserted the invariant now says
  which HALF of it this line implements, and that the restart callers own the
  other half. That comment reading as the whole invariant is what let the bug
  live; leaving it intact would leave the next reader the same trap.

**Test plan for the pin (item 2).** Three sites, and they are not equally
testable:

- Sites 1+2 (engine): drive `eng.restartSession` / `eng.applySessionArgs` for
  real against a temp userData with `manager.create` spied out, exactly as
  `test/engine-args-env.test.js` already does. That harness is proven and cheap.
  But note a spied create does NOT re-mint — so the spy alone would pass even
  with the fix reverted. **The pin must therefore drive the real create() read
  as well, or assert the seeded record directly BEFORE create runs.** Decided:
  assert the persistence record between kill and create is not reachable from
  outside, so instead let create() be the REAL one where feasible and assert
  the final stamp; where the spy is used, assert the pre-create seed the spy
  observes. Whichever shape lands, the ENTER question must be answered
  explicitly: the test must show the record was actually REMOVED by kill first,
  or it is pinning a path where existingEntry was never null.
- Site 3 (reload): no existing test drives it. It is reachable via
  `_handleIntent` with `{type:'context', sub:'reload'}` on a real manager with a
  fake pty, but the block is `setImmediate`-deferred and waits on a boot signal.
  If that proves flaky, say so and pin site 3 by its observable seed rather than
  faking a whole boot — and FLAG the weaker pin rather than let it look equal.

Failure messages must name the sidebar's created sort, per the ruling.

**RESOLVED — one technique covers all three sites.** The spy-vacuity problem
above has a clean answer: don't assert what the spy RETURNS, assert what
persistence HOLDS at the moment the spy is called. That snapshot is taken
after the real `kill()` and after the real `_preserveAcrossRestart`, i.e. it is
exactly the value `create()`'s `existingEntry` read would see. So the spy stops
being a substitute for the product decision and becomes a probe placed at the
seam — inputs in, output observed, predicate never recomputed.

Site 3 (reload) turns out to be reachable the same way and is NOT the weaker
pin I feared: `_handleContextIntent(session, 'reload', '<handoff>')` on a real
manager runs the real kill + the new preserve, and its create is the manager's
own method, so the same spy works. Two mechanics to respect: the block is
`setImmediate`-deferred behind a `waitExit` poll, so the test must await the
spy rather than the call; and the handoff body is MANDATORY (a blank body
aborts before killing anything — which would silently pin nothing, so the test
must pass a real body and assert the spy fired).

Three ENTER questions, asserted separately from the behaviour, because every
one of these tests is about a fallback that must NOT fire:

1. `kill()` actually REMOVED the record — otherwise `existingEntry` was never
   null and the test pins a path where the bug cannot appear. This is the
   load-bearing one: without it, deleting the fix leaves the test green.
2. The spy actually FIRED — a create that never happened asserts nothing, and
   the reload path has two early returns that would produce exactly that.
3. The prior stamp is DISTINGUISHABLE from `Date.now()` — use a fixed old
   value (a real past ms), so "preserved" and "re-minted" cannot coincide.

Plus one test for the OTHER half of the invariant (the restore-on-launch path,
where the record survives and create()'s own read is what preserves the stamp),
so the comment at :1458 is pinned in both directions rather than only the one
that was broken.

### `test/createdat-restart.test.js` — WRITTEN, 4 tests, all passing

Design landed as planned. Two things worth recording because they were not
obvious from reading:

- **The restart paths skip the kill entirely unless a session is in the map.**
  `if (manager.sessions.has(name))` guards it, so a test that only seeds
  persistence never removes the record, never enters the window, and passes for
  free — the exact vacuity ENTER (a) exists to catch, and it caught it here
  during construction. Hence `liveSession()`: a fake session whose
  `pty.kill()` deletes itself from the map, which is what `waitForSessionExit`
  polls for.
- **ENTER (a) is asserted from the PRODUCT'S OWN CALL**, not from my reading of
  kill(): `persistence.remove` is wrapped, and the test asserts one removal
  happened AND that `get(name)` was null immediately after it. If kill() ever
  stops removing the record, these tests announce it rather than silently
  becoming vacuous.

The reload test needed two accommodations, both flagged in-file: the respawn is
`setImmediate`-deferred behind a `waitExit` poll (so the probe is awaited, not
assumed), and `_injectReloadHandoff` is stubbed — it polls for a transcript
symlink that never appears in a test with no real CLI.

**The restore direction landed too — 6 tests total, all green.** Built the
slimmer bash-arm real-`create()` harness rather than extending
`reuseArgFor`: the bash arm needs ~20 seams against the claude arm's ~35 (no
hooks, no prompt bake, no team resolution) and reaches the same persistence
write, which is the line under test. Probed before writing
(`process.getActiveResourcesInfo()` after one bash create → `['PipeWrap',
'PipeWrap']`, process exits clean), so the ctxWatcher hang that bit t63 does
not arise on this arm. **The teardown is in the file anyway** and says why: it
is the discipline for any real `create()` in a test, not a reaction to a
measured leak, and making it conditional on today's measurement is how it goes
missing when the arm grows a watcher.

Two restore-direction tests, not one:

- restore-on-launch adopts the surviving record's stamp (the half that always
  worked, now pinned so it cannot break silently).
- a genuinely NEW session still MINTS. Without this, "preserve createdAt" could
  be satisfied by never minting at all, and every new session would sort as
  epoch-0. A preserve test and a mint test constrain each other; either alone
  has a trivial wrong implementation that passes it.

### The reverts — 6 applied, 5 failed correctly, **1 EXPOSED A DECORATIVE ASSERTION**

| revert | product site broken | result |
|---|---|---|
| A | `restartSession` preserveFields drops createdAt | both restartSession tests fail, by message |
| B | `applySessionArgs` list drops createdAt | args-edit test only, by message |
| C | reload's `_preserveAcrossRestart` line deleted | reload test only, by message |
| D | `create()` always mints (ignores a surviving record) | restore-on-launch test only, by message |
| E | same break as D, seen from session-manager.test.js | **PASSED — 314/314 green** |
| F | `_preserveAcrossRestart` skips createdAt | the surviving :1959 assertion fails, by message |

Every failure was an `AssertionError` with the intended message; none was a
crash, hang, or timeout. A/B/C/D each broke ONLY the test naming their path,
which is what makes the four sites independently pinned rather than jointly.

**Revert E is the finding.** The second assertion I added to
`test/session-manager.test.js` — "the birth stamp survives the rebuild" —
passed with `create()`'s stamping line deleted. It was decorative, and I would
not have known without running the revert.

The reason is worth keeping. That test models create()'s rebuild with a
HAND-WRITTEN `persistence.upsert({..., createdAt: 1})`. For `rosterSentAt` and
`reviewFor` the model is honest: create() never writes those fields, so their
survival across the spread-merge is a real property of the store. But create()
DOES write createdAt — so the `1` in that upsert was a value *I* chose, not one
the product computed, and asserting it afterwards asserted my own fixture. The
vacuity rule as clodex stated it covers this exactly: the harness contained the
answer, so the test was asserting against itself.

Removed rather than repaired: the survives-create() half belongs against the
REAL create(), where `test/createdat-restart.test.js` already pins it (revert D
proves that one bites). The remaining :1959 assertion — that
`_preserveAcrossRestart` seeds the field at all — is genuine, and revert F
proves it.

**This is the fourth harness-lying-quietly instance this week**, and the first
found by the revert discipline rather than by an external cross-check. Same
signature as the other three: a CLEAN result, not an error. Worth noting that
the previous three were caught by luck or by clodex's independent count; this
one was caught by process.

### `test/session-manager.test.js:1950` — corrected

It passed `createdAt: 1` in the prior entry, did NOT request the field, and
never asserted it. So it exercised the exact drop under repair and read as
though that were the intended behaviour — the bug, encoded as a fixture. Now
requests `createdAt` and asserts it both after the seed and after create()'s
rebuild upsert, the second message naming the sidebar sort. The `createdAt: 5`
in the simulated rebuild upsert was also wrong (create() writes what its
existingEntry read returns, which is the seed) and is now `1`.

---

# THE HARNESS LYING QUIETLY — a failure class, written up at clodex's instruction

Three times this week my own tooling produced a **CLEAN result, not an error**,
while being wrong. Not one of them announced itself. Collected here because the
ruling is right that this is the most dangerous failure mode we have found, and
it has now appeared in three different disguises:

1. **SIGPIPE truncation (t63).** I piped `node --test` through `head`. The
   SIGPIPE killed the run mid-flight and printed EMPTY totals sections, which
   read as a pass. Standing rule since: never pipe `node --test` through `head`.
2. **The trap-restore omission (t71 phase 2).** My revert harness restored only
   the files in a hand-written list, and `session-restore.js` was not on it. So
   revert D stayed APPLIED after the script exited, and the next census run
   reported 2/3 — a "failure" with no cause visible in the tree. Caught by
   diffing against HEAD rather than trusting `trap restore EXIT`.
3. **The phantom string in my own scanner (t71 phase 2).** Stripping comments
   and strings across the whole file first, a regex literal containing an
   apostrophe opened a string that never closed and swallowed an entire call
   site. **The scan reported 10 sites and looked perfectly healthy.** Caught
   only by checking against clodex's count of 11 instead of trusting my output.

**What they share**: each replaced a real signal with a plausible one. A crash
is self-announcing; a truncated run, a silently-unrestored tree and a
short-by-one census all look exactly like success. The defence is never "read
the harness more carefully" — I read all three and they looked right. It is:

- **check the harness's output against a number derived somewhere else** (the
  scanner died on clodex's 11, not on my own review);
- **verify the tree state independently after any mutation** (`git diff` after
  every revert, not the trap's promise);
- **make no-op detection explicit** — my revert script now fails loudly if the
  perl expression changed nothing, because "the revert applied and the test
  still passed" and "the revert never applied" are the same output otherwise.

Note the recursion, which is the actual lesson: **this ticket is about a flag
that cannot answer the question its name implies, and my scanner was a harness
that could not answer the question its output implied.** Same defect class, one
layer down, found the same way — by measuring instead of reading.

---

# PHASE 2 — the call sites, re-derived from scratch

Derived by grepping `\.create(` across all non-test, non-renderer JS, then
reading the enclosing function of each hit rather than trusting any prior
table. **10 real `manager.create()` sites + 1 unrelated `mgr.create` = 11
hits**, which matches clodex's count and not mine.

| # | site | enclosing | mint today | correct | ok? |
|---|---|---|---|---|---|
| 1 | ipc-handlers.js:136 | `spawnFromParams` | **true** | true | ✅ |
| 2 | ipc-handlers.js:1218 | deploy-fix session | **true** | true | ✅ |
| 3 | ipc-handlers.js:1981 | `session:retrySpawn` | false | false | ✅ |
| 4 | session-manager.js:4107 | `[agent:spawn]` intent | **true** | true | ✅ |
| 5 | session-manager.js:4401 | reviewer seat | **true** | true | ✅ |
| 6 | session-manager.js:5027 | `[agent:context reload]` | false | false | ✅ |
| 7 | engine.js:1304 | `restartSession` | false | false | ✅ |
| 8 | engine.js:1463 | `applySessionArgs` | false | false | ✅ |
| 9 | **session-restore.js:81** | `restoreSessionsForWorkspace` | false | false | ✅ (but was never surveyed) |
| 10 | **remote-wiring.js:215** | peer `createSession` | **false** | **true** | ❌ **the defect** |
| — | ipc-handlers.js:1587 | `mgr.create(id, label)` | n/a | n/a | sandbox box registry, different object |

## What my t63 survey actually got wrong — three things, not one

Worth writing down precisely, because "I said 9, it's 11" understates it:

1. **Missed `remote-wiring.js:215`** — the one site that is actually wrong.
2. **Missed `session-restore.js:81`** — correct by default, so invisible, but
   it is the real restore-on-launch path.
3. **Mislabelled `engine.js:1304` as "restore-on-launch"** — it is
   `restartSession`. So my table had a row NAMED after the path it omitted,
   which is how the omission stayed invisible: the reader (including me)
   ticks off "restore-on-launch — covered" and moves on. A wrong label is
   worse than a missing row for exactly this reason.

Both misses land in the safe direction (default false), which is the only
reason this was a cleanup and not an incident — the default was chosen for
this, and it did its job. That is a point in favour of the design, not in
favour of the survey.

## RULED (clodex, msg-81580-34): TAKE THE REKEY

Full scope approved as a day, protocol migration included. Not the one-liner,
and not split into a follow-up. The ruling's own argument for refusing the
cheap fix, which is sharper than mine: the one-liner leaves (c) guarded by a
destructive prophylactic that must fire on every name-freeing path forever,
including paths not yet written — the same construction as `_userKilled`, and
**the third instance of that class in three tickets (MF3, the pending rm, now
this). At three you stop paying the fee and fix the shape.**

The sentence clodex asked to be recorded here, which is the generalization of
the whole judgement:

> **A flag records what the SYSTEM did; a stamp records what was TRUE at the
> time. Only the second survives a path nobody has written yet.**

And the corrected diagnosis of the comment/gate relationship, in the terms the
ruling asked for — the failure is NOT "comments drift". The comment is
accurate and even names the hazard. The failure is that `_userKilled` was
chosen as the mechanism for "not unconditional", and **a flag cannot answer the
question its name implies.** That is why the fix stops asking flags.

### Conditions attached to the rekey (all four carried into phase 3)

1. **The old-format entry case must be decided EXPLICITLY, with the reasoning
   in a comment.** Ruled: **DELIVER an unstamped entry.** It was parked by a
   version in which the rm made (c) unreachable in practice, so its provenance
   is as good as the old system could make it; dropping it loses a real message
   to defend against a case that version already guarded. The comment must
   state the window in which that holds and note that it expires once no
   old-format entries can exist.
2. **Pin the new generated hook bytes deliberately** — they are test-pinned
   already and template-literal interiors are byte-sensitive under moves
   (CLAUDE.md names this). Changing them is expected; changing them by accident
   is the hazard.
3. **State the drain/create interleaving** and why the bad one is UNREACHABLE
   rather than unlikely — same standard as t61's drain ordering and t58's
   register-then-bind. The drain runs out of process and can race a `create()`.
4. **Comment (b)'s inert residue as DELIBERATE**, citing the prompt-cache
   precedent ("four small texts and is harmless"). A future reader will want to
   add an rm back; the comment is what stops them.

## The pin question — RESOLVED (phase 2, shipped)

The ticket asks for a pin "if a cheap pin exists," because a future call site
added without `mint` is silently wrong the same way. The obvious shapes:

- **enumerate-and-assert**: a test that greps the tree for `manager.create(`
  and asserts the site count + each site's mint value against a checked-in
  table. Cheap, and it fails loudly when someone adds a site — which is the
  point. But it pins LINE NUMBERS, which churn on every edit above them, so it
  would false-fail constantly. A name-keyed variant (enclosing function name,
  not line) is more stable and is what I would build.
- **arity assert**: require every `manager.create(` call to pass all 20 args.
  Rejected on sight — it pins a style, not the decision, and says nothing about
  whether the value is RIGHT.

Note the vacuity trap here, since it is the same one that bit t63: a pin that
recomputes "is this a front door?" in the harness proves nothing. The pin can
only assert against a hand-maintained table that a HUMAN updates when adding a
site — its value is the forced pause, not the computation. I will say that in
the test's own comment so nobody later "improves" it into inferring the answer.

### Built: `test/create-mint-census.test.js`, 3 tests

Took the census shape, **keyed by file + source order, NOT by line number** —
line numbers churn on every edit above them and would false-fail constantly.
Each row carries a human-written label. The header states, at length, that the
test must never DECIDE whether a site is a mint, and why: a predicate that
inferred it would be a copy of the product's, which is the exact vacuity t63's
revert B exposed.

The mislabelling hazard is written up where the pin lives, per the ruling: the
failure mode in an audit table is not "forgot a row" but "named one row after a
different thing" — the table then names the path it omits and the reader ticks
it off as covered. A census catches the first and cannot catch the second.

The three tests: the census (count + order), the per-row mint assertion, and a
pin on `mint = false` being the parameter DEFAULT — the eight restore rows all
omit the argument and depend on it, so a flipped default would make every one
of them silently wrong with nothing else failing.

### The probe that caught my own scanner being wrong

First version stripped comments and strings across the WHOLE FILE before
scanning. A regex literal containing an apostrophe opened a phantom string that
swallowed `ipc-handlers.js:1218` entirely — **the scan reported 10 sites and
looked perfectly healthy.** A census that silently loses a row is worse than no
census, which is this ticket's own lesson arriving one layer down. Fixed by
localizing: start at each `.create(` and walk forward only, so nothing upstream
can drift the parse. Found only because I ran the count against clodex's 11
rather than trusting my own output.

### Reverts — four, all proven BY ASSERTION MESSAGE, `NODE_EXIT=1`, no crashes

- **A** — the t71 defect restored (remote-wiring's `true` removed) → the
  remote-wiring row fails: *"is a MINT, so it must pass the 20th positional
  explicitly — omitting it takes the default (false)… Found arity 19."*
- **B** — `mint = false` flipped to `true` in the signature → the default pin
  fires alone.
- **C** — a NEW mint-less `create()` site added to ipc-handlers → count
  mismatch, *"found 12, table has 11 … this test cannot tell you whether your
  new site is a mint — go read it."* **This is the future regression the pin
  exists for, and it fires.**
- **D** — a RESTORE path (`session-restore.js`) made to claim `mint=true` →
  *"is a RESTORE path and must not claim to be a mint… Found mint=true."*
  Proves the restore branch is reachable and not vacuously true.

**A harness bug worth recording**: my restore list omitted `session-restore.js`,
so revert D stayed applied after the script exited and the next census run
showed 2/3. Caught by diffing the tree against HEAD rather than trusting the
trap. The trap only restores what you list — same class as the SIGPIPE lesson
(the harness lying quietly), and the reason the post-revert tree diff is not
optional.
