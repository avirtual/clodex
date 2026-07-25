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
