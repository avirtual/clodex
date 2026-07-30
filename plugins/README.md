# Plugins

Clodex is extensible. A plugin adds UI, behaviour, or an `[agent:…]` verb, in
process, without a fork — and it can live entirely outside this repo.

This page is the orientation. The contract is
[`plugin-api.md`](plugin-api.md), frozen at `hostApi "1"`, and it is
the authority on everything a plugin can reach. Nothing here restates it.

## What a plugin is

A directory with a manifest and up to two JavaScript halves:

```
<id>/
  manifest.json    required — { id, name, version, hostApi, entry, style?,
                                enabledByDefault?, announce? }
  engine.js        optional — { activate(host), deactivate?() }   plain Node, no Electron
  renderer.js      optional — { activate(rhost) -> dispose? }     DOM, one per window
  style.css        optional — injected per plugin, per window
```

At least one half is required, and **the directory name is the id**.

The split is the thing to understand first. The **engine half** runs in the
Clodex engine — it can touch the filesystem, the session manager and the network,
and it is the only half that can register an `[agent:…]` verb. The **renderer
half** runs in each window and only draws; it cannot reach the filesystem, so it
asks its engine half to. They talk over `invoke`. The reason for the split is
that the engine also runs headless on a server with no Electron and no DOM at
all, so an engine half that imported `electron` would break a real deployment
(and the test suite fails it before it can).

A plugin contributes UI through seven named slots — status-bar actions and
segments, a sidebar footer button, a session row badge, a session-menu provider,
a Preferences section, and a full-window overlay — described with their specs in
§6 of the contract.

## Where your plugin goes

Discovery scans **two roots**, in this order:

| Root | What it is |
|---|---|
| the app's own `plugins/` | Shipped with Clodex. Inside `app.asar` in a packaged build: read-only, and replaced by every update. |
| `~/.clodex/plugins/` | **Yours.** Nothing but you writes it, and no update touches it. |

**If you are not working in a checkout of this repo, your plugin goes in
`~/.clodex/plugins/<id>/`.** Manage Plugins ▸ **Open Plugins Folder** reveals it
and creates it if it does not exist yet; **Re-scan** in the same dialog picks up
a plugin you just added, with no restart.

Two copies of one id do not merge — the shipped copy wins unless yours declares a
strictly higher `version`, and the loser gets a visible row in Manage Plugins
saying so. That rule, symlinking a plugin out of a working checkout, and the
limits of a re-scan are all in
[`plugin-sources.md`](plugin-sources.md), which is the authority on
where plugins come from.

## Start from a working one

[`tools/`](./tools/README.md) is the short path — three commands, no reading
required first:

```bash
node plugins/tools/build-context.js            # the whole contract as one pack, for an agent
node plugins/tools/scaffold.js my-plugin       # a valid, empty plugin that already passes
node plugins/tools/verify.js plugins/my-plugin # does it run against the real host?
```

`scaffold.js` writes the id and the directory name from one argument because the
app refuses a manifest whose id and directory disagree, and that mismatch is the
single most common way a first plugin fails to appear at all. `verify.js` drives
the real loader and engine, so it answers a question a syntax check cannot: did
`activate()` actually run.

`git-branches/` is the reference plugin to read and to copy from: both halves, a
settings section, a row badge, an intent verb, and a real cache — about as small
as a plugin can be while still exercising most of the API.

```bash
cp -R plugins/git-branches ~/.clodex/plugins/my-plugin
```

Copying by hand means renaming `id` in `manifest.json` to match the new directory
yourself. Its own [README](./git-branches/README.md) explains what each file does,
and `NOTES.md` beside it records what the API did and did not tell its author,
which is worth reading before you hit the same corners.

`workbench/` is the larger example — Files, Source Control and Worktrees in the
sidebar footer — if you want to see the overlay slot carrying real weight.

**A renderer half needs a build step.** Clodex also ships as a browser bundle,
which resolves modules at build time, so renderer halves are baked into a
generated map: after **adding or removing** a `renderer.js` (not after every edit
to one), run `npm run build:web` and commit the regenerated
`renderer/web/plugin-registry.js`. Engine-only plugins need no build step. This
applies to plugins **in this repo**; a plugin in `~/.clodex/plugins/` loads in
the Electron app and does not appear in the browser frontend at all
(`plugin-sources.md` §6).

## What to expect from the host

- **Your plugin can be turned off.** Plugins ▸ Manage Plugins… is one checkbox
  per plugin, and disabling one removes its UI from every open window
  immediately. `CLODEX_PLUGINS=0` skips the plugin system entirely — the app must
  work with none of this loaded.
- **A crash is survivable, and it is counted.** A plugin whose `activate()`
  throws is skipped and the app boots anyway; after two consecutive failed
  launches it is held back until you press Retry.
- **An intent verb is privileged.** A verb your plugin registers does nothing
  until an operator grants it to a seat in that session's intent checklist. This
  is the host's design: nothing fires and nothing is logged until then.
- **There is no sandbox.** An engine half runs with the privileges of the app.
  The host API is a *contract* — it exists so plugins are removable, versionable
  and uncoupled from core internals, not so a hostile plugin is contained. §14 of
  the contract says this plainly and it is worth believing.

## Rules the test suite enforces on plugins in THIS repo

These are static gates over the code this repo ships. They compute their scan
root from the repo, so they cannot see `~/.clodex/plugins/` even in principle —
a plugin of your own gets no static checking at all.

- **No electron.** `test/electron-boundary.test.js` walks every engine half here
  and fails on a `require('electron')`. An engine half is plain Node for the same
  reason the rest of the engine is: the headless host stands the same engine up
  with no Electron present.
- **No backdoors.** `test/plugin-boundary.test.js` walks every file here and
  allows only relative requires that stay INSIDE the plugin's own directory, plus
  node builtins. Core internals (`../../session-manager`, `electron`,
  `window.api`, …) are reachable **only** through the `host` / `rhost` argument.
  That argument is the versioned surface, and reaching around it is exactly the
  "core with hardcoded friends" coupling the plugin system exists to prevent.
  This is a lint against accident and drift in first-party code — **not** a
  security control, and it has never been one.
- **Web parity.** `test/plugin-web-parity.test.js` fails if a plugin here has a
  `renderer.js` that is not in the generated bundle map, naming the remedy. The
  Electron app itself will not notice, which is why it is easy to miss.

## Where to read next

- [`what-plugins-can-do.md`](what-plugins-can-do.md) — the reach of a plugin in
  plain terms: what it can show, what it can alter, what it can do for agents,
  and what it cannot see. Read this one to decide *whether* to build something.
- [`plugin-api.md`](plugin-api.md) — the contract. Manifest, both
  host objects, the seven slots, intents, events, lifecycle, boundaries, and what
  is deliberately not exposed.
- [`plugin-sources.md`](plugin-sources.md) — where plugins come
  from: the two roots, precedence and shadowing, trust, and what a re-scan can
  and cannot do.
- [`tools/README.md`](tools/README.md) — the four author tools: generate the
  context pack, scaffold a valid plugin, verify it against the real host, and
  check that the verifier can still fail.
