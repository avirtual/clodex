# Clodex — Visual multi-agent PTY manager

> If `.claude/memory.md` exists (local, untracked), read it first: it is the live thread.

## What it is

Electron app wrapping the Claude Code, Codex and Muse Code CLIs in a sidebar UI
with inter-agent IPC. Repo: https://github.com/avirtual/clodex (public). The
on-disk folder is still `wb-wrap-ui`; package `name` is `clodex`, `productName`
is "Clodex".

## Stack and layout

- Electron; node-pty (native addon — `npx electron-rebuild` after `npm install`)
- xterm.js + `@xterm/addon-fit` + `@xterm/addon-search`
- Vanilla HTML/CSS/JS renderer, no framework
- `contextIsolation: false` + `nodeIntegration: true` so the renderer can
  `require()` xterm modules directly

Layout: flat `*.js` modules at the root (main process) · `preload.js` (assigns
`window.api`) · `renderer/` (index.html, styles.css, renderer.js + `lib/` +
`popovers/` + islands) · `build/` (icons + `afterPack.js`) · `cli/deploy/` (the
packaged infra catalog, indexed in `cli/deploy/README.md`) · electron-builder
config under `"build"` in package.json.

Docs: `docs/architecture.md` is the module map; `docs/map/` holds symbol-level
maps of the giant modules, gated by `test/module-map-fresh.test.js`. Read the
matching subsystem doc before changing a subsystem: `docs/sessions.md`,
`docs/messaging.md`, `docs/peering.md`, `docs/telemetry.md`,
`docs/exec-tools.md`, `docs/renderer-events.md`, `docs/tests.md` — `ls docs/`
for the rest.

## Run / ship

```
npm install && npx electron-rebuild
npm start                  # dev
npm run dist:mac           # arm64 DMG only
```

Release is one command: `scripts/release.sh <patch|minor|major|X.Y.Z> [notes.md]`.
It preflights (clean tree, on master, in sync, gh authed, the Electron smoke test
`scripts/electron-smoke.js`), bumps the version, builds the arm64 DMG, mounts it
and proves the packaged app can spawn a shell through node-pty (the DMG pty
probe, `scripts/dmg-pty-probe.sh`), commits +
tags + pushes, runs `gh release create`, prunes old release assets, and
publishes the container image (`scripts/publish-image.sh`).
Non-interactive; stops at the first error. No CI; `gh` is logged in as
`avirtual`. arm64 only — Intel users build from source.

CHANGELOG contract: the release publishes `CHANGELOG.md`'s `## Unreleased`
section verbatim, then stamps it with the version + date and opens a fresh empty
one — so keep it current as work lands. Text after `## Unreleased —` becomes the
subtitle. Empty or absent, the notes fall back to commit subjects since the last
tag; a markdown file passed as the second arg overrides both. The extraction is
pinned by `test/release-script.test.js`, since the release path itself runs only
at ship time.

Signing: ad-hoc, in `build/afterPack.js` (`codesign -s -`). Not notarized; first
launch needs right-click → Open or `xattr -cr`.

## Architecture

`engine.js` assembles the whole electron-free module graph; its two hosts are
`main.js`, a thin Electron adapter, and `headless-main.js`
(`grep -rn "require('./engine')" *.js` is the list). `web-host.js` and the
sandbox are not hosts. Wiring questions belong in engine.js, not main.js.
Everything else lives in factory modules taking a deps object: whenReady-assigned
values cross as lazy getters, module-written singletons as get+set pairs.
`test/free-identifier-leaks.test.js` gates every extraction in both directions,
so a new extraction must be added to its `SCANNED_MODULES` /
`RENDERER_SCANNED_MODULES` lists. Data that must survive a restart never goes
under `run/<name>/`, which every exit path removes (`clodex-paths.js`'s header
lists the shared dirs). Per-module detail: `docs/architecture.md`.

`docs/sessions.md` has the session lifecycle table, the full record-droppers
list (a new `getPersistence().remove()` call site belongs on it) and the
workspace rules.

## Comments

Every reader here is an agent that can read the code. A comment earns its place
only by naming a wrong change it prevents — an ordering that must hold, a
duplication that must not be merged, a vendor quirk, a measured value, a
security property an obvious refactor drops. If you can't name one, don't write
it. Always cut narration, ticket archaeology, another file's behaviour (point by
symbol, never by line number), references to documents not in this repo,
all-caps emphasis and repeated rationale. Prefer deleting a stale comment to
rewriting it: a rewrite resets its apparent freshness without re-verifying it.

Gate: `test/comment-ratchet.test.js` (tokenizer: `comment-census.js`) fails a
tracked source file outside `test/` that gains comment lines against the
merge-base with master; a new file ships with zero. A fact the code cannot
express goes under its symbol in `docs/notes/<module>.md`, or in a test.

## Tests

`docs/tests.md` has the case behind each rule.

- Where a fixture builds a dependency set, `deepStrictEqual` the whole built object; a partial match reads around an unwired `undefined` dep.
- Where a test reduces before asserting, assert the interesting row survived the reduction (the `ENTER: …` idiom); absences and universals are true of an empty set.
- Where a table drives one assertion across many cases, each row carries its distinguishing value as a literal, never one computed by the code's own rule.
- Grep for the pins on a file before you add behaviour to it; a source-shape pin is invisible from the code you are editing.
- A comment claiming coverage is not coverage: grep for the pin before trusting one, and land a claim in the same commit as its test.

## Gotchas

- Sessions are keyed by name globally — two windows can't share a name. Bash
  sessions are private: no registry/socket, invisible to `[agent:who]`, not
  DM-able.
- Session name regex: `/^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/`. The lookahead rejects
  dot-only names (they traverse when joined into a path) while `.hidden` is
  deliberately accepted (`test/name-dot-only.test.js`); without both anchors it
  is a substring match and every traversal attempt passes. The literal is
  duplicated across ~37 modules — `grep -rn "1,64" --include=*.js` finds them;
  change them together.
- `web-dist/index.html` is tracked and inlines every plugin `renderer.js`:
  editing a renderer half owes `npm run build:web`, or the committed bundle
  serves the old code (`test/web-dist-fresh.test.js`). Its sibling
  `renderer/web/plugin-registry.js` moves only when a half is added or removed
  (`test/plugin-web-parity.test.js`) — taking the map's trigger for the
  bundle's is the mistake.
- Hide xterm containers with `visibility`, never `display:none`, which breaks
  xterm's measurements.
- The pty exit handler (`onProcExit` in session-manager.js) must
  `_sendToSession` before `_cleanup`: cleanup removes the
  session from the map that window resolution depends on, and the wrong order
  leaves a dead sidebar tab.
- Restore failures must not remove from persistence — return the entry with
  `{ failed: true }` for the retry/forget UI. Wiping it is how agents vanished
  after an upgrade.
- Ad-hoc signing must stay in `afterPack`: without it node-pty dies with
  "killed" on Apple Silicon, and electron-builder's `identity: "-"` doesn't
  work reliably.
- `contextIsolation: false` is required for renderer `require()` — fine for a
  local CLI wrapper; revisit if the threat model changes.
- `userDataPath`, and every store path built from it (`PERSIST_FILE` in
  stores.js et al.), exists only once main.js's `app.whenReady()` calls
  `createEngine` (the `userData` path isn't available earlier). The packaged
  `userData` dir is `Clodex`; `npm start` uses lowercase `clodex`.
