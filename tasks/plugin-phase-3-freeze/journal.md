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
- **No deviation letter used. (r) is still free.** The eight shape findings were
  the ticket's requested proposal pass, not departures; the nine plan
  divergences are piece 4's deliverable, not my choices. Nothing in T6 departed
  from the spec.
