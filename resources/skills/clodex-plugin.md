---
description: Write a Clodex plugin — a directory with a manifest that adds UI, behaviour, or an [agent:…] verb to Clodex in process. Use when asked to build, scaffold, or extend a Clodex plugin, add a sidebar drawer or status badge to Clodex, or give agents a new [agent:…] verb. Routes to the authoritative contract instead of guessing.
---
# Writing a Clodex plugin

You are building a directory that Clodex loads in process. There is a real
contract for this, it is 2,000 lines, and **you must not read all of it.** This
page tells you which part to read for what you are building.

## Step 1 — find the docs

Four files. Prefer a local checkout if the machine has one:

```
ls ~/projects/clodex/plugins/plugin-api.md 2>/dev/null || \
  find ~ -maxdepth 5 -name plugin-api.md -path '*/plugins/*' 2>/dev/null | head -1
```

The repo's own folder may be named something else on disk — follow whatever the
`find` turns up. The four files always sit together in a `plugins/` directory.

If there is no checkout, fetch from the public repo (`avirtual/clodex`, branch
`master`):

```
https://raw.githubusercontent.com/avirtual/clodex/master/plugins/plugin-api.md
https://raw.githubusercontent.com/avirtual/clodex/master/plugins/what-plugins-can-do.md
https://raw.githubusercontent.com/avirtual/clodex/master/plugins/plugin-sources.md
https://raw.githubusercontent.com/avirtual/clodex/master/plugins/README.md
```

`master` may describe a Clodex newer than the one installed. The manifest's
`hostApi` is the check that matters — if the running app refuses your plugin
with a `hostApi` mismatch, you read docs for a different host.

## Step 2 — read only what you need

`plugin-api.md` is sectioned; go straight to the section.

| Building | Read |
|---|---|
| Deciding whether this should be a plugin at all | `what-plugins-can-do.md` — the whole thing, it is short |
| The manifest | §2 |
| An `[agent:…]` verb | §7, then `host.intents` in §4 |
| Anything touching the filesystem, sessions or network | §4 (the engine `host`) |
| A viewer: a button, an overlay, and reading files | §6.3, §6.7, §8, and the `fsScope` part of §4 (§4.2) — the commonest shape there is |
| Any UI at all | §6 — seven named slots, pick yours, read that subsection |
| A full application surface inside Clodex | §6.7 (overlay) |
| Talking between your two halves | §8 (`invoke`) |
| A plugin that should be invisible to most seats | §2.1 (scope) |
| Enable/disable, failure, quarantine behaviour | §10 |
| What you are NOT allowed to reach | §12 and §13 — read these before designing, not after |

Three shipped plugins are readable in an afternoon and are better than any
summary: **git-branches** (badge + settings panel + a verb), **memory-viewer**
(footer button + overlay + two panes + `invoke` for the filesystem — the viewer
shape, and the closest match if you are building one) and **workbench** (a full
overlay). Read one whose shape matches yours.

## Step 3 — the facts that cause wrong turns

These are cheap to state and expensive to discover:

- **The directory name IS the plugin id**, and `manifest.id` must equal it.
  A mismatch is refused at load and at registration.
- **`hostApi` must be the exact string the host expects** (`"1"` at time of
  writing). Not a number.
- **Two halves, and the law between them.** `engine.js` runs in the Clodex
  engine: filesystem, sessions, network, and it is the ONLY half that can
  register an `[agent:…]` verb. `renderer.js` runs in each window and only
  draws — it cannot reach the filesystem and must ask its engine half over
  `invoke`. An engine half that imports `electron` breaks headless deployments
  and the test suite refuses it.
- **At least one half is required**; both are optional individually. An
  engine-only plugin (a verb and no UI) is a normal, complete plugin.
- **A plugin verb is off by default on every seat, and fails silently.** Core
  verbs get an all-enabled default; plugin verbs are enabled only by explicit
  inclusion in a seat's intent allowlist. A freshly installed plugin's verb is
  inert everywhere until the operator ticks it in the session's ⚙ Intents
  checklist — the line is simply not parsed, nothing is logged, and the agent
  sees an unrecognised intent. **Say this in your README.** Every user hits it
  once, and from the inside it looks like the plugin is broken. The converse is
  worth knowing too: a plugin with **no** verb has nothing to enable in that
  checklist, and the seat's Plugins list is then the only place it is turned on
  per seat.
- **Verbs share one global namespace.** Two plugins cannot register the same
  verb; the second fails to load. See `plugin-sources.md` §4a.
- **A path a user or an agent named must be realpath'd on EVERY read**, and the
  resolved string prefix-checked against the root you confine to. A lexical
  join is defeated by a symlink inside the tree pointing out of it — the join
  stays under the root and the open does not. `fsScope` does not do this for
  you: it answers "local session, which cwd", and §4's `fsScope` passage says
  so in as many words ("not workspace scoping, not cwd confinement, not a
  sandbox"). Read that passage before you write the first `readFileSync`.
- **Handlers are synchronous.** A returned promise is logged and ignored, so a
  rejection becomes silence. Do the synchronous part, schedule the rest, inject
  the answer when it lands.
- **Node's module cache survives a disable.** A re-enable calls `activate()`
  again on the same module object, so reset state in `activate()`, not at module
  scope.
- **The renderer half is desktop-only for a plugin outside the Clodex repo.**
  The browser bundle is built with the app and inlines only the repo's own
  plugins, so a registered external plugin gets its engine half over the web
  surface and no UI there. Design around it or accept it; do not try to fix it.

## Step 4 — where it lives, and registering it

A plugin can live anywhere on disk, including its own git repo. Two ways in,
and they are not equals:

- **Register it — the default, and what you should tell your user to do.**
  Clodex → Plugins → **Register Plugin…**, pick the folder. Clodex validates the
  manifest and symlinks it into `~/.clodex/plugins`. Registration records where
  the plugin came from: the row shows where it points and offers Unregister,
  which removes only the link. **The folder must be named for the plugin id** —
  this is the one refusal users hit by accident.
- **Copy or symlink it** into `~/.clodex/plugins/<id>/` by hand, then press
  Re-scan. This is the escape hatch, for when the dialog is not available to
  you — a script, a headless box. It loads identically. A hand-made *symlink*
  is indistinguishable from a registered one afterwards, so it keeps the
  provenance line and the Unregister button; a *copy* keeps neither, and the
  row cannot say where it came from.

Do not pick an id that a plugin built into Clodex already uses; registration
refuses it, because only one copy of an id can run and precedence decides which.

`plugin-sources.md` covers discovery roots, id precedence and shadowing if any
of that becomes relevant. Most plugins never need it.

## What to hand back

A directory with `manifest.json`, the half or halves you needed, a `style.css`
if the renderer half draws anything, and a README that states what the plugin
does and — for anything with a verb — that the operator must enable it per seat.
