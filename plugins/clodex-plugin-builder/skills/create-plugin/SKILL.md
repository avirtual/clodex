---
description: Build a Clodex plugin end to end - scaffold it, wire the surfaces it needs, and verify it against the real loader. Usage - /clodex-plugin-builder:create-plugin <id> [what it should do]
---
# Build a Clodex plugin

You are building a plugin for Clodex, the app you are running inside. This skill
carries the facts that are expensive to rediscover; the authority is the
contract, and where they disagree the contract wins.

## Step 0 — find the contract

A Clodex **checkout** carries the contract. The installed app does not give you
one you can read: its copy is inside the app archive, which your shell cannot
list. So look for a checkout first:

```bash
find ~/projects /Applications -maxdepth 4 -name plugin-api.md -path '*plugins*' 2>/dev/null | head -3
```

A checkout also carries the author tools, and they are the fastest path by a
wide margin:

```bash
node plugins/tools/build-context.js /tmp/plugin-context.md   # the full pack
node plugins/tools/scaffold.js <id> <target-dir>             # a plugin that already passes
node plugins/tools/verify.js <dir>                           # run it against the REAL loader
```

**If `verify.js` exists, you must use it** — it loads the plugin through the
host's own loader, so it catches what reading cannot.

With no checkout, fetch the four docs from the public repo, and say in your
final message that the plugin is unverified — nothing ran it:

```
https://raw.githubusercontent.com/avirtual/clodex/master/plugins/plugin-api.md
https://raw.githubusercontent.com/avirtual/clodex/master/plugins/what-plugins-can-do.md
https://raw.githubusercontent.com/avirtual/clodex/master/plugins/plugin-sources.md
https://raw.githubusercontent.com/avirtual/clodex/master/plugins/README.md
```

`master` may describe a Clodex newer than the one installed, so prefer whatever
is on disk. If the running app refuses your plugin over `hostApi`, you read the
docs for a different host.

Delegate the reading to `clodex-plugin-builder:api-scout` rather than pulling
the whole contract into your own context. Ask it for the specific sections your
plugin needs; it returns the rules and the signatures, not the prose.

`plugin-api.md` is ~2,000 lines and sectioned. **Do not read it end to end** —
send the scout to the section:

| Building | Section |
|---|---|
| Deciding whether this should be a plugin at all | `what-plugins-can-do.md`, whole — it is short |
| The manifest, and why one gets refused | §2 |
| Per-seat visibility, `scope`, capability grants | §2.1 |
| The engine `host` object | §4 |
| Session hooks, the turn-text feed | §4 (`sessions`) |
| Any UI at all — seven slots, one subsection each | §6 |
| A button plus an overlay plus reading files | §6.3, §6.7, §8 |
| An `[agent:…]` verb | §7, then `host.intents` in §4 |
| Talking between your halves | §8 (`invoke`) |
| Engine → renderer events | §9 |
| Enable, disable, failure, quarantine | §10 |
| **What you may not reach** | §13 — read before designing, not after |
| Known gaps and unspecified behaviour | §14 |

Three shipped plugins are better than any summary, and a checkout has them:
**git-branches** (row badge + settings panel + a verb), **memory-viewer**
(footer button + overlay + `invoke` for filesystem work — the commonest shape)
and **workbench** (a full overlay application). Read the one whose shape matches
what you are building.

## Step 1 — decide the shape

Ask, if the user has not said:

- **What should it DO** for the operator or for agents?
- **Where should it appear** — a sidebar button, a status-bar readout, a badge
  on session rows, a full overlay, a settings panel?
- **Does an agent need to reach it** — an `[agent:…]` verb?
- **Does it need code at all?**

That last one first, because it changes everything. **Three complete shapes**,
and picking the smallest one that works is most of the job:

- **Content only** — `skills/`, `agents/`, `prompts/`, `templates/` and no
  JavaScript at all. `"entry": {}` is legal when the directory carries a
  content bundle. If what the user wants is a skill and some subagents, build
  that and stop; do not add an engine in order to have one.
- **Engine only** — a verb, a session hook, or a feed subscriber with no UI.
  A normal, complete plugin; the renderer half is optional.
- **Both halves** — anything the operator has to see or click.

A renderer half with no engine is legal too, but rare: it can only draw, so it
has nothing to draw *from*.

## Step 2 — the manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "hostApi": "1",
  "scope": "session",
  "entry": { "engine": "engine.js", "renderer": "renderer.js" },
  "style": "style.css",
  "surfaces": { "index": "any", "doc": "any" },
  "enabledByDefault": false,
  "announce": "One sentence. Shown in Manage Plugins AND as the skill's description in Claude Code."
}
```

Rules that refuse a manifest outright, so get them right first:

- **The folder name must equal `id`.** Lowercase, digits and hyphens, starting
  and ending alphanumeric, 1–40 characters. `enabled` is reserved and refused,
  as is any id a built-in plugin already uses.
- **`hostApi` is the string `"1"`.** Required — an absent one is refused, not
  defaulted.
- **`entry` must be an object**, even when empty.
- **`scope`, if present, is exactly `"global"` or `"session"`.** `"Session"` is
  a refusal. Add `scope: "session"` **only** if the plugin consumes a capability
  grant (today: the turn-text feed). It no longer controls visibility — a seat's
  plugin list does that.
- Entry and `style` paths must stay inside the plugin folder.
- **If the plugin has a renderer half, it needs a `surfaces` table.** See Step 3a
  — this is the one field whose default costs you reach rather than granting it,
  and forgetting it is the commonest way a working plugin is broken in the
  browser.
- **`announce` and `version` are read twice.** If the plugin ships a `skills/` or
  `agents/` bundle, Clodex generates a `.claude-plugin/plugin.json` for it and
  stamps `announce` in as the `description` and `version` as the version — that
  is the line the agent's own `/skills` listing shows. Omit `announce` and the
  bundle falls back to `Clodex plugin <name>`; omit `version` and it reads
  `0.0.0`. So write `announce` as a sentence that survives being read next to a
  skill name, not only in a plugin manager. (Older builds hardcoded a generic
  description here regardless of the manifest; a bundle that still reads
  "clodex session-injected skills" means the host predates the fix.)

## Step 3 — write the halves

**Engine** (`engine.js`) is plain Node, no Electron, no DOM, full privileges.
**Renderer** (`renderer.js`) is browser context, no filesystem, no `window.api`.
They talk one way only: `rhost.invoke('method', …)` → `host.ipc.handle('method',
…)`, arguments structured-cloned, so plain data only.

```js
// engine.js
module.exports.activate = (host) => {
  host.ipc.handle('greet', (who) => ({ ok: true, text: `hello ${who}` }));
};
module.exports.deactivate = () => { /* release anything the host cannot */ };
```

Define `deactivate` at **module scope**, not by assigning to `module.exports`
inside `activate`.

Nine rules that are not obvious and cost a debugging session each — rule 7 is a
security rule, not an ergonomic one:

1. **Feature-check any recent API and throw**, naming the capability rather than
   a version: `hostApi` stays `"1"` and new APIs arrive additively, so the
   manifest cannot express "needs a newer Clodex". Throwing *is* the error
   channel; two failed launches quarantine the plugin until Retry.
2. **`style.css` is injected verbatim and unscoped into every window.** Prefix
   every selector with your own class or you will restyle the app.
3. **Never `innerHTML` anything an agent produced.** Build nodes and set
   `textContent`, or use `rhost.lib.renderMarkdown`, which never emits raw HTML.
4. **`host.events.emit(topic, payload, scope)` — `scope` is required**
   (`{session}`, `{workspace}`, or `'all'`), and an omitted one is a logged
   no-op, not a broadcast. `'all'` reaches every workspace, so it carries
   **invalidation hints only** — say the thing changed, let each window pull.
   A **counter or a row id is data, not a hint**: `{ seq }` on an `'all'` emit
   tells every workspace how busy the others are. If the receiver pulls anyway,
   send `null` — the easiest way to leak is to ship a number that felt like
   metadata.
5. **Events are unbuffered**: a window closed during an emit hears nothing, so
   your surface must pull its own state on open. Events only save you a timer.
   If your pull is incremental (`since: lastId`), decide what happens when the
   engine's counter goes **backwards** — a re-scan restarts it at zero, and a
   pane holding a higher mark then waits for an id that is never issued and
   silently never paints again. Re-pull from zero when you see it rewind.
6. **`paths.dataDir` is not created for you.** `mkdir -p` it before writing your
   own files.
7. **Realpath every path a user or an agent named, on every read**, and
   prefix-check the resolved string against the root you confine to. A lexical
   `path.join` is defeated by a symlink inside the tree pointing out of it: the
   joined string stays under your root and the open does not. `fsScope` does not
   do this for you — it answers "local session, which cwd", and is explicitly
   not cwd confinement and not a sandbox.
8. **Node's module cache survives a disable.** Re-enabling calls `activate()`
   again on the same module object, so initialise state inside `activate()`,
   never at module scope.
9. **A renderer half must be `require`-free.** In the desktop app it is loaded by
   path; in the browser it is read as source text and evaluated, and the shim's
   `require` throws naming your plugin. One `require` therefore means a half that
   works in no browser. It has nothing to require anyway: a renderer half touches
   `module.exports` and the `rhost` it is handed, and nothing else.

## Step 3a — `surfaces`, or your UI works only on the desktop

Clodex also runs as a browser client against a running desktop app. Both
surfaces share **one** engine half and one invoke channel, so a method cannot be
withheld from the browser by not serving it — the distinction rides the call,
and `surfaces` in your manifest is where you declare it.

```json
"surfaces": { "index": "any", "doc": "any", "quote": "any" }
```

**Everything you do not list is desktop-only.** A browser client calling an
unlisted method gets, before your handler runs:

```js
{ ok: false, error: 'plugin method not available on this surface' }
```

A plugin with no `surfaces` field at all is entirely desktop-only, so a renderer
half plus no table is a UI whose every button fails in the browser. **So: if you
wrote a renderer half, write the table.** List every method the renderer
invokes — then take back out the ones below.

**What to leave off.** Anything a remote caller should not reach: a method that
writes a file, commits, discards, pushes, changes a setting another method acts
on, or — the category people miss — **takes a caller-supplied host path**. A
folder picker's `setRoot` is the canonical one: the path means nothing on the
browser's machine and everything on the desktop's. Choose the root on the
desktop, let the browser read it.

Three traps:

- **Nothing correlates the table with your `host.ipc.handle` calls.** Rename a
  method, forget the manifest, and it silently becomes desktop-only. It fails
  closed, which is the right direction, but it fails quietly.
- **A renderer half cannot ask which surface it is on.** There is no
  `rhost.surface`, so a desktop-only button looks identical in the browser until
  the call comes back refused. Handle the refusal string; do not assume a method
  you registered is callable.
- **`surfaces` gates `invoke` and nothing else.** Your intent verbs (§7) and
  session hooks (§4) are not covered and cannot be — anything that writes a
  session's PTY reaches both regardless of transport. If a verb does what a
  desktop-only method does, gating the method is theatre.

Manifests are read at registration, so a browser box needs a plugin re-scan or a
restart after you add the table.

## Step 4 — the UI slots

(Not to be confused with the manifest's `surfaces` table above: that says which
*transports* may call a method; these are the *places* a plugin may draw.)

Seven slots: status-bar action, status-bar segment, sidebar footer button,
session row badge, session menu provider, settings panel, full overlay. You
supply data and callbacks; the host draws. Ask the scout for the exact spec of
the ones you use. Two behaviours that surprise people:

- **Row badges are painted synchronously** inside the sidebar's render loop.
  Return what is cached now and fill the cache in the background; the first
  paint is blank by design.
- **`mount(root)` on an overlay runs once, lazily, at first open.** One-time
  construction in `mount`, per-open refresh in `onOpen`.

## Step 4a — styling, where a first plugin looks broken

Two mistakes make a working plugin look like a failed one. Both are invisible
until someone opens the surface, and neither is caught by any verifier.

**1. The host paints the backdrop; YOU paint the panel.** For an overlay, the
host creates `<div class="plugin-overlay">` and styles it as a scrim only —
fixed, full-screen, centred, translucent black. It draws no card. If your root
element has no background, border or size, your controls float as bare text on
the dark scrim and the plugin reads as broken. Give your own top-level element
a panel:

```css
.myplugin {
  width: 100%; max-width: 1100px; height: 82vh;
  display: flex; flex-direction: column;
  padding: 14px 16px; box-sizing: border-box;
  background: var(--sidebar-bg); color: var(--text);
  border: 1px solid var(--accent); border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
```

Do **not** restyle `.plugin-overlay` itself: the host creates, toggles and
removes it, so it is host contract rather than plugin skin.

**2. Use the theme variables. Never hardcode a colour.** Clodex ships several
themes and **some are light**, selected by `[data-theme]` on the document. A
dark-theme hex that looks right while you build it is unreadable for any user on
a light theme — and you will not notice, because you are not on one.

Core declares these on `:root`, and a plugin stylesheet inherits them:

| Variable | Use for |
|---|---|
| `--bg` | the window background; inputs and buttons |
| `--sidebar-bg` | a panel or card sitting above the background |
| `--sidebar-hover` | hover states |
| `--text` | body text |
| `--text-dim` | secondary text, timestamps, labels |
| `--accent` | your panel border, selection, emphasis |
| `--border` | rules, separators, input borders |
| `--warn`, `--error`, `--ok` | semantic states, contrast-corrected per theme |

Write `var(--text-dim, #949eb1)` — the fallback keeps the stylesheet sane if it
is ever read outside the app. Ask the scout to read the current variable list out
of core's stylesheet rather than trusting this table if the exact palette
matters; themes gain variables over time.

For everything else, remember the stylesheet is injected **verbatim and
unscoped** into every window: prefix every selector with one class of your own
(`.myplugin-row`, not `.row`), or you restyle Clodex itself and every other
plugin.

## Step 5 — an intent verb, if it needs one

`host.intents.register(row)` adds an `[agent:verb]` any agent can emit. Three
properties: it fires **exactly once** per matched line (so a non-idempotent side
effect is safe), a **throw becomes a reply** to the emitting agent, and it is
**off for every seat until the operator ticks it** — there is no enabled-by-
default. That last one looks exactly like a broken registration, so say it in
the README.

Verbs are one flat global namespace across all installed plugins. The second
plugin to claim one is refused at activation. Pick `myplugin-run`, never `run`.

## Step 6 — verify, then hand over

Run `verify.js` if you found it. Fix everything it reports; it exercises the
real loader, including that `deactivate` releases what `activate` took.

Then write the plugin's `README.md` — required sections: what it does, the seat
it expects, what it writes and where. Plus, when they apply: that a verb is off
until ticked, that a capability grant is off until granted, and which methods
are desktop-only (so the browser's refusal reads as a decision, not a bug).

Finally tell the user how to install it:

> **Plugins ▸ Manage Plugins… ▸ Register Plugin…**, pick the folder, then tick
> the plugin on the seat that should hold it. A renderer change needs an app
> restart (`require` caches by path); an engine change needs only a Re-scan.

Registering is the right loop **while editing** — the folder is symlinked, so a
`git pull` or a save is the whole update. To install one from GitHub instead,
**Manage Plugins… ▸ Install from GitHub…** takes:

```
https://github.com/owner/repo/tree/<ref>/<subpath>   # the URL, verbatim from the address bar
owner/repo                    # repo root, default branch
owner/repo@<ref>              # @ picks the ref
owner/repo:<subpath>          # : picks a subfolder
owner/repo@<ref>:<subpath>    # both
```

**A plugin living in a subfolder of a monorepo needs the subpath**, and for a
one-plugin-per-folder repo the subpath is just the plugin's id. Two things worth
saying to the user. A registered symlink of an id **blocks** a GitHub install of
that same id — unregister it first:

> `"<id>" is a registered link, not a directory from a source — unregister it first.`

And the ref is the release channel: a branch re-resolves on update, a tag is
pinned forever and will never report one.

## What a plugin cannot do

Do not design around these — they are refusals, not gaps: spawn a session,
change a session's command line, reach another plugin, register its own IPC
channel, touch the peer/remote wire, or read Clodex's own stores (`sessions.json`,
workspaces, teams, the library). It also cannot read another plugin's settings.

There is **no sandbox**: an engine half runs with the app's full privileges. The
API is a contract for removability and versioning, not containment. Say so
plainly if the user asks whether a plugin is safe to install.
