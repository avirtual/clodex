# t93 — make a stale running host VISIBLE

Branch `t93-stale-host-visibility` off master `ad5deef`.
Scope per spec: **instrumentation only.** No auto-restart, no hot-reload.

## The finding (promoted from t92)

A long-lived Electron main process serves whatever `session-manager.js` was on
disk at boot, indefinitely. Merging implies no restart, so every intent-handling
fix is inert for the running host until the operator restarts the app.

Today: host PID 55910 booted 02:33:56, t82 merged 11:13:41, and at 16:01:36 the
host took the pre-t82 code path — 8h40m after the fix landed. clodex filed t92
against source that was already correct.

The failure mode is not "the fix didn't work." It is **"the fix worked and the
evidence says otherwise"** — strong enough to make a correct engineer file a
ticket against correct code, because it did.

## Phase A — design, before any code

### What to compare

Two candidate stamps, and they catch different things:

- **git HEAD** — moves on merge. Catches exactly today's case (a fix merged
  under a running host). Does NOT catch an uncommitted edit, and requires git to
  be present and the app to be running from a checkout (a packaged DMG is not).
- **module mtime/size digest** — catches merges, uncommitted edits, rebases,
  and a checkout swapped underneath. No git dependency. Works packaged, where
  it correctly reports "never stale" because the asar is immutable.

**Decision: digest the main-process module files (mtime + size), not git HEAD.**
Reasons, in order: it is the honest question (what code is on disk vs what was
loaded), it has no external dependency from a strict-leaf script, and it does
not silently degrade to useless in a packaged app. git HEAD is a proxy for the
thing I can measure directly.

Rejected: content hashing every module on every query. Same answer as mtime+size
for this purpose, materially more IO on a path that may be hit often.

### Where it surfaces — the real question

The ticket is right that this dominates. A stamp nobody reads reproduces t79
exactly: correct information in a file no one opens. Two constraints pull
against each other:

- **t79 (silence):** a UI badge is useless here. Nobody opens a settings pane
  mid-debug. clodex made today's mistake while reading a **ticket reply** and a
  **park file** — neither is in the UI.
- **t82 (noise):** "the happy path must stay quiet — a NOTE on every dispatch
  would train the lead to ignore the ones that matter." That is a settled
  position in this repo, and a staleness banner on every reply violates it
  directly.

Both are satisfiable at once, because staleness is **rare and binary**:

> **Surface it only when STALE, at the moment a lead is reading intent-handling
> output.** A fresh host says nothing at all.

That is the same shape as `_ticketDeliverySuffix`: quiet on the happy path,
explicit when the thing the reader is about to assume is false.

Chosen surfaces, both argued from where the mistake gets made:

1. **The `[agent:task]` reply** (`_handleTask:4712`). This is the exact artifact
   clodex was reading when they concluded the source was broken. A one-line
   suffix here reaches the lead inside the workflow where the wrong conclusion
   forms, with no extra action required. Quiet unless stale.
2. **`clodex-team` roster/tickets output.** The deliberate second home: it is a
   SEPARATE process that reads disk fresh, so it can report staleness even if
   the host's own intent handling is the thing that is stale. A host too old to
   know about a new signal cannot suppress this one.

Surface 2 exists because surface 1 has a bootstrap problem worth stating: a
running host that predates this ticket will never emit the suffix at all. The
first host to benefit is the first one booted after the merge. `clodex-team` is
re-materialized per invocation, so it is stale-proof by construction.

Rejected surfaces: a tray/UI badge (nobody looks mid-debug); a log line (same
t79 failure — `log.info` at boot is already there and did not help today); an
`[agent:who]` field (wrong audience, per-agent rather than per-host).

### Where the stamp lives

`~/.clodex/run/.host.json`, at the shared root next to `messages/`, `pending/`,
`agents/`, `skills/`. NOT in `clodex-paths.js`'s grammar — that is strictly
per-agent (`run/{name}/`, 18 kinds) and a host stamp is not per-agent. Leading
dot so the `run/*/agent.json` discovery iteration (which skips dotfiles, and
which `doRoster` also skips at scripts/clodex-team.js:133) does not mistake it
for a registration.

### Verification shape

The check must distinguish a fresh host from a stale one — if it reads the same
in both states it proves nothing. So the comparison function has to be pure and
directly callable with two digests, and the tests drive it with a matched pair
and a mismatched pair. A test asserting "a stamp exists" is a containment
check and is worthless here.

Proof it bites: simulate a stale host by writing a stamp captured against an
older module state, and confirm the signal changes. Plus reverts.

## Phase B — implementation

### A finding that sharpens the ticket: dev-reload already solves this, dev-only

`dev-reload.js` watches the flat main-process modules and does a full
`app.relaunch` when one changes — exactly the problem, already solved. But
main.js:624 gates it on `process.env.CLODEX_DEV && !app.isPackaged`, and
package.json:9 shows `npm start` does NOT set CLODEX_DEV (only `npm run dev`,
line 10, does).

So the mechanism exists and the common cases are precisely the ones it misses:
a long-lived `npm start` host (today's) and a packaged DMG. That does not weaken
the ticket — it explains why the gap was invisible. Anyone who checked would
have found a hot-reloader and concluded staleness was handled.

It also means this ticket must stay signal-only, as specced: the auto-restart
answer already exists for the case where it is safe, and extending it to the
operator's real session would tear down live agents.

### Shipped

**`host-stamp.js`** (new, pure leaf — fs/path only):
- `computeModuleDigest(dir, fsImpl)` — `name:mtimeMs:size` per flat `*.js`,
  sorted, joined. Skips the same dirs dev-reload ignores plus renderer/web-dist/
  cli/tasks. Returns null when unreadable ("cannot tell").
- `isStale(bootDigest, currentDigest)` — THE comparison, pure and separately
  callable so tests can drive matched/mismatched pairs directly. **Fails closed
  to fresh**: an unknown digest on either side returns false, because a notice
  we cannot substantiate trains the reader to ignore the real ones (t82).
- `writeHostStamp(runRoot, dir, opts)` — atomic tmp+rename, best-effort.
- `readHostStamp(runRoot, fsImpl)`, `staleNotice(stamp, currentDigest, now)`.
- `fsImpl` / `pid` / `now` are injectable so tests need no real clock or app.

**`main.js:550`** — `writeHostStamp(path.join(REGISTRY_DIR, 'run'), __dirname)`
right after the existing startup log line, plus the require at `:12`.

**`session-manager.js`** — `_staleHostSuffix(now)` above `_handleTask`, and
`_handleTask` computes it ONCE per intent and appends it to every reply through
the existing `reply` closure. Wrapped in try/catch returning `''`:
instrumentation must never break the reply it rides on.

**`scripts/clodex-team.js`** — `hostModuleDigest` + `staleHostLine()`, appended
to both `doRoster` and `doTickets` output. Duplicated rather than imported, for
the documented strict-leaf reason (flat-copied into `run/bin/`, node builtins
only) — same precedent as `TICKET_FILTERS` at :159, and commented as such.

### Verified functionally, not just by `node --check`

t86's lesson: `node --check` passed a `ReferenceError` that only running the
code caught. So every path was exercised for real against a temp tree —
digest non-null, test/ excluded, stamp roundtrip, **fresh → null notice**,
**post-edit digest changes → notice fires**, and all three fail-closed cases
(`isStale(null,y)`, `staleNotice(null,…)`, unreadable run dir).

### Digest parity between the two implementations

The duplicated digest is the obvious way this breaks: if the leaf's copy and
`host-stamp.js` disagree by even one file, the exec surface reports a PERMANENT
false stale — a notice that is always on, which is worse than none.

Checked on the real repo by extracting the leaf's block and running both:
**83 files each, identical strings.** Pinned by test below so a future edit to
one grammar and not the other fails loudly.

## Phase C — tests

`test/host-stamp.test.js` (11 new) + 5 t93 tests in
`test/session-manager.test.js`. Every test drives BOTH outcomes — fresh and
stale — because a signal that reads the same in both states is decorative.

## Phase D — revert proofs, and two defects they found

Pristine copies of all three product files; every revert restored from them and
verified byte-identical.

| # | File | Corruption | Result |
|---|---|---|---|
| A | host-stamp | fail-closed flipped to `return true` | 2 fail |
| B | host-stamp | comparison inverted (`!==` → `===`) | 3 fail |
| C | host-stamp | notice fires unconditionally | 2 fail |
| D | host-stamp | digest drops mtime, keeps size only | 4 fail |
| E | clodex-team | ONE token of the duplicated grammar drifts | 2 fail (parity only) |
| F | clodex-team | one dir dropped from the ignore list | **NO-OP → finding** |
| G | session-manager | suffix dropped from the task reply | 2 fail |
| H | session-manager | suffix recomputed per reply | 3 fail |

All fail **by message**. E is the one that justifies the parity test: a single
`Math.round` removed from the leaf's copy fails parity and nothing else.

### Defect 1 — my own product broke, and a test caught it

Writing the "instrumentation must not break the reply" test, I first wrote a
weak version that asserted almost nothing. Strengthening it to actually throw
from `_staleHostSuffix` **failed** — `_handleTask` called it unguarded, so the
exception propagated and killed the whole ticket intent.

`_staleHostSuffix` catches its own fs errors, which is what my comment claimed
was sufficient. It was not: the call itself was unguarded, so any throw from
outside that try (or from a future edit inside it) would take down ticket
handling. A diagnostic that can break the protocol it observes is strictly worse
than no diagnostic. Fixed by guarding at the call site too, and the comment now
says why both layers exist.

Worth noting how close this came to shipping: the weak version of the test
passed against the broken code. The defect was found by making an assertion
sharper, not by a revert.

### Defect 2 — revert F was a no-op, and the ignore list was DEAD CODE

Revert F (drop `tasks` from the leaf's ignore list) changed no test result. Per
standing practice a no-op revert is a finding, so I investigated instead of
waving it through — and the ignore list turned out to be **unreachable in every
case**:

- a DIRECTORY never passes `\.js$`, so `test/`, `renderer/`, `node_modules/`
  were already excluded by the file filter;
- a FILE named `test.js` never equals `test`, so the list never matched it either.

Checked exhaustively: no name can satisfy both `WATCHED_RE` and `IGNORE_RE`. The
list did nothing, in both copies.

Deleted from both, with the reasoning recorded in each. Dead code in a
DUPLICATED grammar is doubly bad: two copies of a rule that does nothing,
inviting a future drift that a parity test would then have to arbitrate over
semantics that never existed. The real mechanism — the digest is flat top-level
`*.js` and never descends — is now stated plainly and pinned by a test that
asserts a subdirectory module is invisible.

My first response was the wrong one and is worth recording: I had strengthened
the parity test so revert F *would* bite, by adding files named `test.js`,
`cli.js` etc. That made the test pass and the revert fail, and it would have
locked in dead code by inventing a case (a top-level `cli.js`) that does not
exist in this repo and has no reason to. Making a test able to see dead code is
not the same as the code being needed. Reverted that and deleted the list.

All reverts were re-run against the corrected product afterwards, since the
code changed after they were first proved. A/B/C/D/E/G/H all still bite.

### ENTER checks

- The two `staleNotice` tests are a matched pair on the same fixture — one
  before the post-boot edit, one after. That is what makes them a distinguisher
  rather than two independent assertions that could both be true for unrelated
  reasons.
- `computeModuleDigest` mtime case sets times EXPLICITLY. Two writes inside one
  filesystem-timestamp granularity can produce identical stats, which would make
  the test flaky in the direction that hides a real failure.
- The parity test asserts `mine.includes('session-manager.js')` before comparing,
  so it cannot pass by both sides returning null on a mis-resolved path.
- The "computed once" test counts calls rather than inspecting output: the
  observable cost is IO on every task intent, and only a call count sees it.

## Deviations / assumptions

- **Removed the ignore list from the product** (both copies) after a revert
  proved it unreachable. This is a deletion the spec did not ask for; I judged
  it in scope because it is code THIS ticket added earlier in the same session,
  not pre-existing code. Flagged.
- **Hardened `_handleTask`'s call site** beyond the original design, because the
  test proved the original guarantee was false as written.
- Digest ignores the renderer deliberately (reloads per window), so a renderer
  edit does not raise a restart notice.
