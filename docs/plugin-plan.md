# Clodex → plugin core + public host API — engineering plan (fable-5.max.v2)

Status: buildable plan, not vision (the vision is `docs/plugin-vision.md`). This plan **starts from
the prior review findings** (multi-window blind spot + 7 MUST-FIX items) and is designed so those
are satisfied **by construction**, not by discipline.

Evidence tags used throughout:
- **[V]** — verified directly in the corpus slice I was given (file:line cited).
- **[F]** — established by the prior reviewer against the full repo (line numbers from the findings,
  not re-derivable from my corpus; treated as fact).
- **[I]** — inferred; stated as such.
- **GAP: Gn** — depends on code NOT in my corpus; the consolidated GAP register is §8. These flags
  are deliberate output.

---

## 0. Compliance map — where each MUST-FIX is handled by construction

| # | Finding | Where handled | Mechanism |
|---|---------|---------------|-----------|
| BS | Multi-window blind spot (N renderers, broadcast leak, `_sendToSession` drops, sessions outlive windows, renderer-driven restore) | §3.3 "The multi-window law" | Renderer `activate` is **per-window by definition**; events are **unbuffered invalidation hints with mandatory scope**; state is **pull-on-open by contract**; engine half activates once and owns durable state |
| 1 | `sessions.list()` conflation (workspace vs global) | §3.2 host.sessions | Two named accessors `listAll()` / `listWorkspace(wsId)`; no unqualified `list()` exists in the API |
| 2 | Intent catalog is a static renderer require + frozen web copy | §2.3 step R-INT-4 | Catalog becomes IPC-served (`intents:catalog` row); `renderer/lib/checklists.js` drops its static `require('../../intent-catalog')` [V checklists.js require block] and gains a cache+setter exactly like its existing exec-lib seam [V checklists.js `setExecLibCache`] |
| 3 | Plugin verbs corrupt allowlist semantics (retroactive grant via absent-list; collapse-to-null over wrong length) | §2.3 rules P1/P2 | Every plugin verb is **forced privileged** (registry ignores any manifest claim) → absent list = disabled [V intent-catalog.js `PRIVILEGED_INTENTS` block]; allowlist computation moves **engine-side** so the null-collapse is computed over the live core catalog only, never a stale renderer copy |
| 4 | `onExit` landmine (sync-only, placement, `_dead` handle) | §3.2 `sessions.onExit` spec | Single host-owned hook point inserted between the exit broadcast and `_cleanup(name)` [V session-manager.js:1513-1560]; sync-only enforced (thenable return logs a violation); handle is already `_dead`; `inject()` on it is a safe no-op [F :5471] |
| 5 | Workbench data path must stay local-only, never on popoverApi peer seam | §4 step W5 + §3.2 `sessions.fsScope` | The locality refusal is a **host guarantee**: `host.sessions.fsScope(name)` reproduces the `sessionCwd` guard verbatim [V ipc-handlers.js:295-313]; plugin channels ride `plugin:invoke` (window.api only) which is **absent from the peer query whitelist** [V remote-wiring.js query switch, :~430-460 in slice 186-501] — unreachable over the wire by construction |
| 6 | Workbench doesn't own its DOM/CSS; web-dist duplicate | §4 steps W2/W3/W8 | Overlay/footer-button DOM is **built by the plugin inside a host-created container**; index.html block removed; CSS ships as `plugins/workbench/style.css` injected as a per-plugin `<style data-plugin="id">` (choice stated); web-dist regen is an explicit step (GAP: G7) |
| 7 | Multiline body allow-set is per-(type, sub) | §2.3 registry row `bodyMode(intent)` | Body capture is a **function of the parsed intent**, returning `'none' | 'greedy' | 'json'` — the task/team sub-verb split [V session-manager.js:2700-2710] and exec's JSON terminator [V :2660-2695] are expressible; a type-level flag is not offered |

Smaller verified corrections are also baked in: twelve stores not eight (§3.2 note) [V stores.js:1668-1676];
declarative status-bar shapes, never HTML strings (§2.1); segment placement that survives
`renderProxyBar`'s early returns (§2.1) [V renderer.js:3015-3041]; `session-actions` as a
type→entries table (§2.4) [V session-actions.js]; registry-generated near-miss bounce with its
pinned-test oracle (§2.3) [F test/session-manager.test.js:578]; three intent feeds funneled through
one choke point (§2.3); no `removeHandler` → **single multiplexed `plugin:invoke` channel with an
engine-owned dispatch map** so disposables are implementable (§3.4) [F]; engine `host.ipc` is
transport-agnostic and inert under pure headless (§3.4).

---

## 1. Architecture in one page

**A plugin is a directory with a manifest and up to two JS halves:**

```
plugins/<id>/                      (in-repo, first-party — Phase 1-3)
~/.clodex/plugins/<id>/            (BYO — Phase 5, Tier B only)
  manifest.json
  engine.js      → { activate(host), deactivate() }     // plain Node, electron-free
  renderer.js    → { activate(rhost) }                  // DOM, loaded per window
  style.css      → injected per-plugin per-window
```

**Two trust tiers** (from the vision doc's liveness/trust table, kept as-is):
- **Tier A — in-process JS, first-party/curated only.** Full host API. Live-enable yes; clean live
  *unload* honestly = restart boundary (deactivate is best-effort teardown, and the residue that
  survives it is documented rather than papered over — §3.1).
- **Tier B — out-of-process, BYO/untrusted (Phase 5).** Speaks a protocol; the process boundary is
  the sandbox. **Only the declarative subset of the taxonomy** (intents-as-protocol like the exec
  loop [V session-manager.js:3406-3520], declarative status segments/badges, declared surfaces or
  webview). Every v1 declarative shape (§2) is chosen to survive this tier.

**Two host objects, one law:**
- `host` (engine): constructed **once** inside `createEngine`, after stores + manager + wiring exist
  and before the engine handle returns — i.e. before any window exists and therefore before the
  renderer-driven restore [V engine.js:1560-1612 bootstrap ordering; F restore is renderer-driven,
  renderer.js:5877 / ipc-handlers.js:1911].
- `rhost` (renderer): constructed **once per BrowserWindow** by a `renderer/plugin-host.js` island,
  initialized in the existing island init block [V renderer/renderer.js:3580-3760] with the same
  deps-object convention as every other island [V renderer/themes.js `initThemes({sessions})`].
- **Law:** engine half owns all durable state; renderer half is rebuild-from-zero on every window
  open; events are unbuffered hints; data crosses only via invoke (§3.3).

**Transport:** exactly five new rows in `api-contract.js` (the file's own rule: a `window.api`
method is a row there, nowhere else [V api-contract.js header]):

```js
{ name: 'pluginInvoke',     kind: 'invoke', channel: 'plugin:invoke' },     // (pluginId, method, args)
{ name: 'pluginCatalog',    kind: 'invoke', channel: 'plugin:catalog' },    // manifests + enabled state
{ name: 'pluginSetEnabled', kind: 'invoke', channel: 'plugin:setEnabled' },
{ name: 'onPluginEvent',    kind: 'on',     channel: 'plugin-event' },      // (pluginId, topic, payload)
{ name: 'getIntentCatalog', kind: 'invoke', channel: 'intents:catalog' },   // MUST-FIX 2
```

Because both frontends build `window.api` from this one table [V api-contract.js header;
architecture.md web-host section], the browser frontend inherits the plugin transport for free.
Plugin *code* in the web bundle is a build-time concern (GAP: G7).

---

## 2. The extension-point taxonomy (the one-way door)

Six named extension points + a small set of host *services* (§3.2). Registration is always
`rhost.ui.<point>.register*(spec) → dispose()` on the renderer side and `host.<area>.*` on the
engine side. All UI specs are **declarative data or callbacks that return declarative data**; a
plugin never hands core an HTML string (correction: today's bar innerHTML-joins strings
[V renderer.js:2958-3007]; that shape dies at the Tier-B boundary, so it is not offered).

> **Rejected alternative (taxonomy):** a generic DOM-injection API ("here is `document`, here are
> stable selectors"). Rejected because (a) disable/unload cannot remove what it cannot enumerate,
> (b) it cannot survive Tier B or the web bundle, and (c) it is precisely the "each plugin pokes
> core in a bespoke way" failure the vision doc names as the mess-renamed outcome. Also rejected:
> a pure-manifest contribution model (VS Code `contributes` with no imperative half) — workbench's
> editor and the intent handlers need real code; the imperative-inside-host-containers middle is
> what the corpus's island pattern already is.

### 2.1 Status bar

**Seams [V]:** `renderSessionActions` (action buttons, innerHTML-joined) renderer.js:2958-3007;
`renderProxyBar` (telemetry strip + visibility) renderer.js:3009-3070, with two early returns —
no-payload (:3015-3029) and `!p.linked` (:3034-3041) — that bypass the segment-building tail; the
`⚙ session ▾` consolidation [V renderer.js:2978-2981].

**API:**

```js
rhost.ui.statusBar.addAction({
  id,                        // namespaced by host: "<pluginId>:<id>"
  when(ctx),                 // ctx — see below
  button(ctx),               // -> { label, tip, accentClass? }   (text, escaped by host)
  onClick(anchorEl, ctx),
}) -> dispose
rhost.ui.statusBar.addSegment({
  id,
  render(ctx),               // -> { text, tip?, accentClass?, onClick? } | null
}) -> dispose
```

**The `ctx` every one of those callbacks receives** — one frozen object, rebuilt per render from
exactly what the bar itself sees, so a contribution cannot drift from the bar's own state:

```js
ctx = { session, type, isAgent, peerQueryable, peerConfigurable, workspaceId }
```

`session` is the active session name (or `null`); `type` its session type. `isAgent` is the
predicate core's own bar branches on, so a plugin asking "is this an agent?" gets the same answer
core does rather than re-deriving it from `type`. `peerQueryable` and `peerConfigurable` are the two
independent peer capabilities — a peer-backed session may be readable without being configurable, so
one flag could not carry both. `workspaceId` is present because §3.3 law 1 requires it: N windows
means N renderer activations, and a contribution that scopes anything — a cache key, an `invoke`
argument, an event filter — must be able to name its own window's workspace without asking.

**By-construction placement rule (early-return correction):** plugin actions AND segments render
inside the `#proxy-actions` span via `renderSessionActions`, which is invoked on **every** branch of
`renderProxyBar` including both early returns [V :3013 top call, :3049 `!linked` re-call]. Plugin
contributions are therefore never silently dropped for Bedrock/Vertex or unlinked sessions. The bar's
visibility condition additionally gains `|| pluginBar.hasVisibleContribution(ctx)` so a segment can
show on a session type the bar would otherwise hide for [V hide branch :3020-3028 — one-line core
edit, done in Phase 1, before any plugin exists].

### 2.2 Sidebar

**Seams [V]:** footer buttons owned by `renderer/index.html` `#sidebar-footer` (Workbench + Inbox
buttons live there today); per-row badge container `.session-badges` built in `addSessionToSidebar`
renderer.js:589-668 (badge span block ~:613-621); the dynamic-chip precedent `applyPrBadge`
renderer.js:1046-1070 (chip inserted into `.session-badges`, `data-tip` delegated tooltip); debounced
relayout `scheduleSidebarRelayout` renderer.js:1073-1078; group headers `makeGroupHeader`
:1078-1100.

**API:**

```js
rhost.ui.sidebar.footerButton({ id, glyph, label, tip, onClick, badge() /* -> string|null */ }) -> dispose
rhost.ui.sidebar.rowBadge({
  id,
  resolve(sessionName, meta),   // -> { text, tip?, cls? } | null   — SYNC, from the plugin's own cache
}) -> dispose
rhost.ui.sidebar.requestRelayout()   // wraps scheduleSidebarRelayout
```

`resolve` is called during the existing row pass in `refreshSidebarView` (same site as
`applyPrBadge` [V :980]) and must be synchronous — the plugin fills its cache via its own
`invoke`/events and calls `requestRelayout()`. This is exactly what the `git-branches` acceptance
plugin (§6 Phase 3) needs and nothing more. Deliberately **not** offered in v1: custom group-by
providers, row context-menu injection (the row menu is a main-process popup
[V renderer.js:655-658 `showSessionContextMenu`] — GAP: G5 for the menu builder), and sidebar
sections. Defer until a plugin proves the need.

### 2.3 Intent grammar (prompt line + parse + dispatch) — the load-bearing point

**Seams [V]:** the regex chain in `parseIntent` (intent-scanner.js, whole file); the multiline
body capture + per-(type,sub) allow-set and exec's JSON terminator in `_extractIntents`
session-manager.js:2596-2751 (allow-set :2700-2710, exec JSON :2660-2695); the gate + routing switch
`_handleIntent` :2753-3111 (unknown bounce :2772-2790, `intentEnabled` gate :2798-2816); grouped
sub-verb dispatch pattern :4292-4392; the catalog leaf intent-catalog.js (whole: `PRIVILEGED_INTENTS`
inversion, `intentEnabled` non-catalogued⇒true, `intentsAllowlistFromChecked` null-collapse,
`withoutPrivilegedIntents` wire/spawn strip, `deniedIntentCount` excludes privileged); the prompt
side `GRAMMAR_LINES` + `buildIpcPrompt` ipc-prompt.js:94-183 (reboot's granted-only line is the
existing precedent for privileged rendering); the renderer checklist consuming a **static require**
of the catalog [V renderer/lib/checklists.js top + `renderIntentChecklist`].

**Registry conversion (core-only refactor, Phase 1, zero behavior change):**

- **R-INT-1 — `intent-registry.js` (new pure leaf).** Row shape:

  ```js
  {
    type,                       // verb
    parse(cleanedLine),         // -> intent object | null   (core rows wrap today's regexes)
    bodyMode(intent),           // -> 'none' | 'greedy' | 'json'      // MUST-FIX 7: predicate over the PARSED intent
    gateable, privileged,       // plugin rows: privileged FORCED true (rule P1 below)
    label,                      // checklist row text
    promptLines,                // grammar-line text | null (resend precedent: gateable, no line [V intent-catalog header])
    handler | null,             // plugin execution half; null = core switch owns it
    source: 'core' | pluginId,
  }
  ```

  `parseIntent` becomes a walk over registry rows after the escape/`end` checks; `looksLikeIntent`,
  fence handling and near-miss synthesis stay in the scanner shell unchanged [V intent-scanner.js].
  `_extractIntents`'s allow-set conditional collapses to `bodyMode(intent)`; exec's JSON-terminated
  capture is the `'json'` mode [V :2660-2695]. Core rows reproduce today's bytes; a
  table-vs-legacy differential test pins it.

- **R-INT-2 — dispatch.** `_handleIntent`'s switch keeps every core case verbatim; a registry lookup
  is appended after the switch for plugin verbs: gate order preserved (unknown bounce → per-seat
  `intentEnabled` gate → dispatch) [V :2772-2816 ordering]. Plugin handlers receive
  `(SessionHandle, intent)` and reply via `handle.inject('[agent:<verb>] …', { parkable: true })`,
  mirroring the exec reply convention [V :3406-3410]. Handlers run inside try/catch; a throw becomes
  a `[agent:<verb>] error: …` bounce, never a crash.

- **R-INT-3 — one choke point, three feeds.** All three intent feeds funnel through
  `parseIntent`/`_extractIntents`/`_handleIntent`: jsonl [V `_scanJsonlText` :2734-2751], the wire
  path [F :474, :524 — GAP: G1 to confirm the wire feed calls the same `_extractIntents`
  funnel], and the bash PTY scan [F :2168-2179 — calls `parseIntent` directly, deliberately not
  fence-aware, no body capture; GAP: G2]. Because registration mutates the shared registry those
  functions read, a plugin verb is live on **all** feeds by construction — the "registered on one
  feed only" failure mode cannot be expressed.

- **R-INT-4 — catalog over IPC (MUST-FIX 2).** New `intents:catalog` handler returns
  `[{ type, label, privileged }]` composed from the live registry. `checklists.js` drops its static
  require and gains `setIntentCatalogCache()` — its own sanctioned-seam pattern, identical to
  `setExecLibCache` [V checklists.js]. Row checked-state is computed client-side from
  `(privileged, intentsList)` with the same three-line semantics as `intentEnabled`; the
  **allowlist itself is computed engine-side**: `collectIntentChecklist` returns the raw checked
  array and the `session:setIntents` / `setArgs` handlers call `intentsAllowlistFromChecked` where
  the registry is authoritative (MUST-FIX 3's stale-copy class killed). The web bundle's frozen
  copy becomes moot — the renderer no longer consults a local catalog for rows.

- **Rules that make plugin verbs safe (MUST-FIX 3):**
  - **P1 — forced privileged.** The registry sets `privileged: true` on every non-core row
    regardless of manifest. Consequences, all inherited from existing verified semantics:
    absent allowlist ⇒ disabled [V intent-catalog.js `intentEnabled` privileged branch];
    `withoutPrivilegedIntents` strips plugin verbs at the spawn-template and peer-wire boundaries
    for free [V intent-catalog.js; V remote-wiring.js:186-501 create/setArgs strip call sites];
    `deniedIntentCount` excludes them, so no seat grows a phantom 🔒 chip [V intent-catalog.js].
  - **P2 — null-collapse over core only.** `intentsAllowlistFromChecked`'s `nonPrivCount` counts
    non-privileged rows [V intent-catalog.js]; since every plugin row is privileged, enabling a
    plugin never changes what "absence" means. Computed engine-side (R-INT-4), never against a
    renderer snapshot.
  - **P3 — prompt line only when granted.** Plugin `promptLines` render via a third
    `buildIpcPrompt(intentsList, execCommands, extraGrammarLines)` argument the engine spawn site
    fills for granted verbs [V spawn call site session-manager.js:960 region
    `buildIpcPrompt(intents, execCommands)`]. Both existing byte-pins pass unchanged (no third
    arg ⇒ identical bytes) [V ipc-prompt.js:94-183 pin comments]; reboot is the shipped precedent
    for granted-only lines.
  - **P4 — near-miss list regenerated.** The "Valid intents: …" bounce string [V :2777-2780]
    becomes a registry join (core order, then plugin verbs). The pinned test is the oracle and is
    updated to compute its expectation from the registry [F test/session-manager.test.js:578].
  - **P5 — namespace.** Plugin verbs must match `AGENT_NAME_RE`-style tokens and may not collide
    with any core verb or `end`/`escape`/`unknown`; collision ⇒ activation error.

### 2.4 Session menu

**Seams [V]:** `session-actions.js` is already the pure type→entries table (whole file; the
CLAUDE_ONLY/SHARED split :~20-36) and `routeSessionAction` is the act→opener router
[V renderer.js:3593-3605].

**API:**

```js
rhost.ui.sessionMenu.addProvider({
  id,
  entriesFor(type),            // -> [{ act, label }]  (act namespaced "<pluginId>:<act>" by host)
  onPick(act, sessionName, anchorEl),
}) -> dispose
```

Core `sessionMenuEntries(type)` composes its own tables plus provider tables;
`routeSessionAction` gains one namespaced-act branch that dispatches to the owning provider.
The table stays a table (correction honored): providers return entry lists, not predicates.

### 2.5 Settings

**Seams [V]:** the monolithic Preferences form `openPrefs`/save renderer.js:5491-5561; the reusable
checkbox builder `renderPrefsCheckboxes` :4313-4328; the `uiSettings` store with `get()`/`set(patch)`
semantics [V usage pattern peer-wiring.js `getUiSettings().get()` / `.set({…})`], one of the
**twelve** stores `initStores` returns [V stores.js:1668-1676 — persistence, templates, workspaces,
promptLibrary, agentDefaults, agentLibrary, skillLibrary, execLibrary, reminders, notifications,
uiSettings, envScopes].

**API:**

```js
rhost.ui.settings.section({
  id, title,
  render(containerEl, values),   // plugin builds its own section DOM
  collect(containerEl),          // -> plain-object patch
}) -> dispose
// engine side:
host.settings.get()              // -> uiSettings.plugins[pluginId] || {}
host.settings.set(patch)         // shallow-merge, persisted under uiSettings.plugins[pluginId]
```

Host appends a `<section data-plugin="id">` to `#prefs-dialog` before `.dialog-actions`
[V index.html prefs structure]; on Save it calls `collect` and persists via
`pluginInvoke('_host','settings.set')`. This is the vision doc's "settings organized by plugin, and
you chose the plugins" made literal: a disabled plugin's section does not exist.

**Choosing and configuring are two surfaces, not one.** Turning a plugin on and off lives in a
top-level **Plugins** menu — a checkbox per plugin plus a `Manage Plugins…` item, with refused
directories listed disabled so a broken plugin is never silently invisible. Configuring lives in the
Preferences dialog, in the per-plugin sections above. They separate cleanly because their state
lives in different places: the enabled set and the quarantine record are **engine**-side, readable
through the host object the main process already holds, so a synchronously-built `Menu` template can
answer "is this on?" with no renderer round trip — whereas a plugin's settings DOM is renderer-side
by construction. The menu is absent rather than empty when there is no host (`CLODEX_PLUGINS=0`) or
nothing on disk: an empty menu reads as a broken feature, a missing one as an absent one. The
checkbox shows the user's **intent** only; quarantine is a third state a checkbox cannot express and
rides in the label instead, because a quarantine must never rewrite what the user asked for.

### 2.6 Whole-surface mounting

**Seams [V]:** the workbench overlay is the exemplar — its DOM currently lives in
`renderer/index.html` (`#workbench-overlay` block, ~140 lines) and its behavior in
`renderer/popovers/workbench-popover.js` (whole file: factory, drag, ESC, one-open semantics); the
file-peek modal is the second instance of the pattern [V index.html `#file-peek-overlay`].

**API:**

```js
rhost.ui.surfaces.overlay({
  id,
  mount(rootEl),        // called once lazily at first open; plugin builds ALL interior DOM here
  onOpen(opts), onClose(),
}) -> { open(opts), close(), dispose() }
```

`mount(rootEl)` is called **once**, lazily, at the first open — and never again. Subsequent opens
reuse the DOM it built and deliver `onOpen(opts)` alone. That is the difference between a
per-open refresh working and silently not: anything a plugin wants recomputed each time the surface
appears belongs in `onOpen`, never in `mount`. (Lazy because a surface nobody opens should cost
nothing; once because the alternative — rebuilding the interior per open — throws away scroll
position, focus and every listener the plugin registered.)

Host responsibilities: create `<div class="plugin-overlay hidden" data-plugin="id">` appended to
`document.body`, toggle `hidden`, centralize Escape handling and one-overlay-at-a-time, and — the
disable guarantee — **remove the container wholesale on plugin disable**, so teardown never trusts
the plugin (MUST-FIX 6). Plugin responsibilities: everything inside `rootEl`, including scoped
`rootEl.querySelector` lookups (ids remain per-window-unique; each BrowserWindow is its own
document, so two windows never collide).

**CSS decision (stated per MUST-FIX 6):** per-plugin `<style data-plugin-style="<id>">` element,
injected by the renderer host from the plugin's `style.css` at activate, removed at disable. Chosen
over a `<link>` because it works identically in the Electron file:// window and the built web bundle
(no path resolution across `web-dist/`), and removal is one node. Build integration for the web
bundle: GAP G7.

---

## 3. The `activate(host)` / `deactivate()` contract

### 3.1 Manifest + lifecycle

```json
{
  "id": "workbench",
  "name": "Workbench",
  "version": "1.0.0",
  "hostApi": "1",
  "entry": { "engine": "engine.js", "renderer": "renderer.js" },
  "style": "style.css",
  "enabledByDefault": true,
  "announce": "Workbench enabled — Files, Source Control and Worktrees for any local session, in the sidebar footer."
}
```

`enabledByDefault` (optional, defaults **true**) decides what happens to a plugin the user has never
made a decision about. It is what lets a plugin ship enabled without writing a settings entry into
every existing install, and it is why "the user turned this off" stays distinguishable from "the
user has never seen this" — a bare boolean in settings would erase that difference. A plugin that
should lie dormant until asked for sets it `false`.

- **Discovery:** Phase 1-3 scans `<repo>/plugins/*/manifest.json` only. Enabled set persists in
  `uiSettings.plugins.enabled` (see §2.5 store). Packaged-app path resolution: GAP G8.
- **Engine lifecycle:** `activate(host)` runs **once per app run** at the end of `createEngine`'s
  electron-free bootstrap (after stores/manager/wiring, before the handle returns — hence before
  any window and before renderer-driven restore [V engine.js:1560-1612; F restore]).
  `deactivate()` is best-effort: host tears down everything registered through it (dispatch-map
  entries, registry rows, hooks) regardless; the honest full-unload is the restart boundary
  (vision doc) — a disabled plugin's `require` cache entry survives, so its module-level state does
  too. That limit is stated in the published contract (`plugin-api.md` §10) rather than surfaced in
  the UI; no banner is rendered.
- **Renderer lifecycle:** `activate(rhost)` runs **once per BrowserWindow**, and **may return a
  teardown function** (`activate(rhost) -> dispose?`). Host-driven disposal still removes everything
  the host created (containers, style element, subscriptions, registry rows), but that cannot reach
  a plugin's own `setInterval`, `document.addEventListener`, `ResizeObserver`, or `window.api.on*`
  subscription — leaving live callbacks firing against a removed container in every window, which is
  exactly the leak the multi-window law (§3.3) exists to prevent. So the renderer half gets BOTH:
  1. an optional returned `dispose()` (or `deactivate()` export), invoked before host teardown; and
  2. `rhost.onDispose(fn)` plus **host-wrapped** `rhost.setInterval` / `rhost.setTimeout` /
     `rhost.addEventListener`, which auto-unregister on disable so the common cases need no
     discipline from the plugin author.
  Window close remains free teardown (the whole renderer dies), but **disable-without-close does
  not** — that is the path this covers. W9 gate #1 asserts zero live timers/listeners after disable.
  [Reviewer MUST-FIX A2.]
- **Enable/disable at runtime:** `pluginSetEnabled` → engine activates/deactivates the engine half →
  emits system topic `plugin-state` scope `all` → each window's plugin host loads or disposes the
  renderer half. The manifest `announce` is the plugin's self-introduction, and it shows as the
  description line beside the plugin in the Manage Plugins dialog rather than as a toast on first
  enable: the text belongs where the user is already deciding, not interrupting them at the moment
  they clicked. Kill switch: `CLODEX_PLUGINS=0` env skips the loader entirely
  (cheap global reversibility during the whole program).
- **Versioning:** `HOST_API_VERSION = "0"` (explicitly unstable) until Phase 3 freezes `"1"`.
  Manifest `hostApi` mismatch ⇒ plugin refuses to load with a named error.

> **Rejected alternative (host contract):** hand plugins the existing broad deps-objects — the
> ~80-key engine handle / `createSessionManager` deps bundle [V engine.js:868-1012] or raw
> `manager`. Rejected because that surface is the *internal wiring* (unversionable, full-power,
> includes `fs`/`pty`/persistence), and handing it to first-party plugins while denying it to
> strangers is exactly the "core with hardcoded friends" the vision doc forbids. The deps-object
> **convention** is kept (it is the codebase's factory idiom [V architecture.md conventions;
> session-manager.js:1-42 charter]); the deps-object **contents** are replaced by a small, named,
> versioned host. Also rejected: an EventEmitter-inheritance host (foreign to the codebase's
> injected-seam style, and event-shaped APIs invite the delta-state pattern §3.3 bans).

### 3.2 The engine `host` object

```js
host = {
  id, hostApiVersion,
  log,                                  // scoped: log.info('plugin:<id>', …) onto the existing log [V main.js log]
  paths: { dataDir },                   // <userDataPath>/plugins/<id>/ (userDataPath is createEngine's param [V engine.js:88])
  storage: { get(), set(obj) },         // whole-file JSON at dataDir/state.json, tmp+rename atomic
                                        //   (pattern: team-manifest.js atomicWrite [V])
  settings: { get(), set(patch) },      // uiSettings.plugins[id]  (§2.5)

  sessions: {
    listAll(),                          // -> [{name,type,cwd,workspaceId}] — GLOBAL (manager.list()) [F :global; V workbench comment "record of truth, local-only" workbench-popover.js:30-38]
    listWorkspace(wsId),                // -> same shape — manager.listForWorkspace [F :2030]  // MUST-FIX 1: two names, no default
    get(name),                          // -> SessionHandle | null   — ANY session in the map, peers included; null means no such session
    fsScope(name),                      // -> { cwd } | { error: 'remote' | … } — verbatim sessionCwd guard [V ipc-handlers.js:295-313]  // MUST-FIX 5 host guarantee
    onCreate(fn),                       // SYNC hook, fired at the tail of create() after registration/notify [V tail region session-manager.js:1565-1570]; fires for restored sessions too iff restore routes through create() — GAP: G3
    onExit(fn),                         // SYNC-ONLY hook — spec below. MUST-FIX 4.
  },

  intents: { register(row) -> dispose },        // §2.3, rules P1-P5 enforced here
  ipc:     { handle(method, fn) -> dispose },   // §3.4 dispatch map; method namespaced by pluginId
  events:  { emit(topic, payload, scope) },     // §3.3; scope is REQUIRED
  lib:     { gitWorktree },                     // sanctioned shared pure leaves, frozen, versioned (§4 W5 rationale)
  telemetry: { snapshot(name) },                // proxyPoller.snapshot passthrough [V wirescope-proxy.js:293] — read-only, may be null
}
```

**`SessionHandle` (opaque, small — lifted from the window-bridge charter's "five handle methods"
discipline [V session-manager.js:28-33]):**

```js
SessionHandle = Object.freeze({
  name, type, cwd, workspaceId,     // identity snapshot at handle mint (cwd/workspace stable for a live session)
  isAlive(),                        // live map membership && !_dead
  inject(text, { parkable=true }),  // -> _injectText; safe no-op on a dead session [F :5471 guard]
})
```

No raw session object, no `pty`, no persistence entry ever crosses. Anything a plugin needs beyond
this is a deliberate future host addition, not a reach-in.

**Where the locality refusal lives — `fsScope` alone.** `get(name)` is a lookup, not a guard: it
hands back a handle for **any** session in the map, peer-backed entries included, and `null` means
only "no such session". A plugin author must not read a non-null handle as "this session is local".
One guard, not two, is the right shape — the check belongs where a filesystem path is about to be
produced, and every filesystem-touching plugin handler's first line is `fsScope` — but it does mean
the peer refusal is *invisible* at the point a handle is obtained. Say it plainly in the published
contract, which is what `plugin-api.md` §4 does.

**Known gap — `fsScope` refuses peers, not foreign workspaces.** Its three refusals are unknown
name, `s.peer` (`'remote'`), and no-cwd; there is no workspace comparison, and **nothing else
supplies one**. `plugin:invoke` discards the Electron event before dispatch [V ipc-handlers.js
`(_e, pluginId, method, args)`], so the caller's window — and therefore its workspace — never
reaches a plugin handler; the engine half could not scope by workspace today even if it wanted to,
because the information is not on the wire. (`rhost.sessions.listWorkspace` filters client-side on
the window's own `workspaceId`, which is a renderer courtesy over a global list, not an engine
guard.) So a plugin handed a session name from any source can resolve a cwd in another workspace.
This is inherited, not introduced: the pre-plugin `sessionCwd` helper was byte-identical, peer check
and all, so the workbench-as-core reached exactly as far. It bounds what it can cost, too — the
engine half is unsandboxed in-process Node, so `fsScope` was only ever a guarantee against a
*careless* plugin widening locality, never a boundary against a hostile one. The defect is in the
guarantee's shape: an author reads "the locality refusal is a host guarantee" and reasonably infers
workspace locality as well.

**Deferred as a v1.1 candidate, alongside the menu slot** — scheduled, not abandoned. Closing it
means carrying a caller workspace on the plugin transport, which is an *additive* change: a new
field older plugins simply do not read, so the bump policy (§3.1 versioning) permits it in `1.1`
without going to `"2"`. It is deferred rather than done because it is inherited rather than a
regression, and because `fsScope` was never a boundary against a hostile plugin in the first place —
so the honest fix is scheduled against a version, not rushed into a surface that was frozen the same
week. Until then the published contract tells an author what to do about it (`plugin-api.md` §14).

**`sessions.onExit` exact spec (MUST-FIX 4):** the host installs a single call site inside
`ptyProc.onExit`, **after** the `session-exit` send and the exit `ipc-message` broadcast, **before**
`this._cleanup(name)` [V ordering session-manager.js:1513-1560; the landmine comment :36-41 and the
"physically before _cleanup" discipline note :1545-1550]. Each subscriber runs in try/catch; the
handle passed is already `_dead` (set first thing in the handler [V :1516]); if a subscriber returns
a thenable the host logs a contract violation and ignores it — the hook is synchronous by
definition, so the landmine ordering cannot be re-broken by a plugin. Note: for a naturally-exited
bash session, persistence removal has already happened by hook time [V :1555-1558]; documented,
not hidden.

**What the host deliberately does NOT expose:** the twelve stores [V stores.js:1668-1676], `fs`
beyond `storage`, `manager` itself, `getRemoteServer`/`getPeerManager`, spawn/argv mutation, or the
IPC transport seams. Every one of those is a named future decision (§5), not a default.

### 3.3 The multi-window law (the blind spot, made structural)

Written into the contract as normative text and enforced by the shapes:

1. **N windows ⇒ N renderer activations.** `rhost` carries `workspaceId`; per-window state lives in
   the activation closure and dies with the window. "Disable" fans out automatically because the
   fan-out is the host's (`plugin-state` broadcast → each window's host disposes locally).
2. **Events are unbuffered invalidation hints; state is pulled.** `host.events.emit(topic, payload,
   scope)` with **required** scope:
   - `{ session: name }` → routes via `_sendToSession`; if the owning workspace has no open window
     the event is **dropped** — only `pty-data` buffers, ever [V session-manager.js:777-797].
   - `{ workspace: id }` → `windowForWorkspace(id)` send [V :746-750]; dropped if closed.
   - `'all'` → `_broadcast` [V :800-806]; permitted **only** for invalidation/state-change hints,
     because broadcast reaches every workspace (the leak finding) — the contract bans data payloads
     on `'all'`.
   Therefore a plugin **cannot** correctly maintain renderer state by delta, and the contract says
   so: *"on window open / surface open / reattach, pull via `invoke`"* — the codebase's own
   convention [F pull-on-open, session-manager.js:2185].
3. **Sessions outlive windows.** Durable per-session plugin state lives engine-side
   (`host.storage`, keyed however the plugin likes); renderer caches are disposable. Restore is
   renderer-driven per window [F renderer.js:5877; ipc-handlers.js:1911 → workspaceOfSender], so a
   renderer half must assume sessions may already exist before its first activation — another
   reason pull-on-open is mandatory, not advisory.

### 3.4 Transport & disposability (the no-removeHandler problem)

`ipcMain.handle` throws on re-registration and the injected transport has no `removeHandler`
[F; V main.js:563-588 shows the transport seam: bare `handle`/`on` wrappers]. Therefore:

- Exactly one channel, `plugin:invoke`, is registered **once** in `ipc-handlers.js` and forwards to
  `engine.pluginHost.dispatch(pluginId, method, args)` — an engine-owned **mutable Map**. Enable,
  disable, and `dispose()` mutate the Map; no Electron-level unregistration ever happens, so
  disposables are implementable at every level of the API. Unknown `(pluginId, method)` ⇒
  `{ ok:false, error:'no such plugin method' }` (a disabled plugin degrades loudly, not silently).
  A plugin's OWN failures come back in the same `{ ok:false, error }` envelope — the host does not
  wrap a handler's return value, so a routing refusal and a handler's considered error are the same
  shape on the wire. `'no such plugin method'` is therefore the exact discriminator, and a caller
  that needs to tell "you are disabled / I typo'd the method" from "your handler said no" must
  compare against that string. Naming it here makes it contract rather than an implementation
  detail a caller reverse-engineered.
- The engine `host.ipc` is **transport-agnostic**: the dispatch map lives in the engine; the
  desktop adapter and the web host each wire their transport to it via `registerIpcHandlers`
  [V main.js:563-588; architecture.md — web-host drives the SAME handler map]. Under pure headless
  (no web port) nothing calls it — inert by construction, matching the finding that
  headless-main loads no ipc-handlers.
- `rhost.invoke(method, ...args)` wraps `window.api.pluginInvoke(id, method, args)`; plugins never
  touch `window.api` directly (no-backdoor lint, §7).

---

## 4. The workbench pilot — first real plugin

Why workbench (vision doc): in-repo, in-process, already factory-shaped
[V workbench-popover.js `initWorkbenchPopover({ getActiveSession, showToast })`], no backend
process, and its data path exercises the host-guarantee question (MUST-FIX 5) without touching the
peer wire. Current coupling inventory, all [V]:

| Coupling | Where today |
|---|---|
| DOM | `renderer/index.html` `#workbench-overlay` block + `#btn-workbench` footer button |
| CSS | ~23 `wb-*`/`workbench-*` rules in `renderer/styles.css` [F count] — GAP: G6 (file unseen) |
| Wiring | require + init + button + `onRequestOpenWorkbench` [V renderer.js:31-50, 3712-3721] |
| Data | `window.api` rows `scm*` (9), `fsList/fsRead/fsWrite`, `worktreeList/worktreeRemove`, plus core rows it shares (`listSessions`, `fileOpen`, `createWorktree`) [V workbench-popover.js; api-contract.js] |
| Backend | `ipc-handlers.js` fs:/scm:/worktree: handlers with the `sessionCwd` peer refusal [V :295-320], delegating to `git-scm.js` (file unseen — GAP: G4) |
| Menu | View ▸ Workbench → `request-open-workbench` (emit site in app-menus.js — GAP: G5) |

**Steps (each lands green and revertable):**

- **W1 — Scaffold** `plugins/workbench/{manifest.json, engine.js, renderer.js, style.css}` against
  the Phase-1 host (`hostApi: "0"`).
- **W2 — DOM moves (MUST-FIX 6).** Cut the `#workbench-overlay` block out of `index.html` into a
  template literal built inside `surfaces.overlay({ mount(rootEl) })`; port the popover body
  verbatim except: `$(id)` → `rootEl.querySelector('#'+id)`; drag/ESC/one-open move to the host
  surface (drag stays plugin-internal — it manipulates only its own modal [V workbench-popover.js
  drag block]). Behavior parity checklist: session dropdown repopulated per open following the
  ACTIVE session [V :populateSessions comment], unsaved-edit confirm on tab/session switch
  [V confirmDiscardEdit], shared editor/diff area semantics.
- **W3 — CSS moves.** Extract the wb-* rules into `plugins/workbench/style.css`; host injects the
  per-plugin `<style>` (§2.6 decision). GAP: G6 for the exact rule set.
- **W4 — Entry points.** Delete `#btn-workbench` from index.html and its wiring
  [V renderer.js:3714-3718]; plugin registers `sidebar.footerButton`. Delete the View-menu item and
  the `onRequestOpenWorkbench` row (GAP: G5 for the emit site; grep before removing the row).
  Product note: the pilot's entry is the footer button; an app-menu extension point is deliberately
  **not** invented for one consumer — recorded as a v1.1 candidate only if a second plugin needs it.
- **W5 — Data path moves (MUST-FIX 5).** `plugins/workbench/engine.js` registers
  `h.ipc.handle('fs.list' | 'fs.read' | 'fs.write' | 'scm.status' | 'scm.diff' | 'scm.stage' |
  'scm.unstage' | 'scm.discard' | 'scm.commit' | 'scm.branches' | 'scm.checkout' | 'scm.remote' |
  'wt.list' | 'wt.remove')`. Every handler's first line is `host.sessions.fsScope(name)` — the
  refusal (including the exact `'remote'` error string the renderer already renders as the remote
  notice [V workbench-popover.js renderExplorer/renderScm/renderWorktrees]) is **host-side**, so a
  buggy plugin cannot widen locality. `git-scm.js` moves into the plugin directory (GAP: G4 —
  grep for other consumers first). Worktree ops keep using core's `git-worktree.js` — it stays
  core because the New-Session worktree row and the delete flow's `removeWorktree` depend on it
  [V architecture.md git-worktree entry; api-contract comment on createWorktree/worktreeInfo] —
  exposed to the plugin as `host.lib.gitWorktree` (a frozen, named, versioned shared-leaf surface;
  the rejected alternative was a private copy, which drifts, or a raw `require('../../git-worktree')`,
  which the no-backdoor lint exists to kill). Rows that STAY core because non-workbench consumers
  exist: `listSessions` (dropdown; wrapped as **`rhost.sessions.listWorkspace(rhost.workspaceId)`**),
  `fileOpen` (worktree "Open",
  also used by files-popover) wrapped as `rhost.ui.openPath(p)`, `createWorktree`/`worktreeInfo`
  (New-Session dialog). `renderDiffHtml` [V workbench-popover.js:1 require] is exposed as
  `rhost.lib.renderDiffHtml` (same sanctioned-leaf reasoning).

  > **CORRECTION [Reviewer MUST-FIX A1] — this plan originally mapped the dropdown to
  > `listAll()`, which was WRONG.** It trusted workbench's header comment ("`manager.list()` is the
  > record of truth and local-only by construction", `workbench-popover.js:39-41`) over the actual
  > handler: `ipc-handlers.js:377` is
  > `handle('session:list', (e) => manager.listForWorkspace(workspaceOfSender(e)))` — i.e.
  > **workspace-scoped, not global**. The header comment is about *locality* (no peers), not about
  > *workspace scope*. Mapping to `listAll()` reintroduces MUST-FIX 1's exact conflation at the one
  > site that actually migrates, and silently converts a per-window dropdown into a cross-workspace
  > file **read/write** surface — `fsScope` refuses peers, not foreign workspaces.
  > **W9 gate:** two windows, two workspaces, assert each dropdown lists only its own workspace's
  > sessions.
- **W6 — Contract shrink.** Delete the 14 moved rows from `api-contract.js` and their
  `ipc-handlers.js` registrations. Pre-delete grep for stray consumers (GAP: G4). The peer wire is
  untouched: `popoverApi`'s peer branch keeps its fixed read-only kind set
  [V renderer.js:3637-3660] and the remote `query` whitelist never learns an fs/scm kind
  [V remote-wiring.js query switch].
- **W7 — Enable-by-default.** Workbench ships enabled in the default persona so existing users see
  no change; the disable path is now real (settings section lists it; disable removes button,
  overlay, styles, dispatch entries in every window).
- **W8 — Web parity.** Regenerate `web-dist` (the duplicated HTML block dies with index.html; the
  bundle must include the plugin renderer module + CSS via a build-generated
  `web-plugin-registry.js` id→module map, since the browser can't `require()` arbitrary paths).
  GAP: G7 — `build/build-web.js` unseen; this step's mechanism is [I] until then. Rebuild the
  Docker web image [V architecture.md docker/web note].
- **W9 — Acceptance gates.**
  1. Two windows open: overlay opens independently per window; disable removes it from both.
  2. Peer/remote session in the dropdown scope: refused with the same UX as today (host `fsScope`).
  3. `rg -i workbench` over core (excluding `plugins/`, docs, regenerated web-dist) → **zero** —
     the vision doc's "core never learns the word" test, made a CI grep.
  4. Leak-scanner + electron-boundary suites extended and green (§7).
  5. Kill switch: `CLODEX_PLUGINS=0` yields a working app with no workbench anywhere (proves the
     app no longer depends on the pilot).

**What the pilot teaches (why taxonomy publication waits):** the exact shapes of `surfaces.overlay`,
`footerButton`, `fsScope`, `host.lib`, and the invoke error envelope are all provisional until W9
passes. Expected friction to watch for: overlay drag/resize ownership, the shared-leaf (`host.lib`)
line, and whether `fsScope` wants to return richer scope info (repo root) — resolve, then freeze.

---

## 5. First-party migration evidence — is the API sufficient?

Method: take the corpus's real coupling points for exec / wirescope / peering and map each onto the
API. Where the mapping fails, that failure is a **named v1.1+ extension point**, not a silent gap.
This section is evidence, not commitment — the vision doc's warning stands: wirescope is a
*migration*, peering is *hard*; neither is a pilot.

### 5.0 The recurring core internals the API formalizes

| Internal (verified use sites) | Host formalization |
|---|---|
| `manager.sessions` walks — ProxyPoller `_activeBases` [V wirescope-proxy.js:295-303], remote `getSessions` [V remote-wiring.js:93-152], who-listing [V session-manager.js:2966-2975] | `host.sessions.listAll()` / `listWorkspace()` (+ handle `get`) |
| `_broadcast` — peer emit closure [V peer-wiring.js emit], poller pushes, ipc-log lines | `host.events.emit(topic, payload, 'all')` (hints only) |
| `_sendToSession` — per-session telemetry push [V wirescope-proxy.js `session-proxy` send ~:410], control chip [V remote-wiring.js onControlChange] | `emit(topic, payload, { session })` — inherits documented drop semantics |
| `_injectText` — exec replies [V :3406-3410], dm bounces [V :2800-2814, :2867-2905] | `SessionHandle.inject()` |
| `proxyPoller.snapshot` — who labels [V :2966-2971], dm hold gate [V resend verdict :2930-2940], remote stats [V remote-wiring.js:110-118] | `host.telemetry.snapshot(name)` (read-only) |
| `getPeerManager()/getRemoteServer()` singletons — who splice [V :2988-2997], federated route [V :4997-5030], reachability [V :5190-5210], telemetry mirror [V wirescope-proxy.js `pushTelemetry`] | **Not** exposed. These become *inversion* points: core consumes what a plugin **provides** (§5.3) |

### 5.1 exec — the archetype, stays core

`[agent:exec]` is already the full plugin-tier loop realized once: capability grant per seat →
registry read-at-invocation → schema-validated data payload (never argv) → out-of-process child →
tail injected back [V session-manager.js:3406-3520; exec-schema.js whole; vision doc names it the
generalizable loop]. Verdict: **exec is the mechanism Tier B generalizes, so it stays core** as
protocol infrastructure; migrating it out would be moving the socket to plug the socket into.
What Tier B lifts from it verbatim: raw-body size cap before parse, `filename` token guard,
data-on-stdin/argv-from-registry, `replyStderr` opt-in discipline [V exec-schema.js;
:3406-3520].

### 5.2 wirescope — Tier A engine plugin, feasible with three named additions

Mapping the corpus couplings:

| Coupling | API today | Gap |
|---|---|---|
| Supervisor: venv/spawn/adopt/pidfile/restart of the Python proxy [V wirescope-supervisor.js:290-491] | Plugin engine half owns child processes (Tier A trusted; node builtins allowed) + `host.paths.dataDir` for pidfile/logs | none — this is exactly "plugin brings its own bridge to its own backend" |
| Poller: session walk + per-session push + peer mirror [V wirescope-proxy.js:293-452] | `sessions.listAll` + `telemetry` inversion + `emit({session})` | **A**: today the poller pushes `session-proxy`, which core's bar treats as *primary* telemetry [V renderer.js:3009-3070]. A plugin can add segments (§2.1) but cannot *be* the bar's primary feed. Named v1.1 point: `host.telemetry.publish(name, payload)` — core owns the bar, wirescope-js feeds it |
| Spawn-time wiring: proxyBase/proxyAgent baked into env + hooks + wire registration [V session-manager.js:847-1006] | none | **B**: a spawn-enrichment hook (`host.spawn.enrich`) that can contribute env/settings at create time. Deliberately NOT in v1 — argv/env mutation is the most dangerous seam in the app; design it against wirescope's real needs only |
| Persisted per-session intent: stripLevel/autoCompact read fresh each tick [V wirescope-proxy.js stripLevelOf/autoCompact reads] | `host.storage` keyed by session | **C**: per-session plugin fields need a deletion story when a session is forgotten — pairs with a future `sessions.onForget` hook (GAP: G3 for the removal sites) |
| Windows/prefs UI: prefs Traffic section + wirescope window [V renderer.js:5491-5561; main.js openWirescopeWindow] | settings section §2.5 covers prefs; the dedicated hardened BrowserWindow [V main.js openWirescopeWindow webPreferences] stays a **host service** (`rhost.ui.openExternalSurface(url)`) — a plugin must never mint its own BrowserWindow |

Verdict: **feasible after A/B/C**, which is precisely why wirescope is Phase-4 evidence work, not
the pilot — its migration is the forcing function that designs those three points against reality.

### 5.3 peering — partial by design; the remote server stays core-adjacent indefinitely

Honest inventory [V]: `createRemoteWiring` takes ~30 callbacks reaching the deepest core internals —
`manager.create()`'s **19-param positional signature** [V session-manager.js:806-810 create
signature; F], `_gatedDeliver`, `_deliverMessage`, kill/restart/args/skills, attach scrollback,
query fan-out [V remote-wiring.js:93-501]. That surface does not shrink onto a small host API
without redesigning it, and pretending otherwise is the dishonesty the findings flagged. Plan:
**the inbound remote server + its wiring stay core-adjacent indefinitely** (they are also the
security boundary: token gate, `withoutLocalOnly`, privileged-intent strip [V remote-wiring.js
:186-501]).

What CAN migrate, as inversion extension points (v1.1 candidates, proven-by-need):

- **DM route provider:** core's dm case branches on `target.includes('@')` →
  `_routeFederatedDm` [V session-manager.js:2857-2862, 4997-5030]. Becomes
  `host.messaging.registerRoute({ match(target), deliver(from, target, body, urgent, verdictCb) })`;
  local dm stays core (the vision doc's line: the moment a message can leave the machine you've
  left core). The park/urgent verdict vocabulary is already shaped for this
  [V :2820-2860 park/held handling].
- **Roster provider:** `[agent:who]`'s remote splice [V :2988-2997] and hub-relay entries
  [V :3000-3015] become `host.messaging.registerRosterProvider(() => [{name, label}])`.
- **Reachability provider:** `_isDmReachable`'s peer branch [V :5084-5210] same shape.
- Outbound `PeerManager`/`TunnelManager` construction and reconcile [V peer-wiring.js whole] can
  live in the plugin's engine half (it already talks to core only through `emit` + two manager
  methods — the emit closure [V peer-wiring.js syncPeerManager emit] maps onto the route/roster
  providers plus `events.emit`).

Verdict: **peering becomes a plugin only for its consumer/outbound half**, later, after the
messaging inversion points exist; the box/server half is core. This partial outcome is the accepted
one (findings: "a partial migration is a legitimate outcome").

---

## 6. Phasing — reversible, workbench-first, taxonomy published last

Global reversibility: everything behind `CLODEX_PLUGINS` (default on from Phase 2; `=0` restores a
plugin-free app) and, in Phase 1, registries that only core populates (pure refactor).

**Phase 0 — guardrails (S, ~2-3 days).**
`HOST_API_VERSION=0`; `plugins/` dir; the five api-contract rows (§1); test scaffolds: extend the
electron-boundary pin so plugin engine halves never import electron [V architecture.md
test/electron-boundary.test.js convention], add the **no-backdoor lint** (plugins may require only
their own files + node builtins; core internals reachable solely via the host argument — modelled
on the leak/boundary scanners [V architecture.md leak-gates]), and add new modules to
`SCANNED_MODULES` per convention [V architecture.md]. Exit: CI green, zero behavior change.

**Phase 1 — registries inside core (M, ~1-2 weeks). Core populates them; no plugin exists yet.**
- 1a. `plugin-host-engine.js`: dispatch map, `events`, `sessions` facade (`listAll`/`listWorkspace`/
  `get`/`fsScope`), `onCreate`/`onExit` hook points injected into session-manager as deps
  (per the factory convention [V session-manager.js:1-42]), `storage`/`settings`. Wired at the
  createEngine tail [V engine.js:1560-1612].
- 1b. `renderer/plugin-host.js` island + the six UI registries (§2.1-2.6), initialized in the
  island block [V renderer.js:3580-3760] with `{ sessions, getActiveSession, showToast,
  scheduleSidebarRelayout, … }`. Includes the one-line bar-visibility edit (§2.1).
- 1c. Intent registry R-INT-1…4 + rules P1-P5; differential byte tests (parse table vs legacy;
  both `buildIpcPrompt` pins; regenerated near-miss string vs pinned oracle [F :578]).
- 1d. In-tests-only fake plugin exercising every point (including a fake privileged verb across
  jsonl + bash feeds; wire feed pending GAP G1).
Exit: all suites green; `CLODEX_PLUGINS=0` is byte-equivalent behavior. Reversal: delete host files;
registries were additive.

**Phase 2 — workbench pilot (M, ~1-2 weeks).** §4 W1-W9. Exit: the five W9 gates. Reversal:
re-add the index.html block + rows from git history; plugin dir deleted.

**Phase 3 — freeze + publish (S-M, ~1 week).**
- Resolve pilot-driven shape changes, bump `hostApi` to `"1"`, write `docs/plugin-api.md` as the
  published, versioned contract (the vision doc's one-way door — signed only NOW, after the seam
  proved what it wants to be).
- Contract-shape test pinning the host surface (an api-contract-style table for the host itself).
- **Acceptance:** build `git-branches` OUT of tree against only the published docs: engine half runs
  `git -C cwd rev-parse --abbrev-ref HEAD` per session (execFile, own cache, `onCreate`/`onExit` +
  a refresh interval), renderer half = `sidebar.rowBadge` + `requestRelayout`. Gate: **zero core
  edits**, works in two windows, survives disable. This is the funnel-thesis proof (the suggestion
  box → "here's the sidebar seam").

**Phase 4 — first-party evidence wave (L, background).**
- 4a. Second trivial in-repo plugin from an existing self-contained island (pot-drawer or
  inbox-drawer [V architecture.md: "self-contained, no core deps"]) to validate a drawer-type
  surface cheaply.
- 4b. wirescope-js design doc + the three named additions (§5.2 A/B/C) as `hostApi 1.1` proposals;
  migrate only when they're designed against its real needs.
- 4c. Messaging inversion points (§5.3) + peering's outbound half; remote server stays core.
  Each 1.x addition is additive-only (SemVer discipline on the taxonomy).

**Phase 5 — Tier B + BYO + personas (L, later).**
Out-of-process host speaking the declarative subset over stdio/socket (the exec loop generalized
[V :3406-3520]); `~/.clodex/plugins/` scan; personas = named enabled-set + settings bundles
(vision doc modpacks) — cheap once §2.5/§3.1 exist, since a persona is literally a
`uiSettings.plugins` preset.

---

## 7. Testing & guardrails (standing)

- **No-backdoor lint** (Phase 0): scans `plugins/**` requires; whitelist = own dir + node builtins.
  Modelled on the electron-boundary/leak scanners [V architecture.md].
- **Electron gap extended:** plugin engine halves join the never-import-electron pin.
- **Byte pins preserved:** both `buildIpcPrompt` pins [V ipc-prompt.js], generated hook scripts
  untouched [V architecture.md cli-hooks pin], parse-table differential (Phase 1c).
- **Near-miss oracle:** pinned test recomputed from the registry [F :578].
- **Grep gates:** `workbench` absent from core (Phase 2); later, `wirescope`/peer words only in
  their plugin dirs as those migrate (the vision doc's "core never learns the word" invariant,
  mechanized).
- **Multi-window CI scenario:** two workspaces, enable → both get UI; disable → both lose it;
  close/reopen a window → plugin surfaces rebuild via pull (asserts the §3.3 law).
- **onExit contract test:** subscriber sees `_dead` handle, `inject` no-ops, throw is swallowed,
  thenable logs a violation, ordering vs `_cleanup` asserted.

---

## 8. Consolidated GAP register (need-to-see before the flagged step)

| ID | Need | Blocks |
|----|------|--------|
| G1 | session-manager.js ~:400-560 — the wire intent feed [F :474, :524]: confirm it funnels through `_extractIntents`/`_handleIntent` (registry then covers it for free) | Phase 1c claim "all three feeds by construction" for the wire path |
| G2 | session-manager.js :2168-2179 — bash PTY scan body (calls `parseIntent` directly per findings): confirm registry rows are consulted and that no-body-capture semantics hold for plugin verbs there | Phase 1c |
| G3 | session-restore.js + the persistence-removal ("forget") sites: does restore route through `create()` (→ `onCreate` fires for restored sessions)? where to hang a future `sessions.onForget` for per-session plugin-state cleanup | §3.2 onCreate note; §5.2 gap C |
| G4 | git-scm.js (whole), the fs:list/read/write + worktree:list/remove handler bodies in ipc-handlers.js, and a repo grep for non-workbench consumers of the 14 rows slated for deletion | Pilot W5/W6 |
| G5 | app-menus.js — View-menu "Workbench…" emit site (`request-open-workbench`) and the session context-menu builder | Pilot W4; sidebar row-menu deferral note §2.2 |
| G6 | renderer/styles.css — the exact ~23 wb-* rules [F] to extract | Pilot W3 |
| G7 | build/build-web.js + web-dist packaging — mechanism to bundle enabled in-repo plugin renderer modules + CSS (`web-plugin-registry.js` proposal is [I]) | Pilot W8; browser-frontend parity generally |
| G8 | Packaged-.app resource layout (initStores' `resourcesDir` [V stores.js:373] and how repo-relative `plugins/` resolves when packaged) | Phase 2 W7 ship; Phase 5 BYO path |
| G9 | manager.list() / listForWorkspace bodies [F :2030] — to freeze the exact `listAll/listWorkspace` row shapes (fields beyond name/type/cwd/workspaceId) | §3.2 sessions facade finalization |
| G10 | Whether `s.peer` entries genuinely occur in `manager.sessions` (the sessionCwd guard implies yes [V ipc-handlers.js:308], the workbench comment implies no [V workbench-popover.js:36-38]) — `fsScope` copies the guard verbatim either way, so this is a documentation question, not a safety one | §3.2 `sessions.get` null-for-peer rule wording |
| G11 | test/session-manager.test.js:578 exact assertion text [F] — to update the pinned near-miss oracle correctly | Phase 1c P4 |

---

## Appendix — skeletons

**plugins/workbench/engine.js**
```js
'use strict';
const gitScm = require('./git-scm');            // moved in W5 (GAP G4)
module.exports.activate = (host) => {
  const scoped = (fn) => (name, ...a) => {
    const r = host.sessions.fsScope(name);      // MUST-FIX 5: host-side guarantee [ipc-handlers.js:295-313]
    if (r.error) return { ok: false, error: r.error };
    return fn(r.cwd, ...a);
  };
  host.ipc.handle('scm.status',   scoped((cwd) => gitScm.status(cwd)));
  host.ipc.handle('scm.diff',     scoped((cwd, p, o) => gitScm.diff(cwd, p, o)));
  // …stage/unstage/discard/commit/branches/checkout/remote, fs.list/read/write…
  host.ipc.handle('wt.list',      scoped((cwd) => host.lib.gitWorktree.list(cwd)));
  host.ipc.handle('wt.remove',    (path) => host.lib.gitWorktree.remove(path));
};
module.exports.deactivate = () => { /* host tears down the dispatch entries regardless */ };
```

**plugins/workbench/renderer.js**
```js
'use strict';
module.exports.activate = (h) => {
  const surface = h.ui.surfaces.overlay({
    id: 'main',
    mount(root) { root.innerHTML = WORKBENCH_HTML; wire(root, h); },   // W2: plugin owns ALL interior DOM
  });
  h.ui.sidebar.footerButton({
    id: 'open', glyph: '◫', label: 'Workbench',
    tip: 'Workbench files, source control, and worktrees for a session',
    onClick: () => surface.open(),
  });
};
// data calls inside wire(): h.invoke('scm.status', name), h.sessions.listAll(),
// h.ui.openPath(p), h.lib.renderDiffHtml(diff) — never window.api (no-backdoor lint).
```

**Hypothetical plugin intent registration (shape only; exercised by the Phase-1 fake plugin)**
```js
host.intents.register({
  verb: 'branch',
  parse: (line) => { const m = line.match(/^\[agent:branch\]\s*(.*)/s); return m ? { type:'branch', body:m[1] } : null; },
  bodyMode: () => 'none',                    // MUST-FIX 7: predicate, per parsed intent
  label: 'Report git branch (branch) — plugin: git-branches, off by default',
  promptLines: '  [agent:branch]                   Report your repo’s current branch to the operator.',
  handler: (seat /* SessionHandle */, intent) => { seat.inject(`[agent:branch] ${lookup(seat.cwd)}`, { parkable: true }); },
});
// privileged is FORCED true (rule P1): absent allowlist ⇒ disabled; stripped at wire/spawn via
// withoutPrivilegedIntents [intent-catalog.js]; prompt line renders only for granted seats (P3).
```
