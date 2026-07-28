# t86 — spilled dm bodies are GC'd out from under parked pointers

Branch: `t86-messaging-spill-receipt` off master `5711737` (t80 and t81 both
merged; base is clean).

## Phase A — the three unestablished questions

### The defect itself: CONFIRMED at source

- `engine.js:257` `MSG_SPILL_THRESHOLD = 500`; `engine.js:856` `spillToFile`
  writes `<MSG_DIR>/<recipient>/msg-<pid>-<counter>.txt`.
- `session-manager.js:5679-5690` `_buildDeliveryText` — a body over the
  threshold is spilled and the delivery text becomes a POINTER
  (`… attached: @<path> ` for claude, `… saved to <path> — read it with your
  Read tool.` for codex). The body is not in the text.
- `engine.js:834-854` `cleanupOldMessages` — unlinks by `mtimeMs` age alone
  (`MSG_MAX_AGE` 1800s, `engine.js:258`), fired at startup (`:1758`) and every
  5 min (`:259`, `:1759`). No read-tracking, no ack, no exemption.

### Q1 — what does the recipient see when the pointer dangles?

**Silent nothing at delivery.** The pointer is injected as keystrokes; nothing
in the tree re-reads the spill file, so no code path can notice the absence.
For a claude target the text is `@<path>` to a file that no longer exists —
the CLI leaves the literal token, so the agent reads
`Message (2534 bytes) attached: @/…/msg-55910-39.txt` and receives no content.
The only way it learns the body is gone is to spend a turn on a Read and take
an ENOENT.

So: no error to the recipient, no signal to the sender, and the byte count in
the pointer is the only trace of what was lost. **This is the false-green
shape, and it upgrades the severity** exactly as clodex suspected.

### Q2 — can the parked record reconstruct the body?

**No. The spill file is the only copy.** `parkDelivery`
(`pending-store.js`) persists `{ text }` — and `text` is the output of
`_buildDeliveryText`, i.e. the POINTER, not the body. Both park call sites
confirm it: `session-manager.js:5807` (`_parkHeldDelivery`, via
`_gatedDeliver:5383`) and `:5845`, each handed
`this._buildDeliveryText(...)`. Nothing carries the body alongside.

**Unrecoverable data loss, not a degraded read.**

### Q3 — does anything exempt referenced files?

**Nothing.** `cleanupOldMessages` stats mtime and unlinks; that is its whole
body. Grepped `MSG_DIR` — no other reader.

### FINDING BEYOND THE TICKET: the two lifetimes are inverted

`PENDING_DIR` **has no GC at all.** Grepping every `PENDING_DIR` use
(`engine.js:249,925`; `session-manager.js`, 22 sites) turns up park, drain,
peek, count and claim — and no expiry. A parked pointer therefore lives
INDEFINITELY, while the body it points at lives 30 minutes.

That inversion is the bug's real shape, and it is what makes the fix cheap:
coupling the body's lifetime to the pointer's does not introduce a new
unbounded-leak class, because the pointer is already in one.

## Design — chosen: reference-aware GC

`cleanupOldMessages` collects the spill paths referenced by live parked
entries and exempts them from age-based collection. On drain the pending entry
disappears, the reference goes with it, and the file falls back to normal age
GC on the next sweep (≤5 min later).

Extraction keys on the SPILL FILENAME GRAMMAR (`msg-<pid>-<n>.txt` under
`MSG_DIR/<recipient>/`), not on the delivery prose — there are already two
pointer wordings (claude `@path`, codex `saved to path`) and a third would
silently defeat a prose-matching scan.

Module split: `pending-store.js` gains `allParkedTexts(root)` (store shape is
its knowledge, stays dependency-free); `engine.js` owns the path grammar,
because `spillToFile` mints it there. Neither module learns the other's job.

### Alternatives rejected, and why

- **Carry the body in the parked record.** Fixes the loss but the delivered
  text still points at a deleted file, so the drain would have to re-spill —
  more machinery, and it duplicates every large body into `pending/`, which
  has no GC. Strictly worse on the same disk axis.
- **GC on delivery/expiry instead of age.** Needs a delivery ack the channel
  does not have (see pending-store's header: the ack channel is deliberately
  lossy). Building one for this is out of proportion.

### THE COST, stated plainly

A seat that never comes back keeps its parked pointers forever, and now keeps
their spill bodies too. Disk grows with undelivered mail instead of being
capped at 30 minutes. I am choosing that over delivering a pointer to nothing:
the current behaviour bounds disk by silently destroying mail, which is the
wrong trade for a channel whose stated discipline is "dropping a DM is not
acceptable". If the leak ever matters the right fix is a `pending/` expiry —
one policy governing both, not two policies disagreeing.

## Phase B — implementation

| # | Site | Change |
|---|---|---|
| 1 | `pending-store.js:266` | `allParkedTexts(root)` — read-only scan of every parked text, skipping claim dirs and corrupt entries |
| 2 | `pending-store.js` exports | `allParkedTexts` added |
| 3 | `engine.js:43` | module-level `require('./pending-store')` for `allParkedTexts` (see the catch below) |
| 4 | `engine.js:96` | `SPILL_NAME_RE = /msg-\d+-\d+\.txt/g` |
| 5 | `engine.js:110` | `referencedSpillNames(pendingDir)` |
| 6 | `engine.js:127` | `sweepSpilledMessages(msgDir, pendingDir, maxAgeSec, now)` — the old body plus the exemption, module-level and parameterized |
| 7 | `engine.js:~890` | `cleanupOldMessages()` reduced to a call into it |
| 8 | `engine.js` exports | `sweepSpilledMessages` added |

### A REAL DEFECT THE TESTS CAUGHT

The first cut left `allParkedTexts` in the EXISTING pending-store require, which
sits INSIDE `createEngine`'s closure (`engine.js:608`). `sweepSpilledMessages`
is module-level, so the name was not in scope: every call threw
`ReferenceError: allParkedTexts is not defined`. That is not a cosmetic slip —
it would have thrown on the startup sweep and on every 5-minute tick, in a
function whose entire body is wrapped in `try {} catch {}` at the per-entry
level but whose top-level throw propagates into the timer.

`node --check` passed it. Inspection passed it. Only running the tests caught
it. Fixed by a second module-level require (commented in place, since splitting
one module's surface across two require sites is otherwise odd-looking) and
amended into the product commit.

## Phase C — tests: 8 added, new file `test/messaging-spill-receipt.test.js`

Drives `sweepSpilledMessages` directly against real temp dirs with a FIXED
clock (`now` is a parameter), so nothing depends on wall time or on sleeping.
No engine construction, no timers, no PTY — nothing armed.

1. referenced spill file survives past MSG_MAX_AGE
2. unreferenced spill file past MSG_MAX_AGE is still collected (with an
   unrelated park present, so the exemption cannot be a blanket stop)
3. fresh unreferenced file survives (age still gates)
4. a CODEX pointer exempts too — the second wording
5. root-level stray files, BOTH directions in one test
6. draining the park releases the body to normal age GC
7. `allParkedTexts` spans agents and skips claim dirs
8. `allParkedTexts` skips a corrupt entry rather than aborting

### ENTER checks

- Test 1 would pass trivially if the file were not actually old enough to
  collect. It builds a CONTROL pair of temp dirs, same age, no park, and asserts
  the sweep DOES take the control file — so "it survived" is known to be the
  exemption and not the clock.
- Test 6 asserts the drain returned exactly one text matching the spill name
  BEFORE asserting the file is then collected. Without that, "collected after
  drain" would pass against a store that was empty from the start.
- Test 2 parks a pointer to a DIFFERENT file, so it enters the window where the
  exemption exists but must not apply.

### REVERTS — all five by message

Pristine copies of both files taken first; `git diff --numstat` after every
restore and every revert, plus a grep confirming each substitution landed.

| # | Change | Tests failed | By |
|---|---|---|---|
| A | drop `referenced.has(fname)` in the subfolder loop | 3 | message |
| B | drop the root-level `!referenced.has(entry.name)` guard | 1 | message |
| C | `SPILL_NAME_RE` matches the claude `@` prose only | 1 | message |
| D | `allParkedTexts` aborts the scan on a corrupt entry | 1 | message |
| E | `allParkedTexts` stops skipping claim dirs | 1 | message |

Revert C is a same-line-count edit twice over (regex + the `refs.add` line), so
numstat alone could not tell it from a perl no-op — the grep showing
`/@\S*msg-\d+-\d+\.txt/g` in place is what proves it landed.

**One perl invocation failed outright** (unescaped braces in the pattern) on the
first attempt at revert D. numstat empty AND the suite still 8/8 is what
identified it as a no-op rather than a silent partial edit; redone with Edit.

Reverts B–E each isolate exactly one test, so each guarantee has a named owner.

### Suite

**2994/2994, ESCAPES 0** (2986 + 8), via the test-runner subagent.

NOTE on the run: the subagent's FIRST run executed in
`/Users/bogdan/projects/tmux/wb-wrap-ui` (clodex's tree) rather than the
`-hand` worktree, and reported 2986 with the new file "not existing". That was
the wrong tree, not a missing file. Re-dispatched with an explicit absolute cd;
the 2994 above is the corrected run.
