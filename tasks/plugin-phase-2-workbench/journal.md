# Ticket t2 — Plugin Phase 2, part 1: workbench pilot W1–W6

Worktree: `/Users/bogdan/projects/tmux/wb-wrap-ui-plugin-phase-1`, branch
`plugin-phase-1` (same worktree/branch as t1 — Phase 2 builds directly on it).

This file is the handoff artifact. If I am cleared, compacted, or replaced, THIS
file plus `tasks/plugin-phase-0-1/journal.md` is the record — not anyone's memory.

---

## THE TICKET (verbatim, from clodex, msg-60180-47.txt)

> [ticket t2] tasks/plugin-phase-2-workbench
> Plugin Phase 2, part 1 — workbench pilot W1-W6 (the migration proper)
>
> FIRST: `[agent:context clear]`, then re-read `docs/plugin-plan.md` §2, §3, §4 and
> `tasks/plugin-phase-0-1/journal.md` in the worktree. Your Phase 1 context is spent;
> start cold from the artifacts. They are the record, not your memory.
>
> Worktree: `/Users/bogdan/projects/tmux/wb-wrap-ui-plugin-phase-1`, branch
> `plugin-phase-1`. Same worktree, same branch — Phase 2 builds directly on Phase 1.
>
> STEP 0 — COMMIT PHASE 1 FIRST. It is 137 tests of uncommitted work sitting in a
> dirty tree; that is fragile and it is now stale-proofing, not ceremony. One commit
> on the branch (NOT master, never push): "plugin host: Phase 0 guardrails + Phase 1
> host engine". Then commit after each of W1-W6 lands green. Committing on a
> throwaway branch is free and makes every step individually revertable — which is
> the whole point of the phasing.
>
> SCOPE: W1 through W6 as specified in §4. Stop after W6. W7-W9 are a separate ticket.
> - W1 scaffold `plugins/workbench/{manifest.json,engine.js,renderer.js,style.css}`,
>   hostApi "0".
> - W2 DOM move out of index.html into `surfaces.overlay({mount(rootEl)})`. MUST-FIX 6.
>   Behavior parity checklist is in the plan text — honour it literally.
> - W3 CSS move (resolves GAP G6 — read styles.css and report the actual rule count vs
>   the plan's "~23").
> - W4 entry points: footer button in, `#btn-workbench` and the View-menu item out
>   (resolves G5 — grep for the emit site before removing the row).
> - W5 data path: 14 `h.ipc.handle` rows, every handler's FIRST line
>   `host.sessions.fsScope(name)`. `git-scm.js` moves into the plugin dir (resolves G4
>   — grep for other consumers FIRST and report them). `git-worktree.js` STAYS core,
>   exposed as `host.lib.gitWorktree`.
> - W6 contract shrink: delete the 14 moved rows + their ipc-handlers registrations.
>   Pre-delete grep for stray consumers.
>
> THE CORRECTION THAT MATTERS MOST: the session dropdown maps to
> `rhost.sessions.listWorkspace(rhost.workspaceId)` — **workspace-scoped, NOT
> `listAll()`**. `ipc-handlers.js:377` is the ground truth, not workbench-popover.js's
> header comment. Getting this wrong silently converts a per-window dropdown into a
> cross-workspace file read/write surface, because `fsScope` refuses peers but NOT
> foreign workspaces. The blockquote in §4 W5 explains it fully. Read it.
>
> STANDING RULES, unchanged from t1:
> - `.claude/CLAUDE.md` is FROZEN. Never edit it.
> - If the CODE contradicts the PLAN, the CODE WINS — implement what the code requires
>   and FLAG the contradiction. Your two calls on t1 (l and m) were both right and both
>   upheld; keep exactly that instinct.
> - Suite: `[agent:exec clodex-run-tests]` is BLIND to the worktree — it runs the main
>   checkout on master and returns 2218 no matter what you do. Your t1 deviation (c)
>   was correct and is now the standing route: use the `clodex-test-green` skill with
>   an explicit cd. Baseline for this ticket is 2355.
> - Journal as you go into `tasks/plugin-phase-2-workbench/journal.md`, at the same
>   granularity as t1's — that journal is why a cold pickup is possible.
> - Flag deviations lettered, as before. I read the flags; that is the part of the
>   report that reaches my judgment.
>
> Do NOT touch master. Do NOT push. Do NOT start W7-W9.

---

## OPERATING NOTES (carried from t1, still in force)

- NEVER push, never tag, never touch `master`. Commits on `plugin-phase-1` ONLY.
- NEVER edit `.claude/CLAUDE.md` (frozen) or `.claude/memory.md` (clodex's file).
- Suite route: the `clodex-test-green` skill, spawning the `test-runner` subagent
  with an EXPLICIT cd into this worktree, plain `node --test` with NO directory
  argument (Node 25 treats a dir arg as a module path and errors).
  `[agent:exec clodex-run-tests]` is blind to this worktree — it reports master's
  2218 regardless. **Baseline for t2 is 2355.**
- `node --test` with no dir arg runs EVERY `.js` under `test/`, `test/fixtures/`
  included. Verified by probe in t1. No shared test-helper module is possible.
- Leak scanner (`test/free-identifier-leaks.test.js`) matches factory params with
  `\(([^()]*)\)` — it cannot cross nested parens, so **no parenthesised defaults in
  a factory deps destructure**. New extracted modules must be ADDED to its
  SCANNED_MODULES / RENDERER_SCANNED_MODULES lists, in both directions.
- An exec intent written line-initial in prose FIRES. Keep such references inline
  or fenced.
- Report at the END, one report, deviations lettered. Journal continuously.

---

## PROGRESS LOG

### STEP 0 — commit Phase 1 — DONE

Staged everything except the `node_modules` symlink (it points at
`../wb-wrap-ui/node_modules`; `.gitignore` lists `node_modules/` with a trailing
slash, which does not match a symlink, so it shows as untracked. Left untracked
deliberately — committing a symlink to a sibling checkout would be wrong).

Commit: **0f205e2** "plugin host: Phase 0 guardrails + Phase 1 host engine"
- 27 paths: 15 modified, 12 added.
- `master` verified still at 55ba16a afterwards. Nothing pushed.
- Working tree now clean apart from the `node_modules` symlink.

Phase 1 is therefore no longer fragile: every W-step from here is individually
revertable with `git revert` / `git reset` on the branch.

### NEXT — context clear, then W1

Per the ticket, clearing context and starting cold from the artifacts. Pickup
order after the clear:
1. Read this file.
2. Read `docs/plugin-plan.md` §2, §3, §4 (§4 is the W1–W9 spec; the W5
   blockquote on `listWorkspace` vs `listAll` is the load-bearing correction).
3. Read `tasks/plugin-phase-0-1/journal.md` (deviation list a–t, what Phase 1
   actually built and how the host API is shaped).
4. Then W1.

---

## COLD PICKUP DONE — reconnaissance, and the W1 scope finding

Read: this file, plan §2/§3/§4 (+§6 phasing, §7 guardrails, §8 GAP register,
Appendix skeletons), the whole Phase 0+1 journal, `plugin-host-engine.js` whole,
`renderer/plugin-host.js` (registries + surfaces + rhost + activate).

### FINDING 1 (scope, must be flagged) — W1 MUST INCLUDE THE LOADER.

Phase 1 shipped no loader by design: `plugin-host-engine.setEnabled(id, true)`
returns the shaped refusal *"enabling requires the plugin loader (Phase 2)"*, and
`engine.js:1732` constructs the host but registers nothing. `renderer.js` calls
`initPluginHost(...)` but never calls `pluginBar.activate(...)` for a real plugin.
So today NOTHING can load `plugins/workbench/`.

The plan's §4 W1 line reads only "scaffold ... against the Phase-1 host", but
W4 DELETES `#btn-workbench` and the View-menu item from core, and W7 says the
plugin "ships enabled ... so existing users see no change". Both are false unless
a loader exists. Discovery is specified in §3.1 ("Phase 1-3 scans
`<repo>/plugins/*/manifest.json` only. Enabled set persists in
`uiSettings.plugins.enabled`") — it is specified, just not assigned to a W-step.
→ Building it in W1. **Flagged as deviation (a): W1 grew the loader (both
halves).** Without it W2–W6 cannot land green and the app loses workbench at W4.

### FINDING 2 — the rhost is missing three things W2/W5 name.

Plan §4 W5 says the migrated popover calls `rhost.sessions.listWorkspace(
rhost.workspaceId)`, `rhost.ui.openPath(p)` and `rhost.lib.renderDiffHtml(diff)`.
`renderer/plugin-host.js`'s `buildRhost` (:458-515) has NONE of them — it has
`id`, `workspaceId`, `invoke`, `ui.{statusBar,sidebar,sessionMenu,settings,
surfaces}`, `onDispose`, wrapped timers/listeners, `log`. Also no `showToast`,
which the popover uses today. These are additive rhost surfaces the pilot is
supposed to discover (§4's closing paragraph says the shapes are provisional
until W9). → adding them in W2/W5 as the steps need them, each flagged.

### GAPs resolved by grep (reporting as the ticket asks)

- **G4 — `git-scm.js` consumers.** Exactly ONE production consumer:
  `ipc-handlers.js:36` `const gitScm = require('./git-scm')`. Others are
  `test/git-scm.test.js:10` (requires `../git-scm`),
  `test/free-identifier-leaks.test.js:61` (lists it in SCANNED_MODULES),
  `test/plugin-boundary.test.js:132` (uses the STRING './git-scm' as a
  require-parser fixture — not a real require, unaffected by the move), plus
  docs. → the move is safe; `test/git-scm.test.js` and the leak-scanner list
  must both be repointed at `plugins/workbench/git-scm.js`.
- **G5 — View-menu emit site.** `app-menus.js:489`
  `if (win) win.webContents.send('request-open-workbench')`. Contract row
  `api-contract.js:151` `onRequestOpenWorkbench`; pinned in
  `test/api-contract.test.js:88`; consumed at `renderer/renderer.js:3781`.
  All four go in W4.
- **G6 — CSS rule count.** `grep -c '^\.wb-\|^\.workbench\|^#workbench'
  renderer/styles.css` → **38 top-level rule heads**, not the plan's "~23".
  (That count is selector-lines-at-column-0 only; the real extraction set is
  computed in W3 and reported exactly there.) → the plan's ~23 is an
  underestimate; flagged.
- **Core `workbench` word.** Files matching case-insensitively today:
  `api-contract.js`, `app-menus.js`, `renderer/renderer.js`,
  `renderer/styles.css`, `renderer/index.html`,
  `renderer/popovers/workbench-popover.js`, plus `test/api-contract.test.js`
  and `test/plugin-boundary.test.js`. Three are FALSE POSITIVES for the W9
  grep gate and must be excluded there, because they mean the unrelated
  upstream project *agent-workbench*: `wire/route.js:4`, `wire/sse.js:4`,
  `proxy-util.js:8` (and `vendor/wirescope/proxylab/codex.py`). One more is a
  passing prose mention: `renderer/popovers/team-roles-popover.js:294`
  ("the workbench editor") — a comment, dies or gets reworded at W9, not now.

### Sizes (for planning): workbench-popover.js 554 lines · git-scm.js 162 ·
index.html `#workbench-overlay` block 283→~overlay end · ipc-handlers.js 2053.

### W1 DESIGN (what I am about to write)

1. `plugin-loader.js` — NEW engine-side pure-ish leaf (electron-free; it is not
   under `plugins/`, so the electron-boundary walk does not cover it, but
   nothing in it needs electron anyway). `discoverPlugins(pluginsDir, fs, path)`
   → manifest records; `loadPlugins({ pluginHost, uiSettings, ... })` requires
   each enabled plugin's engine entry and calls `pluginHost.register`. Enabled
   set from `uiSettings.plugins.enabled`; a plugin absent from the set uses its
   manifest default (W7 makes workbench default-on).
2. `plugin-host-engine.setEnabled(id, true)` gets a real body via an injected
   loader seam (the Phase-1 refusal was explicitly "until the loader exists").
3. `catalog()` rows gain what the RENDERER needs to activate its half without a
   new IPC channel (the five api-contract rows are frozen — §1): the renderer
   entry path and the plugin's `style.css` TEXT. Renderer `require()`s the path
   (nodeIntegration is on) and passes the css to `pluginBar.activate(id, mod,
   { invoke, css })`, which already accepts `css`.
4. `plugins/workbench/{manifest.json,engine.js,renderer.js,style.css}` — real
   manifest (`hostApi: "0"`, id `workbench`), engine/renderer as minimal
   activate stubs that W2–W5 fill in. style.css empty until W3.
5. Renderer-side loader block in `renderer.js` next to `initPluginHost`.
6. Tests: `test/plugin-loader.test.js`; leak-scanner list += `plugin-loader.js`.

**W1 commits only when the suite is green at ≥2355.** Baseline 2355.

### NEXT: write W1.
