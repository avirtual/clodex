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

---

## W1 — DONE. Commit 699aa15. Suite 2380/2380 (baseline 2355, +25).

+23 from `test/plugin-loader.test.js`, +2 from the two per-plugin lint rows the
new `plugins/workbench/` dir adds (plugin-boundary no-backdoor walk +
electron-boundary engine walk). Both were already wired and green-but-empty in
Phase 0; the pilot is their first real subject.

### ADDED
- `plugin-loader.js` — discovery + the enabled set. `createPluginLoader(deps)`,
  fs/path/require injected (electron-free, M3 factory shape). Exports
  `discover / isEnabled / enabledSet / setEnabledInSettings / loadAll /
  activateById / rendererInfo` + the standalone `validateManifest`.
- `plugins/workbench/{manifest.json,engine.js,renderer.js,style.css}` — real
  manifest (`hostApi:"0"`, `enabledByDefault:true`), both halves as named
  activate stubs that actually load, style.css empty until W3.
- `test/plugin-loader.test.js` — 23 tests against a REAL temp plugins/ tree
  (mocked readdir would pass a loader that can't read a directory), plus a
  final test against the REAL `plugins/` dir so the pilot's manifest drifting
  from what the loader accepts is a failure, not a mystery.

### CHANGED
- `plugin-host-engine.js` — `getLoader` getter dep; `setEnabled` got a real
  enable path; new `_host` method `renderer.info`; the returned object is now
  named `api` so setEnabled can hand the loader the same surface ipc-handlers
  has (and no more).
- `engine.js` — requires plugin-loader; `let pluginLoader = null` beside
  `pluginHost`; loader constructed + `loadAll(pluginHost)` inside the existing
  `pluginsEnabled` try; the catch now nulls BOTH halves.
- `renderer/renderer.js` — `loadPluginRenderers()` after `initPluginHost`.
- `test/free-identifier-leaks.test.js` — `plugin-loader.js` → SCANNED_MODULES.

### DECISIONS (report material)

1. **`renderer.info` rides the `_host` pseudo-id, NOT a sixth api-contract row.**
   §1 freezes the plugin transport at five rows "for every plugin, forever". The
   renderer needs two things to activate a half — the module path and the CSS —
   and that is host plumbing, not a plugin method. `_host` already exists for
   exactly this class (settings.get/set) and is deliberately outside the
   dispatch map. Zero api-contract churn; `pluginCatalog` keeps its pinned row
   shape untouched.
2. **CSS crosses as TEXT, not a path.** `renderer/plugin-host.js:524` already
   injects `<style data-plugin-style=id>` from a `css` string. A path would not
   resolve in the built web bundle; text works in both. (Web bundle still needs
   G7/W8 for the MODULE, hence the `__CLODEX_WEB__` guard below.)
3. **`enabledByDefault` in the manifest + a null-vs-array enabled set.** `null`
   (key absent) = "the user has never chosen" ⇒ manifest default; an array = an
   explicit decision. Collapsing these to a bare boolean erases the difference
   and W7 ("ships enabled, existing users see no change") becomes a settings
   migration for every install instead of a manifest flag.
4. **First-toggle materialization** — `setEnabledInSettings` expands the current
   EFFECTIVE set before mutating. Otherwise the first-ever enable of one plugin
   writes a one-element array and silently disables every default-on plugin.
   Pinned by its own test.
5. **`setEnabled` persists the decision BEFORE attempting activation**, so a
   plugin whose activate() throws still records the user's click rather than
   looking like the toggle was lost.
6. **Two boundary checks, not one.** The static no-backdoor lint reads requires
   INSIDE plugins/; the loader additionally refuses a manifest whose `entry`/
   `style` path escapes the plugin dir. Neither sees the other's case — a
   scanner can't see a path assembled in a manifest, a runtime check can't see a
   require three files deep.
7. **Renderer activation is guarded on `window.__CLODEX_WEB__ || !window.require`
   and skips.** The desktop window `require()`s the absolute renderer path
   (contextIsolation is off by design here); the browser can't, and its
   build-generated id→module registry is explicitly GAP G7 / step W8. Guarding
   now means W8 replaces a documented skip, not a crash.
8. **Per-plugin failure isolation at three levels**: `loadAll` try/catches each
   plugin (one bad plugin costs only its own features), `renderer.js` try/catches
   each renderer half, and engine.js's existing catch drops both halves if the
   HOST itself fails to construct.

### DEVIATION (a) — W1 GREW THE LOADER (both halves). Flagged, load-bearing.
§4's W1 line says only "scaffold ... against the Phase-1 host", but Phase 1 shipped
no loader at all (`setEnabled(id,true)` → "enabling requires the plugin loader
(Phase 2)"; nothing ever called `pluginBar.activate`). W4 deletes core's
`#btn-workbench` and W7 says the pilot ships enabled — both are false without
discovery + activation. §3.1 fully specifies the mechanism; it just wasn't
assigned to a W-step. Alternative considered and rejected: defer to W7, which
would leave W4 shipping a commit where the app has NO workbench entry point.

### NEXT: W2 — DOM move into `surfaces.overlay({mount(rootEl)})`.
Read `renderer/popovers/workbench-popover.js` (554 lines) whole + the
`#workbench-overlay` block in index.html (from :283). Parity checklist from §4
W2 is literal: dropdown repopulated per open following the ACTIVE session,
unsaved-edit confirm on tab/session switch, shared editor/diff area semantics.
Known rhost gaps to add as W2/W5 need them (FINDING 2): `ui.openPath`,
`lib.renderDiffHtml`, a toast surface. Note W2 keeps the OLD data path working
(`window.api.*` rows stay until W5/W6) — but the plugin's renderer half may not
touch `window.api` (no-backdoor lint), so W2 must route its data calls through
`rhost.invoke` and W5's engine rows must therefore exist by then, OR W2 lands
the overlay against temporary `_host`-free passthrough rows. RESOLVE THIS FIRST
IN W2: likeliest answer is to do W5's engine registrations as part of W2's
landing so the moved DOM has a legal data path from its first commit.

---

## W2 — the data-path ordering question, RESOLVED

### The constraint
`test/plugin-boundary.test.js` forbids the plugin's renderer half from touching
`window.api` at all, and forbids either half from requiring outside the plugin
dir. So the moment the overlay DOM lives in `plugins/workbench/renderer.js`, its
data calls must go through `rhost.invoke` → engine rows registered by
`plugins/workbench/engine.js`. Those rows must call SOMETHING. The scm/fs
implementations (`git-scm.js`, `fs-explorer.js`) are still at the core root and
the plugin cannot require them there.

Naively that collapses W2+W5+W6 (and W4, since a deleted popover leaves
`#btn-workbench` opening nothing) into ONE commit — losing exactly the
per-step revertability the ticket calls "the whole point of the phasing".

### The resolution: two TEMPORARY `host.lib` entries.
W2 registers the 14 engine rows against `host.lib.gitScm` / `host.lib.fsExplorer`
— core keeps owning both files, exposed the same sanctioned-shared-leaf way
`host.lib.gitWorktree` already is (§3.2 `lib`). W5 then does exactly what §4 W5
says — moves the files INTO the plugin dir, switches the engine half to a local
`require('./git-scm')`, and DELETES the two temporary lib entries. W6 deletes
core's rows.

Each commit is green, lint-clean, and leaves a working app:
- **W2**: DOM + wiring live in the plugin; data flows plugin→host.lib→core files.
  Core's `window.api` rows still exist (unused by the plugin, still used by
  nothing else — deleted in W6).
- **W3**: CSS extraction.
- **W4**: entry points (footer button in, `#btn-workbench` + View item out).
- **W5**: the two files move; temp lib entries die; `git-scm`/`fs-explorer`
  requires become plugin-local.
- **W6**: core's 14 rows + registrations deleted.

Cost, stated plainly: two `host.lib` entries exist for three commits and are then
removed. That churn is the price of per-step revertability, and it is commented
as W5-temporary at the registration site so a reviewer isn't left wondering
whether they were meant to be permanent API. **Flagged as deviation (b).**

### Two more GAP answers found while reading (both change W5's scope)

- **`fs-explorer.js` moves too — the plan never mentions it.** §4 W5 names only
  `git-scm.js`, but `fs:list/read/write` delegate to `fsExplorer`
  (ipc-handlers.js:373-386), not to gitScm. Its consumers are exactly the same
  shape as git-scm's: `ipc-handlers.js:37`, its own `test/fs-explorer.test.js`,
  and the leak-scanner list. So it is a second file to move, with two more test
  repoints. **Flagged as deviation (c).**
- **`renderDiffHtml` genuinely must stay core** — `renderer/lib/render-html.js`
  is also required by `renderer/renderer.js:11`, `popovers/files-popover.js:15`,
  `bust-popover.js`, `cost-popover.js`. Plan §4 W5's `rhost.lib.renderDiffHtml`
  call is correct. Same for `fileOpen` (files-popover.js:204 also uses it) →
  `rhost.ui.openPath`, and `createWorktree` (renderer.js:2457, the New-Session
  dialog) → stays core.

### A gap the plan leaves: the workbench's OWN "Create Worktree" button.
`workbench-popover.js:461` calls `api.createWorktree(wl.repo, branch, {base})`.
§4 W5 lists `createWorktree` among the rows that STAY core "(New-Session
dialog)" but never says how the plugin reaches it. Two options: a new
`rhost.ui.createWorktree` wrapper, or a plugin engine row `wt.create` built on
the `host.lib.gitWorktree` leaf the plugin already has. **Taking the engine row**
— it needs no new renderer-side surface, it keeps the leaf as the single
sanctioned path to worktree code, and core's `worktree:create` row stays
untouched for the New-Session dialog that actually owns it.
**Flagged as deviation (d).**

### rhost surfaces W2 must add (FINDING 2, now concrete)
`ui.openPath(p)` (→ `window.api.fileOpen`), `lib.renderDiffHtml(diff)`,
`ui.showToast(msg, opts)`, and `sessions.listWorkspace(wsId)` — the last is
**THE load-bearing correction**: `rhost.sessions.listWorkspace(rhost.workspaceId)`,
NEVER `listAll()`. Ground truth `ipc-handlers.js:377`
`handle('session:list', (e) => manager.listForWorkspace(workspaceOfSender(e)))`.
Note the OLD popover called `api.listSessions()`, which IS `session:list`, i.e.
already workspace-scoped — so mapping it to `listAll()` would have been a real
regression, not a theoretical one. `fsScope` refuses peers, not foreign
workspaces.

### NEXT: write W2 (DOM move + wiring + the four rhost surfaces + 15 engine rows
— the 14 from §4 W5 plus `wt.create` per deviation (d)).

---

## INBOX — a follow-on from clodex, NOT part of W1–W6 (msg-60180-50.txt)

Arrived mid-W2. Scoped addition to the W1 loader (fail-safe activation +
quarantine). Deliberately NOT started — the ticket says finish W2 first and this
message says the same ("a follow-on, not an interrupt"). Recorded here so it
survives a compaction:

- REQUIRED 1 — try/catch per plugin around manifest parse, engine `activate(host)`
  AND renderer `activate(rhost)`. A throwing/malformed plugin is marked failed and
  SKIPPED; the app boots regardless. Surface it in the §2.5 settings section (+ a
  toast if cheap). Motivation: the engine half activates inside createEngine's
  bootstrap, BEFORE any window exists — an uncaught throw there kills startup with
  no window, so the user can't open a session to repair the plugin.
- REQUIRED 2 — quarantine on the SECOND consecutive failed activation, not the
  first (one throw is often transient). Persist a per-plugin failure counter;
  clear it on any successful activation.
- THE DESIGN RULE: do NOT clear `uiSettings.plugins.enabled` to quarantine —
  that field is the USER'S INTENT and flipping it destroys the record. Keep a
  SEPARATE quarantine set that SHADOWS enabled. Settings row reads e.g.
  "disabled automatically: activate() threw on 2 consecutive launches — Retry".
- RENDERER NUANCE: the renderer half activates once per BrowserWindow, so a
  failure may be one window of three. Quarantine on consistent failure across
  activations, not per-window. My judgment on the exact rule; flag what I choose.
- Tests for both paths (throwing plugin skipped + app still boots; two strikes =
  quarantined with enabled untouched).

Note for whoever picks this up: `loadAll` ALREADY try/catches per plugin
(plugin-loader.js) and `renderer.js:loadPluginRenderers` already try/catches per
renderer half — W1 decision 8, "per-plugin failure isolation at three levels". So
REQUIRED 1 is largely present and the real new work is (a) recording the failure
rather than only logging it, (b) surfacing it in settings, and (c) the whole of
REQUIRED 2. Verify before rebuilding.

---

## W2 — DONE. Commit cd618e1. Suite 2392/2392 (+12 over W1's 2380).

### What moved

- **`renderer/index.html`** — the whole `#workbench-overlay` block (:283-354)
  deleted, replaced by a 4-line comment. Core ships NO workbench markup.
- **`renderer/popovers/workbench-popover.js`** — DELETED (`git rm`), 554 lines.
  Its body lives in `plugins/workbench/renderer.js`, ported per §4 W2's list:
  `$(id)` → `rootEl.querySelector('#'+id)`, the DOM as a template literal built
  inside `mount(rootEl)`, drag kept plugin-internal, ESC + one-open-at-a-time
  handed to the host surface (the plugin installs NO document keydown listener).
- **`renderer/renderer.js`** — the popover require + init deleted; the two entry
  points kept working (see the bridge below); three new deps passed to
  `initPluginHost`.

### The four rhost surfaces (FINDING 2, now real) — `renderer/plugin-host.js`

- `rhost.sessions.listWorkspace(wsId)` — **THE load-bearing one.** Wraps
  `window.api.listSessions()` (= `session:list` = `manager.listForWorkspace(
  workspaceOfSender(e))`) and FILTERS on `workspaceId`. There is deliberately no
  `listAll()` and no unqualified `list()` on this surface, mirroring the engine
  half's law 1. Pinned by a test that asserts both are `undefined`.
- `rhost.sessions.active()` — the active-session name. NOT in the plan; the old
  popover took `getActiveSession` as a factory dep and the parity checklist
  ("each open follows the ACTIVE session") is unimplementable without it.
  **Flagged as deviation (e)** — it is a fifth surface, not one of the four.
- `rhost.ui.openPath(p)` → `window.api.fileOpen` (files-popover uses it too).
- `rhost.ui.showToast(msg, opts)` → core's toast host. The old popover fell back
  to `alert()` when no showToast was injected; here the fallback is a
  `console.warn`, since core always injects it.
- `rhost.lib.renderDiffHtml` — `renderer/lib/render-html.js` required at the TOP
  of plugin-host.js (core file, so no lint issue) and frozen into `rhost.lib`,
  mirroring the engine host's `lib`.

### The 15 engine rows — `plugins/workbench/engine.js`

`fs.list/read/write`, `scm.status/diff/stage/unstage/discard/commit/branches/
checkout/remote`, `wt.list`, `wt.remove`, `wt.create`. Thirteen go through a
`scoped()` wrapper whose FIRST line is `host.sessions.fsScope(name)` and whose
refusal envelope is `{ ok:false, error }` — byte-identical to ipc-handlers', so
the renderer's existing `error === 'remote'` branches keep matching.

`wt.remove` is NOT scoped: it takes a worktree PATH, exactly as core's
`worktree:remove` does (which has no `sessionCwd` guard either, because the path
comes from a `wt.list` result the user just clicked). Reproduced rather than
"improved" — a behavior change hidden inside a move is the thing this phasing
exists to prevent. Pinned by its own test so a future consistency fix argues
with a test rather than silently tightening it.

`scm.remote` keeps the `['push','pull','fetch']` allowlist on the ENGINE side,
where ipc-handlers had it — not in the renderer.

### Two decisions the plan didn't cover

**1. `.plugin-overlay` base CSS is CORE css.** The host CREATES the overlay
container, centralizes hidden/Escape/one-open on it, and removes it wholesale on
disable (§2.6 / MUST-FIX 6) — so its backdrop/centering rule belongs to the host
contract, not to any plugin's stylesheet. Added to `renderer/styles.css` beside
the old `#workbench-overlay` rule (which dies in W3 with the rest of the wb-*
block). It is `.plugin-overlay.hidden`, NOT a generic `.hidden`, so the project's
always-visible gotcha stays impossible. **Flagged as deviation (f)** — W3 is
"CSS moves OUT"; this is a small piece of CSS moving IN, and it is permanent.

**2. A temporary DOM-event bridge keeps `#btn-workbench` working.** W4 owns the
entry points; W2 must not break them. Core now does
`document.dispatchEvent(new CustomEvent('clodex:open-workbench'))` and the plugin
listens via `rhost.addEventListener(document, …)` (the host-WRAPPED one, so
disable removes it). Core holds no handle to the plugin, and the plugin is not
reached by name — the event is the whole coupling, and it is deleted in W4 when
the plugin registers its own `sidebar.footerButton`. The alternative — accepting
one commit where the Workbench button does nothing — was rejected because the
ticket's "each step lands green and leaves a working app" is the point of the
phasing. **Flagged as deviation (g).**

### Parity checklist — honoured literally, plus one fix

- Dropdown repopulated per open, following the ACTIVE session: `onOpen` →
  `fetchSessions()` + `populateSessions()`, same logic verbatim.
- `confirmDiscardEdit` on tab switch: unchanged.
- `confirmDiscardEdit` on SESSION switch: **the old popover did NOT do this** —
  `sessionSel`'s change handler called `resetEditor()` unconditionally, silently
  dropping unsaved edits. The plan's checklist says "unsaved-edit confirm on
  tab/session switch", i.e. the plan describes the intended behavior and the CODE
  was the outlier. Implemented the plan here (confirm, and restore the select to
  the current scope if the user cancels) because this is a bug, not a behavior
  worth preserving. **Flagged as deviation (h)** — it is the one intentional
  behavior CHANGE in W2.
- Shared editor/diff semantics (Files edits · Source read-only diffs · Worktrees
  hides `#wb-editor` and sets `worktrees-mode`): unchanged.

### Tests

- **NEW `test/workbench-plugin.test.js`** (8 tests) — the plugin's engine half
  driven through the REAL host engine. The MUST-FIX 5 test loops EVERY
  session-scoped row and asserts both the `'remote'` refusal and that no leaf was
  touched; a spot-check would miss the single unguarded row that is the whole bug.
- **`test/plugin-host.test.js`** +4 — the new rhost surfaces, incl. "offers ONLY
  the workspace-scoped accessor" (asserts `listAll`/`list` are `undefined`).
- **`test/plugin-host-engine.test.js`** — the two temporary lib entries added to
  the fake deps + one assertion; both marked DELETE-IN-W5 at the site.

### NEXT: W3 — CSS move.
Extract the wb-*/workbench-* rules from `renderer/styles.css` into
`plugins/workbench/style.css` (already wired, currently empty; the loader passes
its TEXT to `pluginBar.activate`). The block is contiguous: `renderer/styles.css`
:2604 (`#workbench-overlay`) through the grouped `#…hidden { display:none }` rule
that ends at :2725. Report the EXACT extracted rule count vs the plan's "~23"
(G6 — the crude grep said 38 top-level heads).

Three things to get right in W3:
1. `.plugin-overlay` / `.plugin-overlay.hidden` (added in W2, :2604-ish) STAYS
   core — it is the host's container, not the plugin's interior.
2. `#workbench-overlay` and `#workbench-overlay.hidden` are now DEAD (no such
   element exists any more) → delete, don't move.
3. The other `#…​.hidden` ids in that grouped rule are LIVE — they are the
   plugin's interior ids, now created by JS rather than shipped in index.html.
   They must move to style.css. `test/css-hidden-invariant.test.js` scans
   index.html only, so it will no longer see them at all — the invariant is not
   violated, but nothing guards them either. Consider whether the plugin's
   stylesheet wants its own equivalent gate; flag the decision.

---

## W3 — DONE. Suite 2395/2395 (+3 over W2's 2392).

### The exact rule count (GAP G6 resolved)

The plan says "~23 rules". The reconnaissance grep said 38 top-level heads.
Both are wrong, in opposite directions — the grep counted only selector lines
starting at column 0 with `.wb-`/`.workbench`/`#workbench`, which misses every
descendant/`:hover`/`.active` variant AND every `.explorer-*`, `.scm-*`,
`.worktree*` rule (the workbench's file tree, its SCM list and its worktree
list are all named after what they show, not after the plugin).

**Actual extracted block: `renderer/styles.css` :2601–2736, 136 lines,
69 rule blocks. 68 moved, 1 deleted.**

- MOVED: 68 rule blocks (`#workbench-modal`, `.workbench-*` ×13,
  `.wb-*` ×22, `.explorer-*` ×7, `.scm-*` ×14, `.worktree*` ×10, plus the
  grouped per-id hidden rule) → `plugins/workbench/style.css`.
- DELETED, not moved: `#workbench-overlay { … }`. Dead since W2 — the element
  does not exist; the host's `.plugin-overlay` container replaced it verbatim
  (same six declarations).
- Also deleted: the `#workbench-overlay.hidden` SELECTOR from the head of the
  grouped hidden rule. The rule itself moved with its other 12 selectors.
- KEPT core: `.plugin-overlay` + `.plugin-overlay.hidden` (W2's, deviation (f)).
- KEPT core, dies in W4: `#btn-workbench` at :309/:323 — the sidebar footer
  button, shared with `#inbox-open` in a grouped rule. Not part of the block.

So the plan undercounted by 3×. **Flagged as deviation (i)** — not a design
disagreement, just the number the ticket asked me to report, and it is large
enough to matter if anyone sized W3 from "~23".

Nothing outside the block references those classes: grepped every class the
plugin's markup emits against the whole tree; the only non-plugin hits are
`web-dist/index.html` (a BUILT artifact, regenerated — W8's problem, G7) and
`renderer/renderer.js:190` / `index.html:521` which match `input-worktree-branch`,
the New-Session dialog's own input, not the workbench's `wb-worktree-branch`.

### THE DECISION W3 FORCED: the hidden-id invariant crossed the boundary

`test/css-hidden-invariant.test.js` reads `renderer/index.html` against
`renderer/styles.css`. That pairing was TOTAL while all hidden ids shipped in
core markup. After W2/W3 it is not: the workbench's 9 `class="hidden"` ids are
emitted by `plugins/workbench/renderer.js` and hidden by rules in
`plugins/workbench/style.css`. Neither file is read by that test. The invariant
is not violated — it is simply no longer enforced for anything in a plugin, and
the project's own gotcha ("no generic `.hidden`; a missed per-id rule renders
the element ALWAYS-VISIBLE and unstyled") is exactly the bug that shipped twice
before that test existed.

Leaving it unguarded was the cheap option and I rejected it: the guard would
have silently stopped covering the pilot at the exact commit that moved it, and
every future plugin would inherit the hole.

**ADDED `test/plugin-style.test.js` (3 tests)** — the same invariant, per
plugin, generic over `plugins/*/manifest.json`:
1. For every plugin: scan its manifest's renderer entry for `id=…
   class="… hidden …"` tags, parse its manifest's stylesheet, assert each id has
   a `#id.hidden{display:none}` rule. Comments are stripped before the CSS parse
   so a `#id.hidden` mentioned in prose cannot count as coverage.
2. A non-vacuity check naming four real workbench ids — a regex that matches
   nothing must not make test 1 pass silently. (The core test has the same
   guard, for the same reason.)
3. A W3 move-gate on CORE css: `.plugin-overlay` + `.plugin-overlay.hidden` must
   still be there, and NO `wb-`/`workbench-` selector may remain (with
   `#btn-workbench` excepted until W4 deletes it — the exception is written at
   the assertion site so W4 has to come back and remove it).

**Flagged as deviation (j)** — a NEW test file the plan does not ask for. It is
additive, gates a real regression class, and is the answer to the question the
W2 journal left open ("consider whether the plugin's stylesheet wants its own
equivalent gate; flag the decision").

### CHANGED
- `renderer/styles.css` — :2601–2736 removed (136 lines). `.plugin-overlay`
  pair kept in place, now sitting where the workbench comment used to.
- `plugins/workbench/style.css` — was an empty wired placeholder; now carries
  the 68 moved rules byte-identical, under a header explaining what stayed core
  and why, and that the vars it reads (`--sidebar-bg`, `--accent`, …) are core's
  `:root` ones — a plugin inherits the host theme rather than restating it,
  which is what keeps the themes island working over plugin surfaces.
- `test/plugin-style.test.js` — NEW, 3 tests.

### NEXT: W4 — entry points.
Plugin registers `sidebar.footerButton`; then delete, in order, with a grep
before each: `#btn-workbench` (index.html + its `renderer/styles.css:309/323`
grouped rule + `test/plugin-style.test.js`'s exception), the View-menu item and
its `request-open-workbench` emit (`app-menus.js:489`), the
`onRequestOpenWorkbench` contract row (`api-contract.js:151`) and its pin
(`test/api-contract.test.js:88`), the renderer subscription
(`renderer/renderer.js:~3781`), and W2's temporary `clodex:open-workbench`
CustomEvent bridge on BOTH sides (deviation (g) retires here).

---

## W4 — DONE. Suite 2398/2398 (+3 over W3's 2395).

Core now has NO workbench entry point of its own. The plugin brings its own way
in, so the button exists exactly as long as the feature behind it does.

### IN — `rhost.ui.sidebar.footerButton` (§2.2)

`plugins/workbench/renderer.js` registers `{ id:'open', glyph:'◫', label:
'Workbench', tip:…, onClick: () => surface.open() }`. Shape taken from the CODE
(`renderer/plugin-host.js:235-245, 277-313`), not the plan: the host renders
`<button data-plugin-footer=…>` into `#sidebar-footer` with three spans
(`.footer-glyph`, `.footer-label`, `.footer-badge`), reconciling on every
register/dispose, so the button appears at activate and vanishes at disable
without either side owning the other's DOM. `tip` becomes `data-tip` — the same
body-delegated tooltip the deleted `#btn-workbench` used, so the hover text is
unchanged.

The glyph is `◫` (U+25EB) — the character `&#9707;` in the deleted markup.

### OUT — five core sites, each grepped first

1. `renderer/index.html:83-86` — the `#btn-workbench` `<button>`. Replaced by a
   comment naming what appends there now.
2. `renderer/styles.css:309/323` — `#btn-workbench, #inbox-open` and its
   `:hover`. **NOT simply deleted**: the selector became
   `#inbox-open, #sidebar-footer [data-plugin-footer]`, so plugin footer buttons
   inherit the footer's native look. See the decision below.
3. `app-menus.js:483-489` — the View ▸ "Workbench…" item and its
   `win.webContents.send('request-open-workbench')` emit (GAP G5's site).
4. `api-contract.js:151` — the `onRequestOpenWorkbench` row.
5. `renderer/renderer.js:3812-3820` — the require-less init block: the
   `#btn-workbench` click wiring, the `onRequestOpenWorkbench` subscription, AND
   W2's temporary `clodex:open-workbench` CustomEvent dispatch. Its twin in
   `plugins/workbench/renderer.js:661-666` went with it. **Deviation (g)
   retires here as designed.**

Residual grep for `btn-workbench` / `request-open-workbench` /
`onRequestOpenWorkbench` / `clodex:open-workbench` across all js/html/css:
only prose comments remain (`plugin-loader.js:7`, the new comments at the two
sites above) plus `docs/plugin-plan.md`, which is the plan and stays as written,
and `web-dist/index.html`, a BUILT artifact (regenerated — G7/W8).

### THE DECISION W4 FORCED: who styles a plugin's footer button?

Deleting `#btn-workbench` from the grouped rule would have left the plugin's
button unstyled — a bare `<button>` in a styled footer — and the plan does not
say whose problem that is. Two options:

(a) the plugin ships the button's CSS in its own `style.css`;
(b) core styles `#sidebar-footer [data-plugin-footer]` by the HOST's own
    attribute.

**Took (b).** The sidebar footer's chrome is core's, not any plugin's: a plugin
that styled its own footer row could drift from `#inbox-open` on every theme
change, and four plugins would mean four slightly different buttons in one
8px-padded strip. Styling by the host's attribute means a plugin gets a native
button by asking for one, and cannot override the footer's look. Same reasoning
as `.plugin-overlay` in W2 (deviation (f)) — host-created chrome is host-styled.
Consistent, and it keeps the plugin's stylesheet strictly about its interior.

Also added `.footer-badge:empty { display: none; }` — the host creates the badge
span unconditionally, and as a flex item an empty one draws the row's 8px gap
after the label. No pill styling: nothing calls `badge()` yet and inventing its
look before a caller exists would be guessing.

**Flagged as deviation (k)** — a second piece of CORE css added during the
phase where CSS moves out, permanent, for the same host-contract reason as (f).

### `test/plugin-style.test.js`'s W4 debt paid

Its move-gate carried an explicit `#btn-workbench` exception with a comment
saying W4 must remove it. Removed. The gate now asserts NO `wb-`/`workbench-`
selector of any kind survives in `renderer/styles.css`, with no exceptions.

### The contract count moved DOWN — the expected shape of this step

`test/api-contract.test.js` pins the surface size in three places. Deleting
`onRequestOpenWorkbench` took it **235 → 234**. Updated all three (test name +
two assertions) and reworded the workbench comment block: the fourteen data rows
are still there and are W6's business; only the open event went in W4.

This is the first row this migration has actually removed from core's contract,
and it is worth stating plainly: the number going down is the deliverable, not a
test that needed fixing.

### Tests — `test/workbench-plugin.test.js` +3

The engine half was already covered; the renderer half's ENTRY POINT was not,
and after W4 nothing else in the suite opens the workbench — an unreachable
feature would have been a silent pass. `activate` touches no DOM (markup is
built lazily in `mount`), so a stub rhost is enough:

- registers exactly ONE footer button, with a glyph, a label and an onClick;
- `activate` alone opens nothing; `onClick()` opens the overlay surface;
- **the W2 bridge is gone** — the stub's `addEventListener` THROWS, so
  `activate()` merely completing is the assertion. That pins the bridge out:
  it cannot creep back as a convenience.

### NEXT: W5 — the data path moves.
Move `git-scm.js` AND `fs-explorer.js` (deviation (c)) into
`plugins/workbench/`; switch the engine half to local `require('./git-scm')` /
`require('./fs-explorer')`; DELETE the two temporary `host.lib` entries
(deviation (b) retires) — `engine.js`'s two requires + the pass-through,
`plugin-host-engine.js`'s two deps + its `lib` freeze, and the fixture/assertions
marked DELETE-IN-W5 in `test/plugin-host-engine.test.js`. Repoint
`test/git-scm.test.js`, `test/fs-explorer.test.js`, and the two entries in
`test/free-identifier-leaks.test.js`'s SCANNED_MODULES. `git-worktree.js` STAYS
core as `host.lib.gitWorktree` (permanent). Use `git mv` so history follows.

---

## W5 — DONE. Suite 2396/2396 (W4 was 2398; the −2 is explained below).

The workbench's data implementations are now the plugin's own files, and
deviation (b)'s two temporary `host.lib` entries are gone as designed.

### MOVED (via `git mv`, so history follows)
- `git-scm.js` → `plugins/workbench/git-scm.js`
- `fs-explorer.js` → `plugins/workbench/fs-explorer.js` (deviation (c) — the
  plan named only git-scm.js; fs-explorer.js backs `fs.list/read/write`).

Both require only node builtins (`child_process`; `fs`+`path`), so the
no-backdoor lint passes them unchanged — nothing had to be rewritten to survive
the move, which is the evidence they were plugin code sitting at the core root.

### DELETED — the (b) temporaries, all five sites
- `engine.js` — the two requires and the two pass-through args.
- `plugin-host-engine.js` — the two deps and their entries in the `lib` freeze.
  `lib` is now `Object.freeze({ gitWorktree })`.
- `test/plugin-host-engine.test.js` — the fixture leaves and the two
  DELETE-IN-W5 assertions.

The `lib` comment now states the RULE the pilot established, rather than
describing the temporaries: **a leaf CORE also uses is lent through `host.lib`;
a leaf only one plugin uses belongs in that plugin's directory.** `gitWorktree`
stays because the New-Session dialog and the delete flow use it. I replaced the
deleted assertions with `deepEqual(Object.keys(host.lib), ['gitWorktree'])` —
otherwise the rule is prose, and the next temporary entry would slip in green.

### THE PROBLEM W5 EXPOSED, and the stopgap I took

`ipc-handlers.js:36-37` still `require`s both files. After the move those
requires resolve to nothing and **`ipc-handlers.js` fails to load at all** — not
a test failure, a hard boot failure of the main process. Ten test files require
it. The plan's W5/W6 split does not mention this: it assumes the files can move
while core still uses them, and they cannot.

Three options:
1. Merge W5 and W6 into one commit. Loses the separation the phasing is for, and
   W6 is the riskiest step (14 contract rows) — exactly the one that most wants
   its own revert.
2. Leave duplicate copies at the core root until W6. Two divergent copies of git
   plumbing, even for one commit, is worse than any pointer.
3. Point core's two requires INTO the plugin directory for one commit.

**Took 3**, with a comment at the site stating it is deleted in W6 and that it
is as wrong as it looks. It is honest about direction (core → plugin, the arrow
this whole program exists to remove) but it is one commit long, it is the
smallest diff of the three, and NOTHING else changes: no core renderer code
calls those fourteen rows any more (grepped: zero hits for `scmStatus`,
`fsList`, … under `renderer/`), so the rows are already dead weight waiting for
W6 to delete them.

**Flagged as deviation (l).** If a reviewer wants W5+W6 squashed instead, that
is a one-line change to this branch's history and I have no objection — it is a
judgment call about revert granularity, not about the end state, which is
identical either way.

### The leak-scanner question: DROPPED, not repointed

The ticket asked me to check rather than assume, and the answer is that
repointing would have been wrong. `test/free-identifier-leaks.test.js` scans a
module against **main.js's module scope** — it answers "did an extraction from
main.js leave a free identifier behind?". A plugin was never extracted from
main.js and cannot see its scope, so scanning one would be asking a question
with no meaning; it would pass vacuously forever and imply a guarantee it does
not make.

The real guarantee for plugin files is `test/plugin-boundary.test.js`'s
no-backdoor walk, and it is strictly STRONGER: not "no leaked identifier from
main.js" but "no require out of the plugin directory at all". So the two entries
were **dropped**, with a comment in the list saying why and naming the test that
covers them now. **That is the −2 in the suite count** — those were two
per-module tests, and the modules they covered left the scanner's remit.
Nothing lost: both files are still covered by their own test files.

**Flagged as deviation (m)** — the ticket said "repoint the two SCANNED_MODULES
entries"; I dropped them instead.

### The workbench test's fake leaves had to change shape

`test/workbench-plugin.test.js` injected all three leaves through the engine's
deps. After W5 only `gitWorktree` is injectable — the other two are plugin-local
requires with no seam. Rather than keep a seam production no longer has, the
test now patches the REAL modules' exports for its duration and restores them in
a `cleanup()` (module identity makes this work: the engine half's `require`
resolves to the same objects). Stated at the site, because a test that could
still inject them would be testing something that no longer exists.

### Repointed
- `test/git-scm.test.js` and `test/fs-explorer.test.js` — requires now
  `../plugins/workbench/…`. Both pass unchanged otherwise.

### NEXT: W6 — the contract shrink.
Delete from `api-contract.js` the fourteen rows (`scmStatus`, `scmDiff`,
`scmStage`, `scmUnstage`, `scmDiscard`, `scmCommit`, `scmBranches`,
`scmCheckout`, `scmRemote`, `worktreeList`, `worktreeRemove`, `fsList`,
`fsRead`, `fsWrite`), their `ipc-handlers.js` registrations (:325-386) and the
two requires at :36-45 (deviation (l) retires here). Update the pinned count
234 → 220 in `test/api-contract.test.js` (three places) and drop the fourteen
names from PINNED_NAMES. Pre-delete grep for stray consumers — expected zero
outside `web-dist/` (built artifact) and docs. NOTE `worktreeList`/`worktreeRemove`
are core rows over `git-worktree.js`, which STAYS core — check whether the
New-Session dialog or the delete flow calls either before deleting them; if they
do, those two rows STAY and only twelve go.

---

## W6 — DONE. Suite 2396/2396. **api surface 234 → 220.** W1–W6 COMPLETE.

### The pre-delete grep: all fourteen rows were already dead

Grepped each of the fourteen names across every `.js`/`.html` in the tree. Live
callers outside `api-contract.js` + its test: **ZERO**. The only other hits are
`docs/ipcmain-vs-wire-gap.md` and `docs/plugin-plan.md` (prose, and the plan is
the plan) and `web-dist/index.html` (a BUILT artifact, regenerated — G7/W8).
W2 moved the last caller into the plugin four commits ago; these have been dead
weight since.

### The worktree question the ticket asked me to check FIRST

`worktreeList` / `worktreeRemove` are core rows over `git-worktree.js`, which
STAYS core — so the ticket was right to ask whether a core caller keeps them
alive. **Checked: no, both go.** The distinction that settles it:

- The New-Session dialog uses `createWorktree` / `worktreeInfo`
  (`renderer/renderer.js:2456, 1925`) — **different rows, untouched.**
- The session-DELETE flow calls `gitWorktree.removeWorktree(worktree.path)`
  **directly, in-process** at `ipc-handlers.js:420` — it never went through the
  `worktree:remove` IPC row. That row existed solely for the workbench's
  worktree pane.

So core keeps using the LEAF while the ROWS die: exactly the shape §4 W5
describes for `git-worktree.js`, confirmed rather than assumed. **All fourteen.**

### DELETED
- `api-contract.js` :54-68 — the fourteen rows.
- `ipc-handlers.js` :319-392 — their registrations **and the `sessionCwd`
  helper**, which had no other caller. Worth stating: that helper was the
  locality guard, re-implemented per handler; the host's
  `sessions.fsScope(name)` is the same guarantee offered to every plugin from
  one place. The pilot didn't just move the rows, it removed a per-handler
  discipline in favour of a host guarantee — MUST-FIX 5's actual payoff.
- `ipc-handlers.js` :36-45 — the two `require('./plugins/workbench/…')` lines.
  **Deviation (l) retires here**; core points at no plugin file again, and
  `node -e "require('./ipc-handlers.js')"` loads clean.
- `test/api-contract.test.js` — the fourteen names from PINNED_NAMES; the count
  updated in all three places, 234 → 220.

Suite unchanged at 2396: the contract test asserts a count, it does not generate
one test per row.

### W1–W6, the arc in one line each
- **W1** 699aa15 — loader (both halves) + the pilot scaffold. 2355 → 2380.
- **W2** cd618e1 — the DOM moves; four rhost surfaces; 15 engine rows. → 2392.
- **W3** 9a00d1c — the CSS moves (69 rules); plugin-style guard. → 2395.
- **W4** 573db5a — entry points; the api surface first shrinks, 235 → 234. → 2398.
- **W5** 2fd0200 — git-scm + fs-explorer move in; host.lib temporaries die. → 2396.
- **W6** (this) — the contract shrink, 234 → 220. → 2396.

Core now contains NO workbench markup, CSS, entry point, data row or file. What
remains anywhere in core is prose: comments naming what moved and why.

### STOPPING HERE, as instructed.
W7-W9 are a separate ticket. clodex's fail-safe/quarantine follow-on (the INBOX
section above) is NOT part of t2 and has NOT been started — it is recorded there
in full for whoever picks it up, including the note that `loadAll` and
`loadPluginRenderers` already try/catch per plugin, so REQUIRED 1 is largely
present and the real work is recording + surfacing the failure and the whole of
REQUIRED 2.

---

# TICKET t4 — Plugin Phase 2, part 2: W7–W9 + the fail-safe/quarantine follow-on

Verbatim, from clodex (msg-60180-57.txt). t2 (W1–W6) is CLOSED and verified by
clodex independently: suite re-run in this worktree, 2396/2396.

> [ticket t4] tasks/plugin-phase-2-workbench
> Plugin Phase 2, part 2 — workbench pilot W7-W9 (enablement, web parity,
> acceptance) + the fail-safe/quarantine follow-on
>
> t2 verified on my side: I re-ran the suite in the worktree myself, 2396/2396.
> W9 gate 3 already effectively passes — every surviving `workbench` string in
> core is a comment naming what moved. 235 → 220 on the api surface is the
> thesis demonstrated numerically; that number goes in the final report.
>
> BOTH your flagged calls upheld. (l) the one-commit wrong-arrow require: the
> W5/W6 split as written is genuinely unimplementable since ipc-handlers requires
> both moved files — you picked the reversible option and commented it, right
> call, no squash needed retroactively. (m) dropping the leak-scanner entries
> rather than repointing: YOU ARE RIGHT AND MY TICKET WAS WRONG. A scanner asking
> "did an extraction from main.js leak an identifier" passes vacuously forever
> for a plugin that can't see main.js's scope, and a green light that verifies
> nothing is worse than no light. The no-backdoor lint makes the stronger claim.
> Keep it dropped.
>
> Your `sessionCwd` observation is the finding of the phase — the pilot didn't
> just move rows, it replaced a per-handler discipline with a host guarantee. Put
> that in the final report in those terms.
>
> SCOPE — three pieces, in this order:
>
> 1. THE FAIL-SAFE/QUARANTINE FOLLOW-ON (in your journal's INBOX; it belongs with
>    W7 since that is where enable-by-default lands). Full spec was my earlier
>    dm. Short form: try/catch per plugin around engine `activate(host)`,
>    renderer `activate(rhost)`, and manifest parse — a throwing or malformed
>    plugin is marked failed and SKIPPED, app boots regardless, failure visible
>    in settings. Then quarantine on the SECOND consecutive failed activation,
>    with a persisted per-plugin counter cleared on any success. THE RULE THAT
>    MATTERS: do NOT clear `uiSettings.plugins.enabled` — that is the user's
>    intent; keep a separate quarantine set that shadows it, so the settings row
>    can say "disabled automatically: activate() threw on 2 consecutive launches
>    — Retry" with intent intact. Renderer half activates per BrowserWindow, so
>    quarantine on consistent failure across activations, not per-window; flag
>    whatever rule you choose.
>    CALIBRATION FROM BOGDAN, important for how much you build: this is BEST
>    EFFORT, not a rescue system. A broken plugin is an annoyance, not a
>    catastrophe — the code is on disk and a stock CLI in that cwd can read the
>    git diff and fix or revert it. Match the posture the plan already sets for
>    `deactivate()` ("best-effort; the honest full-unload is the restart
>    boundary"). try/catch and a counter, not clever recovery logic. If
>    quarantine gets fiddly at the edges, pick a simple rule with a clear message
>    over elaborate correctness.
>
> 2. W7 — enable-by-default. Workbench ships enabled in the default persona so
>    existing users see no change. The disable path must be real: disable removes
>    button, overlay, styles and dispatch entries in EVERY window.
>
> 3. W8 — web parity. Regenerate web-dist; the bundle needs the plugin renderer
>    module + CSS via a build-generated `web-plugin-registry.js` id→module map,
>    since the browser can't `require()` arbitrary paths. This resolves GAP G7
>    (`build/build-web.js` was unseen when the plan was written) — read it first
>    and report what you find; the plan flags this step's mechanism as inference,
>    not verified. Rebuild the Docker web image if that is reachable; if not, say
>    so rather than guessing.
>
> 4. W9 — the five acceptance gates. Gate 1 (two windows: overlay independent per
>    window, disable removes from both, ZERO live timers/listeners after disable)
>    and gate 5 (CLODEX_PLUGINS=0 yields a working app with no workbench
>    anywhere) are the two that need real rigor — gate 5 is the first time the
>    kill switch is load-bearing, since t1's byte-equivalence passed with the
>    switch ON only because nothing registered. Gate 2 is the peer/remote fsScope
>    refusal keeping today's UX. Gate 3 you have effectively passed; make it a
>    real CI grep. Gate 4 is leak-scanner + electron-boundary extended and green.
>
> Note W9 gate 1's two-window requirement and gate 5 may not be fully provable
> from unit tests alone. Where a gate needs a running app, say so explicitly and
> specify exactly what a human should click — Bogdan can run it from the worktree
> (`npm start` there works; node_modules is symlinked). Do not claim a gate
> passed on inference.
>
> STANDING, unchanged: CLAUDE.md FROZEN. Code wins over plan, flag
> contradictions — your hit rate on that is 3 for 3. Suite via the
> clodex-test-green skill with an explicit cd (the exec is blind to worktrees);
> baseline 2396. Commit per step on `plugin-phase-1`. Journal as you go. Do NOT
> touch master, do NOT push.

## t4 OPERATING NOTES

- Deviation letters CONTINUE from t2's (a)–(m). Next new flag is **(n)**.
- Baseline **2396**. W1–W6 commits: 699aa15 · cd618e1 · 9a00d1c · 573db5a ·
  2fd0200 · a864e3c. Master is at 2f3f8e1 (clodex's About-panel commit) and must
  stay untouched.
- Suite route unchanged: `clodex-test-green` skill → `test-runner` subagent with
  an EXPLICIT cd into this worktree, plain `node --test`, no dir argument.
- Order is fixed by the ticket: fail-safe/quarantine FIRST (it lands in the W1
  loader and belongs with W7), then W7, then W8, then W9.
- W8 has a REAL unknown: read `build/build-web.js` BEFORE designing anything.
  The plan's mechanism for it is inference and clodex says so explicitly.
- W9: do NOT claim a gate passed on inference. Gates 1 and 5 likely need a
  running app — name exactly what Bogdan should click.

### NEXT: the fail-safe/quarantine follow-on (piece 1).
Verify BEFORE building — journal note from t2 says `loadAll` already
try/catches per plugin and `renderer.js:loadPluginRenderers` already
try/catches per renderer half (W1 decision 8, "per-plugin failure isolation at
three levels"). So REQUIRED 1 is largely present; the real new work is
(a) RECORDING the failure rather than only logging it, (b) surfacing it in the
§2.5 settings section, and (c) all of REQUIRED 2 (the quarantine set + counter).

---

## t4 PIECE 1 — fail-safe / quarantine. DONE. Commit e0dd361. Suite 2410 (+14).

### VERIFIED FIRST, as the pickup note said
REQUIRED 1 was indeed largely present: `plugin-loader.js:loadOne` already wraps
`require` + `pluginHost.register` (i.e. `activate(host)`) in a try/catch,
`discover()` already refuses a malformed manifest, and
`renderer.js:loadPluginRenderers` already try/caught per renderer half. So the
new work was exactly what the note predicted — RECORD, SURFACE, and all of
REQUIRED 2.

### What landed
- **`plugin-loader.js`** — the failure record + quarantine. `_failures` key
  under `uiSettings.plugins` (leading underscore ⇒ collision-proof, since
  PLUGIN_ID_RE forbids one; unlike `enabled`, which is a legal id and so has to
  be reserved explicitly). `recordFailure` / `clearFailures` / `isQuarantined`;
  `loadAll` skips a quarantined plugin with `skipped: 'quarantined'`;
  `activateById` clears the counter first, so it doubles as Retry. New
  `status()` (every plugin ON DISK + refused directories) and
  `noteRendererActivation(id, ok, error)`.
- **`plugin-host-engine.js`** — two new `_host` methods, `plugins.status` and
  `renderer.report`; `announceState()` broadcasting `plugin-state` on the
  `_host` pseudo-id from both branches of `setEnabled`.
- **`renderer/renderer.js`** — `activatePluginRenderer(id)` split out of
  `loadPluginRenderers` (so the state hint can call it); reports outcome BOTH
  ways; `requirePluginRenderer()` seam (the W8 registry hook, see below); an
  `onPluginEvent` subscriber that disposes/activates this window's half; and
  `renderPluginsSection()` — core's own §2.5 Plugins section.
- **`renderer/index.html` + `styles.css`** — `#prefs-plugins-section` (hidden by
  its own `#id.hidden` rule — no generic `.hidden` in this project) + the
  `.plugin-row` styles.
- **Tests** — 9 in plugin-loader.test.js, 5 in plugin-host-engine.test.js.

### DEVIATION (n) — the renderer quarantine rule
Only the FIRST renderer activation report per app run counts. A renderer half
activates once per BrowserWindow, so counting every activation would quarantine
a three-window user on their FIRST bad launch (3 strikes, threshold 2). A
strike is therefore per LAUNCH, not per window: "consistent failure across
activations" reads as "it failed the first time this launch tried it". The
alternative — tally per window, require all of them to fail — is more correct
and much fiddlier at the edges (windows open and close mid-run); the ticket
explicitly says prefer a simple rule with a clear message. Flagged as asked.

### Second call inside piece 1 (not a deviation, an unasked-for necessity)
W7 says "disable removes … in EVERY window", which is unimplementable from the
engine alone: `deactivate(id)` tears down the ENGINE half, and each renderer
half lives in a BrowserWindow that only that window can dispose. So `setEnabled`
now emits `plugin-state` on the existing `plugin-event` row and each window acts
on it. No new api-contract row (§1 freezes the transport at five) — it rides the
`_host` pseudo-id, the same way `renderer.info` already does.

### NEXT: W7 (enable-by-default) — mostly VERIFY, not build.
`plugins/workbench/manifest.json` already has `enabledByDefault: true` and
`loader.isEnabled` already falls back to it, with a test pinning it
(plugin-loader.test.js "the pilot ships enabled (W7)"). The real W7 work is the
DISABLE path, which piece 1 just built. So W7 = prove the disable path end to
end (renderer-side test: dispose removes footer button, overlay, style element,
and zeroes _liveResources), confirm the packaged-app plugins/ dir resolves
(GAP G8 — `__dirname` inside app.asar), and check `files` in package.json's
build config actually ships plugins/.
