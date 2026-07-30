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

### Implementation pass (t109)

Done. Suite: **3078 pass, 0 fail, ESCAPES 0** (gate said 3075 + additions; net
+3 = four new plugin-host tests minus one merged/removed prefs-shaped test, see
"tests" below).

Signatures settled on in `renderer/plugin-host.js`:

- `renderSectionsInto(pluginId, containerEl, values = {})` → `number` (count of
  that plugin's sections rendered). The count is what lets a test say "both of
  this plugin's sections rendered" and "a plugin with no sections renders zero"
  without reaching into the DOM. `values` is that ONE plugin's values object,
  not the old `valuesByPlugin` map — the caller already knows whose row it is.
- `collectSectionsFrom(pluginId, containerEl)` → merged patch object or `null`.
  Multiple sections shallow-merge in registration order.
- `settingsSectionOwners()` unchanged.

Files changed:

- `renderer/plugin-host.js` — `renderSettingsSections`/`collectSettingsSections`
  replaced by the two container-taking fns; exports updated. No `#prefs-dialog`
  lookup survives anywhere in the host.
- `renderer/renderer.js` — new `makePluginSettingsPanel(p, row)` builds the
  Settings toggle + inline panel; `renderPluginsDialog()` appends the panel
  after the row when `settingsSectionOwners().includes(p.id)`. Removed
  `renderPluginPrefs()`, its `await` in `openPrefs()`, and the prefs Save loop.
- `renderer/styles.css` — `.plugin-settings-panel` / `.hidden` /
  `.plugin-settings-actions` / section `h3`; the `#prefs-dialog
  [data-plugin-section] h3` rule deleted (its selector can never match now).
- `renderer/index.html` — the prefs comment claiming the host appends
  `[data-plugin-section]` there, and the Plugins dialog hint text sentence "A
  plugin's own settings live in Preferences", both retargeted.
- `plugins/plugin-api.md` — the two §6.6 location sentences, plus the §10
  sentence "Your own settings *are* in Preferences" which asserted the same
  now-false fact. Code sample and structure untouched.
- `README.md` — the seven-slot list said "a Preferences section".
- `test/plugin-host.test.js`, `test/plugin-fake.test.js` — repointed (below).
- `web-dist/index.html` — regenerated by `npm run build:web`; verified it
  contains `renderSectionsInto` / `plugin-settings-panel` and zero occurrences
  of `renderSettingsSections`.

`plugins/git-branches/renderer.js` NOT touched, as required. `HOST_API_VERSION`
NOT touched.

Tests:

- The "mounted BEFORE .dialog-actions" assertion was DELETED, not reworded, in
  both files (plugin-host.test.js and the parallel one at
  plugin-fake.test.js:741).
- The three surviving properties are all still asserted: pull-on-open values,
  re-render-clears-the-body (second collect still `{n: 1}`), dispose drops both
  the section node and the owners entry.
- New plugin-host.js coverage: sections render into a supplied container; a
  second container is provably untouched (guards against a document-wide
  lookup); merged patch across two sections; a plugin with no sections is not an
  owner and collects null; all-null collects yield null rather than `{}`.
- `plugin-fake.test.js`'s `installDom()` no longer builds a `#prefs-dialog`; it
  builds a `.plugin-settings-panel` with a `.plugin-settings-actions` child, so
  the "the container's own children survived dispose" assertion keeps its
  meaning against the new host.

### Deviations (flag for adjudication)

1. **Two extra edits the journal did not list**: `renderer/index.html` (prefs
   comment + Plugins dialog hint text) and `README.md`'s slot list. Both stated
   the same now-false location as plugin-api.md §6.6. The hint text is
   user-visible in the very dialog this change is about, so leaving it would
   have shipped a UI that contradicts itself.
2. **plugin-api.md §10 also edited** — one sentence, "Your own settings *are* in
   Preferences, via the `settings.section` slot (§6.6)". The instruction scoped
   me to §6.6; this is outside it, but it is a third statement of the exact fact
   §6.6 was corrected for.
3. **Deleted the `#prefs-dialog [data-plugin-section] h3` CSS rule** rather than
   leaving it. Step 4 said "style the inline panel"; a selector that can no
   longer match is dead.
4. **`renderSectionsInto` returns a count** — the journal specified no return
   value. Additive.

### Not verified

- **The renderer.js dialog wiring is untested**, exactly as the journal
  predicted. `makePluginSettingsPanel` and the `renderPluginsDialog()` call site
  are not covered by any test: the Settings button appearing, the toggle
  collapsing, the `settings.get` on expand, the `settings.set` on save, and the
  collapse-after-save are all UNVERIFIED except by reading. Testing them needs
  `renderPluginsDialog` extracted, which is a separate change.
- **Nothing was exercised in a running app** — no Electron launch, so the panel
  has never been rendered or clicked. Layout (the 26px indent aligning the panel
  under the row body past the checkbox) is by inspection only.

### Assumptions the journal did not settle

- On save failure the panel STAYS OPEN and toasts; only success collapses it.
  (The journal said "on save: settings.set, then collapse".) Collapsing on a
  failed write would hide the form holding the only copy of the user's input.
- A `collect()` returning null skips the `settings.set` IPC entirely rather than
  writing `{}`.
- The panel is a SIBLING of the row in `#plugins-list`, not a child of the row
  — `.plugin-row` is `display: flex`, so a child would land in the flex line
  beside the checkbox.
- Expanding re-pulls `settings.get` every time (no cache), matching the old
  pull-on-open semantics.
- Only normal plugin rows get the button; `problems` and `shadowed` rows do not,
  since neither has an activated renderer half and so neither can be an owner.
