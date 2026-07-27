# t61 — per-agent IPC prompt cache: stop rewriting the system prompt under a live conversation

Branch off master `d5db769` (t60 merged). Do not touch master, do not push.

## Spec amendment (msg-81580-5, overrides the ticket's "WHAT THE DELTA SHOULD SAY")

- **Deliver a plain diff.** The ticket's "raw unified-diff hunks are probably
  wrong, render something friendlier" is WITHDRAWN. Keep the channel dumb: diff
  in, additionalContext out. No prose generation, no summarization, no
  templating — a renderer can drift from the bytes, and a REMOVAL is exactly
  what friendly prose would soften into something an agent reads past. At most a
  one-line header naming it an IPC protocol change; nothing that transforms the
  content.
- **Extra required pin**: a freshly created session (no resume) receives NO
  delta, by construction — `session_ipc == real_ipc == last_ipc` at birth. Zero
  deltas is the healthy steady state. A fresh session producing a delta is a
  `last_ipc`-initialization bug that would hand every new agent a diff against
  nothing.

## Phase 1 — reading (docs + the sites the ticket names)

Read: `docs/messaging.md` (§6 protocol text, §7 hook drains, invariants),
`docs/sessions.md` (§1 create, §2 hook generation, §4 exit/restore),
`ctx-reminder.js`, `clodex-paths.js`, `cli-hooks.js:105-300`,
`session-manager.js:921-1170` (claude/codex arms) and the reload path at :4900.

### The write site (confirmed)

`session-manager.js:1130-1132`, claude arm:

```js
const promptPath = pathFor(REGISTRY_DIR, name, 'appendPrompt');
fs.writeFileSync(promptPath, teamBlock ? `${append}\n\n${teamBlock}\n` : append, { mode: 0o600 });
args.push('--append-system-prompt-file', promptPath);
```

`append` comes from `mergeClaudeSystemPrompt(extraArgs, ipcPrompt, {...})` at
:977-978, where `ipcPrompt = buildIpcPrompt(intents, execCommands,
pluginGrammarLines(intents))` — so the blob is IPC prompt + library appends +
legacy inline + user flags, with the team block concatenated at :1132.

Codex has the same shape at :1142-1163 (`instructions.md`,
`model_instructions_file`).

### Delivery precedent (confirmed)

`cli-hooks.js` generates three UserPromptSubmit drains, all registered in the
`--settings` hooks block at :260-268:

| drain | consumes? | loss posture |
|---|---|---|
| `acks.sh` | read + truncate | lossy-tolerant (bookkeeping) |
| `pending.sh` | atomic whole-dir rename-claim | zero-loss by construction |
| `ctxwarn.sh` | read only, never consumes | recurs every submit (level-triggered, deliberate) |

The ticket names `ctx-reminder.js` as the precedent for the *channel*
(a per-agent file the hook drains into `additionalContext`), but ctxwarn is
LEVEL-triggered and non-consuming — the exact posture this ticket forbids.
The consuming shape to copy is `acks.sh` (read+truncate) or, if the advance
must be atomic with delivery, `pending.sh`'s rename-claim.

`cli-hooks.js:76` records the settled position that `additionalContext`
survives `/compact` verbatim.

### Paths

`clodex-paths.js` `KINDS` currently has 19 kinds (the header says 18 in two
places and then lists 19 — pre-existing, not mine to fix). A new per-agent file
adds a `KINDS` entry AND a `LEGACY_SUFFIXES` entry (the sweep invariant: every
kind stays sweepable, even ones no flat build ever wrote — `fileHeat` is the
precedent for a defensive legacy suffix).

## Phase 2 — verification of the design's premises

### (a) `append-prompt.md` does NOT survive to resume time — RESOLVED, premise false

```js
// cli-hooks.js:401
function cleanupClaudeHook(name) {
  try { fs.rmSync(runDirFor(REGISTRY_DIR, name), { recursive: true, force: true }); } catch {}
}
```

`_cleanup` (session-manager.js:2289) calls it for every claude agent on EVERY
exit path — natural exit, restart's kill, quit's `killAll` — not just user-kill.
So the whole `run/<name>/` dir, `append-prompt.md` included, is gone before the
next `create()` runs. State 1 of the design ("the file already on disk") cannot
be read back on resume.

This does not break the DESIGN — it breaks only its assumed storage. The three
states still work; `session_ipc` just has to live somewhere `_cleanup` does not
delete.

**The codebase already solved exactly this**, and its answer is the opposite of
the ticket's instruction to add a `clodex-paths` kind. Parked DMs must survive
session death, so the DATA lives at the shared `~/.clodex/pending/<name>/` root
while only the drain SCRIPT lives in `run/<name>/` — `clodex-paths.js:33` states
the rule outright ("SHARED state stays at the ~/.clodex ROOT and never moves"),
and `_cleanup`'s own comment (:2273-2280) explains why an unconditional rm there
would be a zero-loss violation. `run/<name>/` is BY DEFINITION per-run state.

Proposed split, mirroring `pending/` exactly:

| what | where | why |
|---|---|---|
| `session.md` (session_ipc), `notified.md` (last_ipc), `delta.md`, `next.md` | `~/.clodex/promptcache/<name>/` (shared root) | must survive `_cleanup` |
| `ipcdelta.sh` (the drain hook) | `run/<name>/` via a new `pathFor` kind | genuinely per-run, regenerated each spawn |

So the ticket's `pathFor` instruction IS honoured for the one new file that is
actually per-run. Raised with clodex rather than taken silently (msg below).

### (b) Delivery confirmation — the edge-trigger hazard

The ticket: advance `last_ipc` only after delivery is confirmed. Shape that
gives that for free, mirroring `pending.sh`'s claim-then-emit:

- producer (`create()`): if `real != last`, write `delta.md` (the diff) and
  `next.md` (= real_ipc). **Do not touch `notified.md`.**
- drain (`ipcdelta.sh`, UserPromptSubmit): emit `delta.md` as
  `additionalContext`, THEN `rename(next.md → notified.md)` (atomic) and unlink
  `delta.md`.

`last_ipc` therefore advances only in the drain, i.e. only once the hook has
actually emitted. A crash between emit and rename re-delivers the same delta
next turn — **at-least-once, never at-most-once**. That is the safe direction:
the ticket's stated failure mode (a delta delivered but never absorbed, lost
permanently) requires advancing before delivery, which this shape structurally
cannot do.

### (c) A removed intent already bounces LOUDLY — no change needed

The ticket's asymmetric-risk question ("check what intent-registry does with an
unknown/disabled verb — if it silently no-ops…"). It does not silently no-op:

- unknown verb → `_handleIntent` synthesizes an `unknown` intent and bounces it
  (`unrecognized intent bounced: …`, session-manager.js:2906).
- known-but-gated verb → `intentEnabledFor` fails and the agent gets an injected
  `[agent:<type>] the <type> intent is disabled for this session` (:2926-2941).

So an agent emitting a verb documented only in its stale frozen prompt gets told,
by the running system, that it is gone. The delta is the fast path, not the only
one. No loud-bounce work needed; recorded as a finding.

### (d) Boundary set — where `session_ipc` regenerates

Verified rather than assumed:
- fresh session (no `resumeId`) — nothing cached, regenerate, free.
- `[agent:context reload]` (session-manager.js:4954) — `create(..., null, ...)`,
  `resumeId=null`, cold respawn: a genuinely new conversation → regenerate.
- `restartSession(name, {fresh:true})` — drops the resumeId → same, regenerate.
- plain resume / restore with `--resume <id>` → REUSE. The point of the ticket.
- `/clear` — mints a new sessionId inside the LIVE process, with no `create()`
  call. Nothing regenerates the file, and nothing can: the CLI already read it
  at spawn. Recorded; the frozen prompt is exactly as correct after a `/clear`
  as before it, so this needs no code — but it means "a session reset" in the
  ticket's boundary list is NOT reachable from `create()`, and is a no-op here.

## Phase 3 — clodex's ruling (msg-81580-7), all four verified at source

- **Storage: approved as proposed.** The `pathFor` instruction was aimed at
  hand-built paths under `run/`, not at overriding the root/run partition. Three
  texts at `~/.clodex/promptcache/<name>/`, `ipcdelta.sh` as a new `pathFor` kind.
- **Added requirement**: the run-dir rm is UNCONDITIONAL while the pending rm is
  gated on `_userKilled`. Mirror the GATED one for `promptcache/<name>/` — a
  user-kill means the session is going away for good, and a stale cache for a
  name later recreated would diff against a dead baseline.
- **Delivery shape accepted as an improvement over the spec**: making the rename
  the final step means `last_ipc` cannot advance early *by construction* rather
  than being guarded against (same move as t58's register-then-bind).
- **`/clear` correction accepted.** Boundaries: fresh session,
  `[agent:context reload]`, `restartSession({fresh:true})`.
- **Bounce finding closes the asymmetric-risk question**; no follow-up ticket.
  Recorded for a later change to either side: **the delta is the fast path, the
  bounce is the floor.** An agent emitting a verb documented only in its stale
  frozen prompt is told by the running system that it is gone — the delta makes
  that fast, it is not what makes it safe. Changing either should know the
  other exists.

### The ENTER question for the central pin (clodex, carried into phase 5)

Because the run dir is destroyed on every exit, a test that "resumes" by calling
`create()` twice **without simulating that teardown passes vacuously** — it
would be reusing a file that in production is already gone. Every
reuse-on-resume pin must go through the real cleanup path, or explicitly delete
the run dir between the two creates. *Does the test enter the window where the
file is actually absent?*

## Phase 4 — implementation (DONE, product code in place)

| file | change |
|---|---|
| `ipc-prompt-cache.js` | NEW leaf (electron-free, like ctx-reminder/pending-store): the three-state cache, a line-LCS `unifiedDiff`, the edge-triggered `ipcDelta`, `stageDelta` (writes delta+next, NEVER notified), `bakePrompt` (freeze-or-regenerate) |
| `clodex-paths.js` | `ipcdeltaScript: 'ipcdelta.sh'` KIND + defensive LEGACY_SUFFIXES entry; header 19→20 kinds, `promptcache/` added to the shared-root list with its rationale |
| `cli-hooks.js` | generates `ipcdelta.sh`, registered LAST under UserPromptSubmit (after ctxwarn) |
| `session-manager.js` | claude arm :1130 bakes via `bakePrompt(..., !!resumeId)` instead of writing unconditionally; `_cleanup` drops `promptcache/<name>/` under the `_userKilled` gate; deps destructuring |
| `engine.js` | requires + injects `bakePrompt` / `promptCacheDir` |
| `test/clodex-paths.test.js` | kind-count pin 19→20 (it caught the addition, as intended) |

### Notes taken while implementing

- **No diff helper existed** to reuse. The one `renderDiffHtml` hit *renders* a
  diff to HTML, it does not compute one. So the module carries a small
  line-LCS unified diff — O(n·m) over ~200 lines, paid once per spawn, never
  per turn.
- **No `@@ -n,m` line numbers.** They would be noise (the reader cannot seek
  into a prompt it does not have) and a churn source: an insert near the top
  would renumber every later hunk and make an unrelated change look large.
  Hunks are separated by a bare `@@` marker.
- **`next.md` is written BEFORE `delta.md`** in `stageDelta`. Crash between the
  two: a `next.md` with no `delta.md` is inert (the drain gates on `delta.md`),
  whereas the reverse would emit and then fail to advance — re-delivering
  forever. The reverse order is the only wrong one.
- **`stageDelta` clears a stale pair when nothing is owed** — otherwise a change
  later reverted would leave a `delta.md`/`next.md` whose eventual drain would
  advance `last_ipc` to a value that is no longer real.
- **`readCache` returns null, never `''`**, for an absent file: a missing
  `notified.md` means "no baseline recorded", while an empty one would mean "the
  agent was last told the prompt is empty" and would diff the entire prompt in.
- **`resumeId` is the reuse signal.** All three boundaries pass it null (fresh
  create, `[agent:context reload]` at :4954, `restartSession({fresh:true})`), so
  `!!resumeId` IS the boundary predicate — no new state, nothing to keep in sync.
- **Two existing pins already cover the new hook** and neither needed touching:
  `generated scripts: heredoc terminators at column 0` globs the run dir, so
  `ipcdelta.sh` is byte-shape checked (column-0 shebang, heredoc terminators, no
  ambient python3); and `PostToolUse must drain pending only`
  (`deepStrictEqual(postCmds, [pendingCmd])`) would have failed had I registered
  the drain per-tool. Verified green.

## Phase 5 — tests

`test/ipc-prompt-cache.test.js`, new, 15 tests. Every ticket pin covered:

| # | pin | test |
|---|---|---|
| 1 | resume + UNCHANGED → byte-identical | `resume with an UNCHANGED prompt…` |
| 2 | resume + CHANGED → still byte-identical, delta produced | `resume with a CHANGED prompt STILL bakes…` |
| 3 | delivered exactly ONCE across N turns (level-vs-edge) | `…delivered exactly ONCE across many turns` + `a SECOND change…` |
| 4 | a boundary regenerates | `a boundary regenerates the frozen prompt` |
| 5 | `last_ipc` not advanced when delivery fails | `last_ipc does NOT advance when the delta is never delivered` |
| 6 | (amendment) fresh session gets NO delta | `a FRESH session receives no delta, by construction` |

Plus: the diff's REMOVAL marker (the asymmetric-risk case), hunk elision, the
stale-staging clear, drain idempotence, the emit-before-advance byte order, and
the cache-placement pin (promptcache survives `simulateExit`).

**The drain is exercised for real, not simulated.** `runDrain` generates
`ipcdelta.sh` through the same `createCliHooks` harness `cli-hooks.test.js` uses
(`nodeInterp: process.execPath` — the env var is a no-op for plain node, so the
bytes the packaged app bakes with its Electron binary are the bytes that run
here) and executes it with `/bin/bash`. A hand-rolled rename would have pinned
my *idea* of the drain; the order inside that script is the whole mechanism.

### The ENTER question, answered mechanically (clodex's, load-bearing)

Every reuse pin calls `simulateExit()` — the real `rm -rf run/<name>/` — between
the two bakes, then `assertRunDirGone()` asserts `append-prompt.md` is actually
absent at that instant. **Proved by revert E** (below): stubbing `simulateExit`
to a no-op fails four tests by that exact message. So the window is proven
entered rather than assumed.

## Phase 6 — reverts (each fails BY MESSAGE; pristine restored + diffed between)

| Revert | Fails | Message |
|---|---|---|
| A: `bakePrompt` ignores the cache (pre-t61 unconditional write) | 6 tests | "THE POINT OF THE TICKET: the system prompt must not move under a continuing conversation…" |
| B: compare against `session_ipc` instead of `last_ipc` | 2 | "but NOT the already-absorbed one — the baseline is what the agent was last told, not what its prompt says" |
| C: rename before the emit in `ipcdelta.sh` | 1 | "the emit MUST come before the rename that advances last_ipc…" |
| D: drop the stale-pair clear | 1 | "a stale delta must be cleared — otherwise its eventual drain would advance last_ipc to a version that is no longer real" |
| E: stub out `simulateExit` (the ENTER guard itself) | 4 | "append-prompt.md must be ABSENT here — …a reuse pin that skips this teardown reuses a file that in production is already gone and proves nothing" |

B is the level-vs-edge revert the ticket names specifically. E is not a product
revert — it proves the guard that stops A-D's tests being vacuous.

After the last revert, all three touched product files were `diff`ed against
their pristine copies: identical, no residue.

## Phase 7 — result

- `test/ipc-prompt-cache.test.js`: 15 pass, new file.
- `test/free-identifier-leaks.test.js`: 84 pass (was 83 — the new module joins
  SCANNED_MODULES).
- `test/clodex-paths.test.js` + `test/cli-hooks.test.js`: green; the kind-count
  pin caught the new kind and was updated 19→20.
- Full suite: **2909 pass, 0 fail** (baseline 2893 + 15 + 1).

No `npm run build:web` needed — nothing bundled into the renderer changed.

## Flags

1. **The ticket's state-1 premise was false** and the storage moved to the
   shared root (`~/.clodex/promptcache/<name>/`). Raised before implementing;
   clodex approved and added the `_userKilled` gate, which is implemented.
2. **`/clear` is not a reachable regeneration boundary** — correction accepted
   into the spec. The three real ones are fresh create, `[agent:context reload]`,
   `restartSession({fresh:true})`, and all three are exactly `resumeId == null`,
   so `!!resumeId` is the whole predicate. No new state to keep in sync.
3. **The delta is the fast path; the bounce is the floor.** An agent emitting a
   verb documented only in its stale frozen prompt is already told by the
   running system that it is gone (unknown → `unrecognized intent bounced`,
   :2906; gated → `the <type> intent is disabled for this session`, :2926-2941).
   No follow-up ticket. Recorded here so a later change to either side knows the
   other exists.
4. **Delivery is at-least-once, not exactly-once, and deliberately so.** A crash
   between the emit and the rename re-delivers the same diff next turn. Stated
   plainly rather than papered over, per the ticket: a repeated diff is noise, a
   dropped one leaves an agent emitting a dead verb.
5. **Codex is NOT covered.** The ticket's problem statement, measurements and
   every named line are the Claude arm (`append-prompt.md`,
   `--append-system-prompt-file`). The codex arm at :1142-1163 has the identical
   shape (`instructions.md` rewritten unconditionally on every create) and is
   presumably the same bust. I did not touch it — out of the stated scope, and
   Codex's caching behaviour is not something I measured. Flagged as a possible
   follow-up, not taken.
6. **The optional `warmth_state`/`warmth_warm` layer was skipped**, per the
   ticket's own "if it adds a dependency or any complexity, skip it and say so."
   It would add a wirescope dependency to a boundary rule that must work with
   wirescope absent, for no benefit the boundary rule doesn't already give.
7. **No `@@ -n,m` hunk headers** in the diff — deliberate. They would be noise
   (the reader cannot seek into a prompt it does not hold) and a churn source:
   an insert near the top would renumber every later hunk and make an unrelated
   change look large. Bare `@@` separates hunks.
