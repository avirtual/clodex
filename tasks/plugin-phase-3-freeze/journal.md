# T6 — freeze hostApi to "1" and publish docs/plugin-api.md

Ticket verbatim: `ticket-t6.txt` in this directory. Phase 2's journal (the whole
pilot: W1–W9, T5, every deviation letter (a)–(q)) is
`tasks/plugin-phase-2-workbench/journal.md` — that is the record, not memory.

## State at dispatch

- Worktree `/Users/bogdan/projects/tmux/wb-wrap-ui-plugin-phase-1`, branch
  `plugin-phase-1`, HEAD `88a811f`, suite **2459/2459**.
- Master untouched at `2f3f8e1`. Nothing pushed. Keep it that way.
- Phase 2 done: all five manual gates passed on Bogdan's machine, plus T5 step 9.
- Deviation letters run (a)–(q). The next new flag is **(r)**.

## The four pieces

1. **Shape pass, then bump `HOST_API_VERSION` `0` → `"1"`.** Last moment the
   shape is free. Update the workbench manifest and every test pinning the
   version. Two known items handed to me, both DOCUMENT-ONLY, do not build:
   - *Slot ordering is undefined* — registration order = discovery order =
     `readdirSync` order. Document honestly as "unspecified, do not depend on
     it" so a v1.1 priority field is not a breaking change. Do NOT invent one.
   - *There is no menu slot.* T5 wired `getPluginHost` into `app-menus.js`,
     which is exactly the plumbing such a slot needs — so it is now a real
     candidate. Document as a known gap WITH that note. Don't build it.
2. **`docs/plugin-api.md`** — the published versioned contract. THE ONE-WAY
   DOOR, and the deliverable itself. **Assume the reader cannot read core**: the
   Phase 3 gate is a plugin built out of tree with zero core edits by a
   different agent working from these docs and nothing else. Minimum contents:
   manifest schema field by field with every validation refusal; the engine
   `host` object; the renderer `rhost` object; all seven UI slots with exact
   spec shapes; the five-row `plugin:*` transport; enable/disable + quarantine
   lifecycle; per-window vs per-app-run (§3.3's laws — the single most likely
   thing for an outsider to get wrong); what is deliberately NOT exposed, and
   why. Refusals as prose an outsider can ACT on, not a list of error strings.
3. **A contract-shape test** pinning `host` and `rhost` themselves, in the
   spirit of `api-contract.test.js`, so the published shape can't drift.
4. **Cross-check `docs/plugin-plan.md` §3.2 against what shipped.** Plan predates
   the pilot; where they disagree the CODE is right and the doc is stale. Report
   the divergences — clodex wants them, they are the pilot's real findings.

## Adjudications carried in (settled, do not re-litigate)

- The quarantine checkbox stands; no Retry menu item.
- **Deviation (q) accepted.** For the docs, explicitly: §1's freeze applies to
  the **plugin transport** — the five `plugin:*` rows — NOT to core's total row
  count. 235→220 was evidence that moving fourteen data methods out shrank
  core's contract, never a ceiling to defend. **Core may add its own chrome.**
  Say this in `plugin-api.md` so nobody re-litigates it.
- The `announceState` refresh seam and the `renderer/web/menubar.js` catch were
  both better than the spec.

## Verification

Full suite from the worktree via the `clodex-test-green` skill with an explicit
cd (plain `node --test`, NO directory arg — Node 25 errors on one).
`[agent:exec clodex-run-tests]` is BLIND to the worktree and will report
master's count. The version bump WILL break tests pinning `0` — fix them, and
**flag any where the pin was load-bearing rather than incidental.**

## Standing constraints

`.claude/CLAUDE.md` FROZEN, `.claude/memory.md` is clodex's — never edit either.
Never push, never touch master. `git reset -q node_modules` before every commit
(the symlink must stay untracked). `web-dist/index.html` is TRACKED — rebuild
with `npm run build:web` if any bundled source changes, or release.sh fails.
CODE WINS over PLAN; flag contradictions with a letter.

## Progress log

### P1 — the shape pass (piece 1, before the bump)

Read in full: `plugin-api.js`, `plugin-host-engine.js`, `plugin-loader.js`,
`renderer/plugin-host.js`, `intent-registry.js`, `plugins/workbench/manifest.json`,
the plugin rows of `api-contract.js`, `plugins/README.md`, plan §2.6/§3.1-3.4.
Asked of every surface: what did the pilot prove wrong or awkward, and would the
freeze cement it painfully?

Eight findings. **Two are clodex's, handed to me document-only. The other six I
resolve as DOCUMENT, NOT CHANGE** — reasons per row. Net shape change: none.
The version bump is the only code change in piece 1.

| # | Finding | Verdict |
|---|---|---|
| S1 | **Slot ordering is unspecified.** Registration order = discovery order = `readdirSync` order (sorted by dir name, `plugin-loader.js:171`), and within a plugin, call order. Two footer buttons from two plugins land in directory-name order — arbitrary, and nothing a user or plugin can influence. | clodex's. Document as "unspecified, do not depend on it" so a v1.1 `priority` is additive, not breaking. Do NOT invent the field. |
| S2 | **No menu slot.** A plugin cannot contribute a system-menu item. | clodex's. Document as a known gap, WITH the note that T5 wired `getPluginHost` into `app-menus.js` — exactly the plumbing such a slot needs, so it is now a real v1.1 candidate rather than a blocked idea. Don't build it. |
| S3 | **`catalog()[].enabled` is constant `true`.** `catalog()` projects `registered`, which only holds successfully-activated plugins — so the field can never be false. It IS read (`renderer.js:3028` `if (!p.enabled) continue;`), defensively. | KEEP. Removing a published field is breaking; the read is harmless. Document precisely: it means LOADED, not intent. Intent lives in `_host` `plugins.status`. |
| S4 | **A renderer half cannot reach `_host`.** `rhost.invoke(method, …)` hard-binds the plugin's OWN id, so `settings.get/set`, `renderer.info`, `plugins.status` are unreachable from a plugin. Consequence an outsider WILL hit: a renderer half has no direct read of its own settings — values arrive only as the 2nd argument of `settings.section`'s `render(body, values)`, or from its own engine half over `invoke`. | KEEP, and it is a security property, not an oversight: `settings.set(pluginId, patch)` takes the id as an ARGUMENT, so an openable `_host` would let plugin A write plugin B's settings. Document loudly. |
| S5 | **A plugin method's return shape is entirely the plugin's**, so a handler returning `{ ok: false, error: … }` is indistinguishable from a host refusal. | KEEP. Document the discriminator: a host refusal is exactly `{ ok:false, error:'no such plugin method' }`. Wrapping every plugin result would break the workbench's 14 rows and add no information. |
| S6 | **`sidebar.rowBadge`'s `resolve` is SYNC**, called inside the sidebar render loop; an async badge is impossible by construction. | KEEP (an async resolve would stall the sidebar). Document the required idiom: fill your own cache, then `requestRelayout()`. |
| S7 | **Two validators disagree about a missing `hostApi`.** The loader refuses it (`String(m.hostApi ?? '')` → `''` ≠ version, `plugin-loader.js:34`); the engine's `register()` DEFAULTS it to the current version (`plugin-host-engine.js:370`). | KEEP. The loader is the only path a real plugin takes, so `hostApi` is required in practice; the engine default exists for direct `register()` in tests. Document `hostApi` as REQUIRED and note the engine default is not a way in. |
| S8 | **`enabledByDefault` ships but is absent from the plan's §3.1 manifest example.** | A piece-4 divergence. Code wins; record it there. |

Not flagged as a deviation letter: nothing here departs from the ticket. S3-S7
are the "propose changes" pass answering *no change, here is why* — which is a
proposal, not a silent compromise.

### P2 — the bump (done)

`HOST_API_VERSION` `'0'` → `'1'` in `plugin-api.js`, with the comment rewritten
from "explicitly unstable until Phase 3" to the freeze + **a bump policy**:
additive changes (a new slot, a new `host`/`rhost` member, a new optional
manifest field) do NOT bump — they ship as 1.1 behaviour older plugins don't
use; only a change that could break a conforming "1" plugin goes to "2". That
policy is what makes S1/S2 documentable as gaps rather than as debt.

`plugins/workbench/manifest.json` `"hostApi": "1"`.

**Six test pins, and the load-bearing question for each** (the ticket asked):

| Site | Was | Now | Load-bearing? |
|---|---|---|---|
| `plugin-host-engine.test.js:251` | `assert.equal(HOST_API_VERSION,'0')` | `'1'` + a comment saying this is THE freeze pin and changing it is the decision | **YES — kept literal on purpose.** Deriving it would make the assertion vacuous. This is now the suite's only literal. |
| `plugin-host-engine.test.js:248` | regex `host is "0"` | template on the constant | No — the test is about the refusal MESSAGE naming both versions. |
| `plugin-loader.test.js:94` | mismatch fixture `hostApi:'1'` | `'99'` | **Was actively wrong after the bump**: "1" became the ACCEPTED version, so the test asserted a valid manifest is refused. It passed only by coincidence of the literals. Caught by reading, not by a failure. |
| `plugin-loader.test.js` `OK_MANIFEST` | `'0'` | constant | No — "otherwise well-formed" fixture; a dozen tests vary one field against it. |
| `plugin-loader.test.js:461` (real workbench) | `'0'` | constant | **YES, in the other direction** — it pins the PILOT's manifest to the host it ships with, so a bump that forgets the manifest fails here. Kept, expressed against the constant. |
| `app-menus-plugins.test.js:63`, `workbench-plugin.test.js:96` | `'0'` | constant | No — fixtures that must be discoverable/registerable. A literal turns a bump into "the menu lists nothing". |

`ui-settings-plugins.test.js:155` and `plugin-fake.test.js:177` already read the
constant. No change needed.

Targeted run of the seven plugin test files: **127/127 pass.**

### P3 — docs/plugin-api.md (written)

`docs/plugin-api.md`, 15 sections, written for a reader who cannot read core.
Every ticket-required item is present: manifest field-by-field + all nine
refusals as actionable prose; the engine `host`; the renderer `rhost`; all seven
UI slots with exact spec shapes; the five-row transport; the enable/disable +
quarantine lifecycle; §3.3's laws (promoted to §3, BEFORE the API, because it is
the thing an outsider most likely gets wrong — reading it after the slots is
reading it too late); what is NOT exposed and why; the (q) framing on the freeze.

Choices worth recording:

- **A working plugin in §1**, three files, copy-pasteable. The Phase-3 gate is
  someone building from this document alone; the fastest way to fail that is to
  make them assemble a first plugin out of a reference table.
- **Refusals as "what to do about it"**, per the ticket, never a list of error
  strings — e.g. the id/directory mismatch says rename one to match the other
  and says why divergence was refused in the first place.
- **The security posture stated in §1**: in-process, no sandbox, the host API is
  a contract not a containment boundary. An outsider could otherwise reasonably
  read all this refusal machinery as a security model and trust it as one.
- **The S3-S7 findings are all in**: `catalog().enabled` means LOADED (§14),
  `_host` unreachable + the consequence for renderer settings reads (§13, with
  the three-line workaround), the `'no such plugin method'` discriminator (§8),
  the sync-`resolve` cache+relayout idiom (§6.4), `hostApi` required (§2).
- **S1 and S2 exactly as clodex directed**: ordering "unspecified, do not depend
  on it" as its own §6 subsection AND a §14 row; no menu slot as the FIRST §14
  row, with the note that T5's plumbing makes it a real candidate. Neither built.
- **One gap I found while writing, not in the brief**: `rhost` has no
  `events.on`. The engine can emit; a renderer half has no documented way to
  subscribe. Written up in §9 as a `"1"` gap with "design against pull, not
  push", and listed in §14. Flagged in the report — this is the kind of thing
  only writing the docs surfaces, which is the ticket's point.
- **§15 versioning policy** matches the new `plugin-api.js` comment: additive
  ⇒ no bump.

### P4 — contract-shape test (done)

`test/plugin-surface-contract.test.js`, **8 tests, all green.** Literal tables
beside the objects (never derived — a generated table re-derives whatever the
code is and calls it the contract), in api-contract.test.js's spirit. Drives the
REAL engine host and the REAL renderer host through real activation; the rhost
is reached only THROUGH `island.activate(...)`, because that is the only shape a
plugin can actually receive.

Pins: the `host` member set exactly (12) + per-namespace members + frozenness;
the SessionHandle at 4 fields + 2 methods; `rhost` exactly (14) + `workspaceId`
as a GETTER (a captured value would be null forever); the seven UI slots by
path, with `UI_SLOTS.length === 7` because the doc says "seven" in prose;
`_host`'s five methods served and a sixth refused. Three ABSENCES pinned as
contract: `host.sessions.list` (the named-accessor law only protects anything
while the tempting default doesn't exist), `rhost.sessions.listAll`, and
`rhost.events` — the last so the documented v1.1 gap cannot appear undocumented.

Plus two doc tests: every published member appears in `docs/plugin-api.md`, and
the nine sections T6 promised are present, along with the three sentences that
are load-bearing for the freeze (ordering unspecified, no menu slot, the
five-row scope).

Three things that resisted, all mine:
1. `host.storage`/`settings`/`log` are NOT frozen (they're plain object
   literals). Real, and fine — the top-level freeze stops a plugin swapping them
   and nothing else holds a reference. Listed the frozen ones POSITIVELY so a
   new namespace has to declare which it is.
2. The freeze-scope regex failed on a line wrap. Normalized whitespace first.
3. The member-presence check first passed vacuously on bare names (`id`, `log`
   match anywhere in 40k chars), then over-tightened. Settled on: top-level
   QUALIFIED (`host.storage`), nested as whole words. **It caught nine genuinely
   thin spots in the doc** — `host.id`/`hostApiVersion`, `rhost.id`/`log`, and
   the four `clear*`/`remove*` wrappers were named in the shape listing but
   never explained. **Fixed the DOC, not the test**: three new paragraphs. That
   is the test doing exactly its job on its first run.

### P5 — plan cross-check (done)

`docs/plugin-plan.md` §3.2 read line by line against `plugin-host-engine.js`,
plus §3.1/§3.3/§3.4/§2.1/§2.5 while there. **CODE WINS everywhere**; nothing
below was changed to match the plan. Nine divergences, in descending order of
what they'd cost an outsider who trusted the plan.

**§3.2 — the engine host.** The member list, the SessionHandle's four fields and
two methods, the `onExit` spec (placement, sync-only, `_dead` handle, bash
persistence-already-removed note) and `lib: { gitWorktree }` all shipped
**exactly as written**. §3.2 is the most accurate section in the plan. Two
things inside it are wrong:

- **D1. `sessions.get(name)` — "null for peer-backed entries".** FALSE as
  shipped. It returns a handle for ANY session in the map, peer sessions
  included; `null` means "no such session", nothing more. The locality refusal
  lives entirely in `fsScope`, which is the better place for it (one guard, not
  two) — but a plugin author reading §3.2 would think a peer session is
  unreachable and skip a check they need. Documented correctly in
  `plugin-api.md` §4.
- **D2. "the twelve stores".** `initStores` returns **eight** (per CLAUDE.md).
  The plan's §2.5 even enumerates twelve by name. Doc-vs-doc drift that predates
  the pilot; the point it was making (plugins get none of them) is unaffected.

**§3.1 — two promises that never shipped.**

- **D3. The `announce`-as-toast on first enable.** §3.1: *"First-ever enable
  raises the manifest `announce` as a toast — the vision doc's consent-scoped
  self-introduction."* Grepped: nothing raises it. `announce` ships as the
  DESCRIPTION line in the Manage Plugins dialog (`loader.status().description`)
  and as a field on `catalog()`. That is a quieter, better answer — the text is
  available where a user is already deciding, instead of interrupting them at
  the moment they clicked — but it is not what the plan says. Documented as the
  description in `plugin-api.md` §2.
- **D4. The "restart to fully unload" banner.** §3.1/§1 promise it twice.
  Nothing renders one. The FACT is still true and is documented (`plugin-api.md`
  §10: disable removes everything reachable; a complete unload is the restart
  boundary) — it is the BANNER that doesn't exist. Cheap to add later if wanted;
  deliberately not built here.
- **D5. `enabledByDefault` is missing from §3.1's manifest example** (S8). It
  shipped, it is load-bearing for the pilot ("ships enabled without writing a
  settings entry into every existing install"), and it is the field that keeps
  "the user turned this off" distinguishable from "the user has never seen
  this". An author copying §3.1's example gets it by accident (it defaults true)
  and could not ship a dormant plugin knowingly.

**§2.1 — the status-bar context object is a different shape.**

- **D6.** Plan: `ctx = { session, type, peerQueryable, linked, hasPayload }`.
  Shipped: `{ session, type, isAgent, peerQueryable, peerConfigurable,
  workspaceId }`. `linked` and `hasPayload` never existed; three others were
  added — `workspaceId` because §3.3 law 1 requires it, `isAgent` because that
  is the predicate core's own bar actually uses. Straight improvement, and the
  single most copy-pasted shape in the plan, so worth the correction.

**Smaller, all recorded in `plugin-api.md` rather than left implicit.**

- **D7.** §3.4 says unknown `(pluginId, method)` yields the refusal — true — but
  the plan never says a plugin's OWN failures use the same envelope shape, so
  nothing in it tells an author how to tell the two apart. `plugin-api.md` §8
  names the exact discriminator string.
- **D8.** §2.5's "a disabled plugin's section does not exist" shipped, but T5
  moved the CHOOSING out of Preferences into a top-level Plugins menu. §2.5
  still reads as though both live together.
- **D9.** §2.6's overlay API matches, but the plan doesn't say `mount()` is
  called ONCE lazily at first open and never again — the difference between
  per-open refresh working and silently not.

Not divergences, confirmed accurate: §3.3's three laws (verbatim in behaviour),
§3.4's transport rationale, §2.2/§2.4's shapes, the `_host` pseudo-id scheme,
the intent rules P1-P5.

### P6 — full suite, commit, report (done)

- Suite via the test-runner subagent with an explicit cd into the worktree:
  **2467/2467 green**, exactly 2459 + 8. First run, no failures at any point in
  T6 beyond the three self-inflicted ones in P4.
- `npm run build:web` run defensively — `web-dist/index.html` UNCHANGED (no
  bundled source was touched; the only renderer edit was a test file).
- Committed `f12fb89` on `plugin-phase-1`, parent `88a811f`. `git reset -q
  node_modules` before staging; the symlink is still untracked. Master
  untouched, nothing pushed.
- T6 **ACCEPTED** by clodex, which independently verified the freeze pin, the
  `sessions.get` peer claim, the §4 peer posture, and 2467/2467 from the
  worktree. It called the `rhost` events gap "the best find in the report".
- **No deviation letter used. (r) is still free.** The eight shape findings were
  the ticket's requested proposal pass, not departures; the nine plan
  divergences are piece 4's deliverable, not my choices. Nothing in T6 departed
  from the spec.

---

# T7 — correct docs/plugin-plan.md against what shipped

Ticket verbatim: `ticket-t7.txt` beside this file. (clodex labelled it "T8" in
the body and "t7" in the ticket id; the id wins — it is t7.)

## State at dispatch

Branch `plugin-phase-1`, HEAD `f36875c`, suite **2467/2467**. Master untouched
at `2f3f8e1`. Nothing pushed. Deviation letters (a)-(q) used; next is **(r)**.

## The task

**Fix `docs/plugin-plan.md` so it stops lying.** Phases 4 and 5 get specced from
that document — a wrong fact in it becomes a wrong instruction later. Correct
all nine T6 divergences (P5 above has every one with its evidence), **in place,
in the plan's own voice**. Not a changelog: a future reader should just find it
correct.

Order given, 1 = the live landmine:

1. §3.2 `sessions.get` "null for peer-backed entries" — false. Handles for any
   session incl. peers; null = no such session. Locality refusal is `fsScope`
   ALONE.
2. §2.1 status-bar `ctx` — the most copy-pasted block. Ship shape is
   `{ session, type, isAgent, peerQueryable, peerConfigurable, workspaceId }`;
   `linked`/`hasPayload` never existed; note `workspaceId` is required by §3.3
   law 1.
3. "twelve stores" → **eight** (§2.5 enumerates twelve BY NAME — fix count AND
   list).
4. §3.1 `announce` toast — never shipped; became the Manage Plugins description
   line. Record the reasoning: the text belongs where the user is deciding.
5. §3.1 "restart to fully unload" banner — the FACT is true and documented; the
   BANNER doesn't exist. Correct the promise, keep the fact.
6. §3.1 manifest example — add `enabledByDefault`.
7. §3.4 — a plugin's own failures share the refusal envelope; name the
   `'no such plugin method'` discriminator.
8. §2.5 — reflect the T5 split: choosing (menu) vs settings (dialog).
9. §2.6 — `mount()` is called once, lazily, never again.

**Plus ONE, clodex's own find at `plugin-host-engine.js:18`:** `fsScope` refuses
PEERS but **not foreign workspaces** — the comment there already knows it.
**Check whether anything else scopes it**, then say WHICH it is: a real hole a
plugin could walk through, or covered elsewhere. If real: write it up as a known
gap in the plan AND in `docs/plugin-api.md` §14 beside the other two.
**Do not build a fix.**

Rule for the voice: where the plan states an intention that shipped differently
and the SHIPPED thing is better, say which shipped and why, in ONE line. Where
the plan is simply stale, just make it right.

## Hard constraints

- **NO code changes. NO test changes.** If I want either, STOP and flag it —
  "a plan-correction pass that edits code has found something we both want to
  know about."
- Code wins everywhere; never change code to match the plan.
- Commit on `plugin-phase-1`. Never touch master, never push.
  `git reset -q node_modules` before staging.
- Suite must still be **2467** — via the `clodex-test-green` skill with an
  explicit cd into the worktree. `[agent:exec clodex-run-tests]` is blind to
  worktrees and will lie.
- `.claude/CLAUDE.md` and `.claude/memory.md` are never mine to edit.

## Progress log

### Q1 — the `fsScope` foreign-workspace question (investigated, answer below)

**VERDICT: a REAL gap. Nothing else scopes it.** Write it up in both docs.
Evidence, in the order it settles the question:

- **`fsScope` (`plugin-host-engine.js:249-255`) is the whole guard.** Three
  refusals: unknown name, `s.peer` (`'remote'`), no cwd. There is no
  workspace comparison, and the comment at :247 says so outright ("scoping
  across workspaces is listWorkspace's job, not this one's").
- **Nothing upstream narrows it.** The path is `plugin:invoke` →
  `host.dispatch(pluginId, method, args)` → the plugin's handler → `fsScope`.
  `ipc-handlers.js:1089` **discards the Electron event** (`(_e, pluginId,
  method, args)`), so by the time a plugin handler runs, the caller's window —
  and therefore its workspace — is GONE. Core's own rows do this correctly with
  `workspaceOfSender(e)` (:317 etc.); the plugin transport deliberately does
  not carry it. So the engine half **could not** scope by workspace today even
  if it wanted to: the information isn't on the wire.
- **The renderer half is scoped, but only by convention.**
  `renderer/plugin-host.js:496` filters `listWorkspace` client-side on
  `s.workspaceId === wsId`, and `rhost.workspaceId` (:474) is the window's own.
  That is a renderer-side courtesy over a global list, not an engine guard —
  and the workbench's fifteen rows take a `name` straight from the renderer
  and hand it to `fsScope`, so nothing stops a caller naming a session in
  another workspace.
- **Not a regression.** The pre-plugin helper (`git show 2f5e6d3:ipc-handlers.js`
  lines 159-165) was byte-identical, peer check and all — the workbench as core
  reached exactly as far. The plugin host inherited the hole, it did not open
  it.
- **Bounded by what it can actually cost.** The engine half is unsandboxed
  in-process Node (api §1: no sandbox, a plugin may `require('fs')`), so
  `fsScope` is a correctness guard that stops a CARELESS plugin widening
  locality — never a boundary against a hostile one. What it really buys is
  that fifteen handlers can't each get the peer check wrong. Judged on that
  bar, the workspace hole is a real defect in the guarantee's *shape* (a
  plugin author reads "the locality refusal is a host guarantee" and reasonably
  assumes workspace locality too), not an escalation path.

So: known gap in the plan §3.2 alongside the `sessions.get` correction, and in
`plugin-api.md` §14 beside the other two. **No fix built** (ticket says so, and
a fix would need the transport to carry a caller workspace — a "1"-affecting
design decision, not a hand's call).

Next: the nine corrections in `docs/plugin-plan.md`.

### Q2 — the nine corrections (done, with ONE refused)

Eight applied in place, in the plan's voice. **Item 3 was NOT applied — the plan is
right and my D2 was wrong.** See the deviation note below.

1. §3.2 `sessions.get` — comment corrected, plus a new "Where the locality
   refusal lives — `fsScope` alone" paragraph. The Q1 gap follows it.
2. §2.1 — the inline `ctx` comment now points to a new block giving the shipped
   six-field shape with a line on why each of `isAgent` / `peerConfigurable` /
   `workspaceId` is there. `linked`/`hasPayload` gone.
3. **REFUSED — see deviation (r).**
4. §3.1 — `announce` is the Manage Plugins description line, with the reasoning.
5. §3.1 + §1 (two sites) — banner promise removed, the restart-boundary FACT
   kept and pointed at `plugin-api.md` §10.
6. §3.1 — `enabledByDefault: true` in the manifest example + a paragraph on what
   it decides.
7. §3.4 — a plugin's own failures share the envelope; `'no such plugin method'`
   named as the exact discriminator.
8. §2.5 — new "Choosing and configuring are two surfaces" paragraph (T5 split,
   why it CAN be a menu: engine-side state, no renderer round trip; absent not
   empty; checkbox = intent, quarantine in the label).
9. §2.6 — `mount()` once/lazily/never again, with what belongs in `onOpen`
   instead. Verified against `renderer/plugin-host.js:438-444` (mount fires only
   when `entry.el` is absent) before asserting it as contract.

Q1 gap also written into `docs/plugin-api.md` §14, phrased for a plugin author
(what to do about it) rather than for a core reader.

### Deviation (r) — item 3 refused: `initStores` really does return twelve

The ticket said "twelve stores → eight (§2.5 enumerates twelve BY NAME — fix
count AND list)". **I did not make this change: the code returns TWELVE.**
`stores.js:1704-1709` returns `persistence, templates, workspaces,
promptLibrary, agentDefaults, agentLibrary, skillLibrary, execLibrary,
reminders, notifications, uiSettings, envScopes` — plus the `renameWorkspaceScope`
helper, which is a function, not a store. The plan's §2.5 list is twelve names
and matches that return **exactly**, in order.

The error is MINE, from T6's P5: I wrote D2 by comparing the plan against
CLAUDE.md's "the eight persistence stores" rather than against `stores.js`, on a
task whose first rule is that code wins. CLAUDE.md's "eight" is itself stale
(stores.js:6's own header says "the eight JSON stores live here" — true of the
userData JSON files, but four more stores are file-backed under
`registryDir/library/`, so the count of STORES and the count of JSON blobs in
userData are different numbers). The plan says "stores", so twelve is correct,
and §3.2's "the twelve stores" in the deliberately-not-exposed list is correct
for the same reason.

Applying item 3 would have written a falsehood into the document Phases 4 and 5
get specced from — the exact failure the ticket exists to prevent — so I left
both sites alone. Flagging rather than silently skipping. **Not mine to fix:
CLAUDE.md is frozen for me, and its "eight" is a separate (real, small) staleness
for clodex to rule on.**

### Queued: t8 (do NOT start until t7 is committed and reported)

`ticket-t8.txt` beside this file — "enforce three boundary invariants the code
only claims", from a cold review that came back REWORK. F1 plugin verbs survive
`withoutPrivilegedIntents`; F2 `host.lib` frozen one level too shallow; F4
`enabled` is a legal plugin id; plus two smalls (false quarantine strike on
double activation, `telemetry.snapshot` returns the live payload). clodex
verified all diagnoses against source itself — **do not re-diagnose**, spend the
effort on fixes and on proving each new test fails WITHOUT its fix (revert, do
not reason). Explicitly OUT of t8: the lint hardening (separate ticket), and the
`fsScope`/`safeResolve` containment question (clodex is ruling on it separately
— note this overlaps Q1 above, so my Q1 write-up is INPUT to that ruling, not a
decision).

Numbering: clodex confirmed the ticket ids are **t7** and **t8**; the "T8"/"t9"
labels inside the message bodies are its own off-by-one. Cite t8 when closing.

---

# T8 — enforce three boundary invariants the code only claims

Ticket verbatim: `ticket-t8.txt`. **t7 is CLOSED** (commit `964d599`, suite
2467/2467) — t8 is now the active ticket.

## State at dispatch

Branch `plugin-phase-1`, HEAD `964d599`, suite **2467/2467**. Master untouched at
`2f3f8e1`. Nothing pushed. Deviation letters (a)-(r) used; next is **(s)**.

## The theme (what makes these one ticket)

Each is an invariant asserted in a COMMENT or a plan marker with **nothing
enforcing it** — the same defect class as the `uiSettings.plugins` bug. clodex
verified all diagnoses against source itself: **do not re-diagnose**, spend the
effort on the fixes and on the proof.

**The proof obligation, and it is the point of the ticket:** where I fix one,
the test must FAIL WITHOUT the fix — verified by REVERTING, not by reasoning.
Report one line per fix proving it.

## The five items

**F1 (CRITICAL) — plugin verbs are not stripped from agent-authored grants.**
`withoutPrivilegedIntents` (`intent-catalog.js:81`) filters against
`PRIVILEGED_INTENTS`, a literal `Set(['reboot'])`. `registerIntent` sets
`privileged: true` on the REGISTRY ROW (`intent-registry.js:367`) and never
touches that Set, so a plugin verb survives every strip site: spawn template
`session-manager.js:3953`, reviewer template `:4090`, peer-wire create
`remote-wiring.js:229`, peer-wire setArgs `:355`. `persistence.setIntents`
stores it verbatim; the fire-time gate then returns true. **A remote peer, or
any agent that can write a template, can grant a seat a forced-privileged plugin
verb.**
- Fix: add `withoutPrivilegedIntentsFor(list)` to `intent-registry.js` —
  filters BOTH `PRIVILEGED_INTENTS` and any registered plugin row — and use it
  at all four sites (injected at `engine.js:963` for session-manager; required
  directly in `remote-wiring.js`). Keeping the catalog fn for core-only callers
  is fine, but **no strip site may keep the old one**.
- Tests: register a plugin verb, assert ABSENT from persisted `intents` after a
  template mint AND after a peer create/setArgs. (`grep withoutPrivilegedIntents
  test/` finds only `reboot` today — that is the hole.)

**F2 (MAJOR) — `host.lib` frozen one level too shallow.**
`plugin-host-engine.js:313` is `Object.freeze({ gitWorktree })`. The WRAPPER is
frozen; `gitWorktree` is the live module object core holds under the same
require-cache entry (`ipc-handlers.js:35`). `host.lib.gitWorktree.removeWorktree
= mine` and core's `worktree:remove`, the session-delete flow
(`ipc-handlers.js:342`) and New-Session's `createWorktree` (`:273`) all call the
plugin's function. Survives `deactivate`. Interception of core through the
sanctioned door.
- Fix: hand out a BOUND FAÇADE, not the module — `Object.freeze({ gitWorktree:
  Object.freeze({ listWorktrees: (...a) => gitWorktree.listWorktrees(...a), … })
  })` for **all four** members.
- Test: mutate `host.lib.gitWorktree.removeWorktree` from a fake plugin, assert
  `require('../git-worktree').removeWorktree` unchanged.

**F4 (MODERATE) — `enabled` is a legal plugin id though the comment says
reserved.** `plugin-loader.js:80-81` and `:222` claim reservation; the only
artifact is a const holding the key name. clodex RAN it: `isValidPluginId('enabled')
=== true`. Such a plugin calling `host.settings.set` writes `plugins.enabled =
{…}`, `sanitizePlugins` coerces the non-array to `[]`, `enabledSet()` reads that
as "user turned everything off" — **every other plugin silently disabled at next
launch.**
- Fix: `RESERVED_PLUGIN_IDS = new Set(['enabled'])` in `plugin-api.js`; refuse in
  `validateManifest` with a `problems` row (so the dialog says WHY) and in
  `register()`.
- **Decide and state: does `_failures` need the same treatment?** (Note:
  `PLUGIN_ID_RE` forbids a leading underscore, which is why the quarantine shadow
  was collision-proof — check whether that already covers it and SAY SO.)

**Also fix (both real, both small):**
- **False quarantine strike on double activation.** `renderer.js:3043` calls
  `activatePluginRenderer` unconditionally on `plugin-state{enabled}`;
  `renderer/plugin-host.js:567` THROWS if already activated; the catch reports a
  renderer FAILURE = a real strike. Two windows racing quarantine a HEALTHY
  plugin. Make already-active a **no-op that is never reported**, not a throw.
- **`telemetry.snapshot` returns the live poller payload**
  (`plugin-host-engine.js:315`) — the same object core rebroadcasts. Return a
  DEEP COPY; the comment says read-only.

## Explicitly OUT of scope

- **The lint hardening** = ticket **t9** (`ticket-t9.txt`, already queued, do
  LAST).
- **The `fsScope`/`safeResolve` containment question** — clodex is ruling
  separately. My Q1 write-up is input to that ruling. **Do not touch it here.**

## Hard constraints

- Commit on `plugin-phase-1`. Never master, never push. `git reset -q
  node_modules` before staging (`git add -A` sweeps it in every time).
- Suite via the `clodex-test-green` skill with an EXPLICIT cd into the worktree,
  plain `node --test`, NO dir arg. `[agent:exec clodex-run-tests]` is blind to
  worktrees and will lie. Baseline to beat: 2467 + however many I add.
- `renderer.js` and `renderer/plugin-host.js` are BUNDLED → run `npm run
  build:web` and commit `web-dist/index.html` if it changes (a stale one is a
  release failure, `scripts/release.sh:45-54`).
- Code wins over docs everywhere. `.claude/CLAUDE.md` and `.claude/memory.md` are
  never mine to edit.
- If a fix turns out to need a `"1"`-surface change, STOP and flag — the API is
  frozen.

## Progress log

### T7 addendum (done, before t8 started)

clodex ruled on the workspace gap: **document, do not build**, and record it in
the plan as a **v1.1 candidate** alongside the menu slot — the fix is additive (a
new field on the transport), so the bump policy permits it in 1.1 without going
to `"2"`, which makes it scheduled rather than abandoned. Added that paragraph to
plan §3.2; committed `ab56253` (docs only). clodex also accepted the item-3
refusal explicitly: *"your refusal of item 3 was correct and is the best thing in
this report… deviation (r) is spent well, do not treat it as a budget concern."*
CLAUDE.md's "eight" is Bogdan's to fix; clodex has flagged it.

### F1 (done — CRITICAL, the registry-aware strip)

`withoutPrivilegedIntentsFor(list)` added to `intent-registry.js` beside
`intentEnabledFor` — its send-side twin, and documented as such: the catalog's
strip filters `PRIVILEGED_INTENTS` (core verbs only), this one additionally drops
any `pluginRowFor(t)`. Implemented by DELEGATING to the catalog fn and filtering
the result, so core's semantics (non-array passes through untouched; `[]` and
privileged-only both collapse to a real "everything gated") are inherited rather
than re-stated.

All four strip sites converted, **none kept the old one**:
- `session-manager.js:3953` (spawn template) + `:4090` (reviewer template) — via
  the injected dep, which I **RENAMED** `withoutPrivilegedIntents` →
  `withoutPrivilegedIntentsFor` (engine.js:963) rather than aliasing. Rename not
  alias on purpose: `test/session-manager.test.js:26` and
  `test/plugin-fake.test.js:907` inject this dep themselves, and an alias would
  have let both harnesses keep injecting the CATALOG leaf while the production
  path was fixed — a green suite over a live hole, the exact failure mode this
  ticket is about. Both harnesses updated to inject the registry fn.
- `remote-wiring.js:229` (peer create) + `:355` (peer setArgs) — now requires
  `./intent-registry` directly.
- `engine.js:545` no longer imports the catalog's strip at all.

Tests + REVERT PROOF (reverting = pointing the injected dep back at
`intent-catalog.withoutPrivilegedIntents`):
- `t8 F1: an agent [agent:spawn] template carrying a PLUGIN verb has it stripped
  too` — fails without the fix: `actual: ['dm','fake-grant']` vs expected
  `['dm']`.
- `t8 F1: a reviewer template carrying a PLUGIN verb has it STRIPPED` — fails
  without the fix: `actual: ['fake-grant','dm','who']` vs `['dm','who']`.
Both use the existing `withVerb` helper (registers into the module-level table,
resets in a promise-aware finally).

Peer-wire tests added to `test/remote-create.test.js` (the existing owner-side
harness: patches `RemoteServer` to capture the options object, then calls the real
closures against a mock manager). Two additions to `makeDeps`: an `argsCalls`
recorder, and `applySessionArgs` upgraded from an inert `{ ok:false }` stub to a
capturing `{ ok:true }` — the setArgs closure passes the patch straight through,
so capturing there IS the assertion point. `withVerb` is duplicated locally (it is
a 9-line module-level-state guard, not exported by session-manager.test.js).
- `createSession (t8 F1): a PLUGIN verb in the wire body is stripped before
  create()` — fails without the fix: `actual: ['dm','fake-grant']` vs `['dm']`.
- `setSessionArgs (t8 F1): a PLUGIN verb in a peer patch is stripped before the
  resolver sees it` — fails without the fix: same `actual`/`expected`.
Revert method: sed the `remote-wiring.js:28` import back to
`intent-catalog.withoutPrivilegedIntents` under the same local name, run, restore
from `/tmp/rw.bak`. File confirmed back at the registry import after.

**F1 DONE** — all four strip sites fixed, four tests, four revert proofs.
`test/remote-create.test.js` 18/18 green.

### F2 (done — MAJOR, the bound façade)

`libGitWorktree` built once at engine-construction time, near `notifyStateChanged`:
a frozen object of bound wrappers `(...a) => gitWorktree[k](...a)`, one per
FUNCTION export, and `lib` now hands that out instead of the module object. The
plugin no longer holds a reference to the real leaf at all, so there is nothing to
assign to; the façade is frozen on top of that.

**Deviation (s) — the spec said "all four members"; `git-worktree.js` exports
SEVEN.** `git-worktree.js:202-205`: `repoToplevel, createWorktree, removeWorktree,
defaultWorktreePath, defaultBranch, repoInfo, listWorktrees`. (`docs/plugin-api.md`
§`host.lib` names only three, but the pre-F2 code lent the whole module object, so
seven is what a plugin could actually reach.) A hardcoded four-name façade would
have SILENTLY NARROWED a frozen `"1"` surface — the exact class of change the
freeze forbids — so I derived the wrapper set from `Object.keys(gitWorktree)`
filtered to functions. That also means a future export is lent automatically
rather than requiring a re-edit nobody would remember. Non-function members are
skipped deliberately: the leaf has none today, and handing one out by value would
re-open this same hole for anything mutable. **No behavior narrowed, nothing
widened.** The doc's three-name list is now under-descriptive rather than wrong;
flagging it for clodex, NOT editing it (t7 is closed and §4's wording is clodex's).

Test `t8 F2: a plugin cannot repoint a host.lib leaf that core itself calls` —
injects the REAL `require('../git-worktree')` as the leaf, because the whole claim
is about identity with what core requires and a stub would prove nothing. Asserts:
the member assignment throws, `realLeaf.removeWorktree` is unchanged,
`host.lib.gitWorktree !== realLeaf`, every function export is present and is NOT
the raw fn, and a wrapper still delegates with args intact.
- REVERT PROOF: sed `lib: Object.freeze({ gitWorktree: libGitWorktree })` back to
  `Object.freeze({ gitWorktree })` → `AssertionError: Missing expected exception
  (TypeError): the leaf façade itself is frozen, not just the lib wrapper`,
  `actual: undefined`. 27 pass / 1 fail. Restored from `/tmp/phe.bak`.
`test/plugin-host-engine.test.js` 28/28 green with the fix.

### F2 follow-ups from clodex (done, with F2)

clodex **approved deviation (s)** — *"you were right and my ticket was wrong…
hardcoding my four would have silently narrowed a surface I froze this morning."*
Two additions ruled and landed:
1. **The seven names are pinned by NAME** in the F2 test. Deriving protects
   against narrowing but would silently WIDEN the surface the day someone adds an
   unrelated export to `git-worktree.js`, with no diff saying plugins can now
   reach it. The assert says so and says the list must move in company with the
   doc.
2. **`docs/plugin-api.md` §`host.lib` now names all seven**, one line of purpose
   each, in a table — clodex's wording ruling: *"an author can only rely on what
   is documented, so if we lend seven we document seven."* Same principle that
   made the handler signature a real defect. Explicitly NOT narrowing the lent set
   to match the old three-name doc: narrowing could break a conforming `"1"`
   plugin and the bump policy reserves that for `"2"`; documenting what already
   ships is additive and stays inside the freeze. The doc also now states that a
   plugin receives bound wrappers, not the module.

### F4 (done — MODERATE, `enabled` is a reserved id)

`RESERVED_PLUGIN_IDS = new Set(['enabled'])` added to `plugin-api.js` and folded
into `isValidPluginId` itself, so **both doors inherit the refusal from the shared
leaf** rather than each re-deriving it. On top of that, each door gets an EXPLICIT
reserved check that runs BEFORE the regex one, because "invalid plugin id:
enabled" reads like a typo for a string that satisfies `PLUGIN_ID_RE` and sends
the author hunting for a malformation that isn't there:
- `plugin-loader.js` `validateManifest` → a `problems` row reading *"plugin id
  "enabled" is reserved — it is a key in uiSettings.plugins, so a plugin of that
  name would overwrite the enabled list"*, which is what the Manage Plugins dialog
  renders.
- `plugin-host-engine.js` `register()` → throws `/reserved/`. The loader refuses
  such a manifest first, so this is the backstop for the in-tests fake and any
  future non-loader caller. An invariant enforced at one door only is the same
  defect class as a comment enforcing nothing.

Both stale loader comments that *claimed* reservation with nothing behind it
(`:78` and `:230`) now point at the enforcement instead of asserting it.

**VERDICT on `_failures` (the ticket asked me to decide and state it): it does NOT
need reserving, and the ticket's own hint was right.** Ran it: `isValidPluginId`
returns false for `_failures` and `_host`, true for `enabled` and `workbench`.
`PLUGIN_ID_RE` = `/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/` requires a
lowercase-alnum FIRST character, so a leading underscore can never match and
`_failures` is collision-proof by construction — exactly as `_host` is. The set is
for keys the regex ALLOWS. Asserted rather than left as prose: the test checks
both `isValidPluginId('_failures') === false` and
`!RESERVED_PLUGIN_IDS.has('_failures')`, so the reasoning is pinned, not just
written down.

Three tests, one REVERT PROOF covering all three (emptying the Set):
- `t8 F4: 'enabled' is refused as a plugin id, and the reason says WHY` — fails:
  *"the reservation is in the shared leaf, so both doors inherit it"*.
- `t8 F4: a plugin directory named 'enabled' is refused at DISCOVERY, with a
  problems row` — fails: *"the reserved-id plugin never becomes a catalog row"*.
- `t8 F4: register() refuses the RESERVED id 'enabled', saying reserved rather
  than invalid` — fails: *"Missing expected exception"*.
61 pass / 3 fail reverted; 73/73 green with the fix (loader + engine + contract).

### The two smalls (done)

**(a) False quarantine strike on double activation.** `renderer/plugin-host.js`
`activate()` threw on an already-active id; `renderer.js:3043` calls it
unconditionally on the `plugin-state{enabled}` broadcast and its catch reports
`renderer.report(id, false)` — a real strike, two of which quarantine. Now an
idempotent no-op returning the rhost the plugin already holds. Required one
supporting change: the resource record gained an `rhost` field (set at
activation) so the repeat call can hand back the SAME object rather than
building a second one — a fresh rhost would be a subtler version of the same bug,
two live surfaces for one activation. `dispose()` deletes the whole record, so it
clears with it, and re-activation after a disable works from scratch (asserted).
- Test `t8: activating an ALREADY-active plugin is a silent no-op, not a throw`:
  no throw, module activated ONCE, no duplicate contribution, same rhost back,
  and a later re-enable really re-activates.
- **An existing test asserted the old throw** — `activating the same plugin twice
  is refused`. Not weakened: rewritten as `activating the same plugin twice does
  not activate it twice`, which asserts the invariant that actually mattered (the
  second activation does not RUN). The throw was the bug, not the guarantee.
- REVERT PROOF: restoring the throw → `Got unwanted exception: a repeat
  activation must not throw — the caller reports a throw as a quarantine strike`,
  and the rewritten test fails too. 33 pass / 2 fail.

**(b) `telemetry.snapshot` returned the live poller payload** — the same object
core rebroadcasts to every window, so a plugin mutating it edited core's state and
every other reader's view. Now `structuredClone`, falling back to a JSON round
trip for a payload it refuses (function/symbol), and `null` on any failure —
because null is this API's documented normal case and it must never throw into a
plugin. Non-objects and null pass through unchanged.
- Test `t8: telemetry.snapshot returns a deep copy` — same VALUE (a copy, not a
  redaction), different object, different NESTED object, mutating the copy at
  every level leaves the live payload byte-identical, two reads are independent,
  and `null` still means null.
- REVERT PROOF: restoring the passthrough → `AssertionError: but not the same
  object`. 29 pass / 1 fail.

`npm run build:web` run (renderer/plugin-host.js is bundled): `web-dist/index.html`
and `renderer/web/plugin-registry.js` both updated. NOTE the registry now bundles
**git-branches AND workbench** — clodex installed the cold-built acceptance plugin
into this worktree while t8 was in flight.

### Arriving mid-t8 (not mine to touch / not started)

- **Uncommitted work in the tree that is CLODEX's, explicitly "leave them,
  they're mine"**: `test/plugin-kill-switch.test.js` (two fixes for tests that
  assumed one plugin would be the only plugin) and the regenerated
  `renderer/web/plugin-registry.js`. Untracked `plugins/git-branches/` is the
  acceptance build. All of it rides in my t8 commit because it is in the same
  tree — flagged to clodex in the close.
- **Ticket t11** (`ticket-t11.txt`) — four doc defects, documentation only, plus
  an addendum ruling handler multiplicity: a verb fires EXACTLY ONCE per matched
  line (`session-manager.js:1519` gates `_scanPtyOutput` behind `if (!agentType)`,
  so the JSONL and PTY feeds are mutually exclusive per session), and §7's "live
  on every input feed at once" must be reworded so it cannot be read as
  multiplicity. Includes the acceptance builder's generalization about
  non-idempotent callbacks, to be attributed in the journal, not the doc.
- **Ticket t12** (`ticket-t12.txt`) — two doc items folding into t11 (the
  `npm run build:web` step is unmentioned in the published contract; the
  generated `renderer/web/plugin-registry.js` header still claims it is "the
  EMPTY map" and now lists two plugins), plus one investigation: check whether any
  OTHER test asserts over the intent registry's contents without controlling for
  plugin-registered rows. Do not weaken assertions to accommodate a plugin.

### T8 close

Suite **2481/2481**. A SECOND test asserted the old activation throw —
`test/plugin-fake.test.js:875` — and was found by the full suite, not by the
targeted runs. Same treatment as the first: rewritten to assert law 1's real
content (`record.activated === 0`, no extra footer button) rather than the throw.
Neither rewrite weakens anything; both assert the invariant the throw was
standing in for.

---

# Ticket t10 — the handler signature is documented backwards (acceptance-build fallout)

Ticket verbatim: `ticket-t10.txt`. Dispatched MID-t8 with **do it FIRST**, so
F1+F2 sit uncommitted in the tree while this lands on top. Ticket t11 (four more
doc defects, documentation-only) arrived at the same time and is saved as
`ticket-t11.txt` — NOT started.

## What was wrong

`docs/plugin-api.md:739` published `handler(intent, ctx)` with no `ctx` fields
described. The shipped call is `session-manager.js:3179` → `row.handler(handle,
intent)`. Arguments reversed, and the first is a host-minted SessionHandle, not a
context bag. Both objects, neither throws — an author following the doc reads each
one's fields off the other and the verb silently misbehaves. The cold builder
concluded "this needs a core change to put session identity on ctx", which is
false: identity was already in the argument it had been told was the intent.

## Done

1. **§7 signature corrected** to `handler(handle, intent)` with `// optional —
   NOTE the order`, plus a full bullet in the parameter list: handle FIRST, it is
   the same SessionHandle `onCreate`/`onExit` get (cross-referencing §4 rather
   than restating it), `handle.name` identifies the emitter, `handle.inject(text)`
   is the reply channel, no return-value channel, a returned promise is logged and
   ignored, a throw becomes an `[agent:<verb>] error: …` bounce, agent sessions
   only. The phantom `ctx` is gone from §7 entirely — the remaining `ctx` mentions
   in the file are §6.1/§6.2's UI-slot render context, which is real and unrelated.
2. **No worked example needed fixing** — §7's only code block is the register()
   call itself, and the pilot (`plugins/workbench/engine.js`) registers no verb, so
   there was no second wrong destructure to chase.
3. **Pinned in `test/plugin-surface-contract.test.js`**: `an intent handler is
   called handler(SessionHandle, intent) — argument ORDER is contract`. Goes
   through the REAL path end to end — real registry row via `host.intents.register`,
   real host-minted handle via `engine.hooks`, real `_handleIntent` dispatch — so
   it cannot pass by agreeing with a mock. Asserts arg1 has `name`+`inject` and
   NOT the parse fields, arg2 has `type`+the parse fields and NOT `inject`, and
   that the DOC says `handler(handle, intent)` and nowhere says `handler(intent,
   ctx)`. Comment says argument order is contract and names the defect class (a
   documented CALL SHAPE no test exercises; this file pinned members instead).
   - REVERT PROOF, both sides: reverting the DOC line → the test fails on `docs §7
     must publish the handler signature in the order it is actually called`;
     reverting the CODE to `row.handler(intent, handle)` → fails on `arg 1 is the
     SessionHandle — handle.name identifies the emitter`. 8 pass / 1 fail each way.
4. **Re-read of §7 for unexercised claims** — every remaining claim has a test:
   verb regex + reserved + collision (`intent-registry.test.js:318,335`), parse
   can't impersonate / can't throw out (`:379`), bodyMode clamped to three modes
   (`:394`), default label naming the owner (`:452`), promptLines only for a
   GRANTED seat (`:504`), forced privileged (`:342`), absent list denies (`:351`),
   live on the bash PTY feed too (`session-manager.test.js:5042`), disposal +
   source sweep (`:409,418`). Nothing else in §7 is stated but unpinned.

Two more from the same report:

5. **§2's "intent-verb namespace" claim removed.** Verbs are global — that is
   precisely why §7 refuses collisions — so the id row now says "a UI-slot id
   prefix and a dispatch prefix … It is **not** an intent-verb namespace: verbs
   live in one global namespace (§7)". §7 gained the positive statement too, with
   the concrete form the builder got wrong: register `review` and agents write
   `[agent:review …]`, never `[agent:yourid:review …]`.
6. **§6's opener made to agree with §6.5.** It said "you never see an
   unnamespaced id come back", which is backwards. Verified against
   `renderer/plugin-host.js:338-350`: `handleMenuPick` splits at the first `:` and
   calls `p.onPick(bare, …)`. New wording: the prefix is the host's business in
   BOTH directions — you never write it and you never see it; `onPick`'s `act` is
   the one hand-back and it arrives unprefixed.

`test/plugin-surface-contract.test.js` 9/9 green.

---

## T9 — lint hardening: make the no-backdoor test fail for classes it cannot see

`test/plugin-boundary.test.js` only. No production code changed, so no `"1"`
surface question arises.

**Framing, first, because it constrains every rule below.** The file's header now
says outright what it is NOT: a security control. `contextIsolation: false` +
`nodeIntegration: true` means a plugin is in-process code with the app's full
authority, and the published contract already says the host API is a contract
and not a containment boundary. This lint catches ACCIDENTS AND DRIFT — the
honest reach for core, the shortcut that outlives its author. The header states
the test to judge new rules by ("would it have caught the honest mistake?") so a
future reader can't mistake the direction of travel.

### The assertion that had to go

The old self-test asserted EXACTLY THREE violations for its synthetic plugin.
That is a green test measuring its own assumptions: a class the scanner cannot
see contributes nothing to the total, so the count stays 3 and nothing goes red,
no matter how many blind spots open. Same family as the fake-store tests, and
same family as `plugin-kill-switch`'s "exactly ['workbench']" that clodex fixed
today — an assertion encoding an assumption the suite cannot violate on its own.

Replaced with `kindsByFile()`: violations now carry a `kind`, and the self-tests
assert WHICH kinds were found per file. A new blind spot now shows up as a
missing NAME rather than a number that happens to still match. Fixtures moved
into a `withSyntheticPlugin(files, fn)` helper so each class gets its own,
against the REAL `plugins/` dir (unchanged rationale: proves resolution against
the actual pluginDir the production scan computes).

### The three blind spots

1. **Denied builtins.** `DENIED_BUILTINS = {module, vm}`, carved OUT of the
   builtin allowance rather than bolted beside it — the allowance is the thing
   that would otherwise wave them through. `require('module').createRequire(
   __filename)('/abs/session-manager.js')` reaches every live core singleton via
   an absolute path no specifier rule can classify. Kind `denied-builtin`, with
   `isDeniedBuiltin()` so the self-test can assert "reports as DENIED", not
   merely "is not a builtin" — those differ and only one is the fix.
2. **Dynamic requires.** Kind `dynamic-require`. See the deviation below.
3. **`api` off any global.** `GLOBAL_API_RE` covers `window|globalThis|self|top|
   parent`, dot AND bracket form; `BARE_API_RE` (`/(?<![\w$\-])api\s*\./`) covers
   the aliased reach `const w = window; w.api.x`, which by construction has no
   global token left to match. `else if` between them: one violation per file per
   class reads better than a doubled report of one mistake. `PROCESS_ESCAPE_RE`
   rides along for `process.binding` / `process.mainModule` — same shape (module
   system through a global), same remedy.

   The lookbehind must NOT exclude `.`: `w.api.foo()` is exactly the case rule 2
   exists for and a dot precedes it. It excludes `\w$` (so `capiX.` is not a hit)
   and `-` (so a live string holding `plugin-api.md` is not one).

### Deviation (t): the dynamic-require rule as specified is blind to its own example

The ticket says: flag any `require\s*(` **not immediately followed by a quote**.
That rule does not catch `require('..' + '/x')` — the ticket's own second
example — because concatenation begins with a quote. Implementing it literally
would have shipped a fixture-less hole under a green test, which is the exact
defect this ticket exists to remove.

Implemented the INTENT instead: `dynamicRequires` is the exact complement of
`requireSpecs`. Every `require(` whose argument is not one COMPLETE string
literal is flagged. The pair is now total by construction — a call site is
either auditable or flagged, never neither — which is a stronger property than
either rule alone and is what makes the blind spot closed rather than narrowed.
Both ticket examples are pinned as fixtures, plus template-literal and
`process.env` forms.

### Revert proofs (all three, by reverting — not by reasoning)

| revert | tests that go red |
|---|---|
| `DENIED_BUILTINS` emptied | `isBuiltin does NOT wave through the module system itself`; `scanPlugin flags a require("module") escape` |
| `dynamicRequires` returns `[]` | `dynamicRequires flags every require whose argument is not a plain string`; `scanPlugin flags a computed require specifier as unauditable` |
| literal `window.api` regex restored, bare rule disabled | `the global-api rules see every alias`; `scanPlugin flags api reached off any global, and via an alias` |

Restored: 13/13 green.

### The hardened lint against the real plugins — NO true positives

Ran against both `plugins/workbench` and the newly-installed
`plugins/git-branches`. **Both clean; nothing silenced, nothing widened.**
Checked by hand as well as by the scan:
- zero non-literal `require(` anywhere under `plugins/`;
- zero `module`/`vm` requires;
- the only `api.`-shaped text in either plugin is `plugin-api.md:739` inside
  COMMENTS (git-branches' notes about the t10 signature bug), which
  `stripComments` removes before any rule runs — a real check of the
  false-positive class the header already documents, and it holds.

So the hardening added five discriminations and cost zero suppressions. That is
a weaker result than a true positive would have been, and it is worth saying
plainly: the lint got sharper, but nothing shipped was found wanting.

---

## T12 — the registry sweep investigation (done first; docs follow)

**Question:** does any OTHER test assert over the intent registry's contents
without controlling for plugin-registered rows?

**Method.** The registry's read surface is `rows / catalogRows /
pluginGrammarLines / validIntentNames / allowlistFromChecked / rowFor /
pluginRowFor`. Grepped every one across `test/`, then crossed that against the
files that really load plugins from disk. Six files enumerate:
`intent-checklist-seam`, `intent-registry`, `ipc-prompt`, `plugin-fake`,
`plugin-surface-contract`, `session-manager`. Six load real plugins:
`app-menus-plugins`, `free-identifier-leaks`, `plugin-loader`,
`plugin-web-parity`, `ui-settings-plugins`, `plugin-kill-switch`.

The intersection is `plugin-kill-switch` ALONE — already fixed by clodex. Node
runs each test file in its own process, so contamination is only ever
within-file; that is why the intersection is the right question and why the
answer is a short list.

**Of the six enumerators, five already control for it**: `intent-registry`
(`withPluginVerb` resets in a `finally`), `ipc-prompt` (two `finally` resets),
`plugin-fake` (`withReset`), `plugin-surface-contract` (t6's reset, in the
`finally` I wrote), `session-manager` (`withVerb`). None loads a real plugin, and
each sweeps its own registration.

**One genuine finding — `test/intent-checklist-seam.test.js:34`.** Titled "for
every CORE row", it iterated `catalogRows()` unfiltered and asserted
`intentRowChecked(row, list) === intentEnabled(row.type, list)`. For a PLUGIN row
those two DELIBERATELY disagree — that is the content of the very next test in
the file: plugin verbs are forced privileged on the row, while intent-catalog
knows nothing of registry rows and answers "ungateable by omission", so an
ungranted plugin verb is `false` on the checklist and `true` at the leaf.
Verified by hand: a registered `probe` verb gives `checklist=false catalog=true`
under `[]` and `['dm']`.

This file registers no verb and loads no plugin, so it passes today — but it
passes by circumstance, not by construction. The day any sibling test in it
registers a verb, it goes red for a correctness property nobody broke.

**Fix, per the ticket's rule.** Not weakened: the equivalence is genuinely
core-only, so it is filtered by `source === 'core'` WITH a comment saying why,
plus `assert.ok(coreRows.length > 5)` so the filter can't quietly empty the loop.
Added a fixture that registers a real verb and asserts the divergence on a live
row.

**A proof-shape correction worth recording.** My first version of that fixture
proved nothing: node runs tests in file order, the fixture sits AFTER the seam
test, so reverting the filter still passed — the registry was empty when the
seam test ran. Deleting the filter and watching it stay green is exactly the
false-confidence shape this phase keeps finding. Rewritten to run the UNFILTERED
loop inside `assert.throws(..., /seamprobe/)` at a moment when a plugin row IS
registered, which is the same proof with no dependence on ordering.

Left alone deliberately: the same file's "exactly the three fields" loop is
unfiltered and should be. Row SHAPE must hold for every served row — a plugin row
with an extra field is a real defect and that loop is what catches it. Verified
plugin and core rows carry identical keys. Commented so the asymmetry with the
filtered loop reads as a decision.

So: **one sibling found and fixed, five already clean, and the shape gate
correctly left universal.**

---

## T11 — source verification, BEFORE writing any doc prose

Three of clodex's specs diverged from code today, so every claim below was
checked against source first. Findings, with the divergences called out:

**§4 `onCreate` and restored sessions — the DOC IS WRONG, and wrong in the
safe-sounding direction.** §14 says "unspecified whether the hook fires for
sessions restored at launch" and §4 tells the author to `listAll()` and
reconcile. Source: `session-restore.js:81` calls `manager.create(...)`, and
`session-manager.js:1622-1627` fires `fireCreate` at the create() tail with the
comment "Restored sessions route through create(), so this fires for them too."
So `onCreate` DOES fire for restored sessions — it is specified, by
construction, and the doc's hedge is stale.

The real gap is a DIFFERENT one and the doc never mentions it: engine halves
activate in `engine.js:1741-1769` (`loadAll`) before any window exists, but a
plugin enabled at RUNTIME (`setEnabled` → `activateById`) activates into a world
where sessions are already running and no `onCreate` will ever fire for them.
That is the case demand-driven resolution actually solves. clodex's ruling
(teach demand-driven resolution) is right; its stated reason is not the reason.

**§14's `listAll()`-at-activation remedy is doubly broken**: at first-run
activation there are no sessions to enumerate (§4's own header says so), and at
runtime-enable `listAll()` works but the doc points the author at reconciliation
rather than the simpler thing.

**§6.4 `cache.get(name)` → `?? null`** — confirmed against the spec three lines
above (`{ text, tip?, cls? } | null`) and against
`renderer/plugin-host.js:262`, which tests `!r || !r.text`. `undefined` happens
to survive that check, so the example is not a crash — it is a spec violation
that works by luck. Fix as ruled.

**§6.4 `cls` vs §6.1 `accentClass` — both accept a space-separated class LIST.**
Verified: `renderer/plugin-host.js:268` does
`chip.className = \`session-plugin-badge${r.cls ? ' ' + String(r.cls) : ''}\``
(assignment to className — a list is native); `:176`/`:184` interpolate
`esc(String(accentClass))` into a `class="…"` attribute, and `esc`
(`renderer/lib/format.js:18`) escapes `<>&"'` only, so spaces pass through
intact. The builder's guess (one token per state) was defensive and unnecessary.
Two different names for the same concept in adjacent sections is the actual
defect.

**§5 `listWorkspace` renderer element shape** — `renderer/plugin-host.js:491-497`
filters the resolved `listSessions()` (bound to `session:list`,
`ipc-handlers.js:317` → `manager.listForWorkspace`) by `workspaceId`. So the
element is `manager.list()`'s row verbatim, `session-manager.js:2040-2062`:
`{ name, type, pid, cwd, workspaceId, team, ticket, backend, activity,
attention, pendingCount }`. IDENTICAL to the engine twin — same function, one
await apart. The doc can point at §4 and say there is no difference.

**§7 multiplicity — confirmed EXACTLY ONCE, and the reason is stronger than the
ticket's.** clodex cited `session-manager.js:1519` (`if (!agentType)` gating
`_scanPtyOutput`), which is correct and is the first of THREE independent
reasons:
1. `:1519` — PTY scanning is bash-only, so the two feeds never both run for one
   session.
2. `_dispatchPluginIntent:3170` — `if (!session || !session.agentType) return;`
   refuses non-agent sessions outright, so even if a bash line reached it,
   nothing dispatches.
3. A session's agent feed is ONE of wire or jsonl, never both
   (`intentSource` is `'wire'` xor `'jsonl'`, `:1379`/`:1391`), and the wire path
   carries a per-batch `fired` Set (`:521-530`) that is explicitly load-bearing
   against intra-turn duplicates.
Any one suffices; together the guarantee is structural, not incidental.

**`parse` vs `handler` — `parse` is the per-feed one.** `parseIntent`
(→ `parseWithRegistry`) runs on BOTH scan paths: the PTY line loop
(`:2210`) and `_extractIntents` (`:2631`, JSONL/wire). `handler` runs only from
`_dispatchPluginIntent`, which is agent-only. So a plugin's `parse` really can be
called from either feed — harmless, since it is pure and returns a value — while
`handler` cannot. That is exactly the asymmetry the ticket asked me to name, and
it confirms "live on every input feed at once" describes REGISTRATION and parse
reach, not dispatch.

**Throwing `handler` — a real guarantee, already implemented.**
`session-manager.js:3186-3189`: catch → log → `_injectText(session,
'[agent:<type>] error: <msg>', { parkable: true })`. Also `:3183` logs and
ignores a returned promise. Both belong in the doc as guarantees.

**The `fsScope` overclaim appears in FOUR places, not three** (clodex named
three). `plugins/workbench/engine.js:5-14` — fixed by clodex.
`docs/plugin-plan.md:605` — "a buggy plugin cannot widen locality", still false.
`docs/plugin-api.md:337-339` — "host guarantee … cannot accidentally widen
access to a remote session"; narrower and defensible as written, but sits three
lines from an unqualified "host guarantee" and never mentions the symlink leg.
**`plugin-host-engine.js:265-268` — the HOST'S OWN comment, "a buggy or careless
plugin CANNOT widen locality", the most authoritative statement of the four and
the one clodex did not know about.** Reporting it before touching it.

### T11/T12 — what was written

All in `docs/plugin-api.md` unless noted.

1. **§4 `onCreate` — corrected, not softened.** States that restored sessions ARE
   covered, names the two moments that have no `onCreate` (pre-window activation;
   runtime-enable into a running world), and teaches demand-driven resolution with
   a worked cache keyed by session name and `onExit` as the eviction hook. Frames
   `onCreate` as an INVALIDATION HINT rather than a source of truth. §14's entry
   rewritten from "unspecified" to the runtime-enable case, with restore called
   out as fine.
2. **New "Callback conventions" block in §4**, the single place the doc's callback
   rules now live: sync-only, throw-contained-per-callback, and the multiplicity
   rule — before putting a non-idempotent side effect in a callback, find out how
   many times it can fire, because there is no emission id anywhere in the API to
   detect a duplicate after the fact. Carries a per-callback guarantee table.
   §6.4 and §7 both link to it. **Attribution, per the ticket's instruction that
   it go here and not in the doc: the generalization is the ACCEPTANCE BUILDER's,
   from the cold Phase 3 build.** It is better than anything §7 said before.
3. **§3 Law 2 — the honest version.** The three pull triggers cover a surface a
   user opens; they cover nothing that renders itself, which in "1" means
   `rowBadge`. Says outright that a rowBadge's first render is structurally blank,
   that this is the design working rather than a race, and to make "nothing yet" a
   legitimate state.
4. **§5 `listWorkspace`** — element shape written out, stated as the engine twin's
   row verbatim (same producer, one await apart), plain data not SessionHandles,
   and `[]` means "none OR could not ask".
5. **§6.1/§6.4 `accentClass` / `cls`** — both take a space-separated LIST; the two
   names are the same thing, historical, not a signal. Anchored `#class-fields` so
   §6.4 links back. Retires the builder's one-token-per-state workaround.
6. **§6.4 example** — `?? null`, with a sentence on why `undefined` renders
   nothing today but is outside the contract.
7. **§7** — three guarantees split out of the handler bullet: exactly once per
   matched line (three mechanisms, stated structurally); a throw becomes a bounce
   and IS the error channel, so do not wrap defensively; a returned promise is
   logged and ignored, and an `async handler`'s rejection becomes silence rather
   than a bounce. "Live on every input feed at once" rewritten to
   "**registration is global, dispatch is not**", naming `parse` as the per-feed
   one (pure, harmless) and `handler` as agent-only and once-per-line. Plus a
   blockquoted operational note on forced-privileged silence: the verb is inert
   until granted per-seat, NOTHING is logged, it looks identical to a broken
   registration, and here is the ⚙-menu path to grant it.
8. **§14** — new "no change notification" gap: `onCreate`/`onExit` are the whole
   lifecycle set, nothing fires on checkout/branch/cwd change, §9 has no renderer
   subscription, so **freshness is bounded by how often you re-ask, not by when
   the data changed**; plugin owns a TTL and should state it in its README. Names
   the real constraint: plugins that report are writable at "1", plugins that must
   be instantaneously correct are not.
9. **§1 — the build step** (t12 item 1). `npm run build:web` after ADDING or
   REMOVING a renderer half, commit the regenerated registry, and the reason it is
   easy to miss: Electron does not notice, only `plugin-web-parity` does.
10. **`renderer/web/plugin-registry.js` header** (t12 item 1, code file, comment
    only) — the "This committed version is the EMPTY map" claim replaced with what
    is actually committed, plus which test catches drift.

### Deviation (u) — approved before execution: the fsScope overclaim, all four sites

clodex named three sites; there were **four**. The fourth is
`plugin-host-engine.js:265-270` — the comment on `fsScope` ITSELF, the function
the other three cite as their authority — claiming "a buggy or careless plugin
CANNOT widen locality" and then, four lines later in the same comment, "Note this
refuses PEERS, not foreign workspaces". It disproved its own claim in place and
read as elaboration.

Flagged before touching it (core code file under a doc-only ticket); clodex
approved, ruling the guard aimed at behaviour changes, not false comments. All
four now say one thing: fsScope answers "what cwd, and is this local?" — not
workspace scoping, not cwd confinement, not a sandbox. `docs/plugin-api.md`'s §4
gained a three-bullet "what this is not" block including the symlink leg;
`docs/plugin-plan.md:605` and the host comment rewritten; §14's fsScope entry
widened from "not foreign workspaces" to "neither scopes workspaces nor confines
the cwd".

Suite **2489/2489**.
