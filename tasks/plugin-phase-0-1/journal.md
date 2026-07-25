# Plugin Phase 0 + 1 — journal

Ticket t1 from clodex. Worktree: `/Users/bogdan/projects/tmux/wb-wrap-ui-plugin-phase-1`,
branch `plugin-phase-1` off master @55ba16a. Spec: `docs/plugin-plan.md` §1-§3, §6 Phases 0+1.
STOP at end of Phase 1. Never commit.

## Plan of attack

- P0.1 `plugin-api.js` (pure leaf) — HOST_API_VERSION = 0.
- P0.2 five api-contract rows + PINNED_NAMES 230→235 + preload count 230→235.
  NOTE: `api-contract.test.js` has a gate "every invoke channel has a registered
  handler in ipc-handlers" — so the 4 new invoke channels MUST get handlers in
  Phase 0, not Phase 1, or Phase 0 cannot exit green. Handlers are inert
  forwarders to an optional `getPluginHost()` seam (absent in Phase 0 ⇒
  `{ok:false, error:'no such plugin method'}`) — still zero behavior change.
- P0.3 `plugins/` dir (with a README so git keeps it).
- P0.4 electron-boundary test extended to walk `plugins/*/engine.js`.
- P0.5 no-backdoor lint: new `test/plugin-boundary.test.js`.
- P0.6 leak-scanner lists updated for every new module.

- P1a `plugin-host-engine.js` — dispatch map, events, sessions facade, storage,
  settings, intents, lib, telemetry. Wired at createEngine tail.
- P1b `renderer/plugin-host.js` island + six UI registries.
- P1c `intent-registry.js` + R-INT-1..4 + P1-P5 + differential byte tests.
- P1d in-tests-only fake plugin.

## Log

(append below as work lands)

### Phase 0 — code landed, awaiting suite

Files added:
- `plugin-api.js` — pure leaf: HOST_API_VERSION='0', PLUGIN_ID_RE/isValidPluginId,
  HOST_PSEUDO_ID='_host'/namespaced, pluginsEnabled(env) kill switch,
  NO_SUCH_METHOD/errorEnvelope.
- `plugins/README.md` — dir + the rules the tests enforce.
- `test/plugin-boundary.test.js` — the no-backdoor lint + 3 scanner self-tests
  (incl. a synthetic plugin written into the REAL plugins/ dir and removed).

Files changed:
- `api-contract.js` — the five §1 rows appended.
- `test/api-contract.test.js` — PINNED_NAMES +5, three 230→235 count bumps.
- `ipc-handlers.js` — requires plugin-api + intent-catalog; `getPluginHost` added
  to the deps destructure; four handlers (plugin:invoke / plugin:catalog /
  plugin:setEnabled / intents:catalog).
- `test/electron-boundary.test.js` — `pluginEngineFiles()` + a second test
  walking `plugins/*/engine.js`.
- `test/free-identifier-leaks.test.js` — `plugin-api.js` added to SCANNED_MODULES.

DECISION (flag to clodex): the spec put "the five api-contract rows" in Phase 0
and the handlers in Phase 1, but `test/api-contract.test.js` already gates
"every invoke channel has a registered handler in ipc-handlers". So Phase 0
cannot exit green with rows and no handlers. Handlers landed in Phase 0 as
INERT forwarders over a lazy `getPluginHost()` seam that nothing supplies yet —
every call returns the §3.4 shaped refusal / an empty catalog, except
`intents:catalog`, which falls back to the live `GATEABLE_INTENTS` projection.
Zero behavior change holds: no existing caller uses these channels.

DECISION: `intents:catalog` got its Phase-0 fallback body (the GATEABLE_INTENTS
projection) rather than a refusal, because it must serve the REAL catalog once
R-INT-4 rewires checklists.js in Phase 1c, and a plugin-host-absent run (kill
switch) must still get a correct catalog. The plugin-host branch overrides it.

ENVIRONMENT: the worktree had no `node_modules`; symlinked to the main
worktree's (`ln -s ../wb-wrap-ui/node_modules`). Untracked, not committed.

### Phase 0 — VERIFIED GREEN. 2224/2224.

RESOLVED (was an open question): `[agent:exec clodex-run-tests]` runs in the
MAIN worktree on master — it returned exactly 2218, the baseline, blind to this
branch. It is NOT a usable signal here. Green for this worktree comes from the
`clodex-test-green` skill with an explicit cd into the worktree path: 2224/2224,
= 2218 + the 6 tests Phase 0 adds (4 plugin-boundary + 1 electron-boundary
plugin walk + 1 leak-scan row for plugin-api.js). Use that route for every
subsequent run; report BOTH numbers to clodex so the delta is auditable.

CAUTION: writing `[agent:exec …]` on its own line in prose FIRES it. Describe
exec commands inline or fenced, never line-initial.

### Phase 1a — DONE (16/16 on its own file; full suite pending)

Added:
- `plugin-host-engine.js` — `createPluginHostEngine(deps)`. Dispatch Map keyed
  `"<id>:<method>"`; per-plugin teardown ledgers (idempotent disposers that
  self-remove); `sessionHandle()` frozen 6-key handle; `sessions` facade
  (listAll/listWorkspace/get/fsScope/onCreate/onExit); scoped `events.emit`;
  storage (tmp+rename atomic at dataDir/state.json); settings
  (uiSettings.plugins[id] shallow-merge); frozen `lib.gitWorktree`; read-only
  `telemetry.snapshot`; register/deactivate/hooks + `_dispatchKeys`/`_hookCounts`
  test seams.
- `test/plugin-host-engine.test.js` — 16 tests.

Changed:
- `session-manager.js` — `getPluginHooks` added to the GETTER dep group; two
  call sites: `fireCreate` at the create() tail (before the return), `fireExit`
  inside ptyProc.onExit between the persistence-remove and `_cleanup(name)`.
- `engine.js` — requires plugin-host-engine + plugin-api + git-worktree;
  `let pluginHost = null` declared ABOVE createSessionManager so the
  `getPluginHooks: () => pluginHost ? pluginHost.hooks : null` getter closes over
  it; construction at the bootstrap tail gated on `pluginsEnabled(process.env)`,
  wrapped in try/catch (a broken host degrades to no-plugins, never takes the app
  down); `getPluginHost: () => pluginHost` added to the returned handle.
- `test/free-identifier-leaks.test.js` — plugin-host-engine.js added.

DECISIONS worth surfacing:
1. The onExit ORDERING is pinned two ways: behaviorally (sync-only/isolated/dead
   handle, via engine.hooks.fireExit) AND STRUCTURALLY — a test reads
   session-manager.js and asserts `_sendToSession('session-exit')` < hook <
   `_cleanup(name)` by source index. A unit test cannot execute that PTY handler,
   so without the structural pin a future reorder ships green. This is the
   landmine the plan calls a documented regression.
2. `host.sessions.list` is asserted `undefined` — the absence is the feature
   (MUST-FIX 1), so it gets a test, not just a comment.
3. Thenable-returning onExit subscriber logs a violation and IGNORES the result;
   it does NOT await. Awaiting would resume after `_cleanup` — the exact break
   the hook placement exists to prevent.
4. `setEnabled(id, true)` returns a shaped refusal ("enabling requires the plugin
   loader (Phase 2)") rather than pretending. Phase 1 has no manifest scan to
   re-activate FROM; disable (teardown) is the honest half and works.
5. host.lib.gitWorktree required git-worktree.js into engine.js, which did not
   previously require it. Additive; core keeps ownership (New-Session worktree
   row + delete flow depend on it) per plan §4 W5.

### Next phase (pickup point if I'm replaced)
1b renderer island → 1c intent registry → 1d fake plugin.
NOTE the deferred item: `host.intents` does NOT exist yet — 1c adds it, and
`test/plugin-host-engine.test.js`'s "no stores/manager/transport" test pins the
CURRENT 11-key surface with a comment saying `intents` joins in 1c. That test
MUST be updated when 1c lands, or it fails.
Read `docs/plugin-plan.md` §3.2 (host object + SessionHandle + onExit spec),
§3.3 (multi-window law), §3.4 (dispatch map) before writing 1a.

### Phase 1b — seams located (read, not yet written)

Renderer seams, all confirmed by reading (line numbers are this worktree):
- `renderSessionActions(holdHtml)` renderer.js:2958-3003 — builds `btns[]` of HTML
  strings, ends `el.innerHTML = btns.join('') + (holdHtml||'')` into `#proxy-actions`.
  Plugin actions+segments append into that same join, per §2.1's placement rule.
- `renderProxyBar()` :3005 — `renderSessionActions()` at :3010 (top call, covers the
  no-payload early return) and again at :3040 (the `!p.linked` branch). Both early
  returns therefore DO render plugin contributions — plan §2.1's claim verified.
- The bar HIDE branch is :3024-3027 (`else { bar.style.display='none'; … }`), guarded
  by `if (activeIsAgent() || activePeerQueryable() || activePeerConfigurable())` at
  :3016. THAT is the one-line core edit: `|| pluginBar.hasVisibleContribution(ctx)`.
- Click routing: the delegated listener at :3551 `e.target.closest('.px-action')`
  then an if/else chain on `action.dataset.act`. Plugin acts are namespaced
  `"<pluginId>:<id>"`, so one appended branch (`act.includes(':')`) routes them.
  Segments are `<span class="px-seg …">`; clickable ones use `data-act` + their own
  `closest()` line (:3545-3550 precedent) — plugin segments get one such line.
- Sidebar: `addSessionToSidebar` :589-668 builds `.session-badges` :613-618;
  `applyPrBadge(item)` :1045-1063 is the dynamic-chip precedent (append span into
  `.session-badges`, `data-tip` for the delegated tooltip); it is called from the
  row pass in `refreshSidebarView` at :981. `scheduleSidebarRelayout` :1068-1071.
- Session menu: `sessionMenuEntries(type)` is the pure table in
  `renderer/lib/session-actions.js`; `routeSessionAction(act, anchor)` :3597-3606.
  Menu is opened at :3564 with `sessionTypeOf(activeSession)` and an onPick that
  calls `routeSessionAction`.
- Settings: `openPrefs()` :5491-5519, save handler :5531-5549, `closePrefs` :5521.
  `#prefs-dialog` is index.html:891. Sections mount before `.dialog-actions`.
- Footer: `#sidebar-footer` index.html:82-92 (Workbench + Inbox buttons, each
  `<button><span class="footer-glyph">…</span><span class="footer-label">…</span>`).
- Overlay exemplar: `#workbench-overlay` index.html:283.
- Island init convention: `const { x } = initFoo({ deps })` at module scope
  (e.g. `initThemes({ sessions })` :67, `initBanners({ openInstallSession })` :3960).
- `esc` comes from `./lib/format` (renderer.js:10) — the island requires it itself,
  not via deps (pure leaf, same as every other island).

### Phase 1b — DONE (28/28 on test/plugin-host.test.js; leak scan green)

Added:
- `renderer/plugin-host.js` — `initPluginHost(deps)`. Six registries as ARRAYS
  (render order = registration order); per-plugin `resources` ledger
  (disposers/timers/intervals/listeners/styleEl/ownDispose); `register()` shared
  guts (validates id + required callbacks, namespaces to `<pluginId>:<id>`,
  returns an idempotent self-removing disposer); `barContext()` built from core's
  own predicates each pass. Core-facing seams: `statusBarHtml`,
  `hasVisibleContribution`, `handleBarClick`, `applyRowBadges`,
  `renderFooterButtons`, `menuEntriesFor`, `handleMenuPick`,
  `renderSettingsSections`, `collectSettingsSections`, `settingsSectionOwners`.
  Lifecycle: `activate`/`dispose`/`disposeAll`. Introspection: `_counts`,
  `_liveResources` (the W9 gate's zero-assert).

Changed:
- `renderer/renderer.js` — require + `initPluginHost({…})` immediately above
  `renderSessionActions`; then SIX call sites:
  1. `renderSessionActions` tail: `+ pluginBar.statusBarHtml()` into the join.
  2. `renderProxyBar` :3016 visibility: `|| pluginBar.hasVisibleContribution()`.
  3. bar click delegation: a `.px-seg.px-plugin[data-act]` check before the
     `.px-action` chain, and an `act.includes(':')` branch inside it.
  4. `refreshSidebarView` row pass: `pluginBar.applyRowBadges(el)` after
     `applyPrBadge(el)`.
  5. `routeSessionAction` head: namespaced-act branch → `handleMenuPick`.
  6. `openPrefs` → `await renderPluginPrefs()`; new `renderPluginPrefs()` helper
     above `closePrefs`; Save handler persists each collected patch.
  Also passes `pluginBar.menuEntriesFor(type)` as openSessionMenu's 4th arg.
- `renderer/popovers/session-menus.js` — `openSessionMenu(anchor, type, onPick,
  extra = [])`; `entries = [...sessionMenuEntries(type), ...extra]`. Default `[]`
  keeps the menu byte-identical without plugins.
- `plugin-host-engine.js` — `hostMethods` on the `_host` pseudo-id
  (`settings.get` / `settings.set`), routed at the head of `dispatch`.
- `test/free-identifier-leaks.test.js` — `renderer/plugin-host.js` added to
  RENDERER_SCANNED_MODULES.

DECISIONS worth surfacing:
1. `getWorkspaceId` is GETTER-shaped, not a value. `currentWorkspaceId` is filled
   asynchronously (renderer.js:353 awaits `window.api.currentWorkspace()`), so a
   captured value would be null for the window's whole life — and §3.3 law 1
   requires rhost to carry a real workspaceId. `rhost.workspaceId` is a getter
   on the frozen object for the same reason.
2. `_host` settings methods are deliberately NOT in `dispatchMap`. They're host
   services, belong to no plugin's teardown ledger, and must not be disposable —
   but they must still ride the ONE multiplexed channel (constraint 5). They
   refuse an unregistered pluginId, so a renderer can't write settings for a
   plugin that isn't loaded.
3. The bar-click seam needed TWO edits, not one: plugin segments are `<span
   class="px-seg">`, so `closest('.px-action')` can never see them. Core's own
   ctx/cost/bust segments have exactly this shape (three separate `closest()`
   lines at :3545-3550) — the plugin segment line follows that precedent.
4. `footerButton` registration PAINTS (and its disposer un-paints). Every other
   registry is pull-driven by an existing core render pass; the footer has none,
   so registration owning its own paint is the only shape where a plugin doesn't
   have to know about a refresh function.
5. `openSessionMenu` gained a 4th param rather than the island importing the
   plugin host: the menu island is deliberately opener-agnostic (its header says
   so) and reaching into another island would be a new cross-island edge.
6. Escape handling for overlays is centralized in the island's own
   document-level listener, so no plugin installs one — one less thing teardown
   must reach (§2.6 host responsibility).

Added (tests):
- `test/plugin-host.test.js` — 28 tests over a hand-rolled fake DOM (the
  api-shim.test.js approach). The fake node's `innerHTML` getter escapes
  `textContent`, because `lib/format.js`'s `esc()` IS that round-trip — so the
  escaping assertions test the real mechanism, not a stub.

TWO BUGS THE TESTS FOUND (both fixed, both worth knowing about):
1. `dispose()` did not close an OPEN overlay when the plugin had eagerly
   disposed its registry row: a registry disposer splices the entry out of
   `overlays`, so the wholesale-removal sweep couldn't see it. `onClose` never
   fired and `openOverlay` stayed pointing at a dead plugin, which would have
   suppressed the NEXT plugin's open. Fixed by closing before the disposers run.
2. `getWorkspaceId = () => null` as a destructured default made the LEAK SCANNER
   BLIND to every dep above it — its param matcher is `\(([^()]*)\)`, which
   cannot cross the nested parens of an arrow default, so the whole deps list
   stopped counting as own-definitions and five real names were reported as
   leaks. Default dropped; call sites guard with `getWorkspaceId ? … : null`.
   GENERAL GOTCHA for any future island: no parenthesised defaults in a factory
   deps destructure.

### Phase 1c — design settled (read complete, not yet written)

Seams read in full: intent-scanner.js (298 lines, whole), intent-catalog.js
(120, whole), ipc-prompt.js GRAMMAR_LINES + buildIpcPrompt (85-192),
session-manager.js `_extractIntents` (2618-2752), `_scanJsonlText` (2754),
`_handleIntent` head + gate (2775-2836).

R-INT-3 GAPs G1 and G2 both ANSWERED by reading, and both favourably:
- G1: the WIRE feed calls `this._extractIntents(t.text)` at :480 and :656 — the
  same funnel as jsonl. Confirmed, not assumed.
- G2: the BASH PTY feed calls `parseIntent` DIRECTLY at :2201 (no
  `_extractIntents`, so no body capture, not fence-aware — deliberate, per its
  own comment). So a plugin verb is live there through the registry walk inside
  `parseIntent`, but with NO body. That is a real semantic difference the 1d
  fake-privileged-verb test must assert rather than paper over.

PARSE ORDER (must be preserved byte-exactly by the registry walk):
escape → dm → resend → who → name → end → context → memory → file → exec →
remind → notify-user → team-review → review-done → reboot → task → team → spawn.
Plugin rows walk AFTER every core row, so a plugin can never shadow a core verb
even before P5's collision check fires.

bodyMode mapping (MUST-FIX 7 — a predicate over the PARSED intent, never a
type-level flag), read off the live allow-set at :2723-2732:
  greedy: dm, remind, notify-user, team-review, review-done,
          task iff sub ∈ {add,done,reject,cancel},
          team iff sub ∈ {role-add,role-set},
          memory iff sub === 'remember',
          context iff sub ∈ {compact,reload}
  json:   exec  (the JSON-terminator branch; its fall-through to greedy on an
          incomplete value stays in the SHELL — that is control flow, not a mode)
  none:   everything else
`task assign/list` and `team role-rm/role-rename/watchdog` are the cases a
type-level flag would get wrong; they get their own assertions.

DESIGN DECISION — where `label` / `promptLines` live for CORE rows (a place the
CODE CONTRADICTS THE PLAN, flag to clodex):
The plan's R-INT-1 row shape carries `label` and `promptLines` on every row. But
intent-catalog.js and ipc-prompt.js own those TODAY with DELIBERATELY DIFFERENT
ORDERINGS, and say so in terms: intent-catalog's header — "two orderings, two
owners"; ipc-prompt's GRAMMAR_LINES comment — "This order is a byte property of
IPC_PROMPT and is INDEPENDENT of intent-catalog's GATEABLE_INTENTS order (which
owns checklist row + allowlist serialization)". Copying both into a third table
would (a) duplicate the bytes IPC_PROMPT is pinned on and (b) collapse two
orderings into one, which is a real user-visible regression in checklist order
or prompt bytes depending on which one wins.
So: CORE rows carry `parse`/`bodyMode`/`type`/`source:'core'` and DERIVE
gateable/privileged/label from intent-catalog; `promptLines` is null for core
(GRAMMAR_LINES keeps owning them, and P3's third `extraGrammarLines` arg is for
PLUGIN lines only, which is exactly what P3 describes). PLUGIN rows carry their
own label + promptLines and are FORCED privileged (P1).
The catalog projection for R-INT-4 = GATEABLE_INTENTS in ITS order, then plugin
rows in registration order — so the checklist keeps its current row order and
gains a plugin tail.

Plan of attack for 1c (in this order, checkpointing between):
 c1. `intent-registry.js` pure leaf + core rows + `parseWithRegistry`.
 c2. intent-scanner's `parseIntent` becomes the walk; differential test
     (table-vs-legacy) over a corpus of every intent-scanner.test.js input.
 c3. `_extractIntents` allow-set → `bodyMode(intent)`.
 c4. R-INT-2 dispatch tail in `_handleIntent` + P4 near-miss string from the
     registry (oracle at test/session-manager.test.js:571 is a `/\breboot\b/`
     match, NOT a full-string pin — so regenerating the join is safe, but I
     will add a full-string pin so the join order is actually gated).
 c5. R-INT-4 `intents:catalog` real body + checklists.js `setIntentCatalogCache`.
 c6. P3 third arg to buildIpcPrompt + re-verify BOTH byte-pins.
 c7. `host.intents` on plugin-host-engine + UPDATE the 11-key surface assertion.

INERT-BY-CONSTRUCTION check (Phase-1 zero-behavior-change): with no plugin
registered, `statusBarHtml()` → `''`, `hasVisibleContribution()` → `false`,
`menuEntriesFor()` → `[]`, `handleBarClick`/`handleMenuPick` → `false`,
`applyRowBadges` returns before touching the DOM (`!rowBadges.length`),
`settingsSectionOwners()` → `[]` so `renderPluginPrefs` issues ZERO invokes, and
`collectSettingsSections()` → `[]` so Save issues zero. The one non-obvious one:
`renderPluginPrefs` is `await`ed inside `openPrefs`, which was already `async`.
Key seams already located:
- `createEngine` tail + handle return: engine.js:1690-1756 (add `getPluginHost`
  to the returned object; both main.js and web-host.js spread `...engine` into
  registerIpcHandlers, so the ipc-handlers dep wires itself once it's returned).
- `ptyProc.onExit` landmine: session-manager.js ~1513-1562 — hook fires AFTER
  the session-exit send, BEFORE `_cleanup(name)`, sync-only, try/catch each.
- `sessionCwd` guard to reproduce verbatim in `fsScope`: ipc-handlers.js:295-313.
- `session:list` is `manager.listForWorkspace(workspaceOfSender(e))`
  (ipc-handlers.js:377) — workspace-scoped. `manager.list()` is global. Two
  named accessors, never an unqualified `list()`.

Seams confirmed by reading (1a can be written straight from these):
- `sessionCwd` guard, ipc-handlers.js:310-316 — EXACT bytes to reproduce in
  `fsScope`: `!s` → `{error:'Session not found'}`; `s.peer` → `{error:'remote'}`;
  `!s.cwd` → `{error:'Session has no working directory'}`; else `{cwd:s.cwd}`.
  (Answers plan GAP G10 as a doc question: the guard checks `s.peer`, so peer
  entries DO occur in `manager.sessions`; `sessions.get` returns null for them.)
- onExit landmine, session-manager.js:1513-1562. Exact ordering to preserve:
  `session._dead = true` → log → `_sendToSession('session-exit')` →
  `_broadcast('ipc-message')` → remoteServer.notifyExit → conditional
  `getPersistence().remove(name)` (bash natural exit only) → `_cleanup(name)` →
  refreshTray/AppMenu. HOOK GOES between the persistence-remove and
  `_cleanup(name)`. NOTE for the contract test: for a naturally-exited BASH
  session the persistence entry is ALREADY GONE at hook time — plan §3.2 says
  "documented, not hidden", so the test asserts it rather than papering over it.
- `_sendToSession` :777, `_broadcast` :800ish, `windowForWorkspace` :746,
  `_injectText(session, text, {parkable})` — the four primitives `events.emit`
  and `SessionHandle.inject` wrap.
- `createSessionManager(deps)` at :224; deps come in three shapes (value / getter
  / electron-seam fn) — the `onCreate`/`onExit` hook points are injected as
  GETTER-shaped deps (`getPluginHooks`), because the plugin host is constructed
  at the createEngine TAIL, i.e. AFTER the manager. A captured value would be
  undefined — same reasoning the header gives for getPersistence et al.


### Phase 1c — c1 + c2 DONE (29/29 new file; scanner 53/53; leaks green)

WRITTEN:
- `intent-registry.js` (NEW, pure leaf, requires only intent-catalog). 16 core
  rows = the regex chain MOVED out of intent-scanner verbatim, in the same
  order. Derived fields (gateable/privileged/label) come from intent-catalog;
  `promptLines: null` for every core row (the ownership decision above).
  Exports: CORE_ROWS/CORE_TYPES/RESERVED_TYPES/PLUGIN_VERB_RE/
  CORE_VALID_INTENT_NAMES + registerIntent/unregisterSource/rows/rowFor/
  pluginRowFor/parseWithRegistry/bodyModeFor/intentEnabledFor/catalogRows/
  allowlistFromChecked/pluginGrammarLines/validIntentNames/_resetPluginRows.
- `intent-scanner.js`: `parseIntent` is now escape-check → end-check →
  `parseWithRegistry(cleaned)`. 12.7KB of regex chain removed. `cleanLine`,
  `fencedLines`, `looksLikeIntent`, `shadowIntentKey` untouched.
- `test/intent-registry.test.js` (NEW, 29 tests).
- `test/free-identifier-leaks.test.js`: `intent-registry.js` → SCANNED_MODULES.

DECISIONS made while writing (all flagged for the report):

1. `escape` AND `end` stay in the scanner SHELL, not the table. The plan only
   says "after the escape/end checks", which this satisfies; the reason to make
   it explicit is that a plugin row able to match a backslash-prefixed or
   `[agent:end]` line could eat a quote or a body terminator. Structural, not a
   verb ⇒ no row ⇒ unshadowable. Test pins `rowFor('end') === null` while
   `parseIntent('[agent:end]')` still works.

2. `intentEnabledFor` is a NEW wrapper, not a change to `intent-catalog`.
   intent-catalog returns TRUE for any type outside its catalog ("ungateable by
   omission", its documented rule). For a plugin verb that rule is a RETROACTIVE
   GRANT to every seat that ever existed — the exact MUST-FIX-3 failure. The
   wrapper answers plugin verbs itself (explicit-grant-or-nothing) and delegates
   every core type unchanged. intent-catalog.js is NOT edited in 1c.

3. `allowlistFromChecked` likewise WRAPS `intentsAllowlistFromChecked`. Core half
   byte-identical (test asserts equality over 5 shapes, with and without a
   plugin registered); a CHECKED plugin verb forces an explicit array, because
   collapsing to null would silently drop the grant — the same bug the reboot
   collapse-guard fixes for core.

4. Plugin `parse` is WRAPPED: try/catch → null, non-object → null, and the
   returned `type` is OVERWRITTEN with the registered verb. Without the
   overwrite a plugin could return `{type:'dm'}` and route itself straight into
   a core case of `_handleIntent`'s switch. Same for `bodyMode` (clamped to the
   three legal modes, throws → 'none'). A string bodyMode is REFUSED at
   registration — it is precisely the type-level flag MUST-FIX 7 rejects.

5. `pluginRows` is MODULE-LEVEL state, on purpose: it is what makes R-INT-3 true
   by construction. All three feeds read the same list through `parseIntent`, so
   "registered on one feed only" is inexpressible. Cost: tests must reset it —
   hence `_resetPluginRows` and the `withPluginVerb` helper.

CONTRADICTION FOUND — P4 near-miss list (the plan says "becomes a registry
join (core order, then plugin verbs)"):
The shipped string is `dm, resend, who, name, context, memory, spawn, file,
exec, remind, notify-user, team-review, review-done, task, reboot, end`. That is
NOT parse order (spawn sits 7th; in the chain it is LAST) and NOT catalog order,
and it OMITS `team` entirely. A literal "join of registry order" therefore
CHANGES user-visible copy, which Phase 1 forbids. So `CORE_VALID_INTENT_NAMES`
is an explicit const reproducing the shipped bytes, with plugin verbs appended
before the trailing `end`; a test asserts every name is a real registry verb
(rot protection without regeneration) and a second test PINS the `team` omission
as pre-existing. → the missing `team` is a real (small) bug in master's bounce
copy; flagged, not fixed here.

CORPUS NOTE: the differential test HARVESTS candidate lines out of
test/intent-scanner.test.js + session-manager.test.js + ipc-prompt.test.js
(every quoted literal mentioning `[agent:`) and unions them with ~110
hand-written adversarial cases → 190ish lines, all compared field-for-field AND
key-order-for-key-order against a frozen copy of master's chain. The harvest
self-checks (asserts it found ≥40) so a silent regex breakage can't quietly
reduce it to the hand list.

NEXT: c3 (_extractIntents allow-set → bodyModeFor), c4 (dispatch tail + bounce
string), c5 (intents:catalog + checklists cache), c6 (buildIpcPrompt 3rd arg),
c7 (host.intents + the 11→12 key surface assertion).

### Phase 1c — c3 + c4 DONE (session-manager 301/301, was 288)

c3 — `_extractIntents` (session-manager.js):
- `if (intent.type === 'exec')` → `if (bodyModeFor(intent) === 'json')`.
- The 10-clause allow-set → `const bodyMode = bodyModeFor(intent); if (bodyMode
  === 'greedy' || bodyMode === 'json')`. The `|| 'json'` is REQUIRED, not
  sloppiness: an exec whose payload never completes within the cap falls THROUGH
  to the greedy capture, and that fall-through is control flow in this shell, not
  a fourth mode. Comment says so.
- The verb list that used to be spelled out in comments here now lives on the
  registry rows; the comment points at it instead of restating it.

c4 — `_handleIntent` (session-manager.js):
- Bounce copy: hardcoded string → `validIntentNames().join(', ')`.
- Gate: `intentEnabled(...)` → `intentEnabledFor(...)`. (The OTHER
  `intentEnabled` call, :5261, gates dm DELIVERY on the RECIPIENT and stays on
  the core leaf — it can only ever be asked about 'dm'.)
- `default:` case → `this._dispatchPluginIntent(session, intent)`, a new method.
  Sits after the switch's core cases, so gate order is unchanged: unknown bounce
  → intentEnabledFor gate → plugin tail.

DECISION: the tail does NOT build its own SessionHandle. It asks the host:
`getPluginHooks().handleFor(name)`, a new one-liner on plugin-host-engine's
`hooks` object delegating to the existing `sessionHandle(name)`. A second copy
in session-manager would drift the moment §3.2 grows a method. Kill switch / no
host ⇒ `handleFor` absent ⇒ clean no-op (tested).

Handler failure policy, matching the onCreate/onExit hooks: sync-only (a
returned promise is logged as a contract violation and IGNORED — an escaped
rejection would bypass every try/catch on this path), throw → `[agent:<verb>]
error: …` bounce, agent sessions only.

DEPS: `bodyModeFor`, `intentEnabledFor`, `pluginRowFor`, `validIntentNames`
added to the VALUE dep group of createSessionManager and passed from engine.js
(module-level require — the registry is a pure leaf, no whenReady dependency).

TESTS ADDED (12 in session-manager.test.js):
- Full-string BYTE PIN of the near-miss bounce (the existing oracle at :578 is
  only `/Valid intents:.*\breboot\b/`, which a wrong-order regeneration would
  sail past). Kept the old one too.
- Plugin dispatch: handle shape (exactly 6 keys, no pty/_dead), P1 absent-list
  denial + the standard gate bounce, explicit vs unrelated grant, throwing
  handler → bounce, bash pane never reached, kill switch no-op, handler-less row
  no-op, async handler refused, core dispatch unperturbed, P4 bounce list gains
  the verb, bodyMode honoured through the REAL _extractIntents, and the
  jsonl-vs-bash-PTY body difference asserted directly (R-INT-3 G2).

BUG FOUND BY TEST (mine, in the test helper): `withVerb`'s try/finally reset the
module-level registry the instant an ASYNC callback returned its promise — i.e.
at the first await, with the test body still to run — so every dispatch after
that point hit an empty registry. One test caught it. Helper now threads the
reset through .then/.catch. (`withPluginVerb` in intent-registry.test.js has the
same shape but every callback there is sync.)

NEXT: c5 (intents:catalog real body + checklists.js setIntentCatalogCache),
c6 (buildIpcPrompt 3rd arg + BOTH byte-pins), c7 (host.intents + the 11→12 key
surface assertion in test/plugin-host-engine.test.js).

### Phase 1c — c5 + c6 + c7 DONE (1c COMPLETE, pending full-suite run)

c5 — R-INT-4, catalog over IPC:
- `ipc-handlers.js`: `intents:catalog` is now `handle('intents:catalog', () =>
  catalogRows())`. DECISION: it reads intent-registry DIRECTLY, not the plugin
  host. Routing it through the host would blank the checklist in exactly the
  degraded cases (kill switch, no plugins, host construction failed) where the
  CORE rows still matter. The registry is a module-level table both halves
  mutate, so it is authoritative either way. Phase 0's GATEABLE_INTENTS fallback
  is gone, and so is ipc-handlers' intent-catalog require.
- `renderer/lib/checklists.js`: static `require('../../intent-catalog')` REMOVED.
  Added `intentCatalogCache` + `setIntentCatalogCache` (modelled on
  setExecLibCache) and `intentRowChecked(row, intentsList)`.
  DECISION: checked-state is computed INLINE from the served row's own
  `privileged` flag rather than by calling `intentEnabled`. Calling the leaf
  would re-introduce the require this seam exists to remove — and would be WRONG
  for plugin verbs, since the leaf answers TRUE for anything outside its catalog
  ("ungateable by omission"), i.e. it would render a granted box for a seat that
  was never granted. Test pins both: equivalence to intentEnabled for every core
  row over 7 allowlist shapes, and the divergence for a plugin row.
- `collectIntentChecklist` now returns the RAW checked array (no collapse).
- Collapse moved ENGINE-side, in TWO places (both persistence writers):
  `session-args.js` `resolveSessionArgsPatch` (the setArgs/peer path) and the
  `session:setIntents` handler (the popover path). Both call
  `allowlistFromChecked`. It is idempotent on an already-collapsed value, so a
  peer patch echoing a persisted array resolves to itself.
- Fetch wired at all three render paths: `refreshNewSessionIntents` (now async),
  the Edit-Session dialog, and the intents popover in checklist-popovers.js.
  The web bundle needs no work — api-shim loops API_CONTRACT, so
  `getIntentCatalog` (added in Phase 0) exists there already.

c6 — P3: `buildIpcPrompt(intentsList, execCommands, extraGrammarLines)`. Third
arg appends after the core block, filtered by the CALLER to granted verbs
(`pluginGrammarLines(intents)` — only the registry knows the rows). Both spawn
sites updated (claude + codex). BOTH byte-pins re-verified, and I added a third
test asserting the pins hold through EVERY no-op shape of the new arg
(undefined/null/[]/non-array/0) plus a round-trip test that stripping the added
line restores IPC_PROMPT byte-for-byte.

c7 — `host.intents = { register(row) -> dispose }` on plugin-host-engine, a
pass-through to `registerIntent` with the plugin id attached, wrapped in the
usual `disposable()` ledger. Rules P1/P5 stay INSIDE the registry (they must
hold for any caller, not just plugins). Throws on collision — deliberately: a
refused verb is an activation error, and swallowing it leaves a plugin believing
it owns a verb that never fires. `deactivate()` also calls `unregisterSource`
(belt to the ledger's braces — intent rows are module-level, so a leaked row
would outlive its plugin process-wide). Surface assertion updated 11→12 keys.
Also added `hooks.handleFor(name)` in c4 (see above) — same object, one owner.

TESTS: +6 test/intent-checklist-seam.test.js (NEW), +5 ipc-prompt.test.js,
+6 plugin-host-engine.test.js (22 total), and the surface pin flipped.

NEXT: 1d (in-tests-only fake plugin exercising every extension point), then the
full suite + CLODEX_PLUGINS=0 byte-equivalence, then the report.

### Phase 1d — test/plugin-fake.test.js DONE (25/25 on its own file)

Four parts, one self-contained file, no new source changes (tests only):
 P1 ENGINE (12): activation touching every §3.2 point; ipc.handle round-trip
    incl. async + throwing + unknown-method/-plugin; events.emit all three
    scopes + the ws-closed drop + the scopeless refusal; sessions
    listAll/listWorkspace/get/fsScope/inject; onCreate/onExit incl. the
    dead-handle and post-cleanup-null cases; storage (atomic, per-plugin dir,
    no .tmp); settings merge + the `_host` dispatch route; lib/telemetry;
    deactivate; the UNCOOPERATIVE plugin (no deactivate, kept no disposers);
    throwing-activate rollback; two-plugin independence.
 P2 RENDERER (6): all six registries through the real activate(); namespacing +
    escaping; click/pick routing with core fall-through; lazy overlay mount +
    centralized Escape close; rhost.invoke as the only engine path (and no
    `api`/`window` on the frozen rhost); the W9 zero-assert; re-activation.
 P3 INTENTS (5): the verb across BOTH feeds with the body difference asserted
    directly, plus the fence asymmetry; P1 forced-privileged; the gate bounce
    for an ungranted seat; catalog/prompt/near-miss join AND the full removal on
    deactivate; the shadow + impersonation refusals.
 P4 KILL SWITCH (2): `pluginsEnabled` truth table; a no-host manager + an empty
    renderer host answering identically on every seam.

DECISIONS:
- The fake is a module object inside the test file, NOT a dir under plugins/.
  Reasons: no loader exists until Phase 2; plugins/* is walked by two lint
  tests, so a permanent fake becomes a permanent lint subject; and VERIFIED BY
  PROBE that `node --test` (no dir arg — the package script) executes every .js
  under test/ INCLUDING test/fixtures/, so a shared helper module is not
  available either. Hence the DOM stub is a trimmed copy of
  plugin-host.test.js's rather than an extraction; commented as such.
- Part 3 wires the REAL SessionManager + a REAL plugin-host engine (not the mkX
  fakes), because the thing under test is a difference between two of the
  manager's own feeds and the handle minted by the host.

TWO BUGS FOUND WHILE WRITING (both mine, in the test):
1. The wrapped `setInterval` the fake registers HANGS `node --test` if the test
   never disposes — a hang, not a failure, which is the worst shape. Fixed with
   a `withRendererHost` sweeper. Worth noting the inverse reading: that the
   sweep fixes it is direct evidence the wrapped-timer teardown is real.
2. `withReset` had EXACTLY the async try/finally bug that bit withVerb in 1c —
   reset fired at the first await, so a later registry read saw an empty table.
   One test caught it. Now threaded through .then/.catch, with a comment saying
   it is the second occurrence.

### CLODEX_PLUGINS=0 BYTE-EQUIVALENCE — PASSED (stronger than required)

Method: a throwaway probe (written, run, DELETED — both worktrees left as they
were, main confirmed clean afterwards) emitting every agent-facing byte and the
whole grammar surface: IPC_PROMPT, buildIpcPrompt in four shapes incl. an exec
catalog, GATEABLE_INTENTS, PRIVILEGED_INTENTS, the full parse of the harvested
~190-line intent corpus, and intentEnabled/allowlist round-trips over 5 shapes.
453 lines. Run in THREE configurations:
  1. main worktree @ master (clean tree, same commit 55ba16a) — the reference
  2. this branch with CLODEX_PLUGINS=0
  3. this branch with plugins ON
All three md5 3824e787d607d30e0fc3613091e86165 — IDENTICAL, zero diff lines.

Note the result is STRONGER than the exit criterion asks: config 3 matches too.
That is expected and worth stating plainly — Phase 1 registers no plugins, so
the kill switch is not yet load-bearing; it becomes so in Phase 2 when a loader
exists to skip. What config 2 proves TODAY is that the switch path itself
doesn't diverge, not that it's suppressing anything.

### Phase 1d — (superseded) plan notes

Decisions taken before writing:
- The fake plugin lives INSIDE test/plugin-fake.test.js, not in a `plugins/`
  subdir and not in test/fixtures/. Two reasons: (a) `plugins/*` is walked by
  test/electron-boundary.test.js and test/plugin-boundary.test.js, so a real dir
  would become a permanent lint subject and would also be the loader Phase 2
  owns; (b) VERIFIED BY PROBE that `node --test` with no dir arg picks up
  `test/fixtures/*.js` as a TEST FILE (it ran a fixture and counted it) — so a
  shared helper module under test/ would be executed as a suite. Hence: one
  self-contained file, DOM stub duplicated from plugin-host.test.js rather than
  extracted to a helper.
- The renderer DOM stub is a trimmed copy (only the selectors the fake actually
  uses). Duplication is deliberate and commented; the alternative is the
  test/fixtures trap above.

## CONSOLIDATED REPORT MATERIAL (for closing ticket t1)

Suite: **2355/2355 green** in the worktree — FINAL (Phase 0: 2224; after 1c:
2330; +25 from 1d). Master's own baseline is 2218, so Phases 0+1 add 137 tests
and break nothing. CLODEX_PLUGINS=0 byte-equivalence: PASSED (see its section).

### Files ADDED
- `plugin-api.js` — pure leaf: HOST_API_VERSION, id validation, `namespaced`,
  `pluginsEnabled` (kill switch), error envelope.
- `plugin-host-engine.js` — the engine half: dispatch map, events, sessions
  facade, hooks, storage/settings/lib/telemetry/ipc/intents.
- `intent-registry.js` — the intent grammar table (R-INT-1).
- `renderer/plugin-host.js` — the renderer half + six UI registries.
- `plugins/README.md` — the directory contract.
- Tests: `plugin-boundary.test.js` (no-backdoor lint), `plugin-host-engine.test.js`
  (22), `plugin-host.test.js` (28), `intent-registry.test.js` (29),
  `intent-checklist-seam.test.js` (6), `plugin-fake.test.js` (25 — the
  end-to-end fake plugin across both halves + both intent feeds).

### Files CHANGED
- `api-contract.js` (+5 rows) · `ipc-handlers.js` (4 plugin handlers +
  intents:catalog; intent-catalog require → intent-registry) ·
  `engine.js` (host construction + registry requires + deps) ·
  `session-manager.js` (getPluginHooks dep; onCreate/onExit hook points;
  bodyModeFor collapse; intentEnabledFor gate; validIntentNames bounce;
  _dispatchPluginIntent tail; buildIpcPrompt 3rd arg) ·
  `intent-scanner.js` (parseIntent → registry walk) ·
  `ipc-prompt.js` (extraGrammarLines) · `session-args.js` (engine-side collapse) ·
  `renderer/lib/checklists.js` (served rows seam) · `renderer/renderer.js`
  (island init + 9 seam edits) · `renderer/popovers/session-menus.js` (4th param) ·
  `renderer/popovers/checklist-popovers.js` (catalog fetch) ·
  tests: `api-contract`, `electron-boundary`, `free-identifier-leaks`,
  `session-manager` (+13), `ipc-prompt` (+5).

### DEVIATIONS / FLAGS (every one, for clodex to verify)
a. Four IPC handlers landed in **Phase 0, not Phase 1** — `test/api-contract.test.js`
   gates that every invoke row has a registered handler, so Phase 0 could not exit
   green with rows and no handlers.
b. `intents:catalog` was given a real GATEABLE_INTENTS fallback body in Phase 0
   (rather than a refusal), replaced in 1c by `catalogRows()`.
c. **Testing route**: `[agent:exec clodex-run-tests]` is BLIND to the worktree — it
   runs in the main checkout on master and returns the 2218 baseline. Green came
   from the `clodex-test-green` skill with an explicit cd. This contradicts the
   ticket's "run the suite ONLY via the exec" instruction.
d. `sessions.onExit` is pinned **structurally** (by source index: exit-send < hook
   < _cleanup) in addition to behaviorally.
e. `setEnabled(id, true)` returns a shaped refusal — there is no loader until Phase 2.
f. `git-worktree.js` newly required into `engine.js` (additive, for `host.lib`).
g. `node_modules` symlinked into the worktree (untracked).
h. Ran `node --test <single file>` directly during development (the full suite
   always via the skill).
i. The bar-click seam needed **two** core edits, not one — plugin segments are
   `<span class="px-seg">`, which `closest('.px-action')` structurally cannot see.
j. `_host` settings methods sit deliberately OUTSIDE the dispatch map (host
   services, must never be disposable) while still riding the one multiplexed channel.
k. `openSessionMenu` gained a 4th parameter (`extra = []`).
l. **CODE vs PLAN — row shape**: core rows do NOT carry `label`/`promptLines` as
   the plan's R-INT-1 shape says. intent-catalog and ipc-prompt own those TODAY
   with deliberately DIFFERENT orderings and say so in terms. Core rows derive
   label/gateable/privileged from the catalog and leave promptLines null;
   plugin rows carry their own. (Full reasoning in the "design settled" section.)
m. **CODE vs PLAN — P4 near-miss list**: the plan says "becomes a registry join".
   The shipped string is in NEITHER parse nor catalog order and **omits `team`**.
   A literal registry join changes user-visible copy. So `CORE_VALID_INTENT_NAMES`
   reproduces the shipped bytes exactly, plugin verbs append before the trailing
   `end`, and a test asserts every name is a real verb. → **the missing `team` is a
   real pre-existing bug in master's bounce copy; flagged, not fixed.**
n. `intentEnabledFor` / `allowlistFromChecked` are NEW WRAPPERS in intent-registry;
   `intent-catalog.js` itself was NOT edited. Reason: the leaf's documented
   "non-catalogued type ⇒ true" rule is a retroactive grant for a plugin verb.
o. The renderer's checked-state is computed inline from the served row's
   `privileged` flag, NOT by calling `intentEnabled` (same reason as n).
p. `intents:catalog` reads intent-registry directly, NOT the plugin host — so the
   core checklist survives the kill switch / a failed host.
q. Two bugs found by my own tests in 1b (overlay not closed on eager dispose; a
   parenthesised default in a deps destructure blinding the leak scanner) and one
   in 1c (an async-unaware try/finally in a test helper resetting the shared
   registry mid-test). All fixed; details in the phase sections above.
r. The 1d fake plugin is a module object INSIDE test/plugin-fake.test.js, not a
   directory under plugins/. Three reasons (no loader until Phase 2; plugins/* is
   walked by two lint tests; and `node --test` executes every .js under test/
   INCLUDING test/fixtures/, verified by probe — so no shared-helper file is
   available either). Consequence: the DOM stub is a trimmed COPY of
   plugin-host.test.js's, duplicated deliberately and commented as such.
s. The CLODEX_PLUGINS=0 check came back stronger than the criterion: the branch
   is byte-identical to master with the switch OFF **and ON**. Correct for Phase
   1 (nothing registers a plugin yet), but it means the switch is not yet
   load-bearing — it becomes so in Phase 2.
t. Two more test-side bugs found in 1d: an undisposed wrapped setInterval HANGS
   `node --test` (a hang, not a failure), and `withReset` repeated 1c's
   async try/finally trap. Both fixed in the test; neither is a source bug.

### DEFERRED (not in scope for Phase 1)
- No plugin LOADER, no manifest reading, no `plugins/` directory scan — Phase 2.
- The workbench pilot — Phase 2, explicitly stopped before.
- Fixing the `team` omission in the bounce copy (see m).
- `setEnabled(id, true)` stays a shaped refusal until the loader exists (see e).

### STATUS: PHASE 1 COMPLETE — STOPPED AS INSTRUCTED
Nothing committed; branch `plugin-phase-1` in worktree
/Users/bogdan/projects/tmux/wb-wrap-ui-plugin-phase-1, tree dirty, fully
reversible by deleting the worktree. Awaiting Bogdan's review before Phase 2.
