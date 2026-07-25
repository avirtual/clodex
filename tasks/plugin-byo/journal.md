# plugin-byo — journal

Worktree `wb-wrap-ui-plugin-phase-1`, branch `plugin-phase-1`. Written at
dispatch so a fresh context can resume without re-reading the tickets.

**State at dispatch:** HEAD `a3e0058` (t15), suite **2489/2489**, tree clean
apart from the untracked `node_modules` symlink. 33 ahead of local `master`,
34 of `origin/master`. Nothing pushed.

**Order: t17 FIRST** (live defect, outranks design work), then t16. Next
deviation letter is **(x)**.

Standing constraints — full set in the pickup note at the end of
`tasks/plugin-phase-3-freeze/journal.md`. Short form: `hostApi` FROZEN at `"1"`,
narrowing a lent surface is breaking; **code wins over docs**; verify clodex's
claims against source before obeying (four were wrong in Phase 3, two more in
Phase 4a); suite ONLY via the `clodex-test-green` skill with an explicit cd into
the worktree; `git reset -q node_modules` + explicit path lists, never
`git add -A`; `npm run build:web` after touching bundled sources or
adding/removing a renderer half; never edit `.claude/CLAUDE.md` or
`.claude/memory.md`; do not touch master, do not push.

---

## T17 — multi-window disable/re-enable: badges return late or not at all

**A live defect Bogdan found by running the app. This is VERIFY.md step 2, and
it failed** — note t15 established that step 2's own claims were partly false,
so the file is a starting point, not an oracle.

### Observation (Bogdan, substance verbatim)

Two workspaces open, both showing branch badges. Unchecked the plugin → badges
disappeared from both (correct). Re-checked → **only ONE window showed badges.**
Several more disable/enable flips → both appeared to stop updating entirely.
Then, **30–60 SECONDS later, badges reappeared on their own while he was
typing.**

### clodex's hypotheses — to CONFIRM OR KILL against source, not assume

1. **Stale-while-revalidate across the disable boundary.** `engine.js:322-331`
   answers a stale slot immediately and refreshes in background. The ENGINE half
   is per-app-run and its cache survives a disable; the RENDERER half is
   per-window and is rebuilt. A re-enabled window may be served a stale slot and
   only paint when the background refresh lands. **`engine.js:28` claims the TTL
   "makes the plugin correct with N windows open" — observation contradicts it,
   and it is a comment, i.e. the exact class of unexecuted assertion we have been
   finding all day.**
2. **`unroutable` is a latch with no reset.** `plugins/git-branches/renderer.js:155-162`
   sets `unroutable = true` and stops timers permanently on `no such plugin
   method` (deliberate). **Disabling produces precisely that error for any
   in-flight invoke.** If the latch survives into a re-enabled renderer half — or
   the module instance is reused rather than freshly constructed per activation —
   that window is permanently dead. **This would explain "only one window came
   back" exactly.**
3. **Timer accumulation or orphaning across flips** — old poll timers not cleared
   on teardown, or a new activation not starting one.

### The key evidence

**The 30–60s figure, which NO timer in the plugin explains**: refresh default is
10s, `ttlMs()` floors at 2s, debounces are 60/120ms. **Find what interval can
produce 30–60s.** If nothing in the plugin can, the delay is coming from core's
relayout path — `renderer/renderer.js:1069-1072`'s 250ms debounce feeding
`refreshSidebarView` — and the badge only repaints when something ELSE triggers a
relayout (activity, a session change, Bogdan typing). **That would make it a CORE
finding: pull-based surfaces have no push.** Far more interesting than a plugin
bug, and it would apply to every future plugin.

### Deliverable, in this order

1. **Root cause, PROVEN — not reasoned.** A failing test if constructible; if the
   two-window aspect genuinely cannot be harnessed, **say so explicitly** and
   prove what can be proven single-window.
2. **PLUGIN defect or CORE/API defect?** Matters more than the fix: if a
   pull-based surface has no way to invalidate, that is a `hostApi` finding and
   belongs with 4a's — the second time the API's shape bit a consumer.
3. **The fix, if it is the plugin's. If it is core's, STOP and report before
   touching core** — same rule as 4a.
4. **Correct `engine.js:28`'s N-windows claim regardless of outcome**; observation
   has already falsified it as written.

### Phase 1 — source reading. All three hypotheses KILLED; root cause found.

**H1 (stale-while-revalidate across the disable boundary) — KILLED.** The engine
cache does *not* survive a disable: `deactivate()` calls `entries.clear()`
(`engine.js:507`) and `activate()` reassigns `entries = new Map()` (`:413`). And
the direction is wrong anyway — a stale slot would paint *sooner*, not later.

**H2 (`unroutable` latch surviving into a re-enabled window) — KILLED.**
`unroutable` lives inside `activate()`'s closure (`plugins/git-branches/renderer.js:41`),
not at module level. The Node module cache does hold the module object across a
re-enable, but `pluginBar.activate` calls `mod.activate(rhost)` afresh
(`plugin-host.js:597`) and `dispose()` clears the `activated` guard first
(`:613`), so a re-enabled window gets a brand-new closure with `unroutable = false`.
This was the hypothesis that would have explained "only one window came back";
it does not.

**H3 (timer orphaning) — KILLED as stated,** but it is the near miss. `dispose()`
clears every tracked interval/timeout (`plugin-host.js:625-628`) and the plugin's
own disposer calls `stopTimers()`; a fresh activation calls `startPolling()`
(`renderer.js:361`/`:366`). The timers are correct. **They just have nothing to
fetch** — see below.

### Root cause — two legs, both required

**Leg 1: activation paints nothing.** `dispose()` un-paints EAGERLY — `:649`
removes every `[data-plugin-badge^="<id>:"]` node directly, which is exactly why
Bogdan saw both windows clear instantly and correctly. **`activate()` has no
counterpart.** It creates the `<style>`, builds the rhost, calls `mod.activate`
and returns (`:566-606`); nothing schedules a relayout. Nor does registration:
`rowBadge(spec)` is a bare `register(...)` (`:243`), while the sibling
`footerButton` calls `renderFooterButtons()` on registration AND on disposal
(`:236-238`). So after a re-enable the row badge exists in the registry and
nothing on screen changes until something ELSE calls `refreshSidebarView`.

**Leg 2: the plugin's poll cannot bootstrap itself.** `poll()` fetches
`activeNames()`, which iterates `seen` (`renderer.js:199-219`). `seen` is written
in exactly one place: `resolve()` (`:261`) — i.e. only when core renders a row.
In a freshly-activated closure `seen` is EMPTY, so the 10 s poll runs forever
fetching an empty name list. The plugin's own liveness mechanism is demand-driven
off a signal only core's relayout produces, so a window that never got a relayout
never self-heals, no matter how long it polls.

### The 30–60 s figure — found, and it is core's

`renderer/renderer.js:1172`: `setInterval(() => refreshSidebarMeta({ includePr:
false }), 30000)`, and `refreshSidebarMeta` ends with `refreshSidebarView()`
(`:1121`). **That is the interval.** A re-enable lands at a uniformly random point
in that 30 s cycle, and a tick is skipped entirely if one is already in flight
(`metaRefreshInFlight`, `:1111`) — so "30–60 seconds" is exactly the shape of
waiting one-to-two 30 s meta ticks. "While he was typing" is the same mechanism by
the other door: PTY activity seeds meta and calls `scheduleSidebarRelayout()`
(`:1135` region), which is why the badges came back *while* he typed rather than
because of anything the plugin did.

This confirms clodex's framing: the badge only repaints when something else
triggers a sidebar relayout. **The pull-based surface has no push at activation.**

### "Only one window came back" — the part I cannot prove

Both windows wait for their own independent relayout trigger, and the focused
window has far more of them (typing, PTY activity) than a background one. That
explains the observation, but it is an ORDERING between two live BrowserWindows
and no harness holds two. **Stated as unproven** rather than folded into the
proven part.

### Verdict: PLUGIN defect, with a core/API finding attached

The plugin can fix itself entirely inside the frozen API: `requestRelayout()` is
lent to it, and calling `queueRelayout()` at the end of `activate()` closes both
legs (relayout → `resolve()` → seeds `seen` and `request()`s → poll has names).
So the fix is the plugin's and no core edit is needed.

But the reason the plugin got it wrong is core's shape, and that is the finding
worth keeping: **`dispose()` paints, `activate()` does not** — the host is eager
on teardown and lazy on setup for the same surface, `footerButton` paints on
registration while `rowBadge` does not, and nothing in `plugin-api.md` tells a
plugin author that registering a row badge leaves the sidebar untouched. Every
future rowBadge plugin walks into this. Belongs with 4a's findings.

### Done — commit `05ed4d6`, suite 2492/2492

`plugins/git-branches/renderer.js` — one `queueRelayout()` at the end of
`activate()`. `plugins/git-branches/engine.js:28` — the N-windows claim corrected.
`test/plugin-git-branches-renderer.test.js` — new, 3 tests; test 2 fails by
message (not by crash) with the fix reverted, verified. `VERIFY.md` step 2 now
records the failure and what to re-check. `web-dist/index.html` rebuilt
(`npm run build:web`) since a bundled renderer half changed.

No core edits. No deviation letter needed — (x) is still unused.

### clodex's rulings on the finding (msg-5178-9), and what they produced

**Ruling 1 — document it in `plugin-api.md`, now.** Done: §6.4 gains
"Registration does not paint", quoting §6.3's *"the host paints the button on
registration"* and stating outright that the sentence is true of `footerButton`
and false of `rowBadge`. Covers the live-enable-with-window-open case, why it is
invisible at startup, the one-line remedy, and the second-order trap for a
demand-driven poll. §3's Law-2 paragraph (`:219-224`) gained a one-line pointer,
since that is where an author meets the blank-first-render idea.

clodex's own observation, worth keeping: `plugin-host.js:234`'s comment on
`addFooterButton` says *"the caller never has to remember either"* — and
`rowBadge` sits two lines below it requiring precisely that. **The doc defect and
the code defect are adjacent**, which is why neither was seen.

**Ruling 2 — do NOT fix core's asymmetry now.** Making `rowBadge()` paint on
registration changes *when `resolve()` is first called* for every plugin: it would
fire during `activate()`, earlier than any existing plugin expects, possibly before
that plugin's own state is built. git-branches tolerates it — one data point, not
a guarantee. Specced in `plugin-plan.md` §6 as a v1.1 candidate with the
resolve-timing hazard named as the reason it is not a two-line patch. Needs
Bogdan awake.

**Ruling 3 — the unproven claim stays unproven and stays labelled.** Unchanged.

**The pattern, now written next to 4a's finding** (`plugin-plan.md` §6, "Phase 4's
second finding"): this is the **second time the API's shape bit a consumer**.
Different symptom — 4a's missing data surface, t17's missing paint-on-register —
one cause: the host was built alongside the workbench, so behaviour the workbench
did not happen to need was never made symmetric. **An insider-shaped artifact
validated by insiders.** The lesson for Phase 5 is not "fix these two"; it is that
the next non-co-designed consumer finds a third.

---

## T16 — multi-root plugin discovery (AFTER t17)

Bogdan reframed the effort: **users must add their OWN plugins to their own
installation without those plugins living in the Clodex git tree** — no merge
conflicts, no `git pull` friction, ever. Long-term: core plugins (this repo
and/or a `clodex-plugins` repo) plus user plugins from **sources**, local or
remote. **His ruling: LOCAL ONLY.** Remote (github) comes later behind an
explicit risk warning and is **out of scope**.

Note this work is **mostly OUTSIDE the frozen surface** — discovery and loading
are host-internal — which clodex wants stated in the doc.

### Part 1 — design doc (`docs/plugin-sources.md` or a section elsewhere; argue the placement)

- **Multi-root discovery.** `plugin-loader.js:64` already takes `pluginsDir`
  injected; `discover()` at `:170` reads exactly that one dir — the seam exists.
  Design the list-of-roots version: repo root + a user root outside the tree.
  `~/.clodex/plugins/` is the plan's Phase 5 choice — **check whether that is
  still right given `clodex-paths.js` single-sources the `~/.clodex` grammar**; a
  new top-level shared dir may need registering there rather than hardcoding.
- **Id precedence across roots.** Today id uniqueness is a **filesystem
  accident** (one dir, one dirname per id). Two roots can both hold
  `git-branches`. Decide precedence, and require a **VISIBLE shadowed-by state**
  in Manage Plugins — otherwise a user edits code that is not the code running.
  **`uiSettings.plugins.enabled` is keyed by bare id**, so a shadowed plugin
  shares the enabled flag AND the settings object with its shadower — say what
  that means.
- **The Electron/web split** (clodex verified): `renderer.js:3020` is
  `window.require(rendererPath)` — a RUNTIME absolute path, so an external
  plugin's renderer half loads fine in Electron with no build step, and CSS was
  never a problem (it travels as text over `plugin:invoke`). The web bundle
  cannot do this (esbuild resolves at build time — hence
  `renderer/web/plugin-registry.js`). **Honest rule: external plugins are
  Electron-only. State it; do not try to solve it.**
- **Trust posture** (Bogdan's framing): a local plugin is code the user
  deliberately placed on their own machine, judged like anything else they run —
  **no warning theatre**. Remote fetch is a DIFFERENT posture (code *authorized*
  rather than *written*) and is where a warning belongs. Tie to §14's "contract,
  not containment": enabling any plugin runs arbitrary in-process code with full
  access. **One honest paragraph.**
- **npm dependencies**: none today. **Sketch only** — vendored `node_modules`
  beside a manifest should work by normal resolution and needs no machinery;
  running `npm install` on fetched code executes install scripts, a strictly
  bigger trust step. **Recommend, do not build.**
- **Sources, SKETCHED NOT SPECIFIED.** A source **populates a root**; it is not a
  new loading path. That framing is what keeps remote additive later. Half a
  page, deliberately disagreeable.

### Part 2 — implement the LOCAL ROOT ONLY

Multi-root discovery with the user root, precedence rule, shadowed-by surfaced in
Manage Plugins, tests. **Do NOT build fetching, updating, pinning, or any network
path.**

### Watch for (clodex calls this a real question, not a detail)

- The no-backdoor lint and `test/plugin-boundary.test.js` **assume plugins live
  under `<repo>/plugins`**. An external root changes what those scan and possibly
  what they CAN scan — **we do not lint code we did not ship.** Decide and state
  it.
- Same for `plugin-web-parity`, which **must not start failing** because a user
  root has a renderer half that is legitimately not in the bundle.

### Standing instruction

**If Part 1 turns up something that makes Part 2 the wrong shape, STOP and report
rather than building to a design you no longer believe. That is what 4a earned.**

---

### T16 phase 1 — source verification, before writing any doc

**clodex's seam claims: both CONFIRMED.** `pluginsDir` is injected
(`plugin-loader.js:64`) and `discover()` (`:170-224`) reads exactly that one
directory. Only two production call sites exist — `engine.js:1762` and the tests.
The seam is as clean as claimed.

**The lint/parity watch-items need NO decision — they are already answered by
construction.** Both tests compute their scan root from `__dirname` at dev time:
`test/plugin-boundary.test.js:54` (`path.join(ROOT, 'plugins')`) and
`test/plugin-web-parity.test.js:30` (same). They are static gates over the code
*this repo ships*, run from the repo, and they cannot see a user root even in
principle — there is no user root on a CI checkout. So "we do not lint code we did
not ship" is not a posture to adopt; it is already true and unbreakable by this
change. Parity likewise cannot start failing: `pluginsWithRendererHalf()` reads
`<repo>/plugins`, so an external renderer half is never expected in the bundle.
**State this in the doc as a verified property, not a decision.**

**`~/.clodex/plugins/` is still the right choice, and it does NOT go through
`clodex-paths.js`.** That module single-sources the **per-agent** grammar only:
`runDirFor` builds `run/<name>/` and `pathFor` builds `run/<name>/<kind>` — those
are the only two constructors it exports, and `KINDS` is a per-agent artifact
table. Shared root-level dirs (`messages/`, `pending/`, `agents/`, `skills/`,
`library/`) are *documented* in its header but not *constructed* by it. A plugins
root is a shared dir, so it needs a line in that header's shared list and no entry
in `KINDS`. Registering it as a kind would be wrong — it is not per-agent.

**NEW FINDING, and it reframes the ticket.** `engine.js:1762` sets
`pluginsDir: path.join(__dirname, 'plugins')`, and the comment two lines above
says plainly that `__dirname` is "the app.asar root when packaged". `package.json`
ships `plugins/**/*` inside that asar. So **in a packaged install the plugins
directory is inside a read-only archive that is replaced wholesale on every
update.** A user running the DMG — i.e. every non-developer — cannot add a plugin
today at all, and could not keep one across an upgrade if they could.

That changes the argument for this work. Bogdan framed the user root as avoiding
merge conflicts and `git pull` friction, which is a developer's problem. It is
also, and more fundamentally, **the only mechanism by which a packaged install can
have a user plugin at all.** Worth reporting: it strengthens Part 2 rather than
undermining it, so it is not a stop-and-report under the standing instruction, but
clodex should have it before the doc argues its own motivation.

Related, for the doc: `engine.js:1759` already names this as "GAP G8
(packaged-.app resource layout) … deliberately not pre-solved here". Part 1 is
where that gap gets an answer.

### T16 DONE — `docs/plugin-sources.md` + the local root. Suite 2501/2501.

Doc and code landed in ONE commit: the doc's §11 status table claims §3/§4/§5 are
implemented, which is only true with the code beside it.

**Doc** (`docs/plugin-sources.md`, 11 sections). Motivation leads with the
packaged case per clodex's ruling — Phases 0–3 shipped an extension system only
its authors can extend — with the merge-conflict framing demoted to a footnote.
GAP G8 answered explicitly, `extraResources` considered and refused (chiefly:
its contents are *still* replaced by an update, so a plugin there fails late and
quietly, which is worse than a directory the user simply cannot write). §10 states
plainly that there is no install flow and scopes what would have to exist.

**Code.** `plugin-loader.js` takes `roots` (precedence order) and keeps
`pluginsDir` as the one-element spelling — every existing caller passes it, so
this is not a breaking change and there is a test saying so. `discoverRoot`
iterates per root with a `claimed` map; a later root's copy of a claimed id is
recorded in `discoveryShadowed` and not loaded. `status()` gains `shadowed` plus
`root`/`rootLabel` per plugin; `problems` rows gain `root`. `engine.js` passes
both roots (`REGISTRY_DIR + '/plugins'` for user, never created by the app).
`renderer.js` renders no-toggle shadowed rows. `clodex-paths.js` header gains
`plugins/` in the shared-dirs list, no `KINDS` entry.

**Symlink following: the finding, and it was already broken.** Verified by
execution that `readdirSync(withFileTypes)` reports a symlink-to-dir as
`isSymbolicLink()` and NOT `isDirectory()`, so the old filter skipped it —
silently, since a dir with no manifest is not an error. Now followed, with
`insideDir` running against the resolved dir. Revert proof: test fails by message
(`a symlinked plugin directory is discovered / 0 !== 1`), not by crash.

**A regression I caused and an existing test caught.** My first `resolveDir`
called `realpathSync` on *every* directory, which on macOS rewrites `/var/...`
to `/private/var/...` — changing `dir`/`enginePath`/`rendererPath` for callers
that have no symlink at all. `rendererInfo returns the renderer path and the
stylesheet TEXT` went red on exactly that. Fixed by resolving **only** when the
entry is a symlink. Worth recording: the test that caught it was pinning
something unrelated, and the failure was a path-prefix diff — the cheapest
possible way to learn that a "harmless" normalisation is not harmless.

9 new tests in `test/plugin-loader.test.js`. `plugin-loader.js` is already in
`free-identifier-leaks.test.js`'s SCANNED_MODULES, so no list update was needed.

**Not built, per scope:** fetching, updating, pinning, any network path.

---

**Superseded phase-2 note:** write `docs/plugin-sources.md`. Design precedence and
shadowing for **inputs we did not choose** — clodex's note, and it is the same
insider-shaped-artifact pattern one level out, since every plugin that has
exercised discovery so far was put in `<repo>/plugins` by us. Named cases to cover
or explicitly exclude: a symlinked plugin directory, a manifest id disagreeing
with its dirname (already refused at `plugin-loader.js:40` — check it still reads
correctly across roots), a half-copied directory with no `manifest.json` (already
silent-skipped at `:186-191`), a directory present in both roots, and case-folding
collisions on macOS's case-insensitive default filesystem. **Where an input cannot
be designed for, say which inputs were assumed.**

---

## T18 — document the global intent-verb namespace as a user-plugin hazard

**Dispatched after t16 shipped. Found by RUNNING the app**, not by reading:
clodex and Bogdan installed a second plugin into the user root (a copy of
git-branches under id `gb-user`) and it would have failed to activate, because
`intent-registry.js:343` is claimed to throw `intent verb "<type>" is already
registered` when two plugins claim the same verb. clodex renamed the copy's verb
to dodge it.

**The behaviour is CORRECT** — a verb is a global namespace and first-come is the
only sane rule. **The gap is that nothing tells an author or a user this.**

### Do this first, before writing anything

1. **Verify the claim at `intent-registry.js:343` myself** (clodex has been wrong
   repeatedly; code wins over docs).
2. **Check what the failure looks like END TO END**, because that determines how
   bad this is. A throwing `activate()` is a strike toward quarantine (§10), so a
   user installing two plugins that want the same verb may get a plugin **held
   back after two launches**, with a message about *activation failure* rather
   than about a *verb collision*. **If that is what happens, say so plainly — the
   user-visible symptom and the actual cause are far apart.**

### STOP condition (changes the ruling)

**If the collision takes down a plugin that was working fine BEFORE the new one
was installed — rather than the new one failing — STOP and report.** That is a
defect, not a documentation gap.

### Two places to write it

- **`docs/plugin-sources.md`** — a user with two installed plugins is the FIRST
  situation where this is reachable; in-repo plugins are curated by us, so a
  collision would be caught at review. State that verbs are global and
  first-come, that the loser fails to activate, and **what the user actually
  sees**.
- **`docs/plugin-api.md`** — an author choosing a verb is choosing from a global
  namespace shared with plugins they have never seen, so **a distinctive verb is
  a compatibility requirement, not a style preference**.

**Do NOT invent a namespacing scheme or propose auto-prefixing.** That is a v1.1
design question and the freeze holds.

### The connection worth one line

**Same pattern as t16's id collisions, one layer down.** Ids got a precedence
rule and a visible shadowed row; verbs got neither — because the plugin system's
only consumers until today were plugins we wrote.

### State at dispatch

HEAD `fef4da4`, suite **2501/2501**, tree clean apart from the untracked
`node_modules` symlink. 39 ahead of local master. Nothing pushed. Deviation
letter **(x)** still unused. Do not touch master, do not push.

### T18 INVESTIGATION — STOP CONDITION MET. This is a defect, not a doc gap.

The ticket named the hard stop: *"if the collision takes down a plugin that was
working fine before the new one was installed, rather than the new one failing,
STOP and report."* **That is exactly what happens.** Proven by execution, not by
reading — probe drove the real `plugin-loader`, real `plugin-host-engine` and
real `intent-registry`, with only the session manager and uiSettings faked.

**`intent-registry.js:343` verified verbatim:**
```js
if (pluginRows.some((r) => r.type === type)) throw new Error(`intent verb "${type}" is already registered`);
```
Called from `plugin-host-engine.js:322` (`intents.register`), inside
`register()`'s try at `:432-438`, which logs, calls `deactivate(pluginId)`, and
**rethrows**. `plugin-loader.js:341` `loadOne` catches, logs `FAILED to load
<id>`, and calls `recordFailure` — one quarantine strike. So a verb collision
IS an activation failure with a strike, as the ticket suspected.

**But the loser is not the newcomer.** `discover()` iterates roots in precedence
order, and within a root sorts entries **alphabetically by directory name**
(`plugin-loader.js:221`). Install order is not recorded anywhere and cannot be
recovered. So the winner is whichever plugin sorts first, and installing a new
plugin whose directory name sorts EARLIER than an existing one takes the
existing one down.

Observed, verbatim from the probe (`zzz` installed and working first, then `aaa`
installed, both claiming verb `probe`, single user root):

```
A1 — only zzz installed
  result: {"id":"zzz","ok":true}
A2 — aaa installed later, first launch after
  result: {"id":"aaa","ok":true}
  result: {"id":"zzz","ok":false,"error":"intent verb \"probe\" is already registered"}
  status: zzz enabled=true quarantined=false failCount=1
A3 — second launch after
  result: {"id":"zzz","ok":false,...,"quarantined":true}
  status: zzz enabled=true quarantined=true failCount=2
A4 — third launch after
  result: {"id":"zzz","ok":true,"skipped":"quarantined"}
```

`zzz` worked. The user installed an unrelated plugin. `zzz` broke, and two
launches later it was quarantined and silently skipped, with its `enabled` flag
still true. **The user's working plugin is the casualty and the newcomer is
fine.** Log line the user would have to find to understand it:
`zzz: strike 2 — QUARANTINED (Preferences ▸ Plugins offers Retry; your enabled
setting is untouched)`.

**Symptom and cause are as far apart as the ticket feared, plus one step.** The
Manage Plugins row for `zzz` says quarantined-after-failed-activation. Nothing
anywhere names the other plugin, and nothing suggests the two are related. The
plugin the user just installed looks healthy.

**Retry does not recover it.** `engine.setEnabled('zzz', true)` →
`{"ok":false,"error":"intent verb \"probe\" is already registered"}`, and it
re-strikes immediately. The only recovery is to disable the WINNER first, which
requires the user to have guessed the relationship:
```
Disable aaa: {"ok":true}
Retry zzz after disabling aaa: {"ok":true}
```

**Core-vs-user is the benign direction, and it is the only one clodex saw.**
Roots are iterated in precedence order, so a core plugin always beats a user
plugin regardless of name (probe B1: core `zcore` beat user `auser`). That is
why the `gb-user` case looked like "the new one fails" — it was a user copy
losing to core. Two USER plugins, the case BYO makes reachable, behave as above.
The mirror hazard is worse and also unhandled: **a core plugin that adds a verb
in a future release takes down a user plugin that already used it**, at update
time, with no diagnostic connecting the two.

**Why the analogy to t16 breaks rather than holds.** t16's id collisions got a
precedence rule AND a visible `shadowed` row that names the winner. Verbs got
neither: the collision is discovered at activate time, after `discover()` has
already accepted both plugins, so there is no shadowed row to render and the
loser is recorded as a failure rather than as a shadowed copy. Same pattern one
layer down, but the layer below has strictly worse behaviour, not merely
undocumented behaviour.

**Not touching either doc.** Per the ticket, this changes the ruling and the
call is clodex's. Documenting "verbs are global, first-come, the loser fails to
activate" would be documenting something that is not true as stated — the loser
is the alphabetically-later plugin, not the later-installed one, and it does not
merely fail to activate, it is quarantined.

Probe scripts (scratchpad, not committed):
`verb-collision-probe.js`, `verb-collision-retry.js`.

Nothing committed under t18. HEAD still `fef4da4`.

### T19 — dispatched mid-t18, NOT started

Record Bogdan's decision that wirescope stays vendored and `docs/plugin-plan.md`
§6 Phase 4b is dropped — struck through like 4a, not deleted, with the
reasoning. Standing rule to state: **a 1.1 addition must serve more than one
caller, or it is a private extension wearing a version number.** Note it costs
nothing and forecloses nothing; migration stays available if a second consumer
appears. Check §5.2's A/B/C additions, the GAP register, and Phase 5's scope for
anything that assumes 4b happens — those should read *unscheduled*, not
*pending*. STOP and report if dropping 4b changes a decision already made rather
than merely removing future work. Deviation letter (x).

## T20 — verb collision must be refused, not punished

Supersedes t18's doc work (its sentence was false). Target behaviour from clodex:
(1) refused, not punished — no quarantine strike; (2) visible and self-explaining
— name the verb and the holder, in t16's shadowed-row register; (3) the incumbent
survives where we can tell who the incumbent is.

### Shape chosen: refuse at REGISTRATION time. Not a manifest field.

Both shapes were weighed against the three targets. The decider is **coverage**.

- **Manifest declaration** would let `discover()` arbitrate before any module is
  required, so the loser never activates and takes no strike *by construction*.
  Deterministic, and it enables a real shadowed-style row. But clodex's own
  question kills it: if an undeclared verb still registers with today's
  behaviour — and it must, or the field is a breaking change — then **the defect
  stays live for every plugin that does not declare**. The plugins that will not
  declare are exactly the ones we did not write, which is the entire population
  that made this reachable. A fix that covers only cooperating plugins does not
  cover the case it exists for.
- **Registration-time refusal** covers every plugin unconditionally, declared or
  not, needs no manifest field and raises no hostApi question at all. Its cost is
  that the loser is decided by load order — but that costs nothing real, because
  **both shapes fail target 3 identically** (below).

So: no new surface, no `hostApi` question, universal coverage.

### Target 3 is NOT achievable, and this is the honest limit

**Incumbency is a temporal property; discovery is stateless.** `discover()` reads
the disk every call and nothing anywhere records when a plugin arrived. Install
order is not recoverable. Any static rule — alphabetical, root precedence,
manifest order — is arbitrary with respect to "who was here first", so it would
be exactly the fake ordering clodex said he did not want.

Rejected: reading install order out of `uiSettings.plugins.enabled`, which *is*
an append-ordered array (`setEnabledInSettings` appends). It only looks like
install order — the first write materialises the whole current set in
**discovery** order (`plugin-loader.js:324`), and a default-on plugin never
appears until its first toggle. It would be a fake ordering that is right often
enough to be trusted and wrong without warning.

Rejected: a persisted verb-ownership ledger. It would hit target 3, and it buys
staleness worse than the bug — ownership held by a deleted plugin, or by a
plugin the user disabled, blocking a plugin that is actually running.

**Consequence, stated plainly rather than papered over:** within one root the
casualty of a collision is still the alphabetically-later plugin, which may be
the one that was already working. What changes is that it now fails *visibly and
recoverably* instead of being quarantined under a message about activation
failure. The user is told which plugin holds the verb, so the fix is a decision
they can actually make.

### The mirror, and why it is target 3's clearest failure

Roots iterate in precedence order, so a core plugin adding a verb in a future
release registers BEFORE the user plugin that already used it. The incumbent
(user) loses to the newcomer (core). Precedence cannot be reversed for verbs
without contradicting the id rule settled in t16. Same mechanism covers it — the
user plugin is refused cleanly and told that a built-in plugin now holds the verb
— but target 3 is missed in the direction where it would matter most. To be
confirmed by probe, not asserted.

### No migration needed — verified, not assumed

Only ONE shipped plugin declares a verb at all (`plugins/git-branches/engine.js:484`,
`verb: 'branch'`), so no released install can hold a verb-collision quarantine
record: the defect is only reachable with user plugins, and BYO is unreleased.
Nothing has to un-quarantine on upgrade.

### Implementation plan

1. `intent-registry.js:343` — find the holding row, throw an error carrying
   `code = 'EVERBTAKEN'`, `verb`, `heldBy`. Message keeps the substring
   `already registered` (pinned by `test/intent-registry.test.js:338` and
   `test/plugin-host-engine.test.js:418`) and gains the holder's id.
2. `plugin-host-engine.js:432-438` — rethrows `e` itself, so the properties
   survive untouched. Verify, do not change.
3. `plugin-loader.js` `loadOne` — classify: on `EVERBTAKEN`, record a verb
   conflict and **skip `recordFailure`**. Conflicts live in an app-run Map, NOT
   persisted (persisting it would reintroduce the staleness I just rejected).
4. `status()` — per-plugin `verbConflict: { verb, heldBy }`. A per-plugin field
   rather than a top-level list like `shadowed`, because unlike a shadowed copy
   this plugin is real and installed and keeps its toggle.
5. `renderer/renderer.js:5154` — the conflict note replaces the quarantine note,
   naming the verb and the holder. `npm run build:web` after.
6. Probe re-run (`zzz`/`aaa` + the mirror), then revert-proof each test.

### T20 OUTCOME — implemented, suite 2506/2506

Targets 1 and 2 HIT. **Target 3 NOT hit, and it is not achievable** — see above.

Proven by re-running the same harness that found the defect. Before/after on the
`zzz`/`aaa` sequence (`zzz` working, then `aaa` installed, both wanting `probe`):

| | before | after |
|---|---|---|
| launch 1 after install | zzz failCount=1 | zzz refused, failCount=0 |
| launch 2 | zzz QUARANTINED | zzz refused, failCount=0 |
| launch 3 | zzz skipped — quarantined | zzz refused, failCount=0 |
| Retry on zzz | re-strikes, still fails | no strike; still refused while aaa holds it |
| disable aaa, retry zzz | works | works |

The mirror was CONFIRMED by probe, not asserted (`verb-collision-mirror.js`): a
user plugin `aaa-mine` holding `notes`, then an app update shipping core plugin
`zz-builtin` claiming `notes`. The user plugin loses to root precedence — the
incumbent loses to the newcomer, target 3's clearest failure — but takes no
strike, is never quarantined, and its row names `zz-builtin`. Same mechanism,
confirmed to cover it.

What the user now sees, in place of "Disabled automatically: activate() threw on
2 consecutive launches":

> Not running: it uses the intent verb [agent:probe], which the "aaa" plugin
> already registered. Two plugins cannot share a verb — disable one of them.

Changed: `intent-registry.js` (EVERBTAKEN + verb + heldBy on the throw; message
keeps the `already registered` substring two tests pin, and gains the holder) ·
`plugin-loader.js` (`verbConflicts` per-run Map; `loadOne` classifies and skips
`recordFailure`; cleared on success and on activateById; `status()` exposes
`verbConflict`) · `renderer/renderer.js` (conflict note checked BEFORE the
quarantine note) · `web-dist/` rebuilt.

Tests: 5 added, each revert-proofed and failing BY MESSAGE. The over-broad
classification (treating every failure as a conflict) is caught by the eight
existing quarantine tests, so the failure machinery cannot be silently turned
off. `intent-registry.js:343`'s bare throw restored → the new registry test fails
on `actual: undefined, expected: 'EVERBTAKEN'`.

**Docs still owed** (t20 says they come after and describe what the code does):
`docs/plugin-sources.md` and `docs/plugin-api.md`. t18's original sentence is
superseded and must NOT be written — the loser is the alphabetically-later
plugin, not the later-installed one.
