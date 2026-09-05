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

At least one half is required — unless the directory ships skills or agents
instead, below — and **the directory name is the id**.

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

## Skills, agents, prompts and templates

A plugin can also carry Claude Code **skills** and **subagents**, plus Clodex's
own **prompts** and session **templates**. They are content, not code: four
directories beside the halves, read by the loader's `readBundle` and handed to
the seats that have the plugin.

```
<id>/
  skills/
    <skill-name>/
      SKILL.md   required — the skill; a directory with no readable SKILL.md is skipped
  agents/
    <agent-name>.md         the subagent; a non-.md file is ignored
  prompts/
    system/<stem>.md        replaces the CLI's own system prompt
    append/<stem>.md        composed onto it
  templates/
    <stem>.json             a session template, same shape the app writes
```

Every name is checked against `AGENT_NAME_RE` — `/^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/`,
the same rule session names obey. A name that fails it is skipped with a reason in
the app's log, and the rest of the bundle still loads: one bad entry does not cost
you the others. A `templates/*.json` that does not parse, or parses to something
other than an object, is skipped the same way.

A template inside a plugin may name that plugin's **own** prompts by bare stem —
`"systemPromptFile": "reviewer"`. The loader rewrites those to the namespaced form
when it reads the file, so the reference cannot dangle when the plugin moves
between roots. A ref that already carries a colon is left alone, so a template may
still name another plugin's prompt deliberately. Every plugin template also
carries its own plugin in `plugins`, merged into whatever it already lists:
starting a seat from it **grants the plugin**, so the seat can reach the prompts
the template names.

They arrive **namespaced by the plugin's id**. A skill `review` in plugin
`my-plugin` is invoked as `/my-plugin:review`; an agent `auditor` in the same
plugin is delegated to as `my-plugin:auditor`; a prompt `reviewer` is referenced
as `my-plugin:reviewer` in `systemPromptFile` / `appendPromptFiles`, and a
template `audit` is `my-plugin:audit` in the template picker. The namespace is the
plugin id, so two plugins may ship a skill of the same name without colliding.

A namespaced prompt ref is resolved **through the plugin, before the library**, so
a plugin prompt never shadows and is never shadowed by a same-named file in
`~/.clodex/library/prompts/`. Naming one for a plugin the seat does not hold is
**refused at spawn** with a message saying so, rather than quietly falling back to
the CLI default — a seat silently missing the prompt it was configured with is the
failure that refusal exists to prevent.

**Visibility is per seat, and it is the plugin's seat list that decides it** —
the same list of §2.1 that gates everything else a plugin reaches. A seat whose
plugin list holds the plugin gets its skills and agents; a seat that does not,
never sees them. Disabling the plugin does not retract them from a running seat:
they are written at spawn, so they go at that seat's **next start**.

A prompt REF does not degrade that gently. A seat whose persisted
`systemPromptFile` or `appendPromptFiles` names a prompt from a plugin that is no
longer loaded is **refused at its next start** — the spawn fails with "not
loaded" rather than booting without the prompt — and a clear or compact rebake
logs `prompt-refresh-error` and leaves the old prompt in place. To recover,
re-enable the plugin for that seat, or save the seat once (Edit Session) after
the plugin is removed — the save drops the refs the seat can no longer resolve.

They **show but do not toggle.** The Skills, Agents and Append-prompts checklists
(New Session, Edit Session, the per-session popovers) and the library drawers group
a plugin's content under the plugin's name, with the rows disabled: a seat that has
the plugin sees them marked as arriving with it, and a seat that does not sees
what enabling the plugin would add. There is no per-skill switch, because the
plugin tick is the switch.

The **template picker is the exception**, and deliberately: it lists every plugin's
templates in a group of their own whatever the dialog's current plugin ticks say,
because picking one grants the plugin rather than requiring it.

**A plugin may be content only.** A manifest whose `entry` names neither half is
valid when the directory carries any of the four, so a pure content pack needs no
JavaScript at all — just `manifest.json` and the directories it ships.

### Who may edit it

Whether the app can edit a plugin's content is decided by **which root the plugin
came from**, and by nothing else:

| Root | In the app |
|---|---|
| `~/.clodex/plugins/` — yours | **Editable.** The drawers open the ordinary editor on the row, and the save writes back into the file inside the plugin folder. |
| the app's own `plugins/` — built in | **Read-only.** The row offers *Reveal plugin folder* instead of an editor. |

The rule is the same for all four kinds. A save is refused engine-side as well as
hidden in the UI, so nothing that reaches the write channel can put a file into a
built-in plugin, and no name it is given can land outside the plugin's own
directory. Neither editable nor read-only content is a record in your own skill,
agent, prompt or template library — the drawers list it under the plugin it came
from, and Manage Plugins ▸ Re-scan re-reads the files without a restart. A seat
picks new text up at its next start.

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
which resolves modules at build time, so renderer halves are baked in: run
`npm run build:web` and commit everything it regenerates. Two artifacts, two
triggers — `renderer/web/plugin-registry.js` is an id→module map, so it changes
only when you **add or remove** a `renderer.js`; the tracked `web-dist/index.html`
inlines each renderer half's own source, so it changes on **every edit** to one.
Rebuild after an edit too: skip it and the committed bundle serves the old code
while the sources read fixed (`test/web-dist-fresh.test.js` catches a stale
bundle, `test/plugin-web-parity.test.js` a stale map). Engine-only plugins need
no build step. This applies to plugins **in this repo**; a plugin in
`~/.clodex/plugins/` loads in the Electron app and does not appear in the browser
frontend at all (`plugin-sources.md` §6).

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
