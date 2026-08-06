# Clodex plugin API — `hostApi "1"`

**Status: frozen.** This document is the contract, not a description of one. If
the code and this document disagree, that is a bug in one of them and worth
reporting; nothing here is "roughly how it works".

You do not need to read Clodex's source to write a plugin, and you should not
have to. Everything a plugin can reach is on the two objects described here —
`host` (engine side) and `rhost` (renderer side). Reaching around them does not
merely violate the spirit of the thing: the test suite fails the build for it
(see [Boundaries](#12-boundaries-what-the-test-suite-refuses)).

- [1. What a plugin is](#1-what-a-plugin-is)
- [2. The manifest](#2-the-manifest)
- [2.2 Surfaces: which transports may call a method](#22-surfaces-which-transports-may-call-a-method)
- [3. The two halves, and the law that separates them](#3-the-two-halves-and-the-law-that-separates-them)
- [4. The engine `host` object](#4-the-engine-host-object)
- [5. The renderer `rhost` object](#5-the-renderer-rhost-object)
- [6. The seven UI slots](#6-the-seven-ui-slots)
- [7. Intents — contributing an `[agent:…]` verb](#7-intents--contributing-an-agent-verb)
- [8. Talking between your halves: `invoke`](#8-talking-between-your-halves-invoke)
- [9. Events](#9-events)
- [10. Lifecycle: enable, disable, failure, quarantine](#10-lifecycle-enable-disable-failure-quarantine)
- [11. The transport, and why it is five rows](#11-the-transport-and-why-it-is-five-rows)
- [12. Boundaries: what the test suite refuses](#12-boundaries-what-the-test-suite-refuses)
- [13. What is deliberately not exposed](#13-what-is-deliberately-not-exposed)
- [14. Known gaps and unspecified behaviour](#14-known-gaps-and-unspecified-behaviour)
- [15. Versioning](#15-versioning)

---

## 1. What a plugin is

A directory with a manifest and up to two JavaScript halves:

```
plugins/<id>/
  manifest.json    required
  engine.js        optional — { activate(host), deactivate?() }   plain Node, no Electron
  renderer.js      optional — { activate(rhost) -> dispose? }     DOM, one per window
  style.css        optional — one <style> per plugin per window, injected
                              VERBATIM and unscoped (§14)
```

At least one half is required. A plugin with only an engine half is a pure data
or automation plugin (it can register intent verbs and session hooks, and has no
UI). A plugin with only a renderer half is pure UI with no privileged access.
Most useful plugins have both, because the renderer half cannot touch the
filesystem or the session manager — it asks its engine half to.

The directory name **is** the plugin id. They may not differ.

**A renderer half needs a build step.** Clodex also ships as a browser bundle,
which cannot resolve a module path at runtime the way Electron can, so renderer
halves are baked into a generated map at build time. After adding or removing a
`renderer.js` — not after every edit to one — run:

```
npm run build:web
```

and commit the regenerated `renderer/web/plugin-registry.js` along with your
plugin. Skip it and `test/plugin-web-parity.test.js` fails, naming the remedy;
the Electron app itself will not notice, which is exactly why it is easy to miss.
An engine-only plugin needs no build step at all.

Discovery scans two roots in precedence order — the plugins directory shipped
with the app, then `~/.clodex/plugins/`, which is where **your** plugin goes if
you are not working in a checkout. Precedence, shadowing between two copies of
one id, symlink following and the re-scan are specified in
[`plugin-sources.md`](./plugin-sources.md) §3–§4 and §10, which is the one
authority on where plugins come from; none of it is observable from inside
`activate()`, so none of it is part of this contract.

Plugins are **in-process JavaScript**, first-party or curated. There is no
sandbox: an engine half runs with the privileges of the app's main process, and
a renderer half runs in the window. The host API is a *contract*, not a security
boundary — it exists so that plugins are removable, versionable and don't couple
to core internals, not so that a hostile plugin is contained. Install
accordingly.

### The smallest complete plugin

`plugins/hello/manifest.json`:

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "1.0.0",
  "hostApi": "1",
  "entry": { "engine": "engine.js", "renderer": "renderer.js" }
}
```

`plugins/hello/engine.js`:

```js
'use strict';
module.exports.activate = (host) => {
  host.ipc.handle('greet', (who) => ({ ok: true, text: `hello ${who}` }));
};
```

`plugins/hello/renderer.js`:

```js
'use strict';
module.exports.activate = (rhost) => {
  rhost.ui.sidebar.footerButton({
    id: 'open',
    glyph: '👋',
    label: 'Hello',
    onClick: async () => {
      const r = await rhost.invoke('greet', rhost.sessions.active() || 'nobody');
      rhost.ui.showToast(r.ok ? r.text : `failed: ${r.error}`);
    },
  });
};
```

Restart the app. The button is in the sidebar footer, and `Plugins ▸ Hello` in
the menu bar has a tick next to it.

---

## 2. The manifest

```json
{
  "id": "workbench",
  "name": "Workbench",
  "version": "1.0.0",
  "hostApi": "1",
  "entry": { "engine": "engine.js", "renderer": "renderer.js" },
  "style": "style.css",
  "enabledByDefault": true,
  "announce": "Workbench enabled — Files, Source Control and Worktrees for any local session."
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lowercase identifier, and the directory name. Becomes a filesystem directory, a CSS attribute selector, a UI-slot id prefix and a dispatch prefix, so it is deliberately narrow: `/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/` — 1–40 chars, lowercase alphanumerics and hyphens, no leading or trailing hyphen, no underscore, no dot, no uppercase. It is **not** an intent-verb namespace: verbs live in one global namespace (§7). |
| `name` | no | Human-readable label for the Plugins menu and the Manage Plugins dialog. Defaults to `id`. |
| `version` | no | Free-form string, displayed to the user. Nothing parses it. |
| `hostApi` | yes | Must be exactly `"1"`. A string, not a number. |
| `entry` | yes | An object. `entry.engine` and `entry.renderer` are paths relative to the plugin directory; each is optional individually but at least one must be present, and each must be a string if present. |
| `style` | no | Path to a CSS file, relative to the plugin directory. Loaded as **text** and injected per window. |
| `enabledByDefault` | no | Defaults to `true`. Only consulted for a plugin the user has never made a decision about; once they toggle anything, their explicit set wins forever. Set it to `false` for a plugin that should ship dormant. |
| `announce` | no | One sentence describing what the plugin does. Shown as the description line in the Manage Plugins dialog. |
| `scope` | no | `"global"` (the default) or `"session"`. A `session`-scoped plugin is **invisible** to any session that has not granted it — see §2.1. Absent means `global`, which is the behaviour every plugin had before this field existed. |
| `surfaces` | no | An object mapping a method name to `"any"`. A method listed as `"any"` may be called from the browser surface as well as the desktop app; **anything you do not list is desktop-only**. Absent means the whole plugin is desktop-only. See §2.2 — this is the one manifest field whose default costs you reach rather than granting it. |

Unknown fields are ignored, not refused. That is deliberate: it lets a future
version add optional fields without breaking your manifest, and lets you carry
your own metadata.

### Why a manifest gets refused

A refused manifest is inert — nothing of the plugin ever runs — and the reason
is written to the app's log and shown in the Manage Plugins dialog under that
directory's name. It is never silently defaulted, because a plugin running with
a guessed id or entry point is worse than one that visibly fails.

The refusals, and what to do about each:

- **The file isn't valid JSON, or isn't an object.** Check for a trailing comma;
  `manifest.json` is strict JSON, not JavaScript. A directory with *no*
  `manifest.json` at all is not an error and not reported — it simply isn't a
  plugin, so you can keep unrelated subdirectories under `plugins/`.
- **The id is missing or malformed.** See the character rule above. The most
  common cause is an uppercase letter or an underscore.
- **The id doesn't match the directory name.** Rename one to match the other.
  Allowing them to differ would mean two names for one plugin — one on disk, one
  in settings — and every later "which one is it?" bug follows from that.
- **`hostApi` is missing, or isn't `"1"`.** A plugin written against a surface
  this host doesn't serve is refused by name rather than half-activated against
  an API it predates. The message names both versions. Note the field is
  genuinely required: an absent `hostApi` is refused, not defaulted.
- **`entry` is missing or isn't an object.**
- **`entry.engine` or `entry.renderer` is present but isn't a string.**
- **`entry` names neither half.** An empty `entry: {}` is refused.
- **An entry path or the `style` path escapes the plugin directory.** Paths are
  resolved and must land inside your own directory; `"engine": "../../session-manager.js"`
  is refused. This is the runtime twin of the static boundary lint (§12) —
  neither catches what the other does.
- **`scope` is present but isn't `"global"` or `"session"`.** Refused rather
  than defaulted, and this one matters: an unrecognized scope resolves to
  `global` everywhere else in the host, so a typo on a plugin meant to be
  invisible would silently make it visible to every session. `"Session"` with a
  capital S is a refusal, not an opt-in.
- **`surfaces` is present but isn't an object, or names a value other than
  `"any"`.** Refused for the mirror-image reason to `scope`: an unrecognized
  value there resolves to *desktop-only*, so a typo would fail closed — your
  method would simply stop answering in the browser, with nothing to read. An
  array, a bare string, `"web"`, `true` and `"ANY"` are all refusals.

---

## 2.1 Scope: global and session-scoped plugins

Plugins are `global` by default and that is what every shipped plugin is: it
loads once, its UI draws in every window, its intent verbs appear in every
session's checklist, and the only thing standing between a seat and one of its
verbs is the per-session intent gate (§7).

That fits a plugin that adds UI. It does not fit a plugin written for one team's
seats, which should be **invisible** to unrelated agents rather than merely
refused. `"scope": "session"` is that opt-in.

### What actually becomes conditional

A session-scoped plugin still **loads once** — its engine half is one module, and
`activate(host)` runs exactly as before. What becomes per-session is what the
plugin *reaches*:

| Surface | Global plugin | Session-scoped plugin |
|---|---|---|
| Intent-checklist rows | every session | only granted sessions |
| Grammar lines in the seat's prompt | every granted seat | only granted sessions |
| The near-miss bounce's verb list | every session | only granted sessions |
| `rhost.ui.sidebar.rowBadge` | every row | only granted rows |
| `rhost.ui.sessionMenu.addProvider` | every session | only granted sessions |
| `rhost.ui.statusBar.addAction` / `addSegment` | every session | only granted sessions |
| `rhost.ui.sidebar.footerButton` | always | **always** — see below |
| `rhost.ui.settings.section` | always | **always** |
| `rhost.ui.surfaces.overlay` | always | **always** |
| `host.sessions.*` / `rhost.sessions.*` *(enumeration)* | unchanged | **unchanged at every scope** |
| `host.sessions.onAgentText` | never delivers | only granted sessions |

The last three UI rows are deliberate. A sidebar footer button belongs to the *window*,
not to whichever session happens to be active; hiding it on session switch would
make the chrome flicker with no coherent meaning. Scope governs what a plugin
sees **of a session**, and those three see none of it.

The `sessions.*` rows are the ones to read carefully, and they point opposite
ways. The session ENUMERATION APIs are **not narrowed for a scoped plugin**:
`host.sessions.get(name)` and `rhost.sessions.listWorkspace()` answer the same
for a plugin granted nothing as for one granted everything. Do not design
against that row as though it were an isolation boundary — see the next section.
The turn-text feed is the exception, and the only member of `sessions.*` that
scope governs: a `global` plugin never receives a single event from it, whatever
a session granted (§4).

### The three grants

A grant is per session and per capability, each defaulting **off**, and they are
separate because they carry different risk:

| Capability | What it covers | Consumed by |
|---|---|---|
| `turns` | Turn text — what the agent writes | `sessions.onAgentText` (§4) |
| `thinking` | Thinking blocks — its reasoning, not just its answers | nothing yet |
| `toolInputs` | Tool inputs — Bash commands it runs and file contents it writes | nothing yet |

They are independent: holding `toolInputs` does not imply `turns`. If they shared
one grant, everyone who wanted a turn archiver would also get every command the
agent ran.

The two unconsumed rows are declared but inert — an operator can grant them and
nothing reads them. That is deliberate rather than unfinished: `hostApi` is
frozen at `"1"` and only a change that breaks a conforming plugin bumps it, so a
capability added *after* the API it gates would be exactly such a change.
Declaring the whole vocabulary up front spends no version bump.

A plugin holding **any** capability on a session is visible to it; holding none
means it is absent. The operator edits these in the Intents popover's *Plugin
Access* block, and only session-scoped plugins appear there — a global plugin has
no per-session decision to offer.

### Scope means visibility, not isolation

State this to yourself before designing around it. Intent verbs live in **one
global namespace**: `registerIntent` throws `EVERBTAKEN` on collision (§7), and
session scoping does **not** partition that. Two session-scoped plugins used by
different agents still cannot share a verb name — the second one to load is
refused, exactly as two global plugins would be.

Nor is scope a security boundary. A scoped plugin's engine half is unsandboxed
in-process Node with the same `host` every other plugin gets (§13); what scope
changes is what the operator is *shown* and what the plugin is *fed*, not what a
determined plugin could reach. The enforcement that was already there —
`intentEnabledFor`'s strict per-session gate — is unchanged and is what actually
refuses a verb. Scope stops a plugin from being *offered*; the gate is what stops
it from *firing*.

---

## 2.2 Surfaces: which transports may call a method

Clodex runs as a desktop app and, optionally, as a browser client talking to a
running desktop app over an authenticated socket. Both surfaces run the *same*
plugin host: your engine half is loaded once, in the desktop process, and both
transports reach it through the one multiplexed invoke channel.

They are not equally trusted. Several capabilities the desktop app has — a
verb runner, a shell — are simply not served to the browser at all. Plugin
methods cannot be withheld the same way, because they all share a single
channel: withholding it would take *every* plugin away from the browser. So
the distinction rides the call instead, and `surfaces` is where you declare it.

```json
"surfaces": {
  "fs.list": "any",
  "fs.read": "any",
  "scm.status": "any"
}
```

Every method named `"any"` may be called from either surface. **Every method you
do not name is desktop-only** — a browser client calling it gets

```js
{ ok: false, error: 'plugin method not available on this surface' }
```

and your handler never runs. A plugin with no `surfaces` field at all is
entirely desktop-only, which is why the field is worth adding the moment your
plugin has a renderer half you expect to work in the browser.

**The default is restrictive on purpose, and it is not symmetric.** A method
you forget to list stops working in the browser — visible, annoying, and fixed
by one line. A permissive default would instead mean that every method you add
later is silently reachable from the network the day you write it, including
the one that writes files. That asymmetry is the whole design: the grain is
per-method with no plugin-wide default to inherit, so opening something is
always an explicit act recorded in your manifest.

**What to mark `"any"`.** Reads. Listing a directory, reading a file, showing
`git status`, enumerating worktrees — the browser client's UI needs these and
they change nothing. **What to leave off:** anything that writes a file, commits,
discards, checks out, pushes, creates or removes a worktree, or changes a
setting another method then acts on. The shipped workbench follows exactly that
line: eight reads are `"any"`, and its ten mutating methods are not.

Note the last clause. A method that only *selects* something can still be
load-bearing if other methods act on the selection — gating the writers while
leaving the selector open moves the target rather than protecting it.

This is enforced in the host, before your handler is reached, so it does not
depend on your code being careful. It is still a **capability** boundary and not
a sandbox: §13's posture is unchanged, and an engine half remains unsandboxed
in-process Node. What `surfaces` buys is that a *remote* caller cannot reach a
method you did not open, which is a different and narrower claim.

**`surfaces` governs `invoke`, and nothing else.** Your intent verbs (§7) and
your session hooks (§4) are not covered by it and cannot be: a verb fires from
turn text and a hook fires from session lifecycle, so anything that can write
into a session's PTY reaches both, regardless of which transport it came in on.
If a verb of yours does what a desktop-only method does, marking the method is
not enough — the verb is the open door.

**One method that is not yours is also ungated: `_host`'s `settings.set`.** The
plugin subsystem's own plumbing answers on both surfaces (see §13), so a browser
caller can write *your* settings key. Nothing today reads a setting as a path or
a command, and nothing should start: **never store a path, a command, an
argument list or a URL in `settings` and then act on it unvalidated.** Treat a
settings value as caller-supplied input at the point you use it, the same way
you would treat an `invoke` argument. A desktop-only method that reads a
browser-writable setting is a desktop-only method in name only.

---

## 3. The two halves, and the law that separates them

This is the single most likely thing to get wrong, so it is stated before the
API rather than after it.

**Law 1 — N windows means N renderer activations.** Clodex has one window per
*workspace*, and a user may have several open at once. Your engine half's
`activate(host)` runs **exactly once per app run**, before any window exists.
Your renderer half's `activate(rhost)` runs **once per BrowserWindow**, in that
window's own document, with its own closure. Three windows means three
independent copies of your renderer half, which cannot see each other's
variables and must not assume they are the only one.

Practical consequences:

- Durable state lives engine-side, in `host.storage` or `host.settings`. Renderer
  state is a per-window cache and must be rebuildable from zero.
- A module-level variable in `renderer.js` is shared across activations *within
  one window's module instance* but is a different variable in another window's
  process-level module cache — do not reason about it at all. Put per-window
  state in the `activate()` closure.
- Your renderer half may activate into a window where sessions already exist and
  have been running for hours. It is never guaranteed a fresh world.

**Law 2 — events are unbuffered hints; state is pulled.** `host.events.emit`
does not queue. If the target window is closed, the event is dropped and no one
will ever hear it. Only PTY output is ever buffered, and that is core's, not
yours. Therefore a plugin **cannot** correctly maintain renderer state by
applying deltas, and must not try. The rule is: **pull on window open, on
surface open, and on reattach**, via `rhost.invoke`. Use events only to say
"something changed, ask again", never to carry the change itself.

Those three triggers cover a surface a user opens. **They do not cover anything
that renders itself** — in `"1"` that means `sidebar.rowBadge` (§6.4), which core
paints on its own schedule and which is synchronous, so there is no moment at
which you could have pulled first. Stated plainly, because you will observe it
and wonder whether you have a bug: **a rowBadge's first render is structurally
blank.** The sidebar asks, your cache is empty, you return `null`; you then
resolve in the background and call `requestRelayout()`, and the chip appears on
the next pass. That is the design working, not a race you can close. Design the
badge so that "nothing yet" is a legitimate state rather than a flash of wrong
data. §6.4 carries the corollary that bites hardest: **registration does not
paint either**, so the pass that fills that first blank is one you must ask for.

**Law 3 — sessions outlive windows.** A window closing does not kill its
sessions; they keep running and reattach when a window reopens. Durable
per-session state belongs engine-side, keyed however you like.

**Law 4 — disable is not window close.** Closing a window is free teardown: the
whole renderer dies. *Disabling a plugin while windows are open* is not, and it
is the path that leaves your callbacks firing against DOM that has been removed
in every window. Everything in [§10](#10-lifecycle-enable-disable-failure-quarantine)
about teardown exists for this case.

---

## 4. The engine `host` object

Passed to `module.exports.activate(host)` in your `engine.js`. Frozen. Runs in
plain Node — **no Electron**, no `window`, no DOM. It is constructed after
Clodex's stores, session manager and wiring exist, and before the first window,
so at activation time there are no windows and (usually) no sessions yet.

```js
host = {
  id,                                    // your plugin id, as a string
  hostApiVersion,                        // "1"

  log: { info(msg), error(msg) },        // scoped to "plugin:<id>" in the app log

  paths: { dataDir },                    // absolute path, <userData>/plugins/<id>/

  storage: { get(), set(obj) },          // whole-file JSON, atomic
  settings: { get(), set(patch) },       // user-visible settings, shallow-merged

  sessions: {
    listAll(),                           // -> [{ name, type, cwd, workspaceId, … }]  GLOBAL
    listWorkspace(workspaceId),          // -> same shape, one workspace only
    get(name),                           // -> SessionHandle | null
    fsScope(name),                       // -> { cwd } | { error }
    onCreate(fn),                        // -> dispose
    onExit(fn),                          // -> dispose
    onAgentText(fn),                     // -> dispose; needs the `turns` grant
  },

  ipc:   { handle(method, fn) },         // -> dispose
  intents: { register(row) },            // -> dispose
  events: { emit(topic, payload, scope) },

  lib: { gitWorktree },                  // sanctioned shared core leaves
  telemetry: { snapshot(sessionName) },  // read-only, may be null
}
```

### `host.id` and `host.hostApiVersion`

`host.id` is your plugin id as a string — the same value as your manifest's
`id`, handed to you so you don't have to hardcode it. `host.hostApiVersion` is
the version this host serves, `"1"`. You will rarely need either; they exist so
shared code can be written without a manifest read.

### `host.log`

`host.log.info(msg)` and `host.log.error(msg)` write into Clodex's own log,
prefixed `plugin:<yourId>`. Use them. A bare `console.log` from an engine half
goes to a terminal the user is probably not looking at.

### `host.paths.dataDir`

`<userData>/plugins/<yourId>/`. Yours entirely. The directory is **not created
for you** — `storage.set()` creates it on first write; if you want to write your
own files there, `mkdir -p` it yourself.

### `host.storage`

Whole-file JSON at `dataDir/state.json`, written atomically (temp file +
rename).

- `get()` returns the parsed object, or `{}` if the file is absent or corrupt.
  It never throws.
- `set(obj)` replaces the whole file. Returns `true` on success, `false` on
  failure (and logs the reason). It is not a merge — read, modify, write.

This is deliberately not one of Clodex's own persistence stores: a corrupt
plugin write can never damage the user's sessions.

### `host.settings`

The same shape one level into the user's UI settings, at
`uiSettings.plugins[yourId]`.

- `get()` returns a shallow copy of your settings object, or `{}`.
- `set(patch)` **shallow-merges** the patch into your object. `patch` must be a
  plain object: a string, array, `null` or primitive is refused and returns
  `false` without writing. Returns `true` when the merge is applied.

Use `settings` for things a user chooses and `storage` for things your plugin
computes. The practical difference: settings are what a `settings.section` slot
(§6) reads and writes, and are what survives if the user's data directory is
migrated.

### `host.sessions`

A "session" is one running CLI agent or shell in the sidebar.

There is deliberately **no `list()`**. Two named accessors exist instead, because
the difference matters and a default-named one makes the wrong choice the easy
one:

- **`listAll()`** — every session in the app, across every workspace.
- **`listWorkspace(workspaceId)`** — one workspace's sessions. This is what a
  per-window UI wants; showing a user another workspace's sessions in a dropdown
  is a leak, and no other guard in this API catches it.

`get(name)` returns a **SessionHandle**, or `null` if there is no such session:

```js
SessionHandle = Object.freeze({
  name, type, cwd, workspaceId,     // snapshotted when the handle was minted
  isAlive(),                        // false once the session's process has exited
  inject(text, { parkable = true }) // send text to the agent as if typed
})
```

`type` is `'claude'`, `'codex'`, `'bash'` or `'remote'`. `cwd` may be `null`
(some sessions have no working directory). A handle held across an exit keeps
reporting what the session *was* rather than throwing — `isAlive()` goes false
and `inject()` becomes a safe no-op.

`inject(text)` writes into the session's input. `parkable` defaults to `true`,
meaning: if the agent is mid-turn, hold the text and deliver it with its next
turn rather than interrupting. Pass `{ parkable: false }` only for something
that genuinely cannot wait.

#### `inject` is typing, not messaging — four rules

`inject` is the narrowest part of this API and the easiest to misuse, because it
looks like "send a message" and is actually "type this at a prompt". Everything
below is a host behaviour you cannot observe from inside a plugin, so none of it
will show up in your testing as an error.

**1. A newline in your text may submit it early, splitting one message into
several.** Interior `\n` is converted to `\r` — an ENTER key event — before the
write. There is a mitigation and you must not rely on it: while the CLI has
bracketed-paste mode (2004) on, multi-line text is wrapped in paste markers, and
interior newlines are then literal content. But *you cannot observe which mode is
live*. It is sniffed from the CLI's own output, differs by session type (a
`bash` pane generally never enables it) and by CLI version, and it toggles at
runtime around dialogs and teardown. **So treat the constraint as unconditional
even though the mechanism is not: if you would not be happy with your text
arriving as N separate prompts, do not put newlines in it.** Join with `' '`, or
make N deliberate `inject` calls. *Consequence when violated:* the first line
submits as its own turn and the remainder lands as a second prompt — observed
live, a message body and its trailer arriving as two user turns.

**Collapse it yourself, before you call.** That rule has an implementation, and
it is worth transcribing rather than improvising — in clean-room trials, plugin
authors who understood the rule perfectly still botched the regex that
discharges it:

```js
// Build these from STRINGS, not regex literals — see the warning below.
const ANSI = new RegExp('\\u001B\\[[0-9;?]*[a-zA-Z]|\\u001B\\][^\\u0007]*\\u0007', 'g');
const CTRL = new RegExp('[\\u0000-\\u001F\\u007F]+', 'g');
const RUNS = new RegExp('\\s+', 'g');

function oneLine(text, max = 0) {
  let s = String(text).replace(ANSI, '').replace(CTRL, ' ').replace(RUNS, ' ').trim();
  if (max > 0 && s.length > max) s = s.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
  return s;
}
```

`CTRL` is the load-bearing pass: it removes `\n`, `\r`, `\t` and every other C0
byte plus DEL, replacing each *run* with a single space so words either side do
not fuse. `ANSI` runs first so that a colour sequence leaves no `[0m` residue
behind once its ESC is gone; if some exotic sequence escapes that pattern,
`CTRL` still strips the ESC itself, so the output is control-free either way.
`max` is optional and off by default — `inject` has no length cap (below), so
truncate only if *your own* protocol needs it.

**Warning — a raw control character in source is a hazard of its own class, not
a detail of this snippet.** Writing a control byte *literally* into a regex
literal — `/[<0x00>-<0x1F>]+/` with the actual bytes in the file — is the
failure the string form above is chosen to make unrepresentable. Sometimes it
is loud: a raw newline inside a literal is a syntax error. The dangerous case
is quiet, and it is **not** that the pattern is wrong to begin with. Written
correctly, the literal matches exactly the same set as the string form and
behaves identically; test it on the day you write it and it passes.

The hazard is that those bytes are **invisible, and they do not reliably
survive**. Reformatting, transcription, a copy through a terminal, an editor
that sanitizes on save, a paste through anything that strips unprintables — any
of these can silently remove them, at which point the character class quietly
narrows to whatever is left and `oneLine('a\nb')` returns `'a\nb'` unchanged,
with no error anywhere. **`node --check` will not catch it**, because there is
nothing syntactically wrong to catch, and neither will a review that reads the
line as printed. A regex built from a string has no such failure mode: `'\\u001F'`
is six ordinary printable characters, and a raw byte cannot survive being
written that way in the first place.

This class of bug has bitten separator constants and ANSI-stripping code
before; prefer `new RegExp('…')` with escapes whenever a pattern mentions a
control character at all.

**2. Your text can be merged with other injects, acquiring newlines it never
had.** When the session cannot usefully receive a turn — mid-turn, blocked on a
permission dialog, or inside a `/compact` window — injects are queued and later
flushed as **one concatenated turn, joined with `\n`**. Two `inject` calls that
were fine individually can therefore arrive as one multi-line payload subject to
rule 1. *Consequence:* your carefully single-line text is no longer single-line,
and the batch may fragment at the join. If two pieces of text must not merge,
they must not be adjacent injects — space them behind something that waits for
the agent to act.

**3. Anything not a string is coerced, never rejected.** The host calls
`String(text)`. `inject(null)` types the four characters `null`; `inject({a:1})`
types `[object Object]`; `inject(undefined)` types `undefined`. There is no
validation, no throw and no log. *Consequence:* a bug in the value you pass
becomes visible text in the user's agent prompt, and the first person to notice
is the user.

**4. It is fire-and-forget, and tells you nothing.** `inject` returns
`undefined` — always, in every case. It is not async, so there is nothing to
await. You cannot learn whether your text was written, queued behind a hold,
parked for the operator's next turn, or dropped because the session had died.
*Consequence:* there is no delivery confirmation to build on. If your plugin
needs to know its text arrived, it has to observe the effect (the agent doing
something), not the call.

There is **no length cap** — text is never truncated at any point on this path,
at any size. Size is the one thing you do not have to worry about here.

**`fsScope(name)`** is the one you must use before touching the filesystem on a
session's behalf. It returns `{ cwd }` for a local session with a working
directory, and otherwise `{ error }` where error is:

- `'Session not found'` — no such session,
- `'remote'` — the session lives on a *peer* machine, so there is no local
  filesystem to read (render this as a "not available for remote sessions"
  notice; the string is stable and matchable),
- `'Session has no working directory'`.

The **peer refusal** is a host guarantee: it is the same guard core uses for its
own filesystem IPC, and the `'remote'` string is stable, so a plugin that routes
every filesystem handler through it cannot accidentally read a peer session's
machine. The idiom:

```js
const scoped = (fn) => async (name, ...rest) => {
  const r = host.sessions.fsScope(name);
  if (r.error) return { ok: false, error: r.error };
  return fn(r.cwd, ...rest);
};
host.ipc.handle('fs.list', scoped((cwd, rel) => listDir(cwd, rel || '')));
```

**Be precise about what that guarantee covers, because three other things sound
like it and are not true.** `fsScope` answers exactly one question — *what cwd,
and is this local?* It is not:

- **not workspace scoping.** The plugin transport discards the calling window
  before dispatch, so your engine half is never told which workspace asked. If a
  session name can reach your handler from somewhere you do not control, another
  workspace's cwd is reachable through it. Compare `handle.workspaceId` against a
  workspace you established yourself when that matters (§14).
- **not cwd confinement.** It hands you a cwd; nothing stops you — or a path bug
  in your own code — resolving out of it. A lexical join is not enough: a symlink
  *inside* the cwd pointing outside it resolves out, and `fsScope` neither knows
  nor cares. Confining reads to the cwd is your code's job.
- **not a sandbox.** Your engine half is in-process Node with `require('fs')` and
  the app's full authority. Everything in this document is a **contract, not a
  containment boundary**; see §12.

That distinction is worth stating this bluntly because the reassuring version of
it was written into three other places in this codebase and was false in all of
them.

### Session hooks

```js
const off = host.sessions.onCreate((handle) => { … });
const off = host.sessions.onExit((handle) => { … });
```

Both are **synchronous by definition**. If your subscriber returns a promise,
the host logs a contract violation and ignores the result — it does not await
it. This is not fussiness: `onExit` fires at a precise point during process
teardown (after the exit has been announced to the UI, before the session is
removed from core's map), and an async subscriber would resume *after* that
removal, observing a world that no longer matches what it was handed. If you
need to do async work, capture what you need synchronously and schedule the rest
yourself.

Each subscriber runs in its own try/catch: throwing does not break teardown and
does not affect other subscribers. It also does not tell anyone but the log.

Two facts worth knowing about `onExit`:

- The handle you receive is already dead. `isAlive()` is `false` and `inject()`
  no-ops. Those are the honest answers, not degradations.
- For a **bash** session that exited naturally, Clodex has *already* removed the
  session's persistence record by the time your hook runs. Do not expect to find
  one.

`onCreate` fires at the tail of session creation, after the session is fully in
core's map, so a handle you mint from it resolves. **Restored sessions are
included**: restore routes through the same `create()` path, so a session
reattached at app launch fires `onCreate` exactly like a fresh one.

**What `onCreate` does not cover, and the pattern that does.** Two moments have
no `onCreate` for you:

- Your engine half activates **before the first window and before restore**, so
  at activation there are (usually) no sessions to see.
- A plugin the user enables **at runtime** activates into a world where sessions
  have been running for hours. Those sessions were created before you existed;
  no hook will ever fire for them.

Do not solve this by enumerating and reconciling at activation. Enumeration is
empty in the first case and a race in the second, and it commits you to keeping
a mirror in step with a world that changes without telling you (§14).

**Resolve on demand instead.** Do the work when something first asks about a
session — a badge resolving, an invoke arriving, a verb firing — and cache the
answer keyed by session name:

```js
const cache = new Map();
function infoFor(name) {
  if (!cache.has(name)) cache.set(name, computeFrom(host.sessions.get(name)));
  return cache.get(name);          // populated on first ask, not at activation
}
host.sessions.onExit((h) => cache.delete(h.name));   // the one hook you do need
```

This works identically for a session created a second ago and one that has been
running since before your plugin was installed, which is exactly the property
enumeration cannot give you. Treat `onCreate` as an *invalidation hint* — a
reason to drop a cached answer — rather than as your source of truth. See
[§14](#14-known-gaps-and-unspecified-behaviour) for what bounds the freshness of
whatever you cache.

Both return a dispose function. You do not have to call it: everything you
register is torn down for you when your plugin is disabled (§10).

### `host.sessions.onAgentText` — the turn-text feed

```js
const off = host.sessions.onAgentText((ev) => { … });
```

What the agent actually said, as it says it. This is the one API that hands you
the work rather than the container, and it is the reason session scope exists.

```js
{ session:   'clodex-hand',   // name; resolve a handle with sessions.get()
  text:      '…',             // visible assistant text
  source:    'wire' | 'jsonl',
  truncated: false,           // wire: the turn exceeded the 4MB text cap
  isTurnEnd: true | null,     // wire only; null on jsonl — see below
  files:     [ { tool, path } ],   // files this turn wrote
  reads:     [ { tool, path } ] }  // wire only; null on jsonl
```

The event and its arrays are frozen, and every subscriber is handed the same
object. Copy anything you intend to keep.

**You need the `turns` grant, per session** (§2.1). Not "any grant" — a session
that granted you `toolInputs` and not `turns` delivers you nothing here, because
Bash commands and turn prose are different exposures and the split exists to
keep them apart. A `global`-scoped plugin receives nothing here even holding a
valid token — the feed re-checks your manifest scope on every delivery, because
grants are stored per session and outlive the manifest that earned them. Grants
themselves are read at **delivery** time too, so a revoke takes effect on the
very next turn rather than at the next restart.

**`isTurnEnd` and `reads` are `null` on the jsonl path, and that is a claim
about knowledge, not a missing value.** The transcript path has no protocol
turn-end signal — it inferred boundaries from a second of silence — and cannot
see tool-use blocks at all. `false` and `[]` would be assertions you could not
distinguish from observations. `files` is computable on both paths, so it is a
real array either way.

**This fires per REQUEST, not per turn.** A single user turn is roughly 4.4
requests, most of them tool-loop hops, and about 40% of requests carry no text
at all (those are dropped rather than delivered as empty events). If you want
turn boundaries, watch for `isTurnEnd === true` — but do not assume one event
per turn, and note that jsonl-sourced sessions cannot tell you.

**Delivery is at-least-once, not exactly-once.** This is the sharpest difference
from §7's intent handler, which *is* exactly-once. Intents get that guarantee
from a deduper keyed on intent content; raw text has no such key, and there is a
real double-delivery path: when the wire's observer fails for a request, Clodex
replays that turn's tail from the transcript, and text the wire already
delivered arrives again. If your subscriber does something non-idempotent —
appending to a file, sending a message — deduplicate on your own key.

**Delivery is deferred.** Your subscriber runs on a later tick, not on the
junction's stack, because that stack also dispatches the agent's intents. It is
still *synchronous* in the §4 sense: returning a promise is a contract
violation. Throwing is contained per subscriber.

You only ever hear the **main line**: subagent turns and side-calls (title
generation, probes) never reach you. A Task-heavy session would otherwise flood
you with subagent chatter you have no context for.

Thinking blocks and tool inputs are **not** in this event. They are separate
grants (`thinking`, `toolInputs`) that no API consumes yet; declaring them
early was the point of shipping the vocabulary before the feed.

<a name="callback-conventions"></a>
### Callback conventions

Three rules hold for **every** callback you hand this API — session hooks, intent
handlers, render callbacks, badge resolvers.

**1. They are synchronous.** Returning a promise is a contract violation: it is
logged and the result ignored, never awaited. Capture what you need
synchronously and schedule the rest yourself.

**2. Throwing is contained, per callback.** Your throw does not break core, does
not abort teardown, and does not affect another plugin's callback. It reaches the
log, and in one case (§7's intent handler) the agent. It reaches nobody else —
if a failure matters to your user, you have to surface it.

**3. Before you put a non-idempotent side effect in a callback, find out how many
times it can fire per logical event.** This is the rule worth internalising,
because the API gives you no way to detect a duplicate after the fact: there is
no emission id on any callback argument. A callback that fires twice for one
event will run your side effect twice, and `inject()` — the most likely side
effect a plugin has — is not idempotent: two injections are two messages the
agent reads.

So each callback either carries a **multiplicity guarantee** in its own section
or must be treated as "may fire more than once":

| Callback | Guarantee |
|---|---|
| `sessions.onCreate` / `onExit` (§4) | Once per session creation / exit. |
| `sessions.onAgentText` (§4) | **At-least-once per request.** Fires per REQUEST (~4.4 per user turn), and a tee-failure replay can re-deliver a turn's tail. Deduplicate on your own key. |
| `intents.handler` (§7) | Exactly once per matched line — see §7. |
| Render callbacks: `when`/`button`/`render`/`badge`/`resolve` (§6) | **No guarantee. Called on every render pass, many times per second.** They must be pure, cheap and side-effect free — treat them as read-only views of state you keep elsewhere. |

The render row is the one that bites. A `resolve()` that injects, writes a file
or fires an IPC is not slow — it is wrong, because a relayout is not an event.

### `host.lib`

Sanctioned shared core utilities, frozen and named. In `"1"` there is exactly
one entry, `gitWorktree`, offering seven functions. All are `async` except
`defaultWorktreePath`, and all are best-effort: they return a shaped result or
`null` rather than throwing.

| Function | What it does |
|---|---|
| `repoToplevel(cwd)` | The top-level working directory of the repo `cwd` lives in, or `null` if it isn't inside a git work tree. |
| `repoInfo(cwd)` | Whether `cwd` is a repo, its default branch, and the candidate base refs to offer in a picker. A non-repo returns `{ isRepo: false }`. |
| `defaultBranch(repo)` | The repo's default branch as a ref string, or `null`. Prefers the remote HEAD, falls back to a local `main`/`master`. |
| `listWorktrees(cwd)` | `{ ok, repo, worktrees: [{ path, branch, head, isMain, detached, locked }] }`. The primary checkout is flagged `isMain` and comes first. |
| `defaultWorktreePath(repoTop, branch)` | **Sync.** A safe default sibling path for a new worktree, `<repo>/../<repo>-<branch>`. Branch slashes become dashes. |
| `createWorktree(cwd, branch, opts)` | Creates a worktree. With no explicit target the sibling default is chosen and disambiguated with a numeric suffix if taken. |
| `removeWorktree(worktreePath)` | `{ ok }` or `{ ok: false, error }`. Refuses to remove the main working tree — the path must be a registered *linked* worktree. |

You receive **bound wrappers**, not the module itself: the members cannot be
reassigned, and core's own calls to these functions are unreachable from a
plugin. Everything else about them is exactly what core uses.

The membership rule, so you can predict what will and won't appear here: a
utility that **core also uses** may be lent to plugins. A utility only your
plugin uses belongs in your own directory — copy it in, don't ask for it here.

### `host.library`

Mutation of a Clodex library file. Two members in `"1"`:

```js
const res = host.library.remove('memory', { agent: 'clodex', id: 'mem-…' });
// { ok: true } | { ok: false, error: '…' }

const p = host.library.setPin('memory', { agent: 'clodex', id: 'mem-…' }, true);
// { ok: true } | { ok: false, error: 'operator pin limit reached (3) — unpin one first' }
```

`setPin` sets the **operator** pin, which is what guarantees a unit rides the
boot digest in full. It is capped, and past the cap it REFUSES rather than
evicting: the operator set every existing pin deliberately, so which one to drop
is theirs to choose. Show that error text verbatim — it names the limit and the
remedy, which a boolean cannot. The agent's own `pinned` flag is a different
field and is not settable from here; it only orders the recent tier.

Two verbs rather than one flagged verb because the obligations differ: a remove
is terminal, while a pin is refusable and reversible.

Generic in shape, per-kind in implementation. Core owns a `kind -> handler`
table and **a kind with no registered handler is refused** — there is no
fallback to a path unlink. `memory` is the only registered kind.

That refusal is the point of the design rather than a limitation of it. The
library's kinds do not mean the same thing when deleted, and most break
*silently*: a deleted memory leaves live agents serving a stale boot digest
unless it is rewritten (which `remove` does, for a live *claude* session only);
prompts, templates and exec commands are referenced **by name** from `prompt-rails.js`,
`team.json` and every seat's system prompt respectively, so removing one is
discovered by the thing that fails later. A uniform unlink would make it equally
easy to get all four wrong. Adding a kind means answering "what else has to
happen when this file goes away?" — and registering the handler that does it.

`ref` is forwarded to the handler, never interpreted here, so per-kind ref
validation is the handler's job. As with `host.lib`, you receive bound wrappers:
the table cannot be repointed from plugin land.

The return is always rebuilt as `{ ok: true }` or `{ ok: false, error }` — you
never receive the handler's own object. Handlers are synchronous; an async one
is refused rather than handing you a pending promise. `remove` does not throw.

Deletion is **permanent** — no archive, no trash. Confirm with the user first;
`plugins/memory-viewer` shows the unit's body in its confirmation rather than an
id nobody can identify, and names a pinned unit's pinned state on its own line.

### `host.telemetry`

`snapshot(sessionName)` returns a read-only telemetry snapshot for a session
proxied through Clodex's wire proxy, or `null` — for a session with no proxy, no
telemetry yet, or if anything goes wrong. Treat `null` as the normal case.

---

## 5. The renderer `rhost` object

Passed to `module.exports.activate(rhost)` in your `renderer.js`, once per
window. Frozen. Runs in the browser context: `document` is real, and so is the
window your code is in.

```js
rhost = {
  id,                                  // your plugin id
  workspaceId,                         // GETTER — this window's workspace id, or null

  invoke(method, ...args),             // -> Promise, calls YOUR engine half

  sessions: {
    active(),                          // -> session name shown in THIS window, or null
    listWorkspace(workspaceId),        // -> Promise<[session, …]>
  },

  events: {
    on(topic, fn),                     // -> dispose; hears YOUR engine half (§9)
  },

  ui: {
    openPath(path),                    // reveal in the OS file manager
    showToast(msg, opts),              // core's toast host
    statusBar:   { addAction, addSegment },
    sidebar:     { footerButton, rowBadge, requestRelayout },
    sessionMenu: { addProvider },
    settings:    { section },
    surfaces:    { overlay },
  },

  lib: { renderDiffHtml },             // sanctioned shared core leaves

  onDispose(fn),                       // -> dispose
  setInterval, clearInterval,          // host-wrapped — auto-cleared on teardown
  setTimeout, clearTimeout,
  addEventListener, removeEventListener,

  log: { info(...a), error(...a) },    // console, prefixed [plugin:<id>]
}
```

`rhost.id` is your plugin id, as on the engine side.

`rhost.log.info(...)` and `rhost.log.error(...)` write to the window's developer
console, prefixed `[plugin:<yourId>]`. They are `console` wrappers, not the app
log — engine-side `host.log` is what reaches the app's own log.

`rhost.workspaceId` is a **getter**, not a value captured at activation. Read it
when you need it. The window's workspace id is filled in asynchronously during
startup, so a value you snapshot at the top of `activate()` may be `null`
forever.

`rhost.sessions.active()` is the session the user is currently looking at *in
this window*. It uses the same predicate the status bar uses, so your plugin and
the bar can never disagree about what "active" means.

`rhost.sessions.listWorkspace(id)` resolves to that workspace's sessions. Note
it is async here and sync on the engine side — different mechanisms, same idea.
As with the engine half, there is deliberately no `listAll()` on the renderer
side at all.

The **elements are the same objects the engine half's `listWorkspace` returns**
(§4) — same producer, one `await` apart, no renderer-side reshaping:

```js
{ name, type, cwd, workspaceId,      // as on a SessionHandle
  pid, team, ticket, backend,        // core's own sidebar fields
  activity, attention, pendingCount }
```

They are plain data, not SessionHandles: there is no `inject()` or `isAlive()`
here. Anything beyond looking is your engine half's job, through `invoke`. A
failure resolves to `[]` rather than rejecting, so an empty array means "none, or
we could not ask" — do not read it as "the workspace is empty".

`rhost.ui.openPath(p)` reveals a path in Finder/Explorer. `rhost.ui.showToast(msg, opts)`
raises one of Clodex's own toasts, so your errors look like every other error in
the app instead of an `alert()`.

`rhost.lib.renderDiffHtml` renders a unified diff to HTML, the same way core's
own diff views do.

### Cleaning up after yourself

You get three overlapping mechanisms and the host trusts none of them
individually, because disable-without-close (Law 4) is the case where a missed
cleanup leaves callbacks firing against removed DOM in every open window:

1. **Return a function from `activate(rhost)`.** It runs first, while your DOM
   still exists. (Exporting a `deactivate()` works too, but the returned
   function wins if you do both.)
2. **`rhost.onDispose(fn)`** for anything set up out of band. Returns a disposer
   you may call early; calling it twice is safe.
3. **Use the host-wrapped timers and listeners** instead of the globals:
   `rhost.setInterval(fn, ms, …)`, `rhost.setTimeout(fn, ms, …)` and
   `rhost.addEventListener(target, type, fn, opts)`. The host holds the handles
   and clears them itself on teardown, so the most common leaks need no
   discipline from you at all. Their signatures are the globals' — except
   `rhost.addEventListener`, which takes the target as its first argument since
   it is not a method on the target.

   Each has its counterpart — `rhost.clearInterval(handle)`,
   `rhost.clearTimeout(handle)` and
   `rhost.removeEventListener(target, type, fn, opts)` — which both perform the
   removal and drop the host's record of it. Use them rather than the globals
   when you cancel something early, so the host isn't left holding a stale
   handle. Forgetting to is harmless: clearing an already-fired timer is a no-op.

Everything you registered through a UI slot, plus your `<style>` element, plus
any host-created container, is removed for you regardless of what your own code
does or forgets. What the host *cannot* reach is a raw `setInterval`, a raw
`document.addEventListener`, or a `ResizeObserver` you created directly. That's
what 1–3 are for.

---

## 6. The seven UI slots

All seven are registered from your **renderer** half, all return a dispose
function (or, for overlays, an object containing one), and all take a spec whose
`id` is a plain string that the host namespaces to `"<yourId>:<id>"` before it
reaches the DOM. **For `id`, the prefix is the host's business in both
directions**: you never write it, and you never see it. Anything the host hands
back to one of your callbacks — `onPick`'s `act` (§6.5) is the one case —
arrives **unprefixed**, as the bare string you wrote, so you always compare
against your own value.

**That rule covers `id` and nothing else.** In particular it does *not* extend to
the class fields (`accentClass`, and `cls` on a row badge): those reach the DOM
**verbatim**, exactly as you wrote them. The asymmetry is easiest to see on a row
badge, where both appear on the same element — the chip carries a namespaced
`data-plugin-badge="<yourId>:<id>"` and an un-namespaced `class`. So write your
bare class name in `style.css` and it matches.

**Everything you supply is data, never HTML.** Labels, tips and badge text are
escaped by the host and inserted as text. This is not only an injection defence:
it is what lets these same specs survive a future out-of-process plugin tier
unchanged. The one place you build DOM directly is inside a container the host
created and owns (`settings.section`, `surfaces.overlay`).

Registration failures **throw**, immediately, out of your `activate()`: a missing
`id`, or a required callback that isn't a function. A throwing `activate()` is
treated as a failed activation (§10). That is deliberate — a silently dropped
registration is a plugin that looks installed and does nothing.

Callbacks that throw *later*, during a render pass, are caught, logged to the
console, and that one contribution is skipped. One broken plugin never blanks
the status bar or the sidebar for everyone else.

### 6.1 `rhost.ui.statusBar.addAction(spec)`

A button on the right of the status bar, beside core's own session actions.

```js
rhost.ui.statusBar.addAction({
  id: 'review',                        // required, string
  when(ctx) { return ctx.isAgent; },   // required -> boolean
  button(ctx) {                        // required -> { label, tip?, accentClass? } | null
    return { label: '✓ review', tip: 'Review this turn' };
  },
  onClick(anchorEl, ctx) { … },        // required
});
```

`when` decides visibility; `button` supplies the appearance and may return
`null` or an object with no `label` to render nothing. `onClick` receives the
button element (useful for anchoring a popover) and the same context.

`ctx` is frozen and rebuilt for every render pass:

```js
ctx = {
  session,            // active session name in this window, or null
  type,               // 'claude' | 'codex' | 'bash' | 'remote' | null
  isAgent,            // the active session is an agent (not a plain shell)
  peerQueryable,      // active session is a peer session that answers queries
  peerConfigurable,   // active session is a peer session that accepts config
  workspaceId,        // this window's workspace
}
```

<a name="class-fields"></a>
`accentClass` is added to the button's class attribute; define it in your
`style.css`. **A space-separated list of classes is accepted** — `'px-warn
px-bold'` applies both — so you do not need one class per state.

The same field appears on the segment (§6.2) and, under the name `cls`, on the
row badge (§6.4). The two names mean the same thing and behave the same way; the
difference is historical and not a signal. In every case the host appends what
you pass to its own class, so you are adding a class, never replacing the
host's — and it appends it **verbatim**: unlike a spec's `id` (§6), a class field
is never namespaced, so the selector you write in `style.css` is the one that
matches. Keep it distinctive; nothing separates your classes from core's.

### 6.2 `rhost.ui.statusBar.addSegment(spec)`

A text segment in the same bar — status, not a launcher.

```js
rhost.ui.statusBar.addSegment({
  id: 'branch',
  render(ctx) {                        // required -> { text, tip?, accentClass?, onClick? } | null
    return { text: 'main', tip: 'Current branch' };
  },
  onClick(anchorEl, ctx) { … },        // optional
});
```

Return `null`, or an object with no `text`, to render nothing. A segment becomes
clickable if either the returned object or the spec supplies an `onClick`; the
returned one wins.

Segments have one property worth knowing: **a visible segment keeps the status
bar itself alive**. Core hides the bar entirely for sessions that have nothing to
show, so a segment is how a plugin gets a bar for, say, a plain shell session.

### 6.3 `rhost.ui.sidebar.footerButton(spec)`

A button in the sidebar footer, matching core's own (glyph, label, optional
count chip). This is the conventional entry point for a plugin's main surface.

```js
rhost.ui.sidebar.footerButton({
  id: 'open',
  glyph: '⌥',                          // optional, text
  label: 'Workbench',                  // optional, text
  tip: 'Files, Source Control…',       // optional, hover tip
  badge() { return unread || ''; },    // optional -> string|number; falsy = dimmed chip
  onClick(el) { … },                   // required
});
```

The host paints the button on registration and un-paints it on disposal — you
never touch the DOM for it. `badge()` is called on every footer render; keep it
cheap and synchronous.

### 6.4 `rhost.ui.sidebar.rowBadge(spec)`

A small chip on each session row in the sidebar.

```js
rhost.ui.sidebar.rowBadge({
  id: 'dirty',
  resolve(sessionName, meta) {         // required -> { text, tip?, cls? } | null
    return cache.get(sessionName) ?? null;   // SYNC, and never undefined — see below
  },
});
```

`meta` is `{ type, cwd }`. Return `null` (or no `text`) to show no chip on that
row; an existing chip is removed. Note the `?? null`: a `Map` miss is
`undefined`, and the return type is `{…} | null`. Returning `undefined` happens
to render nothing today, but it is outside the contract — say `null` and mean it.

`cls` is a CSS class added to the chip, and takes a space-separated list. It is
the same field §6.1 calls [`accentClass`](#class-fields) — same behaviour, two
names, no significance to the difference.

**`resolve` is synchronous and is called inside the sidebar's render loop, once
per row.** There is no async form, because an awaited badge would stall the
sidebar. The idiom for anything that needs I/O is therefore: return whatever is
in your own cache right now, fill the cache in the background, then call
`rhost.ui.sidebar.requestRelayout()` — a debounced request for another render
pass, at which point your now-populated cache is read.

Two consequences to design for rather than fight:

- **The first render is blank** (§3, Law 2). Nothing pulls on your behalf before
  the sidebar paints, so the first `resolve` for a session runs against an empty
  cache. The chip appears on the relayout you request afterwards.
- **`resolve` is called constantly and must be side-effect free** — see
  [callback conventions](#callback-conventions). Kick your background fill off
  from a *guard* (a name you have not seen before), never from the resolve itself
  unconditionally, or every render pass launches another one.

**Registration does not paint. Call `requestRelayout()` at the end of your
`activate()`.**

This is the one asymmetry in §6 worth stating outright, because the neighbouring
paragraph teaches the opposite lesson. §6.3 says of `footerButton`: *"The host
paints the button on registration and un-paints it on disposal — you never touch
the DOM for it."* **That sentence is true of `footerButton` and false of
`rowBadge`.** Registering a row badge schedules nothing; the first `resolve` runs
whenever core next lays the sidebar out for reasons of its own. Disposal is *not*
symmetric with it either — the host removes your chips immediately when your
plugin is disabled.

So a badge is un-painted eagerly and painted lazily, and the gap is invisible at
startup — the sidebar lays out while the window boots, so a plugin enabled at
launch appears to work. It becomes visible on a **live enable with the window
already open**: nothing about that event touches the sidebar, so your badge does
not appear until something unrelated does — a session's activity, a filter
change, or core's periodic refresh. That wait can be tens of seconds, and it
looks exactly like a plugin that failed to load.

The remedy is one line and it is entirely within this API:

```js
module.exports.activate = (rhost) => {
  rhost.ui.sidebar.rowBadge({ id: 'dirty', resolve });
  …
  rhost.ui.sidebar.requestRelayout();   // ask for the first pass; nothing else will
};
```

Note the second-order trap if your badge polls: a poll driven by "sessions the
sidebar has asked me about" is driven by `resolve`, and `resolve` has not run
yet. Without the line above such a plugin polls an empty set forever and never
recovers on its own — the poll is not a fallback for the missing first paint,
because the missing first paint is what would have populated it.

### 6.5 `rhost.ui.sessionMenu.addProvider(spec)`

Extra entries in a session's ⚙ menu, appended after core's.

```js
rhost.ui.sessionMenu.addProvider({
  id: 'wb',
  entriesFor(type) {                   // required -> [{ act, label }] | anything else = none
    return type === 'bash' ? [] : [{ act: 'inspect', label: 'Inspect…' }];
  },
  onPick(act, sessionName, anchorEl) { // required; `act` is YOUR bare string
    if (act === 'inspect') … ;
  },
});
```

`entriesFor` is called with the session's type and must return an array;
anything else is treated as "no entries". Each entry needs both an `act` string
and a `label`. The host namespaces `act` for the DOM and hands it back to
`onPick` **unprefixed**, so you compare against the string you wrote.

### 6.6 `rhost.ui.settings.section(spec)`

A section inside your plugin's row on the `Manage Plugins…` dialog, for your
plugin's own settings.

```js
rhost.ui.settings.section({
  id: 'prefs',
  title: 'My Plugin',                  // optional <h3>
  render(bodyEl, values) {             // required — build your form into bodyEl
    bodyEl.innerHTML = '';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!values.verbose;
    bodyEl.appendChild(cb);
  },
  collect(bodyEl) {                    // required -> a patch object, or null
    return { verbose: bodyEl.querySelector('input').checked };
  },
});
```

`render` is called each time the user expands your row's `Settings` panel, with
`values` being your current persisted settings (the same object
`host.settings.get()` returns engine-side).
`collect` is called when the user saves; the object you return is
**shallow-merged** into your settings. Return `null` to save nothing.

Note the split of responsibilities: settings *organized by plugin* is the point
of this slot, but **choosing which plugins are enabled is not a preference** and
does not live here. That is the `Plugins` menu (§10).

Nothing in this slot lets you read another plugin's settings, or write your own
from the renderer outside of `collect` — see [§13](#13-what-is-deliberately-not-exposed).

### 6.7 `rhost.ui.surfaces.overlay(spec)`

A full modal surface — the slot for a plugin's main UI.

```js
const surface = rhost.ui.surfaces.overlay({
  id: 'main',
  mount(rootEl) { rootEl.innerHTML = MY_HTML; wireUp(rootEl); },  // required
  onOpen(opts) { … },                  // optional
  onClose() { … },                     // optional
});
// -> { open(opts), close(), dispose() }
```

The host creates `<div class="plugin-overlay hidden" data-plugin="<yourId>">`,
appends it to `document.body`, and calls `mount(rootEl)` **once, lazily, at the
first `open()`**. From then on it only toggles visibility — `mount` is not called
again, so put one-time construction there and per-open refresh in `onOpen`.

The host owns: the container, showing and hiding it, Escape-to-close, and the
rule that only one plugin overlay is open at a time (opening yours closes
another's, firing that one's `onClose`). It also removes the container
**wholesale** when your plugin is disabled, so teardown never depends on your
own cleanup being right.

You own everything inside `rootEl`. Scope your lookups to it —
`rootEl.querySelector('#thing')`, not `document.getElementById('thing')`. Element
ids inside your overlay are per-window unique (each window is its own document),
so they will not collide across windows, but they *can* collide with core's ids
in the same document if you pick a common one. Prefix them.

### Slot ordering

**Unspecified. Do not depend on it.** Within one plugin, contributions to a slot
appear in the order you registered them. *Across* plugins, the order is
discovery order, which is directory-name order — arbitrary from your point of
view, and not something a user can influence. If a future version adds a way to
control this, it will be an optional field that older plugins simply don't use.

---

## 7. Intents — contributing an `[agent:…]` verb

Clodex agents emit bracketed intents in their output — `[agent:dm bob] hi` — and
Clodex parses and acts on them. A plugin's engine half can add a verb.

```js
const off = host.intents.register({
  verb: 'review',                                   // required
  parse(line) {                                     // required
    const m = line.match(/^\[agent:review\s+(\S+)\]\s*(.*)/s);
    return m ? { target: m[1], body: m[2] } : null;
  },
  bodyMode(intent) { return 'greedy'; },            // optional
  label: 'Review',                                  // optional, for the UI checklist
  promptLines: '  [agent:review <target>] body',    // optional, for the agent's prompt
  handler(handle, intent) { … },                    // optional — NOTE the order
});
```

- **`verb`** must match `/^[a-z0-9][a-z0-9._-]{0,31}$/` and must not collide with
  a core verb or another plugin's. Core's verbs are reserved, as are the three
  structural ones (`end`, `escape`, `unknown`) — a plugin that shadowed those
  could eat body terminators or escapes. **Verbs share ONE GLOBAL namespace.**
  Your plugin id does not namespace them and is not prefixed onto them: register
  `review` and the line agents write is `[agent:review …]`, never
  `[agent:yourid:review …]`. That single namespace is exactly why collisions are
  refused — pick a verb distinctive enough to survive in it. See
  [choosing a verb](#choosing-a-verb-is-a-compatibility-decision) below: this is
  the one field where a name collision with a plugin you have never seen stops
  your plugin from running.
- **`parse(line)`** receives one cleaned, trimmed line and returns your intent
  object or `null`. Your returned object always has `type` set to your verb by
  the host, whatever you put there; you cannot impersonate another verb. A
  `parse` that throws is treated as "no match".
- **`bodyMode(intent)`** is a **function of the parsed intent**, not a flag,
  returning `'none'`, `'greedy'` or `'json'`. `'greedy'` captures following lines
  as a body until a bare `[agent:end]` or the next intent; `'json'` captures a
  single complete JSON value; `'none'` (the default, and the fallback for any
  other return value) captures nothing. It is a function because the right answer
  often depends on a sub-command — one form of your verb may take a body while
  another must not.
- **The captured body arrives on `.body`, and you do not get to choose the
  name.** This is the one field the host writes onto *your* object. Nothing in
  the API announces it, so it is stated here rather than left to be discovered:
  the host takes the object your `parse` returned, sets `type` to your verb, and
  — once the body capture completes — assigns the captured text to `.body`. The
  captured text is **appended to whatever `.body` already held**, joined with a
  newline, so the same-line remainder your `parse` returned is preserved and the
  following lines are added to it. Two consequences worth stating plainly:
  **(a)** with `bodyMode` returning `'none'`, nothing is ever assigned and
  `.body` is exactly what your `parse` put there; **(b)** if you return a
  `.body` that is *not* the same-line remainder — a parsed structure, say — the
  host will concatenate raw text onto it and hand your handler the wreckage.
  Put same-line text in `.body` and everything else under your own property
  names.
- **`label`** is what the user sees in the per-seat intent checklist. Defaults to
  `"<verb> (plugin: <yourId>)"`.
- **`promptLines`** is documentation injected into an agent's system prompt, and
  only for seats that have actually been granted your verb.
- **`handler(handle, intent)`** runs your verb. **The handle comes first.** It is
  the same **SessionHandle** `onCreate`/`onExit` receive (§4) — minted by the
  host, never the raw session object — and it is how your verb knows *who* emitted
  the line: `handle.name`. The second argument is the object your own `parse`
  returned, with `type` set to your verb. Reply through `handle.inject(text)`;
  there is no return-value channel. Handlers run for **agent** sessions only — a
  bash pane never dispatches one, because injecting into a shell would type the
  text at the operator's prompt.

Three guarantees on `handler`, stated as guarantees because you are meant to
build on them rather than defend against them:

**It is called exactly once per matched line.** Not "usually once" — once, by
construction, and you do not need a de-duplication guard. Three independent
mechanisms each enforce it on their own: PTY scanning runs only for non-agent
sessions, so a session's two possible feeds are mutually exclusive; dispatch
refuses any session that is not an agent, so a bash line could not reach your
handler even if it were scanned; and an agent session's intent feed is one
source or the other, never both, with the live path additionally de-duplicating
identical intents within a turn. Put your non-idempotent side effect in a handler
with that in hand — this is the one callback in the API that earns it (see
[callback conventions](#callback-conventions)).

**A throw becomes a bounce, not a crash.** Your exception is caught, logged, and
injected back to the emitting seat as `[agent:<verb>] error: <message>`. You do
not need to wrap your handler body in a try/catch to protect the app or to tell
the agent something went wrong — throwing *is* the error channel, and the agent
that wrote the line is who hears about it. Catch only when you want a different
message than your exception's.

**A returned promise is logged and ignored.** Handlers are synchronous, like the
session hooks. An `async handler` will run, but nothing awaits it: its rejection
escapes every guard above, so its failure becomes silence rather than a bounce.

### Choosing a verb is a compatibility decision

Every other name you pick is yours. Your plugin id namespaces your settings, your
storage, your IPC methods and your DOM nodes, so two plugins can both have a
`refresh` method and never meet. **A verb is the exception.** It is drawn from one
global namespace shared with every plugin the user has installed — including
plugins you have never seen, written by people you will never talk to, installed
years after you shipped.

So `host.intents.register` refuses a verb another plugin already holds, and the
plugin that asked for it **does not load**. Not a degraded mode with the rest of
its features working: its `activate()` threw, so nothing it registers survives.
A generic verb is therefore not a style preference — it is a latent
incompatibility with plugins that do not exist yet. `notes`, `run`, `sync`,
`search` and `open` are the kind of name two authors pick independently. Prefer
something recognisably yours: `gitbranch` over `branch`, `potdrawer` over
`drawer`.

The refusal is safe and legible — no strike, no quarantine, and the user is told
which plugin holds the verb (see [failure and quarantine](#failure-and-quarantine)).
But the remedy is to change one of the two verbs, and if yours is the one that
shipped to other people, changing it changes the line their agents write. That is
why the choice is worth a minute at design time and expensive afterwards.

**Which plugin wins is not something you can rely on.** It is not who registered
first in any meaningful sense — see
[plugin-sources.md §4a](./plugin-sources.md#4a-verbs-share-one-global-namespace)
for the ordering and its known limits. Write your plugin so that losing is
survivable information for the user, not a scenario you tried to win.
If you need async work, do the synchronous part, schedule the rest, and inject
the result when it lands.

Two rules you cannot opt out of:

**Plugin verbs are always privileged.** Whatever you pass, the host forces it.
Privileged means the verb is *off* for every seat unless the user has explicitly
granted it. There is no way to ship a verb enabled-by-default, and that is
intentional: a plugin that could grant itself a verb retroactively across every
seat that ever existed is not a plugin, it's a surprise.

> **Read this before you debug a verb that "does nothing".** The consequence of
> the rule above is that a freshly installed plugin's verb is inert on every
> existing seat, and **the failure is silent**: the line the agent wrote is not
> parsed as your verb, your `parse` is never consulted, your handler never runs,
> and *nothing is logged* — to the agent it reads as an unrecognised intent. It
> is working exactly as designed and looks identical to a broken registration.
>
> To make it fire: the session's ⚙ menu → the intent checklist → tick your verb,
> per seat. Grant it to a seat before you conclude anything about your code, and
> say so in your plugin's README — every one of your users hits this once.

**Registration throws on a bad shape or a collision.** A refused verb must be an
activation error you see, not a verb you believe you own that never fires.

**Registration is global, dispatch is not.** One `register` call makes your verb
recognisable everywhere Clodex scans for intents — there is no way to register on
one feed and not another. That is a statement about *where the verb is known*,
not about how often it runs: `parse` may be consulted on any feed that produces
a candidate line, including a bash pane's, which is harmless because `parse` is
pure and merely returns a value. `handler` is the asymmetric one, and it is
agent-only and once-per-line, as above. If you are deciding where to put a side
effect, that sentence is the whole answer: never in `parse`, always in `handler`.

On deactivation every row you registered is removed, twice over: once through the
normal disposal ledger, and once by a sweep of anything still claiming your
plugin as its source.

---

## 8. Talking between your halves: `invoke`

Your renderer half cannot touch the filesystem, the session manager, or anything
privileged. It asks your engine half.

Engine side:

```js
host.ipc.handle('fs.list', async (relPath) => {           // -> dispose
  return { ok: true, entries: await read(relPath) };
});
```

Renderer side:

```js
const r = await rhost.invoke('fs.list', 'src');
```

`rhost.invoke(method, ...args)` always calls **your own** plugin. There is no
way to invoke another plugin's method, by design.

Method names are namespaced by the host to `"<yourId>:<method>"`, so two plugins
cannot collide. Registering the same method name twice replaces the first
silently — the last registration wins.

Arguments and return values cross a process boundary and are structured-cloned,
so they must be plain data: no functions, no class instances, no DOM nodes.

Return whatever shape you like. Clodex does not wrap your result — the object you
return is the object the caller gets. The convention in the pilot plugin is
`{ ok: true, … }` / `{ ok: false, error }` and it reads well, but it is a
convention, not a requirement.

**Distinguishing your failures from the host's.** If your handler throws, the
caller gets `{ ok: false, error: "<your message>" }`. If the call could not be
routed at all — plugin disabled, not loaded, no such method, plugins switched off
entirely — the caller gets exactly:

```js
{ ok: false, error: 'no such plugin method' }
```

That exact string is the discriminator. Nothing ever resolves `undefined`,
because an undefined resolution is indistinguishable from a successful call that
returned nothing.

There is one more host refusal, in the same envelope shape:

```js
{ ok: false, error: 'plugin method not available on this surface' }
```

The caller is the browser client and the method is not marked `"any"` in your
manifest (§2.2). Note it is a *different* string from the routing refusal above,
and deliberately only reachable for a method that exists — a method that does
not exist answers `'no such plugin method'` on both surfaces, so the two
refusals cannot be used to discover which of your methods are desktop-only.

An `async` handler is awaited. A handler that never settles hangs the caller;
Clodex imposes no timeout.

---

## 9. Events

Engine → renderer, one direction only.

```js
host.events.emit(topic, payload, scope);
```

`scope` is **required** and must be one of:

| Scope | Reaches | Dropped when |
|---|---|---|
| `{ session: name }` | the window showing that session's workspace | that workspace has no open window |
| `{ workspace: id }` | that workspace's window | it is closed |
| `'all'` | every open window, every workspace | — |

An omitted or malformed scope is **a logged no-op, not a broadcast**. There is no
default, because every plausible default is wrong in one direction or the other.

`'all'` carries **invalidation hints only**. A broadcast reaches every workspace,
so a data payload on `'all'` is a cross-workspace leak. Say "the thing changed";
let each window pull what it needs. This one bites for real now that `events.on`
exists: an `'all'` payload used to be discarded renderer-side, and today it is
delivered into every workspace's renderer half.

Renderer side, subscribe during activation:

```js
module.exports.activate = (rhost) => {
  const off = rhost.events.on('changed', (payload) => { /* re-render */ });
  return off;   // or let dispose() collect it — see §11
};
```

`events.on(topic, fn)` returns a disposer, and the host releases every listener
on teardown whether you call it or not. You hear **your own** engine half only:
`emit` is your plugin's channel, not a bus, so another plugin's topics never
reach you.

Listeners are **synchronous**, like the session hooks in §4. A throwing listener
is caught and logged per-plugin and the others on that topic still run — but an
`async` listener's rejection escapes that catch and surfaces as an unhandled
rejection, so do the work in a plain function and hand off if you need `await`.

Events are unbuffered (Law 2). A window that opens after your emit hears
nothing, which is precisely why pull-on-open is the contract rather than a
suggestion.

> **`events.on` does not replace pull-on-open.** It removes the polling you would
> otherwise need *between* opens. Your surface must still pull its own state when
> it opens, because an emit that happened while this window was closed is gone —
> nothing buffers it. Design the pull first, then add `events.on` to avoid the
> timer. Scope is applied main-side, so if a listener fires, this window was an
> intended recipient of that scope.

---

## 10. Lifecycle: enable, disable, failure, quarantine

### Where the user turns a plugin on and off

A top-level **`Plugins`** menu in the menu bar, with one checkbox per discovered
plugin, and a `Manage Plugins…` item opening a dialog with descriptions,
versions, errors and a Retry button. If there are no plugins at all, the whole
menu is absent rather than empty.

Enabling and disabling is **not** in Preferences, deliberately: it tears down
live DOM in every open window, which is not what a preference does. Your own
settings are not in Preferences either — they open from a `Settings` button on
your row in that same dialog, via the `settings.section` slot (§6.6).

### Startup

1. Clodex scans `plugins/*/manifest.json`, in directory-name order.
2. Each valid manifest is checked against the enabled set (the user's explicit
   choices, falling back to your `enabledByDefault`) and against quarantine.
3. For each plugin that survives: `require(entry.engine)`, then
   `activate(host)`. Both are inside one try/catch, because this runs before any
   window exists — an uncaught throw here would kill startup with no window from
   which to repair the plugin.
4. Each window, as it opens, pulls the catalog and activates the renderer half of
   every loaded plugin: `require(entry.renderer)`, inject `style.css` as a
   `<style>` element, `activate(rhost)`.

One plugin's failure is its own. The others load.

### Runtime toggle

Disabling runs, in order: your engine half's `deactivate()` if you export one
(best-effort — its throwing is logged and ignored), then **unconditional** host
teardown of every dispatch method, intent row and session hook you registered.
The host does not trust your teardown; it merely gives it the first chance. Then
a hint goes to every open window, and each window disposes its own renderer half
locally — the engine cannot reach into a window's registries, and pretending
otherwise is how the multi-window blind spot returns.

Enabling does the reverse, live: the engine half is required and activated, and
every open window activates its renderer half.

Because plugins are in-process JavaScript, a **truly complete** unload is the
restart boundary. Disable removes everything reachable — DOM, styles, handlers,
timers, listeners, verbs, rows — which is enough for the plugin to be gone from
the user's point of view, but Node's module cache still holds your code.

### Failure and quarantine

If your `activate()` throws — either half — that is a **strike**, recorded
persistently. With one exception: **a verb collision is refused, not punished**
(below).

- Two consecutive strikes and the plugin is **quarantined**: it is skipped at
  the next launch. One throw is often transient (a half-written file, a missing
  directory on first run), and quarantining on it turns a blip into something the
  user has to go re-enable.
- A **renderer** strike is counted once per *app run*, not once per window. Three
  open windows would otherwise mean three strikes and instant quarantine on the
  first bad launch.
- Any successful activation clears the count. "Consecutive" means consecutive.

**Quarantine never overwrites the user's choice.** The enabled set records what
the user asked for; quarantine is a separate counter that *shadows* it. So the
UI can honestly say "you have this enabled, but it is being held back after 2
failed launches, here is the error" — and the moment the plugin is fixed, the
user's original intent is still there. In the `Plugins` menu, a quarantined
plugin still appears, still shows its tick (intent), and says it is held back;
re-ticking it is the retry.

Re-enabling clears the strike counter *first*, so a user who fixed the plugin is
never refused by a stale strike, and a still-broken one starts counting again
from zero.

**A verb collision is the one activation failure that takes no strike.** If your
`activate()` fails because another plugin holds your verb, your plugin does not
load — but it is never quarantined, however many times it happens. The counter
exists for plugins that *crash*, and a collision is a knowable structural
refusal: your plugin is fine, the verb is taken. Striking for it used to
quarantine a plugin that had been working for months because the user installed
an unrelated one, under a message that named neither the verb nor the other
plugin, and Retry could not clear it because the collision reproduces on every
attempt.

Instead, the `Plugins` menu row says which verb is contested and which plugin
holds it, and the remedy — disable one of the two, or change one of the verbs —
is the user's to make. The record is per app run and is never persisted: it
describes which plugins are loaded right now, and a stored one could outlive the
plugin that caused it.

### The kill switch

`CLODEX_PLUGINS=0` in the environment skips the loader entirely: no plugin loads,
the `Plugins` menu is absent, and every plugin call returns the shaped refusal.
Only the exact string `0` disables — an unset or empty variable, or any other
value, leaves plugins on, so a typo fails safe toward normal behaviour.

If you are debugging whether a problem is yours, this is the first thing to try.

---

## 11. The transport, and why it is five rows

Everything a plugin does across the process boundary rides five IPC rows, and
that number is fixed for every plugin, forever:

| Row | Channel | Carries |
|---|---|---|
| `pluginInvoke` | `plugin:invoke` | `(pluginId, method, args)` — every plugin call |
| `pluginCatalog` | `plugin:catalog` | what is loaded, for a window to activate |
| `pluginSetEnabled` | `plugin:setEnabled` | the toggle |
| `onPluginEvent` | `plugin-event` | `(pluginId, topic, payload)` |
| `getIntentCatalog` | `intents:catalog` | the intent grammar, including plugin verbs |

`plugin:invoke` is one multiplexed channel over a dispatch map the engine owns,
rather than a channel per plugin. That is not tidiness: the IPC transport has no
way to *unregister* a channel, so per-plugin channels could never be removed and
`dispose()` would be a lie at every level of this API. Mutating a map is a
disposal primitive; unregistering a channel is not available. Everything
disposable in this document bottoms out there.

Host plumbing that is not a plugin's own method — reading and writing settings,
resolving a renderer half, listing plugin status, reporting an activation
outcome, the enable/disable hint — rides these same rows under a reserved
pseudo-plugin id, `_host`. That id can never collide with a real plugin, since
plugin ids may not begin with an underscore. Plugins cannot call it (§13).

**What the five-row freeze does and does not mean.** It caps the **plugin
transport**: a plugin gets these five rows and no sixth, ever, so plugin count
cannot inflate Clodex's IPC surface. It does **not** cap Clodex's own total row
count — core may add rows for its own chrome (the `Plugins` menu's open-dialog
request is one). The point was never a ceiling to defend; it was that moving
fourteen data methods out of core into the pilot plugin *shrank* core's contract,
and the freeze is what stops that gain leaking back one convenience row at a
time.

---

## 12. Boundaries: what the test suite refuses

These are not style guidelines. Each is a test that fails the build.

- **No Electron in an engine half.** `require('electron')` anywhere under
  `plugins/*/engine.js` (and its plugin-local requires) fails. Engine halves are
  plain Node because the same engine runs headless, with no Electron at all.
- **No backdoors, either half.** A file under `plugins/` may require Node
  builtins and relative paths that stay **inside its own plugin directory**.
  `require('../../session-manager')`, `require('electron')`, and reaching for
  `window.api` are all refused. Core is reachable **only** through the `host` /
  `rhost` argument. That argument is the versioned surface; reaching around it is
  exactly the coupling this API exists to remove.
- **Subprocesses are allowed.** An engine half may `require('node:child_process')`
  and spawn whatever it needs. A plugin owning its own child process is a design
  goal, not a loophole left open by an under-specified lint — the accepted-module
  list names `node:child_process` explicitly. Shelling out to a CLI the user has
  already authenticated (`gh`, `kubectl`, `docker`) is the intended way to reach
  an external service, and it keeps credentials out of your plugin entirely: the
  CLI holds the token, you hold none.
- **No manifest escape.** Entry and style paths must resolve inside your
  directory (§2). The static lint cannot see a path assembled in a manifest, and
  the runtime check cannot see a require buried three files deep — hence both.
- **The app must work with plugins off.** `CLODEX_PLUGINS=0` is tested to yield a
  working app with no trace of any plugin.

If you need something core has and the host does not offer, the answer is to
propose adding it to the host — not to reach past it. A plugin that reaches past
it is a plugin that breaks on the next refactor and takes the blame with it.

---

## 13. What is deliberately not exposed

Each of these is a decision, not an oversight. If you have a real use case for
one, it is a conversation about extending the host, not a gap to route around.

- **Clodex's persistence stores.** Sessions, workspaces, peers, teams — none of
  it. You get `storage` (your own file) and `settings` (your own key). A plugin
  cannot corrupt `sessions.json` because it cannot reach it. The one exception
  is `host.library.remove` (§4): deletion only, for registered kinds only, and
  every kind's side effects are core's to perform. There is still no read, no
  write and no create against the library.
- **`fs` beyond `storage`.** Your engine half is plain Node and *can* `require('node:fs')`
  — nothing stops you, and the workbench pilot does exactly that. What the host
  does not do is hand you a filesystem helper that has already decided which
  directory is safe. `fsScope` is how you find out, and it is deliberately a
  question you have to ask per session rather than an ambient capability.
- **The session manager itself.** You get named accessors and an opaque
  `SessionHandle` with four fields and two methods. No raw session object, no
  PTY, no persistence entry ever crosses. Anything more is a deliberate future
  host addition, never a reach-in.
- **Spawning sessions, or mutating a session's command line.** A plugin cannot
  create a session or change what gets executed.
- **Peer and remote-server internals.** Peer sessions are visible as sessions
  with `type: 'remote'` and are refused by `fsScope`. The peer wire is not
  reachable, and plugin channels are not on the peer query whitelist — a plugin's
  methods are unreachable across the network by construction.
- **A desktop-only method, from the browser client.** The browser surface is a
  real caller of your engine half — that is the point of it — but only for the
  methods you marked `"any"` (§2.2). Everything else is refused in the host
  before your handler runs. This one is not a decision *you* are exempt from
  making: the default denies, so a plugin that never thinks about surfaces is
  desktop-only rather than accidentally networked. Scope it exactly, though:
  `surfaces` gates `invoke` and only `invoke`. Intent verbs (§7) and session
  hooks (§4) fire from turn text and session lifecycle, reachable by anything
  that can write a PTY, and no surface check stands in front of either.
- **The IPC transport seams.** You cannot register your own channel. §11 says why.
- **Another plugin.** `rhost.invoke` binds your id; `host.settings` binds your
  id; there is no plugin-to-plugin API and no directory of loaded plugins with
  callable methods.
- **The `_host` pseudo-plugin.** Its methods take a plugin id as an *argument* —
  which is precisely why plugins cannot reach it. An openable `_host` would let
  plugin A write plugin B's settings. It is not, however, gated by surface: the
  browser client's plugin UI cannot function without it, so `_host` answers on
  both surfaces including `settings.set`. Design for that — see the warning in
  §2.2 about never storing a path or a command in `settings`. The practical
  consequence to design
  around: **your renderer half has no direct read of its own settings.** Values
  reach it as the second argument to `settings.section`'s `render(body, values)`,
  or from your engine half over `invoke` — add a `settings.get` method to your
  own engine half if you need one, which is three lines and keeps the boundary.
- **`window.api` from a renderer half.** Everything core offers a plugin is on
  `rhost`. The lint enforces it.

---

## 14. Known gaps and unspecified behaviour

Honest inventory as of `"1"`. These are stated so that a future addition is
*additive* rather than a surprise, and so you do not build on sand.

- **No menu slot.** A plugin cannot contribute an item to the system menu bar.
  This is the most likely v1.1 addition and is now a real candidate rather than a
  blocked idea: the plumbing that would carry it (the app menu reading plugin
  state from the engine) already exists, wired for the `Plugins` menu itself. The
  conventional entry point today is a sidebar footer button (§6.3).
- **`fsScope` refuses peers, but neither scopes workspaces nor confines the cwd** (§4). It answers
  "does this session have a local working directory?", not "is this session mine to touch" and not
  "is this path inside it". Nothing else supplies the missing halves: the plugin transport discards
  the calling window before dispatch, so your engine half is never told which workspace asked; and
  no host code sees the paths you build from the cwd it returns. If a session name can reach your
  handler from somewhere you do not control, a cwd in another workspace is reachable through it.
  Compare `handle.workspaceId` against a workspace you established yourself when that matters to
  you, and confine your own path joins (a lexical check is not enough — a symlink inside the cwd
  resolves out of it). Closing the workspace half in the host would mean carrying a caller workspace
  on the transport — additive, but not yet decided. The transport now carries a caller *surface*
  (§2.2), which is the same shape of fact and shows the plumbing is available; it answers "desktop
  or browser", not "which window", so it does not close this gap.
- **Your `style.css` is not scoped.** The host injects it verbatim as a single
  `<style data-plugin-style="<yourId>">` in the shared document — the text is not
  rewritten, wrapped or prefixed, so your selectors match anywhere in the window,
  including core's own DOM and other plugins' surfaces. Nothing stops a plugin
  restyling the app; the `data-plugin-style` attribute exists so the sheet can be
  removed wholesale at disable, not to confine it. This is the same posture as
  the rest of §13 — **contract, not containment** — and the same reasoning: with
  `contextIsolation: false` a plugin that wanted to restyle core could do it from
  JavaScript regardless, so a CSS scoper would buy appearance rather than safety.
  Keep your selectors under your own class names (`cls`/`accentClass` reach the
  DOM verbatim, §6) and prefix them so two plugins do not collide.
- **`inject` has no delivery feedback** (§4). It returns `undefined` in every
  case — written, queued, parked and dropped are indistinguishable from the
  caller. There is no acknowledgement channel and no plan for one at `"1"`; a
  plugin that must know its text arrived has to observe the effect instead. The
  four rules that follow from this, including the newline hazard, are with
  `inject` itself in §4 rather than here, because they bite while you are
  writing the call rather than while you are designing around a gap.
- **A renderer half cannot ask which surface it is running on** (§2.2). There is
  no `rhost.surface`. A UI built against a desktop-only method therefore looks
  identical in the browser until the call comes back refused — so handle the
  refusal string rather than assuming a method you registered is callable.
- **`surfaces` is per method name, and method names are yours to choose.**
  Nothing correlates an entry with a `host.ipc.handle` registration, so renaming
  a method and forgetting the manifest silently makes it desktop-only. It fails
  closed, which is the right direction, but it fails *quietly*.
- **Slot ordering across plugins is unspecified** (§6). Do not depend on it.
- **Events are unbuffered, so `events.on` is not a state feed** (§9). A window
  closed at emit time never learns. Pull on open; subscribe to skip the timer.
- **`rhost.sessions` has no `listAll()`** and never will; if you need the global
  picture, ask your engine half.
- **`sidebar.rowBadge.resolve` is sync-only** (§6.4). The cache-plus-relayout
  idiom is the supported pattern, not a workaround.
- **No change notification for session data** (§4). `onCreate` and `onExit` are
  the complete lifecycle set, and nothing else tells you a session's world moved:
  a `git checkout`, a branch rename, a file appearing, a cwd's contents changing
  all happen in silence. `events.on` (§9) lets your engine half push an
  invalidation once it knows — but nothing tells *it* either, so the gap is the
  detection, not the delivery.
  **The practical consequence: the freshness of anything you cache is bounded by
  how often you re-ask, not by when the data changed.** A plugin whose data can
  change out from under it must own that — a TTL, a re-resolve on the user
  looking at something, a refresh on your own surface opening. Pick a bound and
  state it in your README; there is no host mechanism that will do better, and a
  badge that is silently ten minutes stale is worse than one that says so. This
  is a real constraint on what is writable at `"1"`: plugins that *report* are
  straightforward, plugins that must be instantaneously *correct* are not.
- **`onCreate` at runtime-enable**: a plugin enabled while sessions are already
  running gets no `onCreate` for them — they were created before it existed.
  (Sessions *restored* at launch are fine: restore routes through `create()`, so
  the hook fires normally.) Resolve on demand rather than enumerating; §4 has the
  pattern.
- **`catalog()[].enabled` means "loaded", not "the user wants it"** — it is
  `true` for everything in the catalog by construction, since the catalog lists
  what successfully activated. The user's *intent*, and the quarantine state, are
  not part of a plugin's own view of the world.
- **Packaged builds**: the plugins directory shipped with the app lives inside
  `app.asar`, which is read-only and replaced wholesale by every update — so a
  plugin cannot be added *there*. Add it to `~/.clodex/plugins/` instead, which
  is scanned as a second root and which no update touches
  ([`plugin-sources.md`](./plugin-sources.md) §2). The two roots are not
  interchangeable: a user copy sharing an id with a shipped plugin is shadowed
  rather than merged (§4 there).

---

## 15. Versioning

`hostApi` is a single string, currently `"1"`, and it is a compatibility gate:
a manifest naming a version this host does not serve is refused by name rather
than half-activated against a surface it predates.

**Additive changes do not bump it.** A new UI slot, a new member on `host` or
`rhost`, a new optional manifest field — these ship as "1.1 behaviour" that
existing `"1"` plugins simply do not use, and this document records when each
arrived. The version goes to `"2"` only for a change that could break a
conforming `"1"` plugin.

**`surfaces` (§2.2) is a borderline case, and it did not bump.** It is a new
optional manifest field, so by the rule above it is additive — but its default
*removes* reach a `"1"` plugin previously had: before it existed, every plugin
method was callable from the browser client. A third-party plugin with a
renderer half will lose its browser functionality until it adds the field.

It stays at `"1"` because the alternative is worse in the direction that
matters. The old behaviour was not a documented guarantee — nothing in this
document ever said the browser surface could call arbitrary plugin methods, and
§13 has always claimed the opposite posture — and bumping to `"2"` would refuse
every existing plugin by name in order to protect a capability that was a
defect. The failure a plugin author sees is a refusal string with a name that
says what to do, on a call they can retry after one manifest line. That is a
"1.1 behaviour" with a rough edge, not a contract break.

What that means for you: write `"hostApi": "1"`, and expect this document to grow
new sections rather than contradict existing ones. If a section here ever
contradicts a later one, this document is wrong and the code is right — that is
worth a bug report.
