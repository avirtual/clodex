# Live state — 2026-08-04 (updated post-compact)

Nothing committed. GUI runs the live tree, so what's here is what's running.
Bogdan: commits can wait, a future session does them.

## Uncommitted (8 modified, 2 new tests)

`cli-hooks.js` `session-manager.js` `engine.js` `ipc-prompt.js`
`intent-catalog.js` `wire/billing.js` `test/hint-arm.test.js`
`test/ipc-prompt-cache-rework.test.js`
NEW: `test/preserve-across-restart.test.js` `test/prompt-refresh-recipe.test.js`

## Everything below is LIVE — nothing is parked any more

- **wire/billing.js** — `claude-opus-5` price row. `priceFor('claude-opus-5')`
  was null, so opus-5 turns billed ZERO while ticking requests.
- **M1** — reload doc fixed in BOTH `ipc-prompt.js` copies. Byte-pins hold.
  Points at the seat's **working directory**, NOT `~/.clodex/messages/<name>/`
  as the review suggested: `sweepSpilledMessages` (`engine.js:84`) unlinks
  anything there older than `MSG_MAX_AGE = 1800`s unless a parked pointer
  references it, and a handoff is not a parked pointer. Also states the
  amnesia bluntly.
- **sessionIds preservation** — `ALWAYS_PRESERVE = ['sessionIds']`
  (`session-manager.js:111`), carried by `_preserveAcrossRestart` whether or
  not a caller names it. All three callers omitted it and none had a reason to;
  an opt-in list invites a fourth caller to repeat the omission.
- **M2 recipe unification** — `_realIpcFor(recipe, teamBlock)` is now the ONE
  assembly. `create()` captures `promptRecipe` onto the live session (extraArgs,
  intents, execCommands, appendPromptFiles, inlineBody, hasSystemFile,
  ipcDisabled); `refreshPrompt` replays it. A session with no captured recipe
  (spawned by an older build, still live across an upgrade) REFUSES to refresh
  — guessing one is exactly the second recipe this deletes.
- **M3 unlink race** — took review option (b), not the stamp. The hook no
  longer touches `session.md`; `refreshPrompt` is its sole writer. The stamp
  was rejected on inspection: in refresh-first ordering `session.md` is
  written BEFORE the stamp would be taken, so an mtime comparison still reads
  it as stale and busts anyway. The "hook survives an app restart" argument
  does not hold either — the CLI is a PTY child of Clodex, so there is no
  clear/compact event without a live app to observe it.
- **Both call sites un-parked**; the three ordering tests un-skipped.
- Nits 2 (compact is "cheap" not "free", with the ~10-20% figure), 3
  (`_teamBlockFor` documents why per-reset resolution is deliberate) applied.
  Nit 4 was already satisfied — the `realIpc === session.md` guard returns
  before the broadcast.

## Test coverage, all mutation-verified

`test/prompt-refresh-recipe.test.js` (11 tests) is the file that closes the
reviewer's NIT 1: it runs the REAL `refreshPrompt` against real deps, where the
old tests stubbed it and never executed its body. Mutations killed:
- reintroduce the original divergence (ignore ipcDisabled + drop extraArgs) → 3 fail
- restore the hook's `session.md` unlink → 2 fail HERE (refresh-first only,
  which is the losing ordering) + 4 in the rework file
- refresh after the injection → 1 fail · drop the clear-site refresh → 1 fail
`test/preserve-across-restart.test.js` (6 tests): empty ALWAYS_PRESERVE → 3 fail;
delete a call site → 2 fail (DISCOVERY, via git ls-files); unconditional seed → 1 fail.

Gotcha for anyone extending the recipe file: `create()` opens an `fs.watch` on
`run/<name>/`. Not closing it in the teardown does not fail anything — it hangs
the whole FILE after the last assertion passes.

## TODO, in order

Record OUTCOMES here, never in-flight status. "Running at time of writing"
cost a full re-run on 08-04: a fresh session cannot tell a run that finished
from one that died with its process, so it re-runs.

1. **Clean full-suite run — GREEN 08-04: 3552 pass, 0 fail, ESCAPES 0** on the
   post-review tree. Baseline before this work was 3527/0; the +25 are the two
   new test files.
   The run BEFORE it wedged and was discarded: `cli/test/attach.test.js`
   passed all 26 of its tests and then never exited (0.0% CPU across the whole
   process tree, 12 min). Alone it is 6s and green, and it did not recur on
   the clean run — so: concurrency-only flake, not a deterministic deadlock.
   It binds real HTTP ports and `server.close()` does not drop live keep-alive
   sockets, which is the shape to check if it returns.
   **A suite that overruns its known baseline is WEDGED, not slow** — check
   `%cpu` on the lock pid before waiting any longer. A monitor timeout set
   generously (15 min) will report "timeout" and tell you nothing.
2. **Cold review — DONE 08-04, verdict REWORK.** One blocking (non-atomic
   `append-prompt.md` write under the live watching CLI), fixed via
   tmp+rename. Nits 1-3 applied, 4 split to its own ticket, 5 no action.
   Full entry: `.claude/review-log.md` under hash `3575a1352d60` (the tree
   has since moved — that hash is the reviewed bytes, not what is on disk).
3. **Backfill** (Bogdan approved in principle) — scope to THIS project dir only;
   all 1,623 dirs evicts real history via the 500-session cap. Dedup by
   `requestId` (raw sum gave $18.76 vs correct $12.78).
4. ~~Fast-mode 2x table~~ **already live** — `wire/billing.js:72,96`, reviewed
   and confirmed correct. Landed by an earlier instance after this file was
   written, which is why it sat here as open work for a day.
5. Commit. Then dispatch t150 (`tasks/billing-vendor-parity` — `PRICES_DATED`
   absent, sonnet-5 flips 2026-09-01); it is blocked only because this
   uncommitted tree touches `wire/billing.js`.
6. `reviewFor`/`ephemeral` divergence between intent-reload (`createdAt` only)
   and GUI restart — flagged, never investigated.

## Standing facts

- Full reviews: `tasks/prompt-refresh/review.md`, `tasks/cost-ledger-audit/journal.md`.
- The CLI WATCHES append-prompt.md and busts cache on change — that watch is WHY
  the freeze exists. Refresh is only affordable at clear/compact/cold-cache.
- ~~This seat is on the Jul 28 frozen prompt~~ — no longer true as of 08-04.
  `session.md` regenerated at the 23:47 respawn (absence-as-regenerate-signal
  working), and the 00:05 restart on `d3d0bdc` re-baked identical bytes with
  NO delta staged, which per `ipc-prompt-cache.js:214` means real IPC already
  equals `session.md`.
  Consequence: **a `/clear` on this seat is no longer an end-to-end test** —
  it hits the `realIpc === session.md` guard (`session-manager.js:1530`) and
  returns false, exercising the guard rather than the rewrite. Testing the
  rewrite needs a seat whose real IPC genuinely differs: one spawned before a
  prompt-affecting change, then cleared. Do not manufacture drift on a healthy
  seat to watch it heal.
- Use the `[agent:exec clodex-run-tests]` INTENT for the full suite (Bogdan's
  correction). The Bash tool's 120s cap is shorter than the suite. Never two at
  once — shared `.test-digest.lock`, deadlocks at 0% CPU.
