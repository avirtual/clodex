# Plugin sources — where Clodex looks for plugins

**Status: design, Phase 4b. Part of this is implemented (the local user root);
most of it is deliberately not.** Every section says which.

**Why this is its own file rather than a section of `plugin-api.md`.**
`plugin-api.md` is the frozen contract a plugin author writes against, published
and version-pinned at `hostApi "1"`; nothing here changes that surface, so
putting it there would imply a contract change where there is none. This
document is different: it is about **where code comes from and who is trusted to
put it there**, which is a question a user asks and a security-minded reader
asks, and both will keep asking it as remote sources arrive. It wants a stable
home that outlives the phase that created it.

---

## 1. Why this exists

The short version: **Phases 0–3 shipped an extension system that only its authors
can extend.**

Discovery scans exactly one directory. `engine.js:1762` sets

```js
pluginsDir: path.join(__dirname, 'plugins'),
```

and the comment two lines above it states the operative fact: `__dirname` is the
repo root in dev and **the `app.asar` root when packaged**. `package.json:62`
ships `plugins/**/*` inside that archive. So for anyone running the DMG:

- The plugins directory is **inside a read-only archive**. There is no supported
  way to put a directory in it.
- Even if there were, `app.asar` is **replaced wholesale on every update**, so
  the plugin would vanish at the next version bump with nothing recording that it
  had been there.

That is not an inconvenience with a workaround; it is a categorical limit, and it
applies to **every Clodex user who does not build from source**. The plugin
system is real for its authors and decorative for everyone else.

There is a second, smaller motivation, and it should be read as a footnote to the
first rather than as the argument: a developer working in a git checkout *can*
drop a plugin into `<repo>/plugins`, but then their own code lives in the
project's tree, and every `git pull` is a merge conflict waiting to happen. Real
friction, but a developer's friction, with a developer's workarounds.

**This is the same pattern the two Phase 4 findings share**, showing up a third
time and one level further out. The plugin system was built alongside
consumers who were all developers with a git checkout, so the path a packaged
user would take was never exercised — exactly as the API was built alongside the
workbench, so the behaviour the workbench did not need was never made symmetric.
Three instances is no longer a coincidence: **an artifact validated only by its
authors is validated against its authors' environment too.**

---

## 2. GAP G8, answered

`engine.js:1759` records "GAP G8 (packaged-.app resource layout) …  deliberately
not pre-solved here". It is now due, and the answer should be explicit rather
than implied by the user root existing.

**The obvious-looking lever is `extraResources`.** `package.json:68` already has
such a block (it ships `vendor/wirescope`), so moving `plugins/` out of the asar
and into `Contents/Resources/plugins/` is available today and would make the
directory visible in Finder and writable by the user.

**We are not taking it, for three reasons.**

1. **It does not solve the actual problem.** `extraResources` content is still
   replaced by an update — that is what shipping it with the app means. A user
   plugin placed there survives until the next version and then silently
   disappears. A directory whose contents an update deletes is a worse place to
   put user data than one the user cannot write at all, because the failure is
   delayed and quiet instead of immediate and obvious.
2. **It puts the user's code inside the application bundle.** On macOS that is a
   signed artifact; ad-hoc signing (`build/afterPack.js`) is already load-bearing
   for node-pty, and inviting users to add files inside `Clodex.app` is at best
   fragile and at worst breaks launch. `~/` is where user data belongs on every
   platform we target.
3. **It conflates two different lifetimes under one directory.** Core plugins
   ship with the app and are the app's business; user plugins outlive the app's
   versions and are the user's. One directory holding both means an update has to
   distinguish them by inspection. Two roots means it never has to.

**So G8's answer is: core plugins stay inside the asar, and the user root is
somewhere the app never writes.** This also settles a question the asar makes
awkward — whether the app should ever modify the core plugins directory. It
cannot, and now it does not need to.

The consequence that answer leaves behind is handled in §4: if the asar copy
always wins, a packaged user can never run a *newer* version of a core plugin
either. The bundled copy is therefore treated as a **floor** — a strictly newer
copy in the user root supersedes it.

---

## 3. Multi-root discovery

**Implemented.**

The seam already existed: `plugin-loader.js:64` takes `pluginsDir` injected, and
`discover()` reads exactly that directory. The change is to take a **list** of
roots and iterate it, with the per-directory validation unchanged.

```
roots = [
  { id: 'core', dir: <app>/plugins,          label: 'Built in' },
  { id: 'user', dir: ~/.clodex/plugins,      label: 'User' },
]
```

Order is precedence order; see §4.

**Why `~/.clodex/plugins/` and not `userData`.** `~/.clodex` is already the
Clodex-owned runtime root (0700, created by the app), it is where an agent's own
files live, and it is a path a user can type. `app.getPath('userData')` resolves
to `~/Library/Application Support/Clodex/` on macOS — correct by platform
convention, and hostile to the actual use case, which involves a person putting a
directory somewhere with a shell or a Finder window.

**It does NOT get registered in `clodex-paths.js`.** That module single-sources
the **per-agent** grammar: `runDirFor` builds `run/<name>/`, `pathFor` builds
`run/<name>/<kind>`, and `KINDS` is a table of per-agent artifacts. Shared
root-level directories (`messages/`, `pending/`, `agents/`, `skills/`,
`library/`) are *documented* in that module's header and *constructed* elsewhere.
A plugins root is shared, not per-agent, so it earns a line in that header's
shared list and no `KINDS` entry. Registering it as a kind would make `pathFor`
lie about what it builds.

**A missing user root is a legal, silent state** — the same rule `discover()`
already applies to a missing `plugins/` directory (`:174-177`). The app does not
create `~/.clodex/plugins/`, because a directory that exists only because we made
it teaches a user nothing, and its absence is the correct representation of "no
user plugins".

---

## 4. Id precedence and shadowing

**Implemented.**

Today, plugin id uniqueness is a **filesystem accident**: one directory, one
dirname per id, and `validateManifest` (`plugin-loader.js:40`) requires
`manifest.id === dirName`. With two roots, `git-branches` can exist in both.

### The rule

**Core wins by default, and a strictly NEWER copy overrides that.** The first
root in the list that contains an id owns it; a later root's copy is shadowed
*unless* its manifest `version` is higher, in which case it takes over and the
earlier copy is the one shadowed.

The default half — core wins — exists because the alternative, unconditional
user-overrides-core, is the more obviously "helpful" choice and is wrong, for one
reason that outweighs the ergonomics: **a shadowing user plugin would silently
replace a core plugin after an update changed it.** A user who copied
`git-branches` to experiment, then forgot, would be running their fork against a
core they no longer match, with the app reporting the plugin as present and
working. Under core-wins, the same mistake is inert and visible.

Put the asymmetry plainly, since user-wins is what most editors do and is what a
reader will expect: the two options do not fail the same way. **User-wins fails
late, quietly, and against a moving target. Core-wins fails immediately and
visibly.** Given a choice between a wrong thing that announces itself and a wrong
thing that waits, take the loud one.

Two objections, both of which dissolve:

- *"I want to modify a core plugin."* Change its id. A fork under its own name is
  more honest than a silent shadow, and it gets its own settings object instead of
  inheriting the original's.
- *"I need to develop against a core plugin."* Anyone doing that has the repo
  checkout and edits in place. **The user root exists for people without a
  checkout** — which is exactly the population that must not be silently running a
  stale fork.

### The bundled copy is a FLOOR, not a ceiling

**The version clause narrows core-wins; it does not overturn it.** Core plugins
ship inside `app.asar` (§2), which is read-only and replaced wholesale by every
update. Without this clause a packaged user could **never** run a newer version
of a plugin than the one their DMG happened to ship — not by installing one, not
by any mechanism at all, because the copy we cannot let them replace would always
win. We cannot make the baked-in copy writable, so we make it losable.

What core-wins protected against survives intact, because **a stale fork is by
definition not newer.** The forgotten experimental copy of `git-branches` still
loses, still loudly. What changes is only the case where the user's copy is a
genuine later release — which was never the dangerous case, only an unreachable
one.

Concretely: core `1.0.0` + user `1.1.0` → the user copy runs. Core `2.1.0` + user
`2.0.0` → the core copy runs and the user's is shadowed. **Equal versions lose**:
"newer" is strictly greater, because an identical copy is not the later release
this clause exists to serve.

**Automatic, with no persisted pin.** The obvious alternative is recording a
chosen copy in settings. A pin is state that goes stale — the pinned directory is
deleted, or a newly bundled version outranks the pinned one — and every
stale-state answer would be a decision better made once an install *affordance*
(§10, still not built) exists to record real user intent — reveal and re-scan
move a plugin onto disk and into the app, but neither captures a choice worth
pinning. Automatic needs no new state. The cost is
expressiveness: there is no way to deliberately run an *older* copy, and the
recourse for someone who wants that is the same as it always was — give the fork
its own id.

**How versions compare, and what malformed does.** `version` was decorative until
this rule and is *still not validated*: `validateManifest` never mentions it and a
manifest with no version at all loads normally. So the comparison has to be total
over inputs nobody checked.

- A comparable version is **dot-separated runs of digits, compared numerically**,
  missing trailing segments treated as zero. `1.10` beats `1.9` — string
  comparison gets that backwards, and the plugin on its tenth patch is precisely
  the one being actively maintained. `1.2` and `1.2.0` tie.
- **Anything else is uncomparable, and uncomparable never wins.** Absent,
  non-string, `v2`, `the good one`, `1.0.0-beta` — all lose. This is the safe
  direction by construction: "uncomparable" collapses to the pre-existing
  behaviour, so junk can only ever fail to change something, and it cannot crash
  discovery because the comparison returns a boolean for every pair of inputs.
- **Semver pre-release ordering is deliberately not implemented.** Getting
  `1.0.0-beta < 1.0.0` right needs the whole grammar and nothing here needs it.
  The consequence is stated rather than hidden: `1.0.0-beta` does not lose to
  `1.0.0` on precedence, it is uncomparable and loses *for that reason* — and the
  settings row says so, rather than telling its author to bump a number.

**A malformed version does not refuse the manifest.** Refusing would turn a
decorative field into one that can un-install a working plugin, and would break
every manifest that omits `version` — a far larger change than this rule needs.

**The hazard this creates, stated plainly: a user-root plugin declaring
`"version": "99"` wins forever and can never be superseded by any real release.**
That is the forgotten-fork case in a new outfit. Nothing prevents it — nothing
*can*, short of a pin or a curated registry — so the only thing that makes it
recoverable is the row described below saying which copy is running and what
version each one is. A user whose app ignores every update needs those two
numbers on screen; without them there is no thread to pull.

**Freeze-neutral, not a `hostApi` change.** `isValidPluginId` and
`validateManifest` are untouched, the set of accepted manifests is identical, and
no new field is required. Precedence between two copies of one id is host-internal
discovery — a plugin cannot observe it from inside `activate()`, it observes only
whether it was loaded, which was never guaranteed. The honest counter-argument is
that `version` moving from decorative to load-bearing is a semantic change to the
manifest contract; it is answered by the fact that no existing manifest's
*observable* outcome changes except the one this rule exists to change. Nothing is
narrowed, and narrowing is the breaking move.

### Shadowing must be VISIBLE — the row is a safety mechanism

A shadowed plugin is not silently dropped. `status()` carries a `shadowed` list
and Manage Plugins renders a row for each — no toggle, in the same register as the
existing `Not loaded: <why>` rows for refused directories:

```
git-branches            User v1.4.0
  Not running: shadowed by the Built in copy of the same id (v2.0.0).
  This copy is v1.4.0; a user copy only takes over when its version is higher.
```

The failure this prevents is specific and nasty: **a user editing code that is
not the code running.** Without the row, the plugin appears in the list (the core
one does), it is enabled, it works — and none of the user's edits have any
effect, with nothing on screen explaining why.

**Since the version clause the row can INVERT**, and it has to read correctly in
both directions — the inverted one is where the version-99 hazard lives, so a row
that could only say "your copy lost" would be silent exactly where it matters:

```
git-branches            Built in v3.5.0
  Not running: this Built in copy is v3.5.0 and the User copy is v99
  — the higher version wins.
```

**Both versions are named on every row, in both directions.** That is the whole
recovery path for a user whose updates appear to do nothing.

**The reason a copy lost is stamped by the loader, not inferred from the two
version strings.** A row that compared the numbers itself would be right most of
the time and wrong in the case that matters: an uncomparable version lost
*because it could not be read*, not because it was lower, and telling its author
to bump the number sends them somewhere that cannot help. So there is a third
wording:

```
git-branches            User v1.0.0-beta
  Not running: shadowed by the Built in copy (v2.0.0). This copy's version
  ("1.0.0-beta") is not a plain number like 1.2.0, so it can never take over
  — fix the version to supersede it.
```

### What a shadowed plugin shares with its shadower

`uiSettings.plugins.enabled` is keyed by **bare id**, and so is the per-plugin
settings object `uiSettings.plugins[<id>]`. Two plugins with one id therefore
share both. Consequences, stated because they are not obvious:

- **The enabled flag is one flag.** There is no state in which the user root's
  copy is enabled and the core one is not — enabling "git-branches" enables
  whichever copy won.
- **The settings object is one object**, and the shadowed plugin's fields may
  differ from the shadower's. If the user's fork added a setting, its value sits
  in the shared object, unread, until the shadow is removed — at which point it
  is read by a plugin that may interpret it differently.
- **This is a reason to keep precedence stable**, not a bug to fix by key
  namespacing. Keying settings by root would mean a plugin's settings vanish when
  it moves between roots, which is a worse and more frequent surprise than the
  one above.

**The version clause gives the shared object a new way to change hands, and this
is the real cost of that rule.** Before it, the winner of a shadow pair was fixed,
so the shared settings object was only ever read by one copy. Now an app update
that bumps the core version can hand *the same object* to the other copy:

> The user's copy v2.0 wins and writes its settings. Core ships v2.1. On the next
> launch core wins and reads settings written by a **different plugin** that
> happened to share its id.

Neither copy is doing anything wrong, and neither can detect the swap. This is not
a bug introduced by version-aware precedence — it is the shared-key design's
existing consequence with a new trigger — but it is the reason the row must name
both versions. A user who sees behaviour change after an update has no other way
to work out that the copy running is not the copy that wrote the settings.

The mitigation is the honest one: **precedence should be stable, and when it does
change the UI must say so.** Key-namespacing settings by root remains rejected for
the reason above; it would trade a rare surprise for a frequent one.

---

## 4a. Verbs share one global namespace

**Implemented.**

Ids are not the only thing two plugins can collide on, and the other one is
worse. A plugin can contribute an `[agent:…]` verb, and **verbs are one flat
global namespace**: they are not prefixed by the plugin id, because the whole
point is that an agent writes `[agent:branch]`, not `[agent:git-branches:branch]`.
So two installed plugins that both want `notes` are in direct conflict, and only
one of them can have it.

This is the same pattern as id collisions, **one layer down** — and it is the
layer where our tools are weaker. An id collision is visible to *discovery*: the
id is in the manifest, so the loader can arbitrate before running a line of
plugin code, and the loser gets a clean shadowed row. **A verb is not in the
manifest.** It is declared inside the engine module, in the `activate()` call
(`plugins/git-branches/engine.js:484`), so it is knowable only by requiring that
module and running it. There is nothing to arbitrate at discovery time. That
asymmetry is structural, not an oversight.

### What happens

The second plugin to register a contested verb is **refused**: its `activate()`
throws, and it does not load. The Manage Plugins row says so, naming both the
verb and the holder:

```
Notes Plus             User
  Not running: it uses the intent verb [agent:notes], which the "scratch"
  plugin already registered. Two plugins cannot share a verb — disable one
  of them.
```

**A verb collision is not a strike and never quarantines.** Quarantine
(`plugin-api.md` §10) is for plugins that crash; a collision is a knowable
structural refusal against a plugin that is otherwise fine. The distinction is
not academic — see the history at the end of this section.

The remedy is the user's: disable one of the two, or change one plugin's verb.
Disabling the holder and re-enabling the loser works immediately, with no
restart.

### The known limit: which plugin wins is arbitrary

State this plainly, because it is a limit we chose to keep rather than a bug
nobody noticed.

Between roots, precedence decides — core beats user, as it does for ids.
**Within a root, the winner is whichever plugin's directory sorts alphabetically
first** (`plugin-loader.js:221`). That is arbitrary with respect to which plugin
the user had first.

It is arbitrary because **discovery is stateless and install order is not
recorded anywhere.** `discover()` reads the disk on every call; nothing persists
when a plugin arrived. Incumbency is a temporal fact and we have no temporal
record, so there is no honest way to compute "who was here first".

We deliberately did **not** invent a deterministic-looking rule to cover this.
Two candidates were considered and rejected:

- **Order of `uiSettings.plugins.enabled`**, which is append-ordered and looks
  like install order. It is not: the first write materialises the whole current
  set in *discovery* order, and a default-on plugin never appears until its first
  toggle. It would be right often enough to be trusted and wrong without warning.
- **A persisted verb-ownership ledger.** It would work until ownership was held
  by a plugin the user deleted or disabled, at which point it would block a
  plugin that is actually running.

Dressing an arbitrary rule in temporal clothing is the exact failure this section
exists to prevent. If this ever needs solving properly, the answer is **recording
install time at the moment of install** — which requires an install *affordance*,
the part of §10 that is still not built. Reveal and re-scan (t22) do not help
here: neither is an install, so neither has an install moment to stamp. The limit
is therefore tied to the real gap rather than left dangling.

### The mirror case: a core plugin can displace yours

Root precedence cuts one way, so the consequence has to be said out loud: **a
future version of Clodex can ship a built-in plugin that claims a verb your
plugin already uses, and yours will be the one that stops loading.** Not because
it did anything wrong, and not because it arrived later — core simply registers
first.

It fails safely: no strike, no quarantine, and the row names the built-in plugin
holding the verb. But **the remedy is to change your own verb**, since you cannot
ask a user to disable a built-in to keep a third-party plugin running. This is
the honest cost of core-wins (§4), and it is the strongest practical reason for
an author to choose a distinctive verb — see `plugin-api.md` §7.

### Why this is written down at all

Verbs got neither a precedence rule nor a visible row until a user actually
installed two plugins, because until then **every plugin in existence was one we
wrote**, and we would have caught a collision at review. The first real
multi-plugin install found it immediately.

It found it in its worst form. Before this was fixed, a collision took a
quarantine strike like any other activation failure — so installing a new plugin
could take down a *different* plugin that had been working, quarantine it two
launches later under a message reading "activate() threw", and leave Retry unable
to recover it, because the collision reproduces on every attempt. The plugin
named in the error was the victim; the plugin that caused it looked healthy.
That is fixed. The arbitrary winner above is what remains, and it is visible.

---

## 5. Inputs we did not choose

Every plugin that has exercised discovery so far lives in `<repo>/plugins` and
was put there by this project. **Discovery has never seen an input it did not
author.** That is the same insider-shaped-artifact pattern as §1, so this section
exists to design against inputs a first real user will produce, and to name what
is assumed where it cannot.

| Input | Behaviour | Status |
|---|---|---|
| Directory with no `manifest.json` | Silently skipped — not an error, since an unrelated subdirectory is not a failed plugin (`:186-191`) | Already correct, unchanged |
| `manifest.json` present but unparseable | Refused, and surfaced as a `problems` row with the parse error | Already correct, unchanged |
| `manifest.id` ≠ dirname | Refused (`:40`) | Already correct; verified it still reads correctly when the dirname comes from a root we do not control — the check is per-directory and never consults the root |
| `entry.*` or `style` escaping the plugin dir | Refused (`:198-212`) | Already correct. Note this is now doing real work: for a core plugin it guarded against our own mistake; for a user plugin it is the first check applied to a path we have never seen |
| Same id in both roots | Core wins, user copy shown as shadowed (§4) | New |
| **Symlinked plugin directory** | **Followed.** `readdirSync(…, { withFileTypes: true })` reports a symlink as `isSymbolicLink()`, *not* `isDirectory()`, so the current filter would skip it | **See below — decided** |
| **Case-folding collision** (`Git-Branches` vs `git-branches`) | Both are discovered as distinct dirnames; on a case-insensitive filesystem they cannot coexist in ONE root but can across TWO | **See below — assumed** |
| A directory being written while discovery runs (a half-finished `cp`) | Refused or skipped depending on how far the copy got; both are inert | Acceptable — no partial activation is possible, since the manifest is read before anything is required |

### Symlinks: followed, deliberately

`isDirectory()` is false for a symlink even when it points at a directory, so the
current filter would skip a symlinked plugin. **That is the wrong behaviour for
the user root**, where symlinking a plugin out of a working git checkout is the
single most likely thing a developer does — and it would fail *silently*, with
the plugin simply absent and no `problems` row, because a directory with no
readable manifest is not an error.

So discovery follows symlinks: an entry is a candidate if `isDirectory()` **or**
(`isSymbolicLink()` and it stats as a directory). The `insideDir` checks then run
against the **resolved** directory, so a symlink cannot be used to make
`entry.engine` escape.

**The assumption named:** a symlink in the user root is the user pointing at
their own code, and following it is what they meant. This is consistent with §7's
posture — a user root is code the user deliberately placed — and it would be the
wrong default for a remote-populated root, which is one more reason a source
populating a root (§9) is not the same thing as a root.

### Case folding: assumed, not solved

macOS's default filesystem is case-insensitive but case-*preserving*. Within one
root, `Git-Branches` and `git-branches` cannot both exist, so `manifest.id ===
dirName` has been sufficient. Across two roots they can, and `isValidPluginId`
accepts both — so they are two distinct ids to every keyed structure
(`uiSettings.plugins`, the enabled list, the shadowing check) and one id to the
filesystem.

**We assume this does not happen, and we do not detect it.** Case-normalising ids
would change what `isValidPluginId` accepts, which is a `hostApi "1"` surface
question and a breaking narrowing of a lent rule; doing it only for the shadowing
check would make shadowing disagree with settings keying, which is worse than
either alone. The honest scope is: **an id differing from another only by case is
undefined behaviour**, stated here so the first person to hit it finds this
paragraph instead of a mystery.

---

## 6. External plugins are Electron-only

**Verified property, not a decision.**

`renderer.js:3020` activates a renderer half with `window.require(rendererPath)`
— an **absolute path resolved at runtime**, legal only because this app runs with
`contextIsolation: false` and `nodeIntegration: true`. That works for any path on
disk, so an external plugin's renderer half loads in Electron with **no build
step**. CSS was never a problem either: it travels as *text* over
`plugin:invoke` (`plugin-loader.js:330`), so no path has to resolve in the
renderer at all.

The web bundle cannot do this. esbuild resolves imports at **build time**, which
is why `renderer/web/plugin-registry.js` exists — a generated id→module table
built from `plugins/*/manifest.json`. A plugin that is not in the repo at build
time cannot be in the bundle.

**So: user plugins work in the Electron app and do not appear in the web
frontend.** This is stated, not solved. Solving it means either shipping a
bundler with the app or defining a pre-built plugin artifact format, and both are
larger than this feature.

### The lint and the parity gate are unaffected — by construction

Both `test/plugin-boundary.test.js` (the no-backdoor lint) and
`test/plugin-web-parity.test.js` compute their scan root from `__dirname` at dev
time (`:54` and `:30` respectively, both `path.join(ROOT, 'plugins')`). They are
static gates over **the code this repo ships**, run from the repo, and they
cannot see a user root even in principle — there is no user root on a CI
checkout.

This is worth stating precisely, because "we do not lint code we did not ship"
sounds like a policy we adopted and it is not: it is a property that already
holds and that this change cannot break. Likewise the parity gate cannot start
failing over a user plugin, because `pluginsWithRendererHalf()` reads
`<repo>/plugins`, so an external renderer half is never expected in the bundle.

A user plugin therefore gets **no static checking at all**. Which is the honest
consequence of §7, and is why §7 is next.

---

## 7. Trust

**A local plugin is code the user deliberately placed on their own machine, and
it is judged by the same standard as anything else they choose to run.** No
warning dialog, no confirmation, no "are you sure" theatre. A user who copies a
directory into `~/.clodex/plugins/` has done something a good deal more
deliberate than double-clicking an installer, and pretending otherwise trains
people to click through warnings — which is worse than not warning.

That is not a claim that plugins are contained. `plugin-api.md` §14 already says
this plainly and it applies unchanged to user plugins: the host API is a
**contract, not containment**. Clodex runs with `contextIsolation: false` and
`nodeIntegration: true`; a Tier-A plugin is in-process JavaScript with the full
authority of the application — it can read any file the user can read, spawn
processes, and reach the network. The no-backdoor lint catches accidents and
drift in code *we* ship; it is not a control, it has never been one, and §6 above
notes it does not run over user code at all.

**Remote fetch is a different posture and is out of scope here** (§9). The
distinction that matters: local plugins are code the user *wrote or chose and
placed*; remote plugins are code the user *authorized by name* and has usually
never read. A warning is meaningful for the second because there is a real moment
of decision to attach it to, and meaningless for the first because the decision
already happened, offline, in a file manager.

---

## 8. npm dependencies

**Sketch only. Not implemented, and not recommended for implementation yet.**

No plugin has a dependency today, and the no-backdoor lint refuses bare package
specifiers in `plugins/**` for exactly that reason.

**Vendored `node_modules` beside a manifest should already work** and needs no
machinery: Node's resolution algorithm walks up from the requiring file, so
`~/.clodex/plugins/foo/node_modules/bar` resolves from
`~/.clodex/plugins/foo/renderer.js` by the ordinary rules. Nothing in the loader
interferes — `requireModule` is plain `require` (`engine.js:1765`). This costs
nothing to allow because it is already true; it needs a test pinning it before
being documented as supported.

**Running `npm install` on fetched code is a strictly bigger trust step**, and
should not be conflated with the above. Install scripts execute arbitrary code at
install time — *before* the user has enabled anything, and outside every
mechanism this document describes. If a source ever fetches a plugin with
dependencies, the honest options are to require them vendored, or to install with
scripts disabled. **Recommend, do not build.**

---

## 9. Sources — a GitHub fetch (phase A: engine only, no dialog)

**Phase A implemented** (t683): `plugin-source.js` + five loader methods +
five `_host` methods. **No UI yet** — Manage Plugins gains no button until
phase B wires a dialog to `resolveSource`/`installFromSource`. Until then this
surface is reachable only from another main-process caller or a test.

The framing that keeps remote additive rather than structural, unchanged from
the sketch:

> **A source populates a root. It is not a new loading path.**

Discovery reads roots. A source is whatever put files in one — here, a tarball
extraction into `~/.clodex/plugins/<id>/`, exactly like an unzipped or
symlinked plugin. Discovery, precedence, shadowing, trust-at-load and the
Electron/web split cannot tell how the directory came to exist, and nothing
about any of them changed to add this.

**A fetched root is a cache; a user root without a sidecar is authority.** A
`.clodex-source.json` sidecar (`{ source, repo, ref, subpath, commit,
commitFull, fetchedAt }`) marks a directory as fetched; `update`/`remove` only
ever touch a sidecar-carrying directory, and a plain user directory sharing an
id is refused with "not from a source" rather than silently adopted.

**Spec grammar** (`parseSourceSpec`, `plugin-source.js`): `owner/repo`,
`owner/repo@ref`, `owner/repo:sub/path`, `owner/repo@ref:sub/path`, and
`https://github.com/owner/repo(/tree/ref/sub/path)?`, with a trailing `.git`
stripped. `ref` absent means the repo's default branch. Refused by name: ssh
remotes, non-github.com hosts, a subpath that is absolute or contains `.`/`..`
segments, an empty owner. Everything else — README-driven discovery, an index,
a search — is still out of scope (§10 below is unchanged by this section).

**Fetch mechanism**: `https.get` on
`api.github.com/repos/<o>/<r>/tarball/<ref>` (empty path segment when `ref` is
null), following redirects, streamed to a temp file under `os.tmpdir()` and
aborted past a 20 MB default cap; extracted with the system `tar -xzf` via
`execFile` (never a shell, never `npm install`). GitHub's tarball's single
top-level directory is named `owner-repo-<sha7>`; the abbreviated sha comes
from that name, and one additional `commits/<ref>` GET is attempted for the
full sha — `commitFull: true` when it succeeds, `false` (abbreviated sha) when
the API call fails or is unavailable. **Public repos only** — no token, no
private-repo support in phase A.

**Commit pinning ruling** (Bogdan + lead, added after the initial sketch): the
ref the user types is remembered for *display*; what installs and what runs is
a resolved *commit*. `resolveSource`/`installFromSource` resolve the ref once
and store the commit; `resolveUpdate(id)` re-resolves the SAME sidecar ref
(never a caller-supplied one) and returns both shas with nothing written yet;
`applyUpdate(id, commit)` re-fetches and **refuses if the newly fetched commit
is not the one the caller passed** — the commit a phase-B dialog would have
shown the user before they clicked update. **No automatic update anywhere**:
nothing schedules a re-fetch, and every path that changes what runs takes an
explicit id and (for apply) an explicit accepted commit.

**Install always registers DISABLED**, regardless of `enabledByDefault` — the
decision to fetch code and the decision to run it are two separate clicks
(§7). Update never touches enable state either way. `setEnabledInSettings`
(the same "explicit set wins forever" store path §4/§10 already used) is the
only writer of the enabled list here, same as every other install path.

**`installFromSource`/`applyUpdate` refusals mirror `registerUserPlugin`'s**:
a core id is refused by name; an existing symlink at the target says
"registered link, unregister it first"; an existing real directory WITHOUT a
sidecar says "not from a source" and is left byte-identical; a sidecar already
present says "use update instead". `applyUpdate` moves the old copy aside
(`.old-<id>-<nonce>`) before the rename-in, and restores it on ANY failure
after that point — a failed update never leaves an id half-installed.

**Temp dirs live under `os.tmpdir()`, not the plugins root.** `discoverRoot`
places no filter on dot-entries — verified by probe — so a `.fetch-<nonce>`
under `~/.clodex/plugins/` would be scanned as a broken plugin candidate on
every `discover()` until removed. `os.tmpdir()` is off every root discovery
ever reads. The move-in from there is `renameSync`, falling back to
`cpSync`+remove on `EXDEV` (a temp filesystem and the plugins root are not
guaranteed to be the same mount).

Still deliberately unanswered: whether a source is EVER per-collection beyond
picking one subpath per install call (no picker, no index read), and whether
phase B's dialog shows anything beyond the warning text §7 already specifies.

---

## 10. What a packaged user's install flow actually is

**Stated honestly, because the answer is "there mostly isn't one".**

End to end, today, with the user root implemented:

1. Find a plugin. **There is no discovery mechanism.** No directory, no index, no
   search, no listing inside the app. The user learns a plugin exists from a
   README, a link, or a person.
2. Obtain it. **No install path in the app.** `git clone` or download and unzip,
   in a terminal or a file manager.
3. Place it at `~/.clodex/plugins/<id>/`, where `<id>` must equal the plugin's
   manifest id. **`~/.clodex` is a dot-directory**, so a Finder user needs
   ⌘⇧. to see it, or ⌘⇧G to navigate to it — but **Manage Plugins ▸ Open Plugins
   Folder** now reveals it directly, creating it if it does not exist yet.
   Copying is not required: **Manage Plugins ▸ Register Plugin…** picks a folder
   anywhere on disk — a plugin living in its own git checkout, say — validates
   its manifest and symlinks it in as `~/.clodex/plugins/<id>`, leaving the
   folder where it is. The folder must still be NAMED for the plugin's id (§4),
   and the row for a registered plugin says where it points and offers
   **Unregister**, which removes the link and never the target. Registration is
   refused when the id belongs to a built-in plugin, when a real directory
   already holds that name in the user root, or when the id is already
   registered — see §4 for why one id can only have one copy. Desktop only: the
   method takes a caller-supplied host path, so a browser client would be
   choosing a directory on someone else's machine to load code from.
4. **Re-scan** in Manage Plugins, or restart. Discovery no longer runs only at
   startup: `plugins.rescan` re-reads every root and loads what it finds.
5. Enable it in **Plugins ▸ Manage Plugins…**, if it is not `enabledByDefault`.

**Revised scope statement: this feature makes user plugins reachable, not
discoverable.** Steps 3 and 4 no longer need a terminal or a restart. Steps 1
and 2 are untouched — nobody discovers a plugin, and nobody installs one without
`git clone` or an unzip.

### What a re-scan can and cannot do

Not symmetric, and the asymmetry is inherent rather than an unfinished corner.
`discover()` is stateless and re-reads disk every call, so scanning is cheap;
what is not cheap is what a scan may do to code **already running**. Node's
`require` caches by resolved path (verified by probe, t22 — rewriting a running
plugin's `engine.js` and re-requiring it returns the *original* export):

| Change | Re-scan result |
|---|---|
| Plugin **added** | Loads. Never required this run ⇒ no cache entry. |
| Plugin **removed** | Deactivated; engine half torn down, renderer halves dropped in every window. |
| Plugin **changed in place** | **Cannot be applied. Restart required, and the row says so.** |
| A **different copy** supersedes it (§4) | Loads only if the running copy is not already registered; otherwise restart-required. |

The third row is the honest half. Busting `require.cache` would leave the old
closure's registrations live while a second copy registers on top, which is worse
than not reloading — so a changed plugin is reported, never silently half-applied.
**A row showing a new version beside old running code is the failure this design
refuses**; it is the same shape as the badge bug and the verb quarantine, a
consumer displaying something the producer never confirmed.

Consequences worth stating:

- **A re-scan takes no strike.** The quarantine counter exists for plugins that
  crash on a real activation; a user pressing Re-scan repeatedly must not
  quarantine a plugin that was half-copied at the moment they pressed it. Same
  reasoning as §4a's refused-not-punished verb collision.
- **Quarantine still shadows a re-scan.** Retry is the explicit counter-clearing
  path, and a re-scan that silently activated a quarantined plugin would make
  Retry meaningless.
- **A re-scan can flip which copy of a shadow pair wins**, since precedence is
  recomputed from disk. Suppressing that would require new state whose only
  purpose is making the dialog disagree with the disk.
- **Enable/disable does not clear a restart-required flag.** An enable does not
  empty the require cache, so re-activating a changed plugin re-runs the *old*
  module against the *new* manifest.

### Still not solved

- **A place to find plugins at all.** No directory, no index, no in-app search.
  This is a **distribution** question, not an install-flow one, and deliberately
  not answered here or stubbed: step 1 above is unchanged, and a user still
  learns a plugin exists from a README, a link, or a person.
- **Obtaining the plugin.** Register Plugin… removes the copying step — a
  cloned checkout is registered where it sits — but step 2 is untouched: the
  clone or the unzip is still the user's, in a terminal or a file manager. This
  is where a local-only design stays honest: picking a directory is not a fetch.
- **A registered plugin's renderer half on the WEB surface.** §6's limit
  unchanged: `renderer/web/plugin-registry.js` is generated at build time from
  the repo's own `plugins/` tree, so a plugin registered from elsewhere runs its
  engine half there and has no browser UI. Stated in the dialog's hint text,
  because a user who reaches this Clodex from a phone would otherwise read it as
  a break.
- **Replacing a running plugin without a restart**, per the table above. Reaching
  it would mean deactivating and re-registering a live plugin against a fresh
  module — a substantially larger change than an install flow, and one that
  would need its own decision about what happens to state a plugin already holds.

---

## 11. Implementation status

| Section | Status |
|---|---|
| §3 multi-root discovery, user root at `~/.clodex/plugins/` | **Implemented** |
| §4 core-wins precedence, shadowed rows in Manage Plugins | **Implemented** |
| §4 a strictly newer copy overrides core-wins; both versions on the row | **Implemented** |
| §4 a `version` 99 in the user root wins permanently | Visible, not preventable — needs §10 |
| §4 pre-release versions (`1.0.0-beta`) order correctly | Not implemented; uncomparable, loses visibly |
| §4a verb collisions refused without a strike, holder named | **Implemented** |
| §4a which plugin wins within a root | Arbitrary — known limit, needs §10 |
| §5 symlink following; the case-folding assumption | **Implemented** / assumed |
| §6 Electron-only, lint & parity unaffected | Verified property; no code |
| §7 trust posture | Posture; no code |
| §8 npm dependencies | Sketch, not built |
| §9 sources: GitHub fetch, engine + host methods | **Implemented** (desktop only), no dialog — phase B |
| §9 sources: install/update/remove UI | Not built — phase B |
| §10 reveal the user plugins folder; re-scan without restart | **Implemented** |
| §10 replacing a RUNNING plugin without a restart | Not possible — require caches by path; reported, never faked |
| §10 an install affordance — register a folder from anywhere | **Implemented** (desktop only) |
| §10 a place to find plugins at all | Out of scope — distribution, not install flow |
