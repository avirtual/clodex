# prompt-refresh — cold review verdict (2026-08-03, clodex-reviewer-1)

**VERDICT: REWORK.** Ordering and freeness reasoning hold. Three must-fixes.
Suite was 3530/0 green WITH these defects present — see NIT 1 for why.

Diff: `/tmp/prompt-refresh.diff` (7 files, 377 lines), uncommitted.

## MUST-FIX 1 — the reload doc names a directory reload deletes

`ipc-prompt.js` (both copies: `IPC_PROMPT` + `GRAMMAR_LINES`) says the handoff
should go in `~/.clodex/run/<name>/` because it "survives the respawn". It does
not. Reload → `kill()` → `_cleanup` → `cleanupClaudeHook` →
`fs.rmSync(runDirFor(...), {recursive:true})` (`cli-hooks.js:429`). Verified.

So an agent following the instruction writes the briefing, fires reload, the dir
is rm -rf'd, `create()` recreates it empty, and `_injectReloadHandoff` types an
`@` pointer at a file that no longer exists — amnesiac cold boot, sole artifact
gone, on the path the prompt frames as safe.

My error, and I knew the fact: earlier in the session I established run/ survives
a CLEAR (process lives) but is destroyed on RESTART (cleanup between kill and
create). I then wrote the reload line as if the clear case applied.

**Fix**: `~/.clodex/messages/<name>/` (already `--add-dir`'d and in
`trustedDirectories`, `cli-hooks.js:311`) or the seat's cwd. Both copies or the
byte-pin drifts.

## MUST-FIX 2 — refreshPrompt uses a DIFFERENT recipe than create()

`_teamBlockFor` de-duplicated the smaller half. The `append` half is still a
second copy and already diverges two ways:

- **(a) `CLODEX_DISABLE_IPC_PROMPT` ignored.** `create():707` suppresses the
  protocol when the env flag is `'1'`; `refreshPrompt` always calls
  `buildIpcPrompt`, which is never empty (PREAMBLE+REPLIES+TRAILER always), so
  the `if (!ipcPrompt)` guard never catches it. Shipped config, not a corner:
  `REVIEWER_FALLBACK` (`session-manager.js:49`) and
  `resources/library/templates/clodex-team-reviewer.json:13`. Verified. A lean
  review seat that auto-compacts silently gains the full ~9KB protocol —
  the regression `test/spawn-template-env.test.js` exists to prevent.
- **(b) `extraArgs` dropped.** `create()` folds `--append-system-prompt[-file]`
  into `append` via `mergeClaudeSystemPrompt` (`argv-merge.js:32-39`);
  `refreshPrompt` passes `[]`, so such a seat loses that text at first
  clear/compact.

Damage OUTLIVES the reset: `bakePrompt(reuse=false)` writes divergent bytes into
`session.md`, so every later resume returns the refresh's bytes and stages a
delta describing recipe-vs-recipe — the permanent phantom delta, arriving
through the half that was not extracted.

It also disarms the `realIpc === session.md` no-op guard, which matters for
`--fork-session` (mint ⇒ reuse=false, already fresh-baked, inherits parent's
warm cache): with matching recipes the guard makes the fork a no-op; with
divergent ones the fork eats a full rewrite.

**Fix**: one recipe. Capture inputs (or computed `realIpc` + closure over
`extraArgs` / `mergedEnv` disable / `sysFile`) on the live session at `create()`
and have `refreshPrompt` re-run that. Minimum: pass `entry.extraArgs || []` and
thread the disable decision onto session/entry.

## MUST-FIX 3 — hook unlink races the in-process re-bake

`cli-hooks.js:111` (hook unlinks `session.md`) vs `session-manager.js:1474`
(refresh bakes). Hook relinks the transcript first, then unlinks; `onSessionId`
fires off a 250ms poll of that same relink; compact fires `onCompactSummary` at
roughly the same instant as `SessionStart(source=compact)`. Both orders occur:

- hook first → `readCache` null → refresh bakes → correct.
- **refresh first → usually early-returns at the no-op guard → hook then
  unlinks → seat runs the rest of the conversation with NO `session.md`.**

Then the next ordinary resume takes the `baked == null` branch with `reuse=true`
and rewrites `append-prompt.md` under a conversation possibly 100k+ tokens in —
exactly the 111k-139k bust the module exists to prevent, preferentially hitting
long-lived seats (they're the ones that compact). Deferred re-bake is unbounded
in time.

**Fix (either)**:
(a) replace the unlink with a `reset-at` stamp captured BEFORE the baseline
read; `bakePrompt` treats `session.md` as absent when mtime <= stamp.
(b) drop the unlink entirely, make `refreshPrompt` the sole `session.md` writer
— every clear (sid change) and compact (incl. CLI auto-compact) is already
observed in-process; the hook is the writer that cannot coordinate.
Keep `notified := session` + staged-pair drop in the hook either way — sound.

## NITS

1. **The three new tests assert call ORDER only; nothing executes
   `refreshPrompt`'s body** (`test/hint-arm.test.js:2258,2275,2291` all stub the
   method). That harness's `mkManager` never injects `readCache`, so removing
   the stub would throw `TypeError`, get swallowed by the `catch` into
   `_shadowLog`, and go green on a refresh that did nothing. **This is why
   MUST-FIX 2 survived a 3530-green suite** — DRIFT and COHERENCE have zero
   executable coverage. Add, in `ipc-prompt-cache-rework.test.js` style (real
   deps, real generated hook): (i) spawn with
   `extraArgs:['--append-system-prompt','EXTRA']`, and again with
   `env:{CLODEX_DISABLE_IPC_PROMPT:'1'}`, call the REAL `refreshPrompt` with
   nothing changed, assert it returns false / bytes identical to create()'s;
   (ii) run `runSessionStart(...,'compact')` and `refreshPrompt` in BOTH orders,
   assert `session.md` exists and equals `append-prompt.md`.
2. Compact site is "cheap", not "free": breakpoint sits BEFORE the system block,
   so the rewrite converts a read hit on the whole system segment into a write —
   ~10-20% of a mid-conversation bust. Say so in the comment so nobody extends
   "free" to a third site.
3. `resolveTeam(cwd)` per reset: correct-but-wasteful, NOT worse. Buys a real
   property — a `team.json`/role-prompt edit lands at the reset. Document that
   in `_teamBlockFor`'s header so a later caching "optimization" knows the cost.
4. Refresh broadcasts `prompt refreshed` even when bytes are unchanged (hook-won
   ordering, `readCache` null). Gate on actual change.
5. Reload's prompt line should be as blunt as clear's about amnesia —
   `resumeId=null` drops ALL history, and getting it wrong is unrecoverable.

## Not verified by the reviewer

That the CLI live-watches `append-system-prompt-file` mid-process (accepted as
settled per Bogdan). Note: if it does NOT, the refresh is inert for the live
process and the whole payload is `session.md` advancing — which makes MUST-FIX 3
*more* important, not less.
