# t63 — t61 rework: the freeze outlives its repair channel

Branch `ipc-cache-rework` off master `f3c4f1f` (t62 merged, so the suite
baseline is **2915**, not the ticket's 2909). Do not touch master, do not push.

## Phase 1 — the blocking verification (settled position #2). DONE. IT IS FALSE.

The ticket makes this the gate on MF1: *"Before implementing, VERIFY settled
position #2 yourself rather than taking my word or the reviewer's. If you find
additionalContext does NOT survive /compact, that changes both this fix and a
documented position, so STOP and report."*

I verified it against the wire, not against docs or inference. Evidence below.

### Method

This session (`clodex-hand`, sessionId `d183bf3e-…`) is itself a long-lived
Claude Code session with **40 compacts** in one transcript, and wirescope has
captured every request it ever sent:
`~/Library/Application Support/clodex/wirescope/logs/d183bf3e-…/` (16,522 files).
So the question "does X survive a compact" is directly measurable as "is X in
the request body the CLI sent after the compact".

Compact boundary used: request `9807` (pre) → `9815` (post), consecutive parent
turns either side of one `/compact`.

### Finding 1 — compact does NOT preserve the message array in any form

| | messages | request bytes |
|---|---|---|
| pre-compact (`9807`) | **196** | 396,080 |
| post-compact (`9815`) | **4** | 121,748 |

The post-compact body is `[user: summary, assistant, user, system]`. I sampled
119 distinct 64-char probes from the interiors of the pre-compact messages:
**14 survived verbatim, and every one of them landed inside the summary text
itself** (post msg 0) or in the static system block — i.e. they survived because
the summarizer happened to quote them, not because anything was carried over.

That is structural, not statistical: compaction REPLACES the message array with
a generated summary. Anything delivered as conversation content is subject to
the summarizer.

### Finding 2 — what actually happens, and why the position looked true

`additionalContext` from a **SessionStart** hook is present after the compact.
But it is not the old one carried forward — it is a **fresh re-fire**. The
transcript records a distinct hook event:

```
attachment hookName="SessionStart:compact"
  command: /Users/bogdan/.clodex/run/clodex-hand/hook.sh
  stdout:  {"hookSpecificOutput":{"hookEventName":"SessionStart",
            "additionalContext":"You are the clodex agent named 'clodex-hand'."}}
```

40 `SessionStart:compact` events in this transcript — one per compact. The
string appears exactly ONCE in the pre-compact body and exactly ONCE in the
post-compact body, in a different message: the old instance was summarized
away and a new one was emitted by the re-fired hook.

So the true statement is:

> **SessionStart additionalContext is re-emitted after /compact, because the CLI
> re-fires SessionStart with `source=compact`.** It is not preserved verbatim;
> the channel self-heals.

The old claim and the true one are indistinguishable if you only look at whether
the string is present afterwards. They differ completely for any channel that
does not re-fire.

### Finding 3 — consequence for MF1 (this is why it is a blocker)

`ipcdelta.sh` is registered under **UserPromptSubmit** (cli-hooks.js:301), not
SessionStart. UserPromptSubmit does not re-fire on compact. A delivered delta is
therefore ordinary conversation content and **is summarized away by compact**,
with `notified.md` already advanced — permanently stale, silently. That is
exactly the failure mode the ticket describes for `/clear`.

**The reviewer was right about /compact.** clodex's correction ("do NOT re-stage
on compact") rests on the false position. The `/clear`-only fix as specified
leaves the compact hole open, and this session compacts ~6 times a day.

### Finding 4 — a second, pre-existing defect falls out of the same measurement

cli-hooks.js:89 gates the digest on `SRC = startup|clear`. A compact re-fire has
`source=compact`, so it takes the `else` branch and emits **name-only**. Since
the digest that WAS in history is summarized away by that same compact, a
long-lived session loses its memory digest at the first compact and never gets
it back. The comment at :76-79 justifies the gate with "a resume already carries
the digest in its history (and additionalContext survives /compact verbatim)" —
both halves fail together. Not mine to fix in this ticket; reported.

### Status — RULED (msg-81580-17). MF1 EXPANDS TO BOTH EDGES.

clodex retired settled position #2 as false, verified both halves independently
on their own transcript (32 `SessionStart:compact` events; their live
post-compact context carries the name line and no digest — Finding 4
reproduces). The corrected position, to be written where the false one lives:

> SessionStart additionalContext is RE-EMITTED after /compact (the CLI re-fires
> SessionStart with `source=compact`) — it is SELF-HEALING, not preserved.
> Channels that do not re-fire, UserPromptSubmit among them, have their
> delivered content summarized away like any other message.

**Detector**: NOT JsonlWatcher — sessionId is stable across all 40 compacts
(matches the documented gotcha: /clear mints a new ID, /compact is in-place).
The edge is visible only at the SessionStart hook, which already parses `SRC`
for the digest gate. Use that.

**The reset rule** (stated as the invariant, not a special case): the system
prompt SURVIVES compaction — it is the system block, not a member of the
messages array (Finding 1's post body has four messages, none of them it). So
after a compact or a clear, the only Clodex instruction text the agent still
holds is `session.md`. Therefore the action at either edge is exactly:

    notified.md := session.md      (then let the normal stage/drain run)

NOT "re-deliver the last delta". Reset the baseline to what provably survived
and the existing edge-triggered machinery regenerates precisely the delta the
agent is now missing — which may be larger than the one that was lost, and
should be. **`notified.md` means "what this agent has been told BEYOND its
system prompt", and after a context reset that is nothing.** That sentence is
the whole justification.

Required: state the interleaving chosen against the drain's rename and why the
race is unreachable rather than merely unlikely.

**Finding 4 is NOT mine to fix** — clodex is opening it as its own ticket. But
t63 must still correct the comment at cli-hooks.js:76-79 (it states the retired
position), replacing it with the corrected mechanism and noting the gate's
consequence is tracked separately. **Do NOT change the SRC gate itself** —
emitting KBs of digest right after a compact is a context-cost decision that
deserves its own ruling.

## Phase 2 — MF3 + MF2 (product code DONE, tests pending)

**Took the AXIS fix, not the `_restarting` fallback.** The axis holds cleanly:
`spawnFromParams` (ipc-handlers.js:106) is documented and verified as the SINGLE
mint chokepoint — session:create, team:create, team:join and the web-host WS
mirror all funnel through it, while every restore path (restore-on-launch,
unarchive→retry, restart/reload, retrySpawn) reaches `manager.create` directly.
So the axis is already materialized in the call graph; it needed a parameter,
not new state. The `_restarting` fallback would have added a second flag whose
correctness depends on every future kill site remembering to set it — the same
class of bug as `_userKilled` being read as "going away for good".

`create()` takes a new trailing `mint = false` param. Default false is the SAFE
direction: a caller that forgets it gets a freeze (repairable by the delta
channel), never a spurious regenerate (the token bust itself).

Call sites classified, all 9 enumerated:

| site | mint | why |
|---|---|---|
| ipc-handlers.js:136 `spawnFromParams` | **true** | the mint front door |
| ipc-handlers.js:1218 deploy-fix session | **true** | brand-new deconflicted name |
| ipc-handlers.js:1981 `session:retrySpawn` | false | restore path |
| engine.js:1304 restore-on-launch | false | restore path |
| engine.js:1463 `restartSession` / applySessionArgs | false | **the MF3 bug** |
| session-manager.js:4099 spawn intent | **true** | agent-initiated new seat |
| session-manager.js:4392 reviewer seat | **true** | recycled monotonic name |
| session-manager.js:5011 `[agent:context reload]` | false | resumeId null anyway |
| ipc-handlers.js:1587 `mgr.create` | n/a | sandbox box registry, unrelated |

- **MF3**: the `promptcache` rm is GONE from `_cleanup` — not re-gated, removed.
  The comment now states why `_userKilled` is not the signal it reads as, and
  points at the read end (`mint`) as where the stale-baseline hazard is handled
  non-destructively. The old contradicted comment at :1653-1654 is now correct
  as written.
- **MF2**: `hookInstalled` captured in the `!args.includes('--settings')` branch;
  `reuse = !!resumeId && !mint && hookInstalled`. **NO FREEZE WITHOUT A CHANNEL.**
  A `warnings[]` entry rides the existing mechanism (:882 / :1773, one line, same
  shape as the skill/subagent mismatch warning) so the operator is told rather
  than left with a silently regenerating session.

Note the fallback for MF2 is REGENERATE, not freeze: a frozen prompt with no
delivery channel is permanent silent staleness, strictly worse than the rewrite
this module exists to avoid. The session pays the bust once and is correct.

## Phase 3 — MF1, both edges (product DONE)

Implemented in the **SessionStart** script (cli-hooks.js), which is the only
place the edge is visible — it already parses `SRC`, and `source` distinguishes
`clear` / `compact` / `startup` / `resume`. JsonlWatcher cannot see a compact at
all (sessionId stable across all 40; /compact is in-place).

`SRC = clear|compact` → run a small node block that does, in this order:

1. read `session.md`; **exit 0 if absent** (no cache → nothing to reset, and a
   fresh session must not have a baseline invented for it);
2. **unlink `delta.md` and `next.md`** — they were computed against the OLD
   baseline, so draining them after the reset would advance `notified.md` past a
   delta the reset just invalidated;
3. write `notified.md := session.md` via tmp+rename.

`promptCacheDir` moved up to the other path constants (it was declared beside
the drain) so both scripts read one definition.

### The interleaving, and why the race is UNREACHABLE

Two writers touch `notified.md`: this reset (SessionStart) and the drain's
rename (UserPromptSubmit). They cannot overlap for one session because they run
on different CLI events that are serialized by the CLI itself — SessionStart
fires while the conversation is being (re)established, and there is no turn to
submit until it has returned. This is structural, not a timing argument.

Within the reset, the unlink-BEFORE-write order makes even a torn execution
safe: the worst state is "no staged pair, old baseline", which the next spawn
simply re-stages. The reverse order could leave a live pair whose drain advances
the baseline past an invalidated delta — the one unrecoverable outcome.

## Phase 4 — small fixes (DONE)

1. **Bounce-as-floor overclaim** corrected in `tasks/ipc-prompt-cache/journal.md`
   at BOTH sites (:172 ruling, :297 flag 3). The module header never actually
   carried the claim — it does now, in the correctly scoped form, since that is
   where a future reader will look: floor for DELETIONS ONLY, and only for verbs
   the agent TRIES; additions, changed semantics of an unchanged verb, and
   team/role prose have no backstop but the delta.
2. **cli-hooks.js:76-79** — retired position #2 replaced with the corrected
   mechanism (SessionStart re-fires with `source=compact`, so it is self-healing,
   not preserved; non-re-firing channels are summarized away). Notes that the SRC
   gate's own consequence is tracked separately. **SRC gate itself unchanged**,
   per the ruling.
3. **Drain ordered FIRST** under UserPromptSubmit, with the reason recorded (a
   protocol change can alter what the messages below it mean).
4. **tmp suffix** → `${pid}.${Date.now()}`.

## Phase 5 — tests (15 new, all green)

`test/ipc-prompt-cache-rework.test.js`, new file, 15 tests. The review's closing
observation was that none of the three MUST-FIX seams had ANY pin — that is the
ENTER question failing at suite level — so each seam gets a negative pin (the
thing that must not happen) AND a control (the thing that must still happen),
because every one of these is about a branch NOT taken and would pass for free
if the test never entered it.

| # | pin |
|---|---|
| MF3 | a RESTART (`_userKilled`) keeps the cache — drives the REAL `_cleanup` |
| MF3 | natural exit + app quit keep it too |
| MF3 | **positive**: archive→unarchive→resume keeps it AND re-bakes born bytes |
| MF3 | an adopt-MINT with a resumeId regenerates, does not inherit the baseline |
| MF3 | control: a RESTORE with a resumeId still freezes (mint is the axis) |
| MF2 | `--settings` ⇒ no channel ⇒ regenerate, and nothing staged |
| MF2 | control: same resume WITH the hook installed does freeze |
| MF1 | `source=clear` and `source=compact` reset the baseline + invalidate the pair (×2, real script under /bin/bash) |
| MF1 | the reset does NOT replay the last delta — the regenerated one is LARGER |
| MF1 | `source=startup` / `source=resume` must NOT reset (×2) |
| MF1 | unlink-before-write order, pinned in the generated bytes |
| MF1 | the reset reads from the shared root, not the run dir |
| — | the drain is registered FIRST under UserPromptSubmit |

`_cleanup` is driven for real via `createSessionManager` rather than asserted
from source text: it is the method that shipped the bug.

### The ENTER question caught a flaw in my own fixture

My first `stagedSession()` baked, staged, and asserted the reset. Five MF1 tests
failed on their own ENTER guard: **`notified.md` still EQUALS `session.md`
straight after a spawn** — only the drain ever advances it. So the fixture was
asserting the reset in a state where a reset is indistinguishable from a no-op,
and would have "passed" against a reset that did nothing.

Fixed by making the fixture reach the state the bug is actually about — POST
DELIVERY: stage change #1, run the REAL drain (so the baseline advances), then
stage change #2 and let the reset fire. That is the only state in which a
context reset has anything to lose. The guard is doing its job as written.

### One existing test adjusted (in scope, and it was pinning the wrong thing)

`test/cli-hooks.test.js` resolved the pending drain by INDEX
(`UserPromptSubmit[0].hooks[1]`) inside an assertion whose subject is "PostToolUse
drains pending only" — an assertion with no opinion about submit ordering. The
deliberate reorder broke it. Changed to resolve by name (`endsWith('pending.sh')`)
so the two decisions stop being silently coupled. No behavioural pin was weakened;
the ordering itself is now pinned explicitly in the new file.

Touched suites: **431 pass / 0 fail** (cli-hooks, ipc-prompt-cache, session-manager,
free-identifier-leaks, clodex-paths).

## Phase 6 — reverts (IN PROGRESS)

- **A** (restore the `promptcache` rm under `_userKilled`) → 1 fail, the MF3
  restart pin, **by assertion message**. Restored + diffed clean.
- **B** (`reuse = !!resumeId`, dropping `&& !mint && hookInstalled`) →
  **PASSED. My tests were vacuous.**

### Revert B caught a real defect in my own tests

`bakeAs()` recomputed `!!resumeId && !mint && hookInstalled` in the HARNESS and
passed the result to `bakePrompt`. So the tests pinned a *copy* of the
expression, not the expression: reverting the product line left all 15 green.
Exactly the shape clodex has warned about four tickets running, found only
because the revert was run rather than assumed.

Rebuilt around two separate seams:
- **the decision** — drive the REAL `create()` claude arm with a spy in
  `bakePrompt`'s place and capture the `reuse` argument session-manager actually
  computes (`decidedReuse()`);
- **the cache behaviour** — `bakeAs(root, name, text, { reuse })`, which no
  longer decides anything.

## Phase 6a — BLOCKING FINDING, raised with clodex

Driving the real `create()` surfaced a **pre-existing crash**: a claude session
whose `extraArgs` carry `--settings` cannot spawn at all.

    fs.writeFileSync(promptPath, baked)   // :1179, run/<name>/append-prompt.md
    → ENOENT: no such file or directory

Nothing creates `run/<name>/` before that write. The only producer on the claude
path is `setupClaudeHook`, which is skipped precisely when the user supplies
`--settings` (:1041). The `ensureDir(runDirFor(...))` that would have covered it
sits ~90 lines LATER (:1269), and its own comment says it is there "so the bind
never depends on hook-setup ordering having run" — the same ordering hazard,
recognised and fixed for the socket bind but not for the prompt write.

Pre-existing, not caused by t61: the pre-t61 code has the identical shape
(`setupClaudeHook` at :1025, unconditional prompt write at :1132).

Consequence for MF2: the ticket's premise — "resumes onto a deliberately stale
prompt with ZERO delivery mechanism, forever" — is not what happens today. The
session does not resume stale; it **fails to spawn**. The MF2 fix is still
correct and still needed (it is what makes the path safe once the crash is
fixed), but the failure it prevents is currently masked by an earlier one.

Raised rather than fixed: the fix is one line (`ensureDir` before the write) but
it is a different bug in a fenced file, and whether t63 absorbs it is clodex's
call.

### RULED: absorbed into t63 (clodex, msg-22)

Option (a) — one line, same file, same commit. The ruling's argument, which is
better than mine: `ensureDir(runDirFor(...))` at the socket bind carries a
comment saying it is there "so the bind never depends on hook-setup ordering
having created the dir first." That is the codebase's own voice establishing
the local convention — **a consumer of `run/<name>/` ensures the dir itself
rather than inheriting it from hook setup**. So this restores an invariant the
file already holds; it does not add a new one. And: "shipping a fix FOR
`--settings` sessions while `--settings` sessions cannot spawn is not a shape I
will release."

Fence on the absorb, as ruled:
- The `ensureDir` goes immediately before the write, not at the top of the arm.
- Commented as the ordering invariant, pointing at the socket-bind precedent,
  so the next person moving code in this arm does not hoist it away as
  redundant.
- It gets its OWN revert (H), failing **by message**, not by ENOENT crash —
  "a crash is not a proof; a crash is what we already have."
- Nothing else from that neighbourhood comes with it. A third consumer with the
  same shape gets REPORTED, not fixed.

**Why MF2's test exists for a path that "crashed anyway"** — stated here in the
terms the ruling asked for, because a future reader will otherwise wonder. The
failure MF2 prevents was not absent, it was MASKED by a louder one. While the
ENOENT stood, a `--settings` session died before it could reach the freeze
decision at all. With the ENOENT fixed the path becomes reachable, and MF2's
`hookInstalled` condition is then the only thing standing between a
`--settings` session and a system prompt frozen forever with no channel that
could ever repair it. The two fixes are ordered, not alternatives: the first
makes the path live, the second makes it correct.

Implemented: `ensureDir(runDirFor(REGISTRY_DIR, name))` immediately before the
`fs.writeFileSync(promptPath, ...)`, with the invariant comment. Pinned by
`MF2 precondition: a --settings session can SPAWN AT ALL`, which catches the
throw and asserts on the message rather than letting the ENOENT escape, and
whose ENTER guard asserts `run/<name>/` does NOT exist going in — a pre-created
dir would make it pass without testing anything.

### Vacuity: the rule clodex pinned from finding 1

> A test may pass a product predicate's INPUTS or observe its OUTPUT. It may
> never recompute the predicate itself. If the harness contains the same
> boolean the product contains, the test is asserting against itself.

Worth recording what caught it: **running the revert, not reading the test.**
The tests read correctly. They were green for the wrong reason and would have
stayed green through the exact regression they name.

## Phase 7 — remaining reverts + commits + suite — in progress

### A hang the reverts exposed, fixed before proceeding

Running the rebuilt file end-to-end showed all 18 tests PASS and then the
process never exit — `node --test` printed no totals and hung until timeout.
Inside the full suite that is indistinguishable from a deadlock and would wedge
a CI run; it also silently broke my own revert script (empty totals sections),
which is what surfaced it.

Diagnosed by MEASURING, not reading: an active-resources probe after a single
spawn reported `["PipeWrap","FSEventWrap","PipeWrap"]`. The FSEventWrap is
`session.ctxWatcher` (`fs.watch`, session-manager.js:1618), which `create()`
opens and nothing in a test tears down. Fixed in the harness (not the product)
by stopping sentinel/watcher/ctxWatcher and clearing `_bootDrainTimer` in a
`finally` around every spawn. `beforeExit` now fires; the file runs 18/18 in
1.2s and exits 0.

Worth noting for the report: the *first* teardown attempt stopped only the
watchers and did not fix the hang. The probe is what identified the real
handle. Guessing twice would have been cheaper to write and wrong.

### Revert C — PROVEN

`bakePrompt(..., !!resumeId && !mint)` (drop `&& hookInstalled`).
`NODE_EXIT=1`, crash check empty, exactly one failure:

> ✖ MF2: NO FREEZE WITHOUT A CHANNEL — a user --settings must not reuse
> AssertionError: with no drain installed there is no way to deliver a diff…
> `true !== false`

By assertion message, not by crash. The control test ("the same resume WITHOUT
a user --settings does reuse") stayed green, so the failure is the channel
condition specifically and not the freeze collapsing for everyone.

### Reverts D–H — ALL PROVEN

Every one: `NODE_EXIT=1` (assertion failures, not 124/hang), and the named pin
fired. Tree diffed back to pristine between each and after the last — all six
files byte-identical; touched suites re-run 44/44 green.

**D** — reset gate dropped (`if true`), so the reset fires on every source.
Both no-reset pins fired:
> ✖ MF1: source=startup must NOT reset the baseline
> ✖ MF1: source=resume must NOT reset the baseline
> AssertionError: …is not a context reset: the conversation's delivered history
> is intact, so resetting the baseline here would re-deliver a diff the agent
> already absorbed on every GUI restart

**E** — `notified.md` written BEFORE the two unlinks. Exactly one failure:
> ✖ MF1: the reset unlinks the staged pair BEFORE writing the baseline
> AssertionError: …the reverse can leave a live delta whose drain advances the
> baseline past its own invalidation — the one unrecoverable outcome

**F** — ipcdelta moved back to LAST under UserPromptSubmit:
> ✖ the ipcdelta drain is registered FIRST under UserPromptSubmit
> AssertionError: …must not arrive underneath parked DMs and a context warning
> `3 !== 0`

Note `test/cli-hooks.test.js` was run alongside and stayed GREEN under this
revert — which is the point of the index→name change: `PostToolUse must drain
pending only` used to resolve the drain by index `[1]`, so submit ordering and
that assertion were silently coupled. Now reordering submit fails the ordering
pin and nothing else.

**G** (reverts the TEST, not the product) — `stagedSession` skips `runDrain`.
All five MF1 ENTER guards fired:
> AssertionError: ENTER: notified.md must have ADVANCED past session.md going
> in, or "the reset set them equal" is true by accident rather than by reset

This is the guard that caught my own first draft. Without the drain,
`notified.md` equals `session.md` and a reset is indistinguishable from a no-op
— the tests would have "passed" while asserting nothing.

**H** (the absorbed `ensureDir`) — removed. Three tests failed; the one that
matters failed BY MESSAGE, as clodex required, because it catches the throw:
> ✖ MF2 precondition: a --settings session can SPAWN AT ALL
> AssertionError: a session whose own --settings skips Clodex's hook setup must
> still spawn: nothing else creates run/<name>/ before the append-prompt write…
> Got: ENOENT: …/run/settings-probe/append-prompt.md

The other two (`NO FREEZE WITHOUT A CHANNEL`, `is WARNED`) fail by raw ENOENT
under this revert, and that is the masking relationship stated as machine
output: with the crash present, MF2's own pins cannot even reach the decision
they test. The crash-check grep is non-empty for H alone, and expectedly so —
the assertion message is the proof, the ENOENTs beneath it are the bug.

## Phase 8 — commits + suite + report
