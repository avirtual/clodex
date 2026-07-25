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
