# t38 — surface the plugin docs where a plugin author looks

Branch `plugin-docs-surface` off master `0e99e1a` (= tag v4.3.1). Worktree
`/Users/bogdan/projects/tmux/wb-wrap-ui-hand`. Baseline 2722, ESCAPES: 0.

## Phase 1 — read + survey. DONE.

### Measured state, confirmed independently

- `README.md`: `plugin` appears **0 times**. Feature tour has nine `###`
  subsections (local fleet, agents that talk, teams, peering, DM federation,
  clodexctl, headless/web, wirescope) — none is plugins.
- `build.files` (package.json) is an allowlist of 10 globs: `*.js`,
  `scripts/clodex-{team,monitor}.js`, `wire/**/*`, `renderer/**/*`,
  `plugins/**/*`, `cli/**/*`, `resources/**/*`, two tray icons,
  `node_modules/**/*`. **`docs/` is absent** — confirms the ticket.
- `docs/` is 500K total; the two big files are `screenshot.png` (168K) and
  `index.html` (68K). `plugin-api.md` is 72K, `plugin-sources.md` 40K.
- `plugins/README.md` exists (30 lines) and is **stale in its premise**: it says
  the directory is "empty of plugins in Phase 0 and Phase 1" and that "the
  workbench pilot (Phase 2) is the first real inhabitant". Both plugins now
  exist (`git-branches/`, `workbench/`). It is a boundary-rules page written for
  a core contributor, not a launchpad for an outside author. Rewriting it is the
  right move and matches scope item 1.
- `plugins/git-branches/README.md` is good and already reads like a starting
  point. Its "Install" section says "Drop this directory into `<repo>/plugins/`"
  — that is the DEVELOPER path; the packaged-user path is `~/.clodex/plugins/`
  per `docs/plugin-sources.md` §3/§10. Not in scope to rewrite, but the new
  `plugins/README.md` must state the user root, not the repo path, or it repeats
  the same checkout-only assumption.

### The optional item (Manage Plugins docs link) — RECOMMEND DECLINING

Surveyed the available mechanisms; none can honour clodex's own condition
("must open the shipped local copy when present rather than assuming network
access"):

- `window.api.fileOpen` → `shell.openPath`. An external app **cannot read a
  path inside `app.asar`** — the asar is a single archive file, not a directory
  the Finder or a Markdown app can traverse. Works in a checkout, fails in the
  DMG.
- `window.api.openExternal` → network, which is the thing the condition rules
  out as the primary path.
- The in-app peek viewer (`renderer/popovers/files-popover.js:211`,
  `onSessionFileView`) is **session-scoped** — it opens a file in the context of
  a named session. The Plugins dialog has no session, so using it means new
  plumbing, not reuse.

So a "Writing a plugin" button that opens the shipped copy is **only possible if
`docs/` ships as `extraResources` (real files under `Contents/Resources/`)
rather than inside the asar**. Scope item 3 as specified puts it in the asar.
Shipping a button that works in dev and silently does nothing in the DMG is
exactly the "artifact validated only by its authors" trap `docs/plugin-sources.md`
§1 names three instances of. Declining, and flagging the `extraResources`
question to clodex rather than deciding it myself — it is a packaging posture
call, and §2 of that same doc already argues against `extraResources` for
`plugins/` for reasons that do NOT all transfer to docs (docs are not user-
writable state), so it deserves a real decision rather than my inference.

### Finding to flag, not a blocker: item 3 is artifact completeness, not discoverability

Worth stating plainly so the report is not read as more than it is. Shipping
`docs/` inside the asar makes the artifact self-contained and is the
precondition for any future in-app docs viewer, but it does **not** by itself
give a DMG user a path to the docs: nothing in the app links to them and the
files are not browsable from the Finder. The actual discoverability win for a
downloaded-DMG user is items 1 and 2 (README → the GitHub copy). Implementing
item 3 as specified regardless — it is correct on its own terms and the ticket
asks for it — but not claiming it closes the gap.

### Test angle

`test/cli-packaging.test.js` is the model to copy (it pins `cli/**/*` in
`build.files` and, in its header, states explicitly that the config pin is the
gate and the `npx asar list` check is the reasoning, because a test must not
depend on a built DMG). A parallel `docs` pin is cheap and belongs in the same
file or a sibling.

## clodex's ruling (msg-29348-4)

**Option 1: fix `plugin-api.md`.** t38 widened to include it. "The fence on that
file was 'don't rewrite the contract,' not 'don't correct false statements'…  a
frozen contract earns its authority by being *true*, and `plugin-api.md:5` claims
exactly that." Scope tight: the three named passages only; §1 points at
`plugin-sources.md` §3 rather than restating; do not touch the `hostApi` value.
Declining the Manage Plugins link: **accepted**, and explicitly do NOT work
around it by moving `docs/` to `extraResources`. The item-3 scope-honesty note:
wanted in the report. Further contradictions: **collect and report, do not fix.**

## Phase 2 — implemented

- **`package.json`** — `"docs/**/*"` added to `build.files`, after
  `plugins/**/*`.
- **`test/docs-packaging.test.js`** (new, 2 tests) — modelled on
  `cli-packaging.test.js`, including its header discipline: the config pin is the
  gate, the `npx asar list … | grep '^/docs/'` line is the reasoning, and the
  header states what the test does NOT claim (asar-shipped ≠ user-reachable).
  Second test pins that the two doc paths the new prose links actually exist.
- **`docs/plugin-api.md`** — the three passages, and only those:
  - `:66` discovery paragraph → two roots named, `~/.clodex/plugins/` called out
    as "where **your** plugin goes if you are not working in a checkout",
    delegating precedence/shadowing/symlinks/re-scan to `plugin-sources.md`
    §3–§4/§10 as the one authority, and stating that none of it is observable
    from inside `activate()` so none of it is part of the contract.
  - §14 — the two false bullets ("BYO plugins … are not discovered", "a plugin
    added to an installed copy is not") replaced by ONE true bullet: the shipped
    root is inside `app.asar` and cannot be added to, `~/.clodex/plugins/` is the
    place, and the two roots are not interchangeable (shadowing, not merging).
  - No revision marker exists in the file, so nothing to bump. `hostApi` value
    untouched.
- **`plugins/README.md`** — rewritten as the launchpad. Orientation only, no API
  restated: what a plugin is and why the halves split (the engine also runs
  headless with no Electron, which is the real reason), the two roots as a table
  with `~/.clodex/plugins/` marked "**Yours**", copy-`git-branches`-and-gut as
  the start (with the id-must-match-dirname trap named), the `build:web` step and
  its "adding or removing, not every edit" qualifier, what to expect from the
  host (kill switch, quarantine after two failed launches, verbs privileged until
  granted per-seat, no sandbox), and the three repo-only static gates — each
  flagged as unable to see a user root even in principle.
- **`README.md`** — new `### Plugins: extend it yourself` in the Feature tour,
  between wirescope and clodexctl's neighbours. Two bullets, matching the
  surrounding subsections' shape and length.

### Every claim in the new prose, verified against code

| Claim | Verified at |
|---|---|
| two roots, core then user | `engine.js:1802-1806`; `plugin-loader.js:408` iterates |
| user root is `~/.clodex/plugins/` | `engine.js:1804` (`REGISTRY_DIR`) |
| core wins; strictly newer user copy overrides | `plugin-sources.md` §4 (Implemented, §11) |
| Open Plugins Folder creates + reveals | `renderer/index.html:972`, `renderer.js:5538-5547` |
| Re-scan, no restart | `renderer.js:5564`; `plugin-loader.js:543` |
| seven slots, names as listed | `plugin-api.md:687-903` (§6.1–6.7) |
| manifest fields | both shipped `manifest.json` + `plugin-api.md` §2 |
| git-branches has both halves, badge, settings section, verb | `renderer.js:249,301`; `engine.js:354` |
| workbench uses the overlay + footer button | `renderer.js:115,832` |
| build:web on add/remove of a renderer half | `plugin-api.md:50-63` |
| user plugins absent from the web frontend | `plugin-sources.md` §6 |
| quarantine after two failed launches | `renderer/index.html:964` |
| plugin verbs privileged until granted | `git-branches/README.md:41-44` |
| the three gates and their repo-rooted scan | the three test files; `plugin-sources.md` §6 |

## Phase 3 — suite. DONE.

`TOTALS: 2724 pass, 0 fail, 2724 tests` / `ESCAPES: 0` (2722 → 2724, +2). Read
from `npm test` directly.

`npm run build:web` NOT run — no bundled source touched (the diff is
package.json, two markdown files, README, and one new test).

### Revert proof

| revert | test that failed |
|---|---|
| `docs/**/*` removed from `build.files` | "package.json build.files must list docs/\*\*/\* or the shipped DMG contains no documentation at all" |

By message, not by crash. The second test (doc paths exist) is a guard against a
future rename rather than a pin on this change, and is honestly weaker — it would
stay green through any edit that did not move a file.

## Drift COLLECTED, not fixed (per the ruling)

1. **`plugin-api.md:938`, slot ordering** — "the order is discovery order, which
   is directory-name order". Now root-precedence-then-dirname. The normative
   sentence in that section is "**Unspecified. Do not depend on it**", which
   remains true, so this is an inaccurate rationale attached to a correct rule,
   not a false rule. Left alone.
2. **`plugins/git-branches/README.md:13`** — "Drop this directory into
   `<repo>/plugins/` and restart the app." That is the developer path; the
   packaged-user path is `~/.clodex/plugins/`, and "restart" understates it since
   Re-scan now exists. Same stale premise as the old `plugins/README.md`, one
   level down. Outside the three-passage scope.

Nothing else found: `plugin-api.md` has no other single-root claim (grepped
`<repo>/plugins`, "not discovered", "not scanned", "one directory", "single
root" — zero hits after the edits).

## Progress

- [x] Phase 1 — read + survey
- [x] Phase 2 — plugin-api.md fixes + plugins/README.md + README.md section
- [x] Phase 3 — build.files + test + suite green at 2724
- [ ] Phase 4 — artifact verification (real build, asar list), report
