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
  style.css        optional — injected as a per-plugin <style>, per window
```

At least one half is required. A plugin with only an engine half is a pure data
or automation plugin (it can register intent verbs and session hooks, and has no
UI). A plugin with only a renderer half is pure UI with no privileged access.
Most useful plugins have both, because the renderer half cannot touch the
filesystem or the session manager — it asks its engine half to.

The directory name **is** the plugin id. They may not differ.

Discovery scans `<repo>/plugins/*/manifest.json` and nothing else. `~/.clodex/plugins/`
is not scanned in this version — see [Known gaps](#14-known-gaps-and-unspecified-behaviour).

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
- `set(patch)` **shallow-merges** the patch into your object.

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

**`fsScope(name)`** is the one you must use before touching the filesystem on a
session's behalf. It returns `{ cwd }` for a local session with a working
directory, and otherwise `{ error }` where error is:

- `'Session not found'` — no such session,
- `'remote'` — the session lives on a *peer* machine, so there is no local
  filesystem to read (render this as a "not available for remote sessions"
  notice; the string is stable and matchable),
- `'Session has no working directory'`.

This refusal is a **host guarantee**, not advice: it is the same guard core uses
for its own filesystem IPC, so a plugin that routes every filesystem handler
through it cannot accidentally widen access to a remote session. The idiom:

```js
const scoped = (fn) => async (name, ...rest) => {
  const r = host.sessions.fsScope(name);
  if (r.error) return { ok: false, error: r.error };
  return fn(r.cwd, ...rest);
};
host.ipc.handle('fs.list', scoped((cwd, rel) => listDir(cwd, rel || '')));
```

Note what `fsScope` does *not* do: it does not scope across workspaces. That is
`listWorkspace`'s job.

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

`onCreate` fires at the tail of session creation. Whether it fires for sessions
*restored* at app launch depends on whether restore routes through create; do
not rely on either answer — if you need to know about pre-existing sessions,
call `listAll()` at activation and reconcile.

Both return a dispose function. You do not have to call it: everything you
register is torn down for you when your plugin is disabled (§10).

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
reaches the DOM. **The prefix is the host's business, in both directions**: you
never write it, and you never see it. Anything the host hands back to one of your
callbacks — `onPick`'s `act` (§6.5) is the one case — arrives **unprefixed**, as
the bare string you wrote, so you always compare against your own value.

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

`accentClass` is a CSS class name added to the button; define it in your
`style.css`.

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
    return cache.get(sessionName);     // SYNC — see below
  },
});
```

`meta` is `{ type, cwd }`. Return `null` (or no `text`) to show no chip on that
row; an existing chip is removed.

**`resolve` is synchronous and is called inside the sidebar's render loop, once
per row.** There is no async form, because an awaited badge would stall the
sidebar. The idiom for anything that needs I/O is therefore: return whatever is
in your own cache right now, fill the cache in the background, then call
`rhost.ui.sidebar.requestRelayout()` — a debounced request for another render
pass, at which point your now-populated cache is read.

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

A section inside the app's Preferences dialog, for your plugin's own settings.

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

`render` is called each time Preferences opens, with `values` being your current
persisted settings (the same object `host.settings.get()` returns engine-side).
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
  refused — pick a verb distinctive enough to survive in it.
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
- **`label`** is what the user sees in the per-seat intent checklist. Defaults to
  `"<verb> (plugin: <yourId>)"`.
- **`promptLines`** is documentation injected into an agent's system prompt, and
  only for seats that have actually been granted your verb.
- **`handler(handle, intent)`** runs your verb. **The handle comes first.** It is
  the same **SessionHandle** `onCreate`/`onExit` receive (§4) — minted by the
  host, never the raw session object — and it is how your verb knows *who* emitted
  the line: `handle.name`. The second argument is the object your own `parse`
  returned, with `type` set to your verb. Reply through `handle.inject(text)`;
  there is no return-value channel, and a returned promise is logged and ignored
  (handlers are synchronous, like the session hooks). A handler that throws
  becomes an `[agent:<verb>] error: …` bounce injected back to the seat, not a
  crash. Handlers run for **agent** sessions only — a bash pane never dispatches
  one, because injecting into a shell would type the text at the operator's
  prompt.

Two rules you cannot opt out of:

**Plugin verbs are always privileged.** Whatever you pass, the host forces it.
Privileged means the verb is *off* for every seat unless the user has explicitly
granted it. There is no way to ship a verb enabled-by-default, and that is
intentional: a plugin that could grant itself a verb retroactively across every
seat that ever existed is not a plugin, it's a surprise.

**Registration throws on a bad shape or a collision.** A refused verb must be an
activation error you see, not a verb you believe you own that never fires.

Your verb is live on every input feed at once — there is no way to register on
one and not another. On deactivation every row you registered is removed, twice
over: once through the normal disposal ledger, and once by a sweep of anything
still claiming your plugin as its source.

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
let each window pull what it needs.

Renderer side, subscribe during activation:

```js
module.exports.activate = (rhost) => {
  // events arrive through core's plugin-event channel; the host does not
  // subscribe for you — see the note below.
};
```

Events are unbuffered (Law 2). A window that opens after your emit hears
nothing, which is precisely why pull-on-open is the contract rather than a
suggestion.

> **`"1"` gap:** `rhost` has no `events.on(topic, fn)` member. A renderer half
> cannot subscribe to its engine half's events through the documented surface —
> the only sanctioned renderer→engine direction is `invoke`, and the only
> sanctioned pattern is pull-on-open plus polling if you need liveness. The
> `plugin-event` channel exists and carries your emits; a subscription slot for
> it is a v1.1 candidate. Design against pull, not push.

---

## 10. Lifecycle: enable, disable, failure, quarantine

### Where the user turns a plugin on and off

A top-level **`Plugins`** menu in the menu bar, with one checkbox per discovered
plugin, and a `Manage Plugins…` item opening a dialog with descriptions,
versions, errors and a Retry button. If there are no plugins at all, the whole
menu is absent rather than empty.

Enabling and disabling is **not** in Preferences, deliberately: it tears down
live DOM in every open window, which is not what a preference does. Your own
settings *are* in Preferences, via the `settings.section` slot (§6.6).

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
persistently.

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

- **Clodex's persistence stores.** Sessions, workspaces, peers, teams, the
  library — none of it. You get `storage` (your own file) and `settings` (your
  own key). A plugin cannot corrupt `sessions.json` because it cannot reach it.
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
- **The IPC transport seams.** You cannot register your own channel. §11 says why.
- **Another plugin.** `rhost.invoke` binds your id; `host.settings` binds your
  id; there is no plugin-to-plugin API and no directory of loaded plugins with
  callable methods.
- **The `_host` pseudo-plugin.** Its methods take a plugin id as an *argument* —
  which is precisely why plugins cannot reach it. An openable `_host` would let
  plugin A write plugin B's settings. The practical consequence to design
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
- **`fsScope` refuses peers, but not foreign workspaces** (§4). It answers "does this session have a
  local working directory?", not "is this session mine to touch". Nothing else supplies the missing
  half: the plugin transport discards the calling window before dispatch, so your engine half is
  never told which workspace asked. If a session name can reach your handler from somewhere you do
  not control, a cwd in another workspace is reachable through it. Compare `handle.workspaceId`
  against a workspace you established yourself when that matters to you. Closing this in the host
  would mean carrying a caller workspace on the transport — additive, but not yet decided.
- **Slot ordering across plugins is unspecified** (§6). Do not depend on it.
- **No renderer-side event subscription** (§9). Design against pull-on-open.
- **`rhost.sessions` has no `listAll()`** and never will; if you need the global
  picture, ask your engine half.
- **`sidebar.rowBadge.resolve` is sync-only** (§6.4). The cache-plus-relayout
  idiom is the supported pattern, not a workaround.
- **`onCreate` and restored sessions**: unspecified whether the hook fires for
  sessions restored at launch. Reconcile from `listAll()` at activation if it
  matters to you.
- **`catalog()[].enabled` means "loaded", not "the user wants it"** — it is
  `true` for everything in the catalog by construction, since the catalog lists
  what successfully activated. The user's *intent*, and the quarantine state, are
  not part of a plugin's own view of the world.
- **BYO plugins outside the repo** (`~/.clodex/plugins/`) are not discovered. A
  scan path is a trust boundary, and widening one is a decision, not a
  convenience.
- **Packaged builds**: the plugins directory is included in the packaged app;
  a plugin added to an installed copy is not.

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

What that means for you: write `"hostApi": "1"`, and expect this document to grow
new sections rather than contradict existing ones. If a section here ever
contradicts a later one, this document is wrong and the code is right — that is
worth a bug report.
