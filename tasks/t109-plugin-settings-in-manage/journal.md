# t109 — plugin settings belong on Manage Plugins, not in Preferences

## The complaint

> "i can see git branches modifying the preferences page, but that one is truly
> too busy. maybe on the plugins page, where we manage plugins, each plugin could
> have its own settings button, so that i do not track the git branches settings
> somewhere else entirely"

Today a plugin's settings live in the global Preferences dialog, which already
carries the app's own settings and gains one more section per plugin installed.
Manage Plugins — the place you go when you are thinking about a plugin — offers
only a checkbox. Settings should live where the plugin lives.

## Decision: MOVE, do not duplicate

Preferences stops rendering plugin sections entirely. Two homes for one fact is
the shape that survives review because both copies look intentional; the point of
the change is that there is ONE place to look.

## What does NOT change (this is not a hostApi break)

`rhost.ui.settings.section(spec)` keeps its name, its spec shape
(`id`/`title`/`render`/`collect`), and its semantics: `render(bodyEl, values)` on
open, `collect(bodyEl)` on save, shallow-merged. A plugin's source does not change
at all. WHERE the host mounts the section is host policy, not surface.

`hostApi` stays `"1"`. Do not touch `HOST_API_VERSION`.

## Why this is cheap

`settingsSections` (renderer/plugin-host.js:31) is per-window state, populated only
for plugins whose renderer half is activated in THIS window. The Manage Plugins
overlay is per-window too (`#plugins-overlay`, plain in-page DOM). So "does this
plugin have settings?" is answerable locally via `settingsSectionOwners()`
(plugin-host.js:325) — no new IPC channel, no new field on `plugins.status`, and
no `_host` method (which would force test/plugin-surface-contract.test.js:109).

A disabled plugin's sections are purged on dispose (plugin-host.js:547), so the
button correctly disappears for disabled plugins with no extra condition. Derive
it; do not add a parallel enabled-check.

## The map (verified, from an exploration pass)

- Dialog markup: renderer/index.html:961-977 (`#plugins-overlay`, `#plugins-list`)
- Row builder: renderer/renderer.js:4161-4308 `renderPluginsDialog()`; normal rows
  at :4176-4248. The ONLY existing per-row button is Retry (:4232-4246), and
  `.plugin-row button { align-self: center; }` (styles.css:2100) already exists.
- Section registry + rhost surface: renderer/plugin-host.js:31, :444-446, :106-124
- Prefs render loop (to be removed): plugin-host.js:296-323 `renderSettingsSections`,
  collect at :329-343, owners at :325-327
- Prefs wiring (to be removed): renderer.js:4832-4841 `renderPluginPrefs()`, called
  from `openPrefs()` :4824; save loop at :4868-4870
- Settings read/write path: `window.api.pluginInvoke('_host','settings.get',[id])`
  and `'settings.set',[id,patch]` → ipc-handlers.js:728 → plugin-host-engine.js:313-320
- git-branches declares its section at plugins/git-branches/renderer.js:301-345

## Shape to build

1. **plugin-host.js** — replace the two prefs-targeted functions with
   container-taking ones:
   - `renderSectionsInto(pluginId, containerEl, values)` — render that plugin's
     sections (a plugin may register more than one; render all).
   - `collectSectionsFrom(pluginId, containerEl)` — merged patch for that plugin,
     or null when every section returns null.
   Keep `settingsSectionOwners()`.
2. **renderer.js** — in `renderPluginsDialog()`, give each row a `Settings` button
   when `settingsSectionOwners()` includes its id. Clicking toggles an INLINE panel
   under the row (not a second overlay — `#prefs-overlay` and `#plugins-overlay` are
   siblings in one document with no stacking manager, so opening one over the other
   is a layering bug waiting to happen). Panel gets its own Save, which maps 1:1
   onto `collect()`. On save: `settings.set`, then collapse.
3. **renderer.js** — remove plugin sections from Preferences: the `renderPluginPrefs`
   call and the save loop.
4. **styles.css** — style the inline panel.
5. **plugins/plugin-api.md §6.6** — it currently says "A section inside the app's
   Preferences dialog" and "called each time Preferences opens". Both become false.
   Update to Manage Plugins. This is a published one-way door: change the two
   location sentences, do NOT restructure the section or touch the code sample.
6. **npm run build:web** and commit `web-dist/index.html` — it is a generated but
   COMMITTED artifact inlining index.html + renderer.js + styles.css.

## Tests

- test/plugin-host.test.js:428-457 and :459-471. REPOINT to the new mount and
  function names. Four properties are asserted there; three MUST survive:
  - the plugin receives its own persisted values on render (pull-on-open)
  - `collect` returns the patch, and a re-render CLEARS the body first rather
    than appending (the second `collectSettingsSections()` still yields `n: 1`)
  - `dispose` removes the section and drops the plugin from the owners list
  The fourth — "mounted BEFORE .dialog-actions, so Save/Cancel stay last" — is
  about the Preferences layout and becomes UNSATISFIABLE, not merely obsolete: an
  inline row panel has no `.dialog-actions` sibling. DELETE that assertion; do not
  reword it into something that passes trivially. A check that cannot fail is worse
  than no check, because it reads as coverage.
- The Manage Plugins row DOM is pinned by NOTHING today. Add coverage at the
  plugin-host.js level (pure, jsdom already in use there) for: sections render into
  a supplied container; collect returns a merged patch; a plugin with no sections
  yields no owner entry.
- Not required: a test for renderer.js's dialog wiring, which is not currently
  testable without extracting `renderPluginsDialog`. Report honestly that it is
  unverified rather than extracting it — that is a separate change.

## Gate

Whole suite green at 3075 (plus any test added), ESCAPES 0. A moved section must
not move an unrelated test.

## Journal

(implementer: append findings, deviations and surprises here as you go)
