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

# PHASE 2 (draft) — the call sites, re-derived from scratch

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

## The pin question — open, decided in phase 3

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
