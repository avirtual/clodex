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

**THE GENERAL RULE, which is the portable part** (clodex's formulation, and it
is sharper than mine): the defect is NOT "hand-written fixtures are bad." The
same modelling idiom is *honest* for `rosterSentAt` and `reviewFor` and
*dishonest* for `createdAt`, in the same upsert, on the same line. What
separates them is whether the product computes the field:

> **A fixture may only model fields the product does not compute.** Model a
> field the product writes, and the value asserted afterwards is the one the
> fixture chose — the test passes with the product's line deleted.

That is the vacuity rule's second face. The first face ("never recompute the
predicate") catches a harness that copies a product *expression*; this one
catches a harness that supplies a product *value*. Both leave a test asserting
against itself, and neither announces it.

Removed rather than repaired: the survives-create() half belongs against the
REAL create(), where `test/createdat-restart.test.js` already pins it (revert D
proves that one bites). The remaining :1959 assertion — that
`_preserveAcrossRestart` seeds the field at all — is genuine, and revert F
proves it. **A hollow assertion deleted is strictly better than a hollow
assertion patched, because the patched one still has to be trusted.**

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

**THE SHARED SIGNATURE, stated first because it is the whole point: every one
of these produced a CLEAN RESULT, not an error.** Detection therefore cannot
rely on noticing a failure — there isn't one to notice. Anything that begins
"when the tests go red, check whether…" is useless against this class. That is
what makes it worth a section of its own.

FOUR times this week my own tooling produced a clean result while being wrong.
Not one of them announced itself. Collected here because the ruling is right
that this is the most dangerous failure mode we have found, and it has now
appeared in four different disguises:

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
4. **The decorative assertion (t71 phase 3a, revert E).** A test I had just
   written passed with the product line it named deleted, because the fixture
   hand-wrote the value it then asserted. **314/314 green.** Caught by the
   revert discipline — the first of the four found by PROCESS rather than by
   luck or an external cross-check, which is the only one of these four that
   would have been caught reliably rather than fortunately.

**What they share**: each replaced a real signal with a plausible one. A crash
is self-announcing; a truncated run, a silently-unrestored tree, a
short-by-one census and a green test that pins nothing all look exactly like
success. The defence is never "read the harness more carefully" — I read all
four and they looked right. It is:

- **check the harness's output against a number derived somewhere else** (the
  scanner died on clodex's 11, not on my own review);
- **verify the tree state independently after any mutation** (`git diff` after
  every revert, not the trap's promise);
- **make no-op detection explicit** — my revert script now fails loudly if the
  replacement matched zero or multiple times, because "the revert applied and
  the test still passed" and "the revert never applied" are the same output
  otherwise;
- **revert every assertion you write, not just the product** (instance 4 was a
  TEST that lied, not a tool) — this is the only defence on the list that
  works by construction instead of by suspicion.

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

## PHASE 3B — the rekey. Design, decided before any code.

Branch rebased onto `dfd5fe4` (phase 3a merged), so this builds on master.

### Where the stamp lives: IN THE PAYLOAD, not in the path

Two shapes were available.

**(B) Rekey the DIRECTORY** — `pending/<name>.<createdAt>/`. Attractive because
it needs no comparison at all: a new session simply looks at a different
directory and the old one is inert residue. **Rejected.** It invents a new path
grammar, and every consumer that currently treats a child of `pending/` as a
session NAME breaks: `claimParkedById` returns `{ name, text }` taken straight
from the directory name and routes an `[agent:resend]` by it, so it would
suddenly route to `alice.1700000000000`. CLAUDE.md single-sources the runtime
path grammar in `clodex-paths.js` precisely to stop this kind of growth, and
condition (a) makes it worse: old-format entries must still DELIVER, so the
new drainers would need a second claim against the legacy `pending/<name>` dir
alongside the new one. Two claims, two grammars, in both drainers.

**(A) Stamp inside the message payload — CHOSEN.** `parkDelivery` writes
`{ text, born }` (alongside the existing optional `id`); the drain compares
`born` against the session's own createdAt and refuses a mismatch. Nothing
about the filesystem changes: same dirs, same `<seq>[.<id>].json` filename
grammar, same 3-vs-4 segment logic in `parkFileHasId`, same whole-dir
rename-claim, same sidebar badge. The payload already carries an optional
field, so the shape tolerates one more. Condition (a) falls out for free —
`born === undefined` means "parked by a version that had no stamp", which is
exactly the deliver case, and needs no second code path.

### The hard part: the HOOK must apply the same rule

The Claude UserPromptSubmit/PostToolUse drain is a GENERATED script
(`cli-hooks.js`, `pendingScriptPath`) that mirrors `drainPending`'s claim
discipline. Both drainers must stay single-source-of-truth, so the hook needs
the expected stamp too. It cannot read sessions.json (that lives in userData,
which the hook has no path to, and giving it one is a worse coupling than the
problem). So the stamp is BAKED INTO THE GENERATED BYTES at hook-setup time.

**MEASURED ORDERING PROBLEM, and it is load-bearing.** In `create()`,
`setupClaudeHook` is called at rel. line 209 while `createdAt` is computed at
rel. 636-637 — the hook is generated ~427 lines BEFORE the stamp exists. Three
ways out:

1. **Move the createdAt computation up**, above the claude arm, and pass it to
   `setupClaudeHook`. Two lines move; the upsert stays where it is and just
   uses the already-computed value.
2. Recompute `(existing && existing.createdAt) || Date.now()` inside the hook
   setup. **Rejected on sight** — that is a second copy of the product's own
   expression, i.e. the exact construction class this ticket exists to remove,
   and the two copies would drift the first time anyone touches either.
3. Write the hook script LATER, after the stamp. Rejected: the hook must exist
   before the CLI spawns, and the spawn is between the two points.

Taking (1). It is the only one that keeps a single expression.

### The drain/create interleaving — the UNREACHABLE argument (condition c)

The hazard to exclude is: an out-of-process hook drain, carrying the OLD baked
stamp, running while a new same-named session is being created — eating the new
session's mail. It is unreachable rather than unlikely, and the reason is
ordering, not probability:

- A hook fires only as a child of a LIVE CLI process, i.e. the old session's.
- For the new session to have any parked mail at all, `parkDelivery` must have
  run for it — and parking happens against a registered session, which cannot
  exist until `create()` has completed, which cannot start while the old name
  is live (`sessions.has(name)` throws) and, on every restart path, not until
  `waitForSessionExit` has confirmed the old process is gone.
- So at every instant an old-stamped drain can still be running, the store
  contains only old-stamped entries. It may consume them (delivering into a
  dying process — the pre-existing loss story, unchanged by this ticket). It
  cannot consume a new-stamped entry, because none can exist yet.

The residual case is a hook SUBPROCESS outliving its parent PTY by a few ms.
Same argument covers it: outliving the parent does not let it observe an entry
that had not been written when the new session was still unborn. **To verify,
not assume:** confirm parkDelivery has no path that runs for an unregistered
name. That check is the first thing to do when the code starts.

### THE CHECK FAILED — the argument above is WRONG. Measured, not read.

Enumerated all 9 product `parkDelivery` call sites. **Two of them park for a
name with NO live session**, reading the persisted entry instead:

- **session-manager.js:3583** — a reboot notice for an OFFLINE but resumable
  seat. Explicitly gated on `getPersistence().get(notice.name)` existing, and
  the comment says it parks "by name so it drains on the seat's next
  UserPromptSubmit after its workspace restores it".
- **session-manager.js:5611** — a reminder firing for an agent that is not
  live: same shape, same persisted-entry gate, "parked (offline) — drains on
  resume".

So "parking happens against a registered session, which cannot exist until
create() completed" is false. Parked mail can exist for a name with no process
at all. **Everything I derived from that premise has to go.** Good that this
was a verify-first item and not a "clearly true" one.

### Re-derived. The interleaving is NOT unreachable — it is unlikely, and
### that is not good enough, so the design changes to make it HARMLESS.

The strongest remaining structural fact is the atomic claim: a drain renames
the whole dir and therefore owns EXACTLY the snapshot present at rename time.
An entry parked afterwards lands in a fresh dir (parkDelivery's documented
recreate-on-ENOENT) and is invisible to that claim. So for a stale drain to
touch a successor's mail, the successor's entry must have been parked BEFORE
the stale drain's rename — i.e. the stale hook process must have been spawned
by the dead CLI, then stalled across the whole of: old CLI death, the new
create(), its persistence upsert, and a park — and only then reached its
rename, which is the first thing it does after node startup.

That is very unlikely. **It is not unreachable, and I am not going to write a
comment claiming it is.** A hook is an ordinary subprocess; nothing in the
system bounds how long it can be descheduled.

**So make the bad case harmless instead of arguing it away.** The comparison
has a direction, and the two directions want opposite handling:

| entry vs the drainer's own stamp | meaning | action |
|---|---|---|
| `born < expected` | mail for a DEAD predecessor of this name | **DISCARD** — this is case (c), the entire point of the rekey |
| `born > expected` | mail for a SUCCESSOR; *I* am the stale drainer | **PUT IT BACK** — not mine to consume |
| `born === expected` | mine | deliver |
| `born === undefined` | pre-rekey park | deliver (condition (a)) |

The `>` branch is what removes the need for a timing argument: a stale drain
that wins a race now returns the mail to the store instead of eating it. Note
this is why a plain "refuse non-matching" would have been WRONG — with a
destructive whole-dir claim, refusing without writing back is just a slower way
of losing the message, and it would lose it in exactly the race the rekey was
supposed to fix.

**This revises condition (c) and clodex must see it.** Flagging rather than
silently substituting: the ruling asked for an unreachability argument, and my
finding is that no honest one exists. The asymmetric design is safe under both
readings (a successor's entry is still "non-matching" and still not delivered),
so it is the safe reversible choice to build now and flag at report time.

### RULED (msg-81580-48): condition (c) revised as proposed — BUILD IT

*"'Unreachable' was my word and it does not survive your call-site
enumeration... I would rather have the accurate 'very unlikely, and harmless if
it happens' than a confident comment that is false."*

Two things held to, both binding on the implementation:

1. **The reason goes in the COMMENT, not just here:** a plain
   refuse-non-matching would have DESTROYED a message in precisely the race the
   rekey exists to fix, because the claim is destructive. Generalized by
   clodex, and this is the sentence to carry: **"Symmetric-looking guards are
   not symmetric when the operation they guard is."**
2. **PIN THE NEWER-ENTRY BRANCH.** It is the one nobody will ever see fire, and
   *"an unfired branch with a hollow test is worse than no branch."* It must
   fail by a message naming WHY restoring beats refusing — not merely that a
   restore didn't happen.

Also ruled worth recording as method: **enumerating the 9 call sites before
arguing from the premise is what caught this** — the same discipline that
produced the ENTER finding in 3a, applied to a PREMISE instead of a test
window. In 3a I asked "does this test enter the window it names?"; here the
question was "is the fact this argument rests on actually true?". Both are the
same move — check the thing you are about to build on, before building on it —
and both found a defect that would otherwise have shipped looking correct.

### Still to decide when writing

- `drainPending` gains an expected-stamp parameter. Every caller must pass it —
  and a caller that forgets gets the SAFE direction, which here means
  DELIVERING (never silently dropping), the same defaulting logic `mint = false`
  uses. Default to "no expectation = deliver everything".
- Condition (b): the generated hook bytes are test-pinned. They WILL change;
  changing them by accident is the hazard. Update the pin deliberately and say
  in the commit that the bytes moved and why.
- Condition (d): the `_userKilled` rm at session-manager.js:2342 comes out, and
  the residue it used to clear must be commented as deliberate, citing the
  prompt-cache precedent ("four small texts and is harmless").

### PRODUCT WRITTEN (uncommitted at this checkpoint). What landed:

- **`pending-store.js`** — `parkDelivery` takes a 7th param `born` and writes it
  into the payload (only when it's a number, so unstamped stays byte-identical);
  `drainPending` takes a 4th param `expectedBorn` and applies the directional
  table; new module-local `restoreParked(dir, base, raw)` re-publishes a
  successor's entry under its ORIGINAL basename (seq order + resend id survive
  the round trip), write-then-rename, best-effort so a failed restore can't abort
  the batch. The full directional table + the destructive-claim reasoning +
  clodex's sentence are in `drainPending`'s header comment.
- **`session-manager.js`** — createdAt/existingEntry MOVED up to just after the
  proxy-identity block (~:922), with a comment saying why it is computed 400
  lines from its consumer and that nothing between writes persistence (verified:
  the only `getPersistence()` calls in that span are the proxy-id read and the
  upsert itself). The old site now points at it. The live `session` object gains
  `createdAt` (same value, not a second `Date.now()`).
- **`session-manager.js`** — new `_bornFor(name)`: live session first, persisted
  entry second, null if neither. The fallback is what makes an OFFLINE park
  (reboot notice, reminder fire) stamp the value the restored seat will carry —
  and it only works because phase 3a stopped restarts from re-minting. Threaded
  into all 10 park sites and all 3 drain sites.
- **`cli-hooks.js`** — `setupClaudeHook` takes `createdAt` (passed, never
  recomputed — comment says so explicitly) and bakes it into the pending-drain
  script as `$5`; the generated JS gains `born_self` + `restore_parked` and the
  same directional check, mirroring `drainPending`. **The pinned bytes moved
  deliberately** (condition b).
- **`session-manager.js`** — the `_userKilled` rm is GONE (condition d). The
  replacement comment names both directions of the old gate's wrongness: too WIDE
  (restart routes through `_userKilled`, so it destroyed mail on restart) and too
  NARROW as hygiene (stale mail survived every other exit anyway), and points at
  the drain-time stamp as where the second concern now lives.

Existing suites green with product in: `test/cli-hooks.test.js` 11/11,
`test/pending-store.test.js` 27/27.

### TESTS WRITTEN — 14 new, across three files

**`test/pending-store.test.js` +7** (the comparison itself). Header states why
each test asserts the STORE and not just the return value: *"not delivered" has
two very different implementations — dropped and put back — and the return value
cannot tell them apart.* A product that destroyed every non-matching entry would
satisfy every "the successor's mail was not returned" assertion while committing
exactly the loss the stamp prevents. So discard and put-back are pinned as a
PAIR — discard is trivially satisfied by destroying everything, put-back by
destroying nothing, and only both together mean anything. Same constrain-each-
other move as 3a's test 6. Tests: predecessor discarded (+ *gone*, not restored),
successor PUT BACK (+ readable by the seat it was addressed to), equal delivers,
a mixed batch partitioned three ways in one claim (`countPending === 1` pins both
directions in a single number), unstamped delivers *to a drainer with a real
expectation*, omitted expectation delivers everything, and restore-keeps-the-
original-basename (asserted through `claimParkedById` + `drainPending`, i.e. the
product's own readers, not my reading of the filenames).

**`test/cli-hooks.test.js` +3** (the SECOND drainer). The hook and `drainPending`
are single-source-of-truth by convention only, which means nothing but a test
holds them together. These exec the generated bash+node end to end with the stamp
baked in at setup: predecessor discarded / this generation delivered, successor
put back under its ORIGINAL name, and one test carrying both halves of the
compatibility promise (an old PARK through a new hook, and a new park through a
hook set up with NO stamp — the bash arm / any caller that omits it).

**`test/session-manager.test.js` +4** (the PLUMBING). pending-store's tests pin
the comparison; these pin that the manager reads the right stamp and actually
hands it over — *a stamp computed correctly and never passed is worth nothing*.
`_bornFor` live-first, `_bornFor` persistence-fallback (with the note that the
fallback is load-bearing and only works because 3a stopped restarts re-minting),
park→drain end to end through `_maybeParkDelivery` + `_drainPendingAtIdle`, and
the condition-(d) pin: `_cleanup` with `_userKilled: true` must NOT delete the
store, failing by a message naming the restart path.

### REVERTS — 8 product reverts, and THREE of them found a hollow pin

Restored from a pristine COPY each time, `git diff` after every one, no-op
checked explicitly. Two more tests exist than when this section was first
written, both added BECAUSE a revert was a no-op.

| # | reverted | result |
|---|---|---|
| A | the whole generation check in `drainPending` | 4 fail |
| B | ONLY the put-back branch (`restoreParked` call) | 3 fail, incl. the binding message |
| C | the `typeof` guards (unstamped/no-expectation compared raw) | 17 fail |
| D | the hook's `born_self` check | 2 fail |
| E | the hook's `restore_parked` call | 1 fail — **by CRASH first, fixed** |
| F | `createdAt` off the live session object | **NO-OP — new test written** |
| G | the `createdAt` arg to `setupClaudeHook` | **NO-OP — new test written** |
| H | re-add the `_userKilled` rm | **NO-OP — harness was blind, fixed** |

**REVERT E failed by ENOENT, not by message.** With the restore gone the whole
directory is gone, so a bare `readdirSync` threw a stack trace instead of the
sentence explaining the branch — on clodex's binding item, the one that must
teach the reason. Fixed by reading defensively (`existsSync ? readdirSync : []`).
The rule "fail by message, never by crash" earns its keep on exactly the
assertion that was written to carry a message.

**REVERTS F AND G WERE BOTH NO-OPS, and they are the same defect.** Every
`_bornFor` test constructs its own session literal — honest for testing the READ,
and structurally incapable of noticing that create() stopped WRITING the field.
Same for the hook: `cli-hooks.test.js` calls `setupClaudeHook` directly with its
own stamp, so it pins what the hook DOES with the value and can never notice the
value failing to arrive. **This is the revert-E finding from 3a, one layer up:**
a fixture may only model fields the product does not compute — and the corollary
is that testing a consumer with a hand-made input never tests the producer.
Fixed with two new tests in `test/createdat-restart.test.js` (the file that
already has a real-`create()` harness): the live session carries the same stamp
as the record, and create() passes it as `setupClaudeHook`'s 8th argument. Both
assert from a REAL create(), so no fixture can fake them.

The hook test lets the spawn throw AFTER the hook call and inspects what was
captured — safe only because the ENTER assertion (`seen.length === 1`) fires
first, so "it crashed early" can never read as "it passed the right value".
Stubbing the entire claude arm was the alternative and would have made the test a
model of create() rather than a test of it.

**REVERT H IS THE WORST ONE AND IT WAS THE MOST IMPORTANT PIN.** Condition (d)'s
test passed with the deleted `rm` fully restored. The reason is not a modelling
slip — it is that the deleted code was `fs.rmSync(path.join(PENDING_DIR, name))`
inside a bare `try {} catch {}`, and the default harness injects no `path`. The
restored rm threw on `path.join` and **its own catch swallowed the throw**. The
test observed a deletion that could not happen for a reason having nothing to do
with the product. Fixed by injecting real `path` + `fs` into that one harness,
with the reason written where the injection is so nobody "tidies" it away.

Generalize it: **a guard that cannot see the thing it guards against is worse
than no guard**, because it is also a claim that someone checked. And the
mechanism is worth naming — swallowing `catch {}` in the code under test can make
a revert un-observable, so a no-op revert against error-swallowing code should be
suspected of harness blindness before it is believed.

### The per-assertion sweep, and why my FIRST version of it measured nothing

The instruction was "delete each new assertion, confirm the test then passes
vacuously". I scripted exactly that — 21 runs, each with one assertion commented
out — and every run came back green. **The script was measuring nothing.** With
the product intact the suite is green, so removing an assertion trivially leaves
it green; "still passes" was a property of the starting state, not of the
assertion. The 3a version of this move worked because the assertion was deleted
while the PRODUCT was reverted.

Redone correctly: for each product revert, collect which assertion messages
actually fire. That answers the real question — *which assertions carry weight,
and do they say something when they do*. It found two of mine failing BARE
(`Expected values to be strictly equal`), both in the mixed-batch and
restore-filename tests. Given messages; re-verified.

Worth recording as the method error it was: **a sweep that cannot distinguish
its two outcomes is not a check.** Same shape as the hollow tests it was meant to
find, one level up — I automated the letter of the instruction and lost its
point. The instruction's point is always "make the product wrong and see what
notices".

### The census caught a COMMENT — a real gap, flagged not papered over

First full-suite run: 2956 pass / 2 fail, both in `test/create-mint-census.test.js`,
reporting a 12th `.create(` site at `cli-hooks.js:50`. There is no call there. My
comment said *"session-manager.create() owns the one expression"* and the census's
top-level scan is `/(\w+)\.create\s*\(/g` — **not comment-aware**, unlike
`callArgs`, which is scrupulously so.

So the census can be tripped by prose. Reworded my comment (and said in it why),
because the alternative — adding a table row for a comment — would corrupt the
census's meaning. **The scanner gap is real and I am not fixing it in this
ticket**: making that regex comment-aware means the same whole-file
strip-then-scan that the file's own header records as having produced a phantom
string and a healthy-looking 10-site count. That is a change with its own failure
history and it belongs to whoever owns the census, with its own reverts.

Note what the census did right, though: it is designed to fail loudly when the
site set changes, and it did — on a false positive, but a loud one. A forced
pause on a wrong signal costs a minute; the silent version costs a release.

### FULL SUITE: 2958/2958, ESCAPES 0

Baseline 2942 + 16 new (pending-store +7, cli-hooks +3, session-manager +4,
createdat-restart +2 — the last two written because reverts F and G were no-ops).

**A DEFECT IN MY OWN TEST, caught by running it.** The park→drain test first
tried to reuse ONE parked message: park as gen A, drain as gen B (refused), then
drain as gen A again expecting it back. It failed — correctly. The gen-B drain
DISCARDS a predecessor's mail, so there was nothing left for the third phase.
The product was right and the test's model of it was wrong. Fixed by parking
once per generation. Worth recording because the failure was legible and
immediate: the test asserted a thing the design explicitly rules out, and it said
so. Contrast the four harness-lying-quietly instances — this one failed LOUDLY,
which is what a test disagreeing with a correct product is supposed to do.

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
