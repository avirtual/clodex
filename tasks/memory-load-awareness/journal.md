# t137 — memory-load awareness (tracker + read API only)

Consumer is the CONTEXTUAL-HINT INJECTOR, not the agent's recall behaviour.
Failure asymmetry that drives every default: a false "not loaded" costs a few
hundred redundant tail tokens; a false "loaded" silently suppresses a hint.
**When in doubt, report NOT loaded.**

Ticket fences: do NOT build the hint injector, embeddings/semantic retrieval,
or the archival-pruning rule. Constraints: temp fixtures, never the live store
(`~/.clodex/library/memory`), suite green via the test brief, no commits.

## Recon — the four event sites, all confirmed live

| # | Event | Site | What it does today |
|---|---|---|---|
| 1a | digest baked pre-spawn | `cli-hooks.js:33` `writeClaudeDigestFile` | `composeDigest(memoryStore.list(name))` → hook file; returns only a boolean |
| 1b | digest at create | `session-manager.js:1018` | recomputes `composeDigest(...) !== null` into `session.digestNonEmpty` |
| 1c | digest delivered post-clear | `session-manager.js:2580` `_maybeDeliverDigest` | composes + `_deliverMessage` when a conversation started before the hook could ride |
| 2 | recall | `session-manager.js:2668` | `_deliverMessage(agent,'memory',…)`; **records nothing** |
| 3 | /clear | `session-manager.js:1066` `onSessionId` | new sessionId when the transcript symlink repoints (`jsonl-watcher.js:88-91`) |
| 4 | compact | `session-manager.js:1086` → `_fireCompactContinuation` (:1752) | fired from `jsonl-watcher.js:133-136` on `isCompactSummary` — covers the CLI's OWN auto-compact |

`composeDigest` (memory-store.js:182) already computes the tiering and drops it:
`pinnedShown` (bodies emitted) = FULL; `demoted` minus `pinnedOmitted`, plus the
`rest` index lines actually pushed = TITLE; `pinnedOmitted` + `indexOmitted` +
everything not in `units` = ABSENT.

## Design

**memory-store.js — `digestTiers(units, opts)` sibling, one implementation.**
Returns `{ text, full: [ids], title: [ids], absent: [ids] }`; `composeDigest`
becomes `digestTiers(...).text`. NOT a return-type change on `composeDigest` —
it returns a string-or-null and callers/tests depend on that shape
(`test/memory-store.test.js:130` asserts `=== null`). Duplicating the budget
policy into a second function is the thing to avoid; a sibling that shares the
loop does not.

**memory-load.js — new leaf, electron-free, fs+path direct (memory-store.js
idiom).** `createMemoryLoad({ logDir, now })`:

- `noteDigest(agent, { full, title })` — set the digest tiers of the live set.
- `noteRecall(agent, id)` — mark FULL **and** append to the persisted log.
- `noteSession(agent, sessionId)` — /clear: resets ONLY when the id differs
  from the one already recorded (it also fires on first attach with the resume
  id, where a reset would wipe the digest cli-hooks just recorded).
- `noteCompact(agent)` — reset, sessionId unchanged.
- `stateOf(agent, id) -> 'full'|'title'|'absent'` (read API), `liveSet(agent)`,
  `recallLog(agent)`.

Reset = empty, on both clear and compact. Do not model what the summarizer
preserved: "possibly evicted" resolves to "not loaded", which is the CORRECT
policy for a dedup consumer, not an approximation.

**Ephemeral hints are deliberately not recorded in v1.** Wirescope tail hints
appear in the transcript zero times (verified 2026-07-31), so recording one as
loaded would be exactly the false-"loaded" suppression the asymmetry forbids.
The echo-detection refinement is named in the ticket as explicitly out of v1.

**Persistence** — `<REGISTRY_DIR>/library/memory-loadlog/<agent>.jsonl`, one
`{id, at, sessionId}` per line. NOT inside `library/memory/<agent>/`: that dir
is enumerated as the set of agents, so a `_loadlog` child would read as an
agent. Sibling dir, injected, so tests use a tmpdir.

**Wiring** — `engine.js:306-308` builds the store; build the tracker beside it
and pass through the existing deps objects to session-manager and cli-hooks
(cli-hooks stays electron-free; it gets an optional `onDigestTiers` callback,
absent → contributes nothing).

## Open questions / decisions taken

- cli-hooks has no sessionId at bake time — `noteDigest` therefore does not take
  one. Only the recall log needs a sessionId, and by then `session.sessionId` is
  set. Reversible.
- `test/free-identifier-leaks.test.js` — memory-load.js is a NEW leaf, not a
  coordinator extraction. Check whether the scanner's lists want it before
  assuming either way.

## A FINDING THAT CHANGED THE WIRING — resumes get no digest

`cli-hooks.js:115` (the generated SessionStart script):

```
if [ "$SRC" = "startup" ] || [ "$SRC" = "clear" ] || [ "$SRC" = "compact" ]; then
  cat "${digestPath}"
```

So the bake in `writeClaudeDigestFile` is NOT evidence of delivery: a RESUMED
session (`source=resume`) has the file written and never reads it. My first cut
recorded tiers from inside `writeClaudeDigestFile` via an injected callback —
that would have claimed FULL for every unit on every resume, i.e. the
suppressing direction of the asymmetry, on the most common spawn path there is.

Reverted. Recording moved to `session-manager.js` create(), gated on
`agentType === 'claude' && !resumeId` — the one place that knows whether this
spawn is a mint or a resume. cli-hooks.js is back to byte-identical.

Cost: the digest is composed twice on a fresh spawn (once to bake, once to
tier). Both are pure reads of the same store microseconds apart. The
alternative — reporting from the bake — is the bug above.

## Wiring as landed

| Site | File:line | Call |
|---|---|---|
| digest on a MINT (not a resume) | session-manager.js create(), after `sessions.set` | `memLoad.noteDigest(name, tiersOf(...))` |
| digest delivered post-clear | `_maybeDeliverDigest` | `noteDigest` after `markDigested`, from the SAME tiers that produced the text |
| recall | `_handleMemoryIntent` recall arm | `noteRecall(agent, unit.id, session.sessionId)` |
| /clear | `onSessionId` | `noteSession` — resets only on a CHANGED id |
| compact | `_fireCompactContinuation` | `noteCompact` |

Read API on the manager: `memoryLoadState(agent,id)` / `memoryLiveSet(agent)` /
`memoryRecallLog(agent)`.

Two null-object seams, both defaulting to the SAFE direction:
- `memLoad = memoryLoad || createMemoryLoad()` — partial deps objects (tests,
  plugin harness) get an in-memory tracker with no log rather than a throw
  inside a turn handler.
- `tiersOf = digestTiers || (() => null)` — a deps object carrying
  `composeDigest` without its sibling records NOTHING as loaded.

`composeDigest` keeps its string-or-null shape (`digestTiers(...).text`);
`test/memory-store.test.js:130` asserts `=== null` and callers branch on it.

Leak scanner: 85/85 green with no list edit. memory-load.js is a pure leaf
(fs+path+path-confine), same class as clodex-paths/path-confine, which the
scanner's header says are deliberately NOT in its lists.

## Tests — test/memory-load.test.js, 11 cases, green in 139ms

Driven through the REAL transitions: a real `create()`, the real
`onSessionId`/`onCompactSummary` closures create() hands the watcher (captured
via a JsonlWatcher stub that records its constructor args), and the real
`_handleMemoryIntent` recall arm. No case calls the tracker's methods directly
except the null-object one, which IS the direct API.

Cases: tiers describe the bytes served (all three tiers populated) · empty store
still yields `null` from composeDigest and a STRING for a non-empty one ·
demoted pin is TITLE not FULL · fresh spawn records FULL+TITLE · resumed spawn
records nothing · compaction empties · new sessionId resets, same id does not ·
recall reports FULL and logs · failed recall logs nothing · log survives a
round-trip through a second tracker · no-logDir tracker still tracks.

### THE FILE PRINTED 11/11 GREEN AND THEN HUNG

Caught by a 120s timeout, not by the runner. The recall arm delivers through the
REAL `InjectQueue`, whose boot-readiness gate polls until `_bootReadySeen`
latches — which only happens on a real mode-2004 byte from a real CLI. The deps
object carried no `INJECT_BOOT_MAXWAIT`, so the cap was `Infinity` and the poll
loop held the event loop open forever. Inside the full suite that is
indistinguishable from a deadlock.

Fixed by driving every inject wait to 0 in the deps object. This is not a
cosmetic speed knob and the comment in the file says so.

Two other seams the ENTER guard surfaced rather than hiding: `bakePrompt`
must return `''` not `null` (create() writeFileSync's it), and a real
create() needs ~20 more leaf seams than the bash-arm fixture in
createdat-restart.test.js. The `assert.fail` in `spawned()` names the missing
seam every time — a fixture that silently skipped create() would have made
every load assertion vacuous.

### A measured budget, not a guessed one

The three-tier case pins `budget: 360`. Measured across 280..420: below ~350
BOTH index lines are withheld (title tier empty — proves nothing about the
split), at 380+ both fit (absent tier empty). 360 is the only budget that
straddles all three tiers.

## Progress

- [x] recon
- [x] digestTiers in memory-store.js (17/17 in memory-store.test.js)
- [x] memory-load.js
- [x] wiring at the four sites (parse ok; leaks 85/85)
- [x] tests through the real transitions (11/11, exits clean)
- [x] mutants — 14, all reddening by message, no escapes
- [x] full suite — 3279/3279 green after the regression fix
- [x] t137 COMPLETE — reported and closed

## Mutants — 14, all reddening BY MESSAGE, zero escapes

Harness: scratchpad/mutate137.js. Refuses to run if the product differs from
pristine, requires the anchor to match exactly once, restores from pristine and
verifies byte-identity after every run. Flags CRASHED-NO-ASSERTION and
TIMED-OUT/HUNG separately — a mutant that reddens by crash or hang proves
nothing. None of the 14 hit either.

| mutant | file | fail | reddens on |
|---|---|---|---|
| title-is-full | memory-load | 2 | "an index-line unit must report TITLE" — THE suppression bug |
| title-is-absent | memory-load | 2 | same case, other direction |
| compact-noop | memory-load | 1 | "compaction resets to EMPTY…" |
| session-never-resets | memory-load | 1 | "/clear mints a new conversation id…" |
| session-always-resets | memory-load | 1 | "the first observed id is an adoption, not a change…" |
| recall-not-live | memory-load | 2 | "a recall delivers the BODY into the transcript…" |
| recall-log-not-persisted | memory-load | 2 | "the log must be on disk, not just in memory; got []" |
| resume-records-digest | session-manager | 1 | the resume case — the finding above, now pinned |
| spawn-records-nothing | session-manager | 4 | four cases lose their ENTER precondition |
| recall-not-wired | session-manager | 2 | the intent arm's call |
| compact-not-wired | session-manager | 1 | the watcher callback's call |
| title-ignores-budget | memory-store | 1 | "the newest index line fits" — tier decoupled from bytes |
| demoted-pin-is-full | memory-store | 1 | "the thin pin fits and rides in full" |
| compose-shape-drift | memory-store | 1 | composeDigest's string-or-null contract |

Two reddened on a BARE "Expected values to be strictly equal" (compose-shape-drift,
recall-not-live's second case). A red that does not name the defect is half a
test, so both assertions got messages and both were re-run to confirm the new
text is what appears. All three products diff-clean against pristine afterward;
local file re-run 11/11.

## THE FULL SUITE CAUGHT A REAL REGRESSION MY OWN FILE COULD NOT

First full-suite run: **3278/3279, one failure** —
`test/session-manager.test.js:345 _maybeDeliverDigest: stray sid … 0 !== 1`.
Not a flake, not a fixture problem: a defect I introduced.

`_maybeDeliverDigest` took its TEXT from `tiersOf(...)`, and `tiersOf` falls
back to `() => null` when the deps object carries no `digestTiers`. That test's
deps carry `composeDigest: () => 'DIGEST'` and no sibling — so the digest stopped
being delivered at all. The null-object seam I added to make tracking fail SAFE
had been placed where it could suppress the digest itself.

The rule this violated, stated so it does not recur: **load tracking is an
observer, and an observer must never be able to suppress the thing it
observes.** Fixed by composing the text independently of the tiers:

```js
const digest = tiers ? tiers.text : composeDigest(units);
...
if (tiers) { try { memLoad.noteDigest(s.name, tiers); } catch {} }
```

The create() site was checked for the same shape and does NOT have it:
`digestNonEmpty` calls `composeDigest` on its own, and the `noteDigest` call
there is observation-only.

No new test written for this — the existing case at session-manager.test.js:326
is the pin, and it is the thing that caught it. Writing a second one would be
pinning my own patch rather than the invariant.

Re-verified after the fix: session-manager + memory-load + memory-store =
396/396; the four session-manager mutants re-run against the FIXED product all
still redden by message; product diff-clean against the refreshed pristine.

NEXT: re-run the full suite (expect 3279), then close t137.

NEXT: mutants. Each must redden BY MESSAGE, never by crash/hang; save pristine
copies of memory-store.js / memory-load.js / session-manager.js first and diff
after each. Planned: tier-collapse (title→full, the suppression bug),
resume-records-anyway, compact-noop, session-always-resets,
session-never-resets, recall-not-logged, recall-log-not-persisted,
absent-derived-from-counters.

NEXT: test/memory-load.test.js. Drive through the REAL transitions, not the
reducer — the four asserts the ticket names (compaction empties; a title-only
unit does NOT report loaded; a recall reports FULL; the log survives a store
round-trip) plus: resume records nothing, /clear with the SAME id does not
reset, digest tiers match the bytes actually served (a unit past the budget is
ABSENT, not TITLE). Existing harness to copy: test/session-manager.test.js:39
builds the manager from a deps object.
