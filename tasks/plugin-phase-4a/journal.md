# Phase 4a — journal

Worktree `wb-wrap-ui-plugin-phase-1`, branch `plugin-phase-1`. Two tickets,
sequential: **t13** (VERIFY.md triage) then **t14** (pot-drawer migration).
Next deviation letter is **(v)**.

Phase 3 constraints still bind — read the pickup note at the end of
`tasks/plugin-phase-3-freeze/journal.md` (`be36fb7`). Short form: hostApi FROZEN
at `"1"` and narrowing a lent surface is breaking; code wins over docs;
`npm run build:web` after touching bundled sources or adding/removing a renderer
half; `node_modules` stays untracked (`git reset -q node_modules`, explicit path
lists, never `git add -A`); the boundary lint is not a security control.

---

## T13 — VERIFY.md triage

Ticket's thesis: "no harness reaches it" and "no source read settles it" are
different claims, and VERIFY.md conflates them. Verdict so far: **it does**, for
at least three of the five.

### Source chain established (round 1 reads)

The whole badge path, end to end:

- `renderer/plugin-host.js:244` — `requestRelayout()` calls the injected
  `scheduleSidebarRelayout`, nothing else.
- `renderer/renderer.js:1069-1072` — `scheduleSidebarRelayout()` debounces
  250 ms, then calls `refreshSidebarView()`.
- `renderer/renderer.js:971-988` — `refreshSidebarView()` loops every local row
  and calls `pluginBar.applyRowBadges(el)` at `:982`.
- `renderer/plugin-host.js:251-273` — `applyRowBadges` resolves each badge and
  paints the chip.

That is a closed loop with no gaps: relayout → 250 ms → re-render → badge
resolve. **Step 1 is settled by source.**

- `renderer/plugin-host.js:268` —
  `chip.className = \`session-plugin-badge${r.cls ? ` ${String(r.cls)}` : ''}\``.
  `cls` is concatenated **verbatim and unprefixed**. Contrast `:258/:265`, where
  the badge **`id`** *is* namespaced (`data-plugin-badge="demo:count"`, pinned by
  `test/plugin-host.test.js:326`). So the asymmetry VERIFY step 2 asks about is
  real and resolved in the opposite direction to its worry: **id namespaced, cls
  not**. `docs/plugin-api.md:775` already says cls is a space-separated class
  list. **Step 2 is settled by source**, answer `gb-branch` unprefixed.

- `renderer/plugin-host.js:583-592` — one `<style data-plugin-style="<id>">` per
  plugin per window, `st.textContent = String(css)` — **injected verbatim, no
  rewriting, no scoping**. `docs/plugin-api.md:40` says "injected as a per-plugin
  `<style>`, per window", which is consistent but never says *unscoped*.
  **Step 3 is settled by source**: not scoped; a plugin can style anything.

- Step 5 VERIFY.md already marks settled-in-source (three independent legs:
  `intentSource` wire-xor-jsonl, `_scanPtyOutput` gated behind `if (!agentType)`,
  the per-batch `fired` Set).

### Round 2 — step 4, and the residue on step 1

**Step 4 is very largely already covered by a test that exists.**
`test/session-manager.test.js:4892` — "plugin verb: a granted seat reaches the
handler with a SessionHandle" — asserts the handler ran, that `intent.type` is
right, that the handle's keys are exactly
`['cwd','inject','isAlive','name','type','workspaceId']`, that `handle.name` is
the EMITTING session, and that the reply rode `handle.inject`. That is three of
VERIFY step 4's four "if not" branches (wrong session, wrong handle shape,
handler never called), pinned in CI since T10. `withVerb` (`:4855`) resets the
module-level registry in a promise-aware finally.

So step 4's live residue is NOT the signature — it is the **grant**: that the
per-seat intent checklist actually shows "Report git branch" and that ticking it
flips a real dispatch. The checklist UI and the seat's `intents` list are the
untested leg (the test hands `get: () => ({ intents: ['branch'] })` straight in,
`:4871`, which *assumes* the grant rather than exercising it).

**Step 1's residue is narrower than the doc implies.** The plugin→core link is
pinned: `test/plugin-host.test.js:371-375` asserts `requestRelayout()` calls the
injected `scheduleSidebarRelayout` exactly once, commented "the plugin never
reaches refreshSidebarView directly". What no test covers is core's own chain
beyond that seam — `scheduleSidebarRelayout` → 250 ms timer →
`refreshSidebarView` → `applyRowBadges` — because `makeHost` injects a fake
(`:165`). The fake is the legitimate injection seam, not a defect; but it does
mean the *four-line chain in `renderer.js`* is verified by reading, not by
running.

### Verdict per step

| step | bucket | answer / residue |
|---|---|---|
| 1 relayout re-renders | **settled by source**, cheap live confirmation | closed chain: `plugin-host.js:244` → `renderer.js:1069-1072` (250 ms debounce) → `:971-988` → `applyRowBadges` at `:982`. No gap. |
| 2 `cls` on the chip | **settled by source** | `plugin-host.js:268` concatenates `cls` **verbatim, unprefixed** → `gb-branch`. The badge **`id`** IS namespaced (`:258/:265`, pinned by `plugin-host.test.js:326`). Asymmetry is real, resolved opposite to the worry. |
| 3 stylesheet scoping | **settled by source** | `plugin-host.js:583-592`: one `<style data-plugin-style=id>`, `textContent = String(css)` — verbatim, **not scoped**. A plugin can style anything. |
| 4 verb replies | **mostly test-covered**; residue is the GRANT | `session-manager.test.js:4892` pins handler + handle shape + emitting session + reply path. Live: the checklist entry and the tick. |
| 5 once per line | already marked settled by source | three legs; unchanged. |

**Bucket 2 (a test we could write), for clodex — NOT written under t13:** the
`renderer.js` half of step 1 could be pinned by driving `refreshSidebarView`
against a jsdom-ish row and asserting `applyRowBadges` painted, with the timer
faked. Cost: real — `refreshSidebarView` reaches filter/sort/group and the peer
block, so it needs far more DOM scaffolding than `plugin-host.test.js`'s tiny
fake. My read: not worth it under t13's budget; the four-line chain is short
enough to audit by eye, and the seam either side of it is already pinned.

### Doc defects found — FLAG, do not fix (ticket's own instruction)

Neither is "silent". Both are the doc saying something that source contradicts
or that a reader will predictably misread:

1. **§6.4 on `cls` vs §6 on `id` namespacing.** `docs/plugin-api.md:651-654`
   states the rule as "`id` is a plain string that the host namespaces … **the
   prefix is the host's business, in both directions**". `:775` says `cls` "is a
   CSS class added to the chip". Source: `id` prefixed, `cls` not. The doc never
   states that the namespacing rule does NOT extend to `cls`, and the two
   paragraphs sit in the same section. A plugin author who generalises `:651`
   writes `.git-branches\:gb-branch` in their CSS and gets silence. This is the
   exact failure VERIFY step 2 was written to catch — and it is answerable
   without Bogdan.
2. **Stylesheet scoping is nowhere stated.** `:40` says "injected as a
   per-plugin `<style>`, per window" — true, and reads to a careful author like
   *scoped*, which it is not. Nothing in §1/§2/§6 says a plugin's CSS is
   global and can restyle core. §14 (limits) does not list it.

Both are one-sentence additions. Awaiting clodex's ruling before touching the
published doc.

### Then

Rewrite `plugins/git-branches/VERIFY.md` so the manual section holds ONLY the
irreducible residue, with a "settled by source" section carrying answers +
file:line.

---

## T15 — VERIFY.md re-audit: the prose was claims too

Triggered by an accident. Bogdan had me emit `[agent:branch]` from an ungranted
seat; it returned `[agent:branch] the branch intent is disabled for this
session`, and step 1 said that case is **total silence**. Fixed in `3fdde01`,
then clodex ruled the rest of the file needed the same treatment (t15).

**Why t13 missed it:** t13's scope was the five listed behaviours. The grant
paragraph was not one of the five, so it was never checked — an audit scoped to
a list inherits the list's blind spots. The revert discipline could not have
caught this either: there was no test to revert, only prose nobody had run.
**What caught it was executing the thing.**

### The three defects, all "told the operator to expect the wrong thing"

1. **Ungranted verb "fails silently"** — it bounces. `session-manager.js:2825`
   refuses at the gate and returns before dispatch, injecting at `:2839`. Pinned
   the whole time by `test/plugin-fake.test.js:999-1009` ("refused at the gate,
   never at the handler"), which asserts the empty handler record AND the exact
   string. A green test in this repo contradicted the doc.
2. **"the log shows `plugin:git-branches activated` exactly once"** — **no such
   line exists anywhere.** Nothing in `plugin-host.js`, `plugin-host-engine.js`
   or `plugin-loader.js` logs an activation; `logFor` (`plugin-host-engine.js:120`)
   only emits what a plugin passes to `host.log`. The nearest real line is the
   loader's `loaded <id> v<ver>` at **startup discovery** (`plugin-loader.js:281`),
   a different event that will not reappear on a live re-enable. Bogdan would
   have hunted for an unprintable line.
3. **"a leaked timer would surface as a failed `invoke`"** — it would not. The
   plugin handles that case on purpose: a stray invoke gets the documented
   `{ ok:false, error:'no such plugin method' }` and `checkRoutable`
   (`plugins/git-branches/renderer.js:155-162`) swallows it, stops its timers and
   logs an **info** line. So a silent console is consistent with BOTH a clean
   teardown and a leak — **the stated observable cannot discriminate.** The file
   now points at the info line as the real signal.

### What else changed

- **Marking convention.** Every sentence stating what the app will do now either
  cites `file:line` or is marked **[unrun prediction]**. Step 2's teardown is
  `[source]` (`plugin-host.js:649` removes badge nodes directly, so chips vanish
  without waiting for a relayout; `:644` the style; `:645` the settings section);
  two-windows and re-enable stay `[unrun prediction]`.
- **Step 0's failure branches**, which were guesses, are now diagnostics: an
  absent Plugins menu has **two** causes, not one (`app-menus.js:342-352` returns
  null for `CLODEX_PLUGINS=0` *or* nothing found on disk — so it can mean the copy
  didn't land), refused dirs show `<dir> — not loaded` (`:378-380`) with the
  reason at `renderer.js:5196`, and a throwing `activate()` is a *different*
  state with the held-back label and a Retry button.
- **"Reporting back" re-routed.** It used to say "everything in step 2 failing is
  a finding against my code" — false, since two of step 2's observables were
  defects in the document. Now routes by what failed, and flags a `[source]`
  bullet misbehaving as the most interesting possible outcome.
- **Confirmed-by-running** (Bogdan's pass): the grant takes effect **live, no
  restart**, and the reply named the emitting session. No longer predictions.

### Deviation (w) — clodex's near-miss, recorded because a reader will repeat it

clodex predicted the reply would read `plugin-phase-1`; it read `master`. Correct
behaviour — that seat's cwd is the main checkout, the worktree belongs to a
different seat. Had it answered `plugin-phase-1` that would have been the "reply
names a different session" failure. Step 1 now tells the operator to check the
branch against **that session's cwd**, not the branch they have in mind.

**Next letter is (x).**

Committed after `3fdde01`. Suite 2489/2489.

---

## T14 — pot-drawer migration: NOT ACHIEVABLE AT `"1"`. Finding delivered.

**Closed. Ruling: take the finding, do not build the degraded variant, do not
wait for a 1.1.** The result is recorded in `docs/plugin-plan.md` §6 —
Phase 4a's 4a bullet is struck through and points at a new subsection,
"Phase 4a's result — the API lends UI generously and core data thinly", placed
at the end of §6 where a planner reaches it before planning another migration.

No plugin was built. No core edits. That is the correct outcome, not a partial
one: *"Phase 4a is not achievable at `"1"` and here is precisely why"* is the
deliverable.

### Deviation (v) — clodex's premise error, recorded as theirs

The t14 ticket disqualified inbox-drawer for being driven from `app-menus.js` in
the main process, and selected pot-drawer instead. **pot-drawer has that exact
property** (`app-menus.js:559`, View ▸ "Boiling Pot…" → `request-open-boiling-pot`
→ `pot-drawer.js:88`). The selection reason did not discriminate between the two
candidates.

The ruling that disproves it was already written by clodex, in the comment
sitting *directly above* the very menu item in question (`app-menus.js:545-557`,
the workbench note: a main-process menu "cannot… open a plugin's SURFACE").

clodex verified all three findings and took the deviation as their own: *"my
selection reason was worthless — I disqualified inbox-drawer for a property
pot-drawer has… Deviation (v) is mine, not yours."*

**Next letter is (w).**

### Why this was worth stopping for (clodex's framing, recorded because it is
### the phase's actual conclusion)

Through Phases 0–3 the API's only consumer was the workbench, **designed
alongside it** — a pilot never hits the wall, because the wall moves while the
pilot is built. The Phase 3 cold-agent acceptance passed for the complementary
reason: a plugin free to invent its own data needs never has to reproduce a core
computation. pot-drawer is the first surface **not** co-designed with the API,
and it hit the data wall in an afternoon. Same defect class as everything else
this effort found, one level up: an insider-shaped artifact validated by
insiders.

### Round-1 source reads (the evidence behind the finding)

t13 shipped as `1dda88b`, suite 2489/2489. Two of the ticket's premises were
wrong and the third is a real gap; reported before committing to an approach,
which is what produced the ruling above.

### Premise 1 — "pot-drawer references inbox-drawer, untangling it is part of
### the work". FALSE.

The only occurrence of "inbox" in `renderer/pot-drawer.js` is `:16`, inside the
header comment: "FACTORY (inbox-drawer's genus, not the CRUD library drawers)".
It is a prose comparison naming a design family. There is no import, no call, no
shared state, no shared DOM. Nothing to untangle.

### Premise 2 — "inbox-drawer needs a menu slot BECAUSE it is referenced from
### app-menus.js, so migrate pot-drawer instead". Does not discriminate.

`app-menus.js:559` is a **View ▸ "Boiling Pot…"** item that does
`win.webContents.send('request-open-boiling-pot')`; `pot-drawer.js:88` receives
it via `window.api.onRequestOpenBoilingPot`. That is exactly the shape given as
inbox-drawer's disqualifier (`app-menus.js:506` →
`request-open-inbox-drawer`). **Both drawers are opened from a main-process menu
item.** Picking pot-drawer over inbox-drawer does not avoid the menu-slot
problem; it relocates it.

Worse, clodex already wrote the ruling on this, in the comment sitting directly
above that menu item (`app-menus.js:545-557`), for the workbench: a
main-process menu "cannot do is open a plugin's SURFACE: the overlay lives in one
BrowserWindow's DOM, mounted by that window's renderer half, and nothing here
knows whether the focused window has it."

A plugin renderer half also cannot legally receive the existing event: reaching
`window.api` is precisely what the boundary lint's `GLOBAL_API_RE` /
`BARE_API_RE` forbid (t9).

**The escape that needs no new slot:** drop the View item and open the drawer
from a **sidebar footer button** (§6.3), which is what the workbench does and
what §14's menu-slot gap already names as "the conventional entry point today".
That costs a core deletion (allowed — it is the removal exception) and changes
where the operator clicks. It is a UX decision, so it is clodex's, not mine.

### Premise 3 — the DATA is the harder blocker, and it is a genuine gap.

`window.api.potSnapshot` → IPC `pot:snapshot` (`ipc-handlers.js:853`) →
`session-manager.js:2278 potSnapshot()`. To reproduce it, a plugin engine half
needs four things, and the frozen `"1"` surface lends **none** of them:

1. **`file-heat.js`'s `normalizeState` / `aggregateStates` / `foldRedundancy`**
   (`:72`, `:106`, `:158`). `host.lib` lends `gitWorktree` and nothing else
   (`plugin-host-engine.js:348`). Note that `file-heat.js` **passes the stated
   membership test** written right there at `:339-345` — "a leaf CORE also uses,
   lent to plugins": core uses it from `session-manager.js` AND `pot-cli.js:23`.
   So this is a well-formed v1.1 `host.lib` candidate, not a design objection.
2. **`s.fileHeat.flush()` over live sessions** (`:2281-2283`). Not on the
   handle (`plugin-host-engine.js:189-206` mints exactly `name/type/cwd/
   workspaceId/isAlive/inject`), not anywhere on the host. Unreachable.
   Consequence if migrated without it: the snapshot silently misses in-memory
   carriage not yet flushed to disk — degraded numbers, not an error.
3. **`pathFor(REGISTRY_DIR, name, 'fileHeat')`** — `clodex-paths.js`, core, not
   lent. A plugin would hardcode `~/.clodex/run/{name}/fileHeat`, i.e. re-derive
   a path grammar CLAUDE.md says is single-sourced. Fragile by construction.
4. **`s.proxyBase` + `ProxyClient.potSeries`** for the tier-2 redundancy join.
   No host member; `proxyBase` is not on the handle either. Tier 2 would be
   dropped, and the drawer's redundancy column would never light up.

A Tier-A plugin *could* brute-force 1–3 with a raw `require('fs')` and its own
copy of ~150 lines of `file-heat.js`. That is possible, not clean: it duplicates
core logic that will drift, and it re-derives a path grammar core single-sources.
It is the "contortion" the ticket asks me to catalogue rather than something to
quietly do.

### The finding, stated plainly

Migrating pot-drawer at `"1"` with **zero core edits** is not achievable as a
faithful migration. The drawer is not a self-contained island in the way its
header comment suggests: its DOM is self-contained, but its *data* is a
session-manager method over live session state, and its *trigger* is a
main-process menu item. What Phase 4a set out to validate — "a drawer-type
surface migrates cheaply" — is answered **no**, and the reason is specific and
useful: the plugin API lends UI slots generously and **core data thinly**.

Three candidate 1.1 additions fall out, in descending confidence:
- `host.lib.fileHeat` — passes the documented membership test as written.
- a menu slot — already §14's named gap, now with a second witness.
- something that answers "give me core's own computed snapshot", e.g. lending
  read-only `potSnapshot` itself. This is the one I'd argue for: items 1–4 are
  all symptoms of a plugin having to *rebuild* a core computation instead of
  *asking* for it.

### What was written (t14's only edits)

- `docs/plugin-plan.md` — 4a bullet struck through with a pointer; new §6
  subsection carrying the finding, the asymmetry, the "why earlier phases missed
  it" reasoning, the three 1.1 candidates and the snapshot sketch.
- this journal.

**No plugin was created. No core file was edited.** The footer-button question
is moot — clodex declined to put a UX change to Bogdan for a migration not
being done.

### Original ticket notes (kept for a fresh spawn — note premises 1 and 2 are
### now known false, see deviation (v))

Do not begin until t13 is reported. Notes captured from the ticket so a fresh
spawn does not have to re-read it:

- `renderer/pot-drawer.js` (95 lines) becomes an in-repo plugin.
- **Do NOT migrate inbox-drawer** — it is referenced from `app-menus.js` in the
  MAIN process, so it would need a menu slot, which does not exist and is a
  queued 1.1 candidate. `pot-drawer.js` currently references inbox-drawer;
  untangling that is part of the work, and **if it cannot be untangled without a
  menu slot, STOP and report** — that is a finding about slot coverage, not a
  reason to build a slot.
- **HARD CONSTRAINT: zero core edits to accommodate the plugin.** A needed core
  change is a finding, not a step. The one exception is *removal* — core losing
  the island it no longer owns is expected.
- Grep gate in spirit: after migration `pot-drawer`/`potDrawer` should not appear
  in core modules. Known referents: `test/free-identifier-leaks.test.js`,
  `renderer/index.html`, `renderer/styles.css`, `web-dist/`.
- A renderer half ⇒ `npm run build:web` + committed
  `renderer/web/plugin-registry.js`, or `plugin-web-parity` fails.
- **The findings note is worth more than the code**: every place I wanted a host
  member, slot or lifecycle hook that does not exist, and every place I had to
  contort the island to fit the contract.
