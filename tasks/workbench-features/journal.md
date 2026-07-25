# t26 — workbench: worktree following + file locator

Branch: `workbench-features` off master @ `5efa7da` (v4.0.0).

## (1) Worktree switching — clodex's hypothesis is KILLED. Not a defect.

Hypothesis was: git half follows the selected worktree, file half stays pinned
to the session cwd, so the two read different roots.

**Both halves read the SAME root, and neither follows a worktree.** Traced:

- `plugin-host-engine.js:282-288` — `fsScope(name)` returns `s.cwd`, the
  session's own cwd. No worktree awareness; it refuses peers and stops.
- `plugins/workbench/engine.js:46-50` — the plugin's own `scoped()` wrapper
  calls `fsScope` and passes `r.cwd` as the root.
- `engine.js:53-55` — all three `fs.*` rows are `scoped`.
- `engine.js:58-70` — all nine `scm.*` rows are `scoped` too, and `git-scm.js`
  runs `git -C <cwd>` throughout (`git-scm.js:10-12`).

So Files and Source read the identical root. They cannot diverge.

**The real cause: there is no worktree SELECTION anywhere.** The Worktrees tab
(`renderer.js:506-573`) lists worktrees and offers exactly three actions — Open
(reveal in Finder, `:545`), Remove (`:550`), Create (`:561`). Clicking a row
does nothing. `activeName()` (`renderer.js:186`) returns the selected SESSION;
there is no selected-worktree state in the plugin at all.

Bogdan clicked a worktree expecting context to follow, and nothing switched
because no such affordance was ever built. **Missing feature, not broken root
resolution.** Both are user-visible; the distinction decides who rules on the
design, which is why it goes back to clodex before any build.

Implementable plugin-internally when ruled: `scoped()` is the plugin's own
code, so it can keep calling `fsScope` for the peer refusal and then substitute
a root, confined to paths that `wt.list` returned for that session (they derive
from `repoToplevel(cwd)` → `git worktree list`, so they are the session's own
repo's worktrees). No host API change.

## (2) File locator — confirmed plugin-internal. No host addition needed.

`fs-explorer.js` is plain `require('fs') + require('path')` (`:8-9`) and the
plugin boundary permits node builtins plus requires inside the plugin dir
(`engine.js:32-34`). A recursive walker lives there as the plugin's own code.
`listDir` (`:30`) is non-recursive by design, so the locator needs its own
walk — but that is a function to write, not surface to request.

`hostApi` stays frozen at "1". Nothing to escalate.

## Built (clodex rulings applied)

**(1) Worktree following.** Substitution lives in `scoped()` alone
(`plugins/workbench/engine.js`), so all twelve fs./scm. rows move together —
Files and Source cannot diverge by construction. Selection is `wtRoots`, a
Map keyed by session name, in memory, never persisted. `effectiveRoot()`
re-validates at USE time and drops to the session cwd on a dead selection
rather than erroring. New rows: `wt.select` (validates a candidate against
`wt.list` for that session — the confinement rule), `wt.apply` (sets it;
outside `scoped` because that wrapper drops the name), `wt.selected` (reports
active root + whether a stale one just dropped).

Renderer: worktree row click selects, `.selected` + an "active" badge marks it,
main is selectable so it is also the way back. `#wb-root-indicator` is a
persistent bar shown ONLY when root ≠ session cwd, click to reset. Refreshed on
open and on session switch; never cached, so it cannot lie. Our own Remove
button clears the selection when it deletes the active tree.

**(2) File locator.** `findFiles()` in `fs-explorer.js`, plugin-internal, no
host API change — `hostApi` stays frozen at "1". Bounds, chosen not discovered:
MAX_VISIT 20000, MAX_DEPTH 12, default cap 50, 120ms debounce, breadth-first so
truncation loses the deepest rather than the likeliest. LOCATOR_SKIP (dist,
build, out, coverage, .next, .cache, web-dist, vendor) is locator-only and
deliberately NOT folded into NOISE, which is the tree view's contract.
.gitignore is deliberately not parsed: partial glob semantics would hide files
the user expects to find. Empty query returns nothing, never the whole tree.

Fuzzy = subsequence on the relative path, scored for contiguity + basename
anchoring. Measured on this repo: 511 entries visited, untruncated.

## Verification

Suite 2541/2541 (was 2529; +12). Substitution proven by reverting
`effectiveRoot` in `scoped()` and watching "fs.list must follow the selected
worktree" fail by message, not crash.

`test/plugin-style.test.js` caught both new hidden ids lacking
`#id.hidden{display:none}` — plugin stylesheets do not inherit core's `.hidden`,
so an id toggled with it would have been always-visible. Fixed before landing.
The pinned row list in `test/workbench-plugin.test.js` also caught all four new
rows, as designed.

## Fix: confinement moved into the row that writes (clodex review)

The first version split selection across two rows — `wt.select` validated and
returned a match, `wt.apply` wrote `wtRoots` and validated NOTHING. The renderer
called them in order, so the UI was safe, but **the guarantee lived in a
renderer call sequence rather than in the engine**. `wt.apply(name,
'/any/real/dir')` set the root, `effectiveRoot`'s statSync passed because the
directory existed, and every scoped row — `fs.write` and `scm.commit` included —
then acted outside the session's repo.

My comment on `wt.select` asserted a caller "cannot point the workbench at an
arbitrary directory". That was false as written: a stated property with no
execution behind it.

The old test used `/definitely/not/here`, which does not exist, so statSync
rejected it for the wrong reason and the fixture dodged the very thing the prose
claimed. **Class to watch: a fixture whose value avoids the case the assertion
is supposed to cover.**

Fixed by collapsing to ONE row. `wt.apply` now calls `fsScope`, then
`listWorktrees`, then matches, then writes. `wt.select` is deleted rather than
left as a row whose only purpose was to be called first.

New test uses a REAL temp dir (statSync genuinely succeeds) and asserts both the
refusal and that a subsequent `fs.list` still reads the session cwd. Proven by
restoring the vulnerable shape and watching it fail by message.

`boot()` now takes `{ worktrees }` so a test that wants a selection to SUCCEED
declares the tree — honest, since in production that set comes from git and not
from the caller.

Suite 2542/2542.
