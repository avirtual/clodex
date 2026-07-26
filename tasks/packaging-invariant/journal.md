# t39 — make the packaging allowlist invariant structural

Branch `packaging-invariant` off master `8aec603` (has t38). Worktree
`/Users/bogdan/projects/tmux/wb-wrap-ui-hand`. Baseline 2724, ESCAPES: 0.

## Phase 1 — survey + design. DONE.

### THE HEADLINE: there is a live third instance, and it is already shipping broken

Before designing anything I probed for what a general guard *would* find. It
finds a real one, today, in the released DMG:

**`peering/` is not in `build.files`, and the app reads it at runtime.**

- `ipc-handlers.js:1159` — `peer:deploy` does
  `fs.readFileSync(path.join(__dirname, 'peering', 'clodex-deploy.sh'))`.
  No `isPackaged()` branch, no `process.resourcesPath` fallback. Compare
  `wirescope-supervisor.js:113-117`, which *does* branch for exactly this reason
  ("packaged runs from Contents/Resources — python can't execute from inside the
  asar archive").
- `ipc-handlers.js:1221` — the deploy-fix briefing passes
  `docsDir: path.join(__dirname, 'peering')`.
- **Verified on the real artifact** (the DMG I built for t38, v4.3.1 content):
  `npx asar list … | grep -c '^/peering/'` → **0**.

Consequence: in every shipped DMG, the **Test & Set Up wizard's install step
fails** with `deploy script unreadable: ENOENT`. That is a README-advertised
feature ("point it at a bare Linux box and it probes what's there, then installs
Clodex from scratch"). Unlike `cli/` this is not hypothetical and unlike `docs/`
it is not merely absent — it is a user-facing feature that cannot work.

This is the strongest possible argument for the derive-don't-enumerate design,
and it is also a product decision (adding a tree to the shipped artifact) that I
am flagging to clodex rather than taking silently. **The guard is what found it,
which is the point of the guard.**

### Closure probe — what a require-scan actually reaches

Transitive local-`require()` closure from `main.js` + `preload.js`
(scratchpad/closure-probe.js): **89 files**, spanning three trees — root, `cli/`
(3 files), `wire/` (11 files). One unresolved match, and it is a false positive:
`ipc-handlers.js:1116` mentions `require('../../intent-catalog')` **inside a
comment** describing what the renderer used to do.

So a require-scan covers `cli/` and `wire/` — it would have caught instance 1.
**It would NOT have caught instances 2 or 3.** `docs/` is not required by
anything, and `peering/` is read with `fs.readFileSync`, not `require`. That is
decisive for the design below.

### The design I chose, and the one I rejected

**REJECTED: require-scan only** (clodex's option A, "catches the unknown case").
It is the more attractive framing and it is insufficient here, for a reason the
data settles rather than my taste: two of the three real instances are **not
`require()` edges at all**. A guard built only on the module graph would have
been green through the `docs/` gap and is green *right now* over the live
`peering/` bug. Shipping it would be worse than the two explicit tests, because
it would carry the authority of a general invariant while covering one third of
the observed failure mode.

**REJECTED: a maintained list of load-bearing roots** (clodex's option B). This
is the two explicit tests with extra steps — a list restating a list.

**CHOSEN: derive from BOTH edge kinds, and make an unclassified top-level tree a
forced decision.** Three layers, cheapest first:

1. **Module-graph closure** — transitive local `require()` from the main-process
   entry points; every resolved file must be covered by a `build.files` pattern.
   Catches instance 1 and anything like it.
2. **Runtime asset reads** — scan first-party sources for
   `path.join(__dirname, '<literal>' …)` where the literal names a top-level
   directory of the repo, and require that tree to be covered. Catches instance 3
   (`peering/`), which is the edge kind the module graph is blind to.
3. **Every top-level tree is classified** — each directory in the repo root is
   either covered by `build.files`, or named in an explicit EXCLUDED table with a
   one-line reason. Adding a new root to the repo fails the test until someone
   decides. This is the layer that catches instance 2: `docs/` is reachable by
   neither edge kind (nothing requires or reads it — it is human-facing), so
   *no* derivation can find it, and the honest mechanism is a forced decision
   rather than a pretence of derivation.

The judgment behind layer 3, stated plainly because it is where I depart from a
pure derive-everything design: **`docs/` proves that not every packaging
dependency is discoverable from code.** A guard that only derives will always be
silently incomplete for human-facing trees. So the general form is derivation
*plus* an exhaustive classification whose cost is one line when a root is added.
The list in layer 3 is not the enumerated list clodex rejected — it lists what is
DELIBERATELY EXCLUDED, so forgetting a tree fails closed rather than passing
silently.

### Folding the two existing tests

Both are subsumed by layer 1 (`cli/`) and layer 3 (`docs/`), but I am **keeping
their second tests** — `cli-packaging.test.js`'s README-prose assertion and
`docs-packaging.test.js`'s doc-paths-exist check are not packaging invariants at
all; they pin prose and links. Decision recorded in Phase 2.

## clodex's ruling (msg-29348-10)

**(a): add `"peering/**/*"` in this ticket.** "Not really a product decision — the
code already reads that tree unconditionally at `ipc-handlers.js:1159`. The
product decision was made when the read was written." Three-layer design accepted
as proposed, over clodex's own derivation-only framing. Two second-tests stay
where they are. **New requirement: report what layers 1–3 flag across the CURRENT
repo, not just that the suite is green** — assume there may be a fourth instance.
v4.3.2 to follow the merge promptly, since v4.3.1 shipped with the bug.

## Phase 2 — implemented

- **`package.json`** — `"peering/**/*"` added after `docs/**/*`.
- **`test/packaging-allowlist.test.js`** (new, 5 tests) — the three layers plus
  two self-guards.
- **`plugins/git-branches/README.md`** (Part 2) — Install now leads with
  `~/.clodex/plugins/git-branches/` + Re-scan (no restart), names Open Plugins
  Folder, and keeps the repo path as the explicitly-labelled developer case.

### Implementation notes worth keeping

- **The pattern matcher is hand-written, and a 5th test fails on any shape it
  does not know.** `minimatch` is present in `node_modules` but is NOT a declared
  dependency of this package — it is transitive, so depending on it in a test
  means a dependency bump can silently delete our coverage. Three shapes are
  implemented (`*.js` root-glob, `dir/**/*`, literal path); anything else fails
  loudly rather than matching nothing. A matcher that silently covers nothing is
  how this whole class of bug works, so the guard must not reproduce it
  internally.
- **`covers()` vs `touchesTree()`.** Layer 1 asks the file-level question; layer 3
  asks the weaker tree-level one, because `build/` legitimately ships two named
  icons and nothing else — that is a classification, not an omission. Layer 2
  picks per reference: a ref naming a file gets `covers()`, a ref naming only a
  directory gets `touchesTree()`.
- **`IMPLICIT = {package.json}`** — layer 1 flagged it, and it is a genuine false
  positive: electron-builder always packs it. Verified empirically against the
  real artifact (`npx asar list | grep -E '^/[^/]+\.json$'` → `/package.json`)
  rather than taken from the docs, and the reason is recorded inline.
- **The one unresolved require in the graph is a false positive in a COMMENT**
  (`ipc-handlers.js:1116` describes `require('../../intent-catalog')` as
  something the renderer used to do). The walker skips unresolvable specifiers
  rather than failing: a packaging test is the wrong place to police prose.

## Phase 3 — verification

`TOTALS: 2729 pass, 0 fail` / `ESCAPES: 0` (2724 → 2729, +5). Read from
`npm test` directly.

`npm run build:web` NOT run — no bundled source touched.

### Revert proofs — 8, all BY MESSAGE, and each names the tree

| revert | layer(s) that fired | message names |
|---|---|---|
| `cli/**/*` removed | 1 + 3 | the files, then `cli` |
| `docs/**/*` removed | 3 | `docs` |
| `peering/**/*` removed | 2 + 3 | `ipc-handlers.js reads peering/clodex-deploy.sh`, then `peering` |
| `renderer/**/*` removed | 2 + 3 | the reads, then `renderer` |
| a new unclassified top-level dir appears | 3 | `newtree-probe` |
| `docker/**/*` added while still EXCLUDED | 3-stale | "EXCLUDED lists docker/ … but build.files now ships it" |
| an unknown pattern (`!**/*.map`) added | shape gate | names the pattern + the remedy |

### Window statements (the rule from t37, applied)

The four tree-removal reverts above co-fire layers, so they do **not** prove
layers 1 and 2 have windows of their own. Proved separately:

- **Layer 1's unique window** — a required file inside a tree covered only by
  LITERAL patterns. Added `require('./scripts/probe-mod')` to main.js with
  `scripts/probe-mod.js` on disk: `scripts/` ships two named files, so
  `touchesTree('scripts')` is true and **layer 3 stays green** — layer 1 fires
  alone. This is the real-world shape of instance 1.
- **Layer 2's unique window** — an asset read of a file in a tree that ships only
  NAMED files. Pointed `app-menus.js` at `build/afterPack.js` (real file, not in
  the two icon literals): **layer 3 green, layer 2 fires alone.**
- **Layer 3's unique window** — a tree reachable by neither edge kind. That is
  the `docs/` revert above, where 1 and 2 both stay green. By construction no
  derivation can enter this window, which is the entire argument for the layer.
- **The shape gate's window** — a pattern outside the three known shapes. Its
  value is that it fires *instead of* the coverage tests silently weakening,
  which is a failure no coverage assertion can express about itself.

### The sweep clodex asked for: what layers 1–3 flag across the current repo

**No fourth instance.** Swept wider than the test itself — 151 first-party JS
files across every shipped subdirectory, four path-expression forms
(`path.join(__dirname,…)`, `resolve(__dirname,…)`, `__dirname + '/…'`,
`process.resourcesPath`), not just the one the test's regex matches.

Eight trees are referenced. All eight are accounted for:

| tree | referenced by | status |
|---|---|---|
| `renderer/` | main.js, remote-wiring.js, dev-reload.js | ships (`renderer/**/*`) |
| `wire/` | dev-reload.js | ships |
| `plugins/` | engine.js | ships |
| `resources/` | stores.js (library seed tree) | ships |
| `peering/` | ipc-handlers.js | **ships as of this ticket** |
| `build/` | app-menus.js (tray icon) | ships the two named icons — correct, the rest of `build/` is builder-time |
| `vendor/` | wirescope-supervisor.js | EXCLUDED: ships via `extraResources`; python cannot execute from inside the asar, and `:113-117` branches on `isPackaged()` |
| `web-dist/` | web-host.js | EXCLUDED: `createWebHost`'s only non-test caller is `headless-main.js`, which never runs in the DMG (Linux node from a git clone, or `docker/web`) |

The last two are the ones worth stating, because a naive reading of layer 2 would
call them bugs. Both were checked against their actual callers and both are
correct as excluded — and the EXCLUDED table now carries that reasoning inline,
so the next person does not have to re-derive it.

### Artifact verification

Real `npm run dist:mac` on this branch (exit 0), then
`npx asar list … | grep '^/peering/'` → **4 entries**: `README.md`,
`clodex-deploy.sh`, `clodex-seed.sh`, `clodex.service`. Was 0 before this ticket.

Went one step further, as in t38: extracted `peering/clodex-deploy.sh` back out
of the asar and diffed it against source — **identical**. Listing a path proves
the name shipped; only the diff proves `fs.readFileSync` at
`ipc-handlers.js:1159` will now get the right bytes. The Test & Set Up wizard's
ENOENT is genuinely fixed, not just papered over in the file list.

(`asar extract-file` writes into the cwd, so it drops a stray file at the
worktree root — removed, tree confirmed clean.)

## Progress

- [x] Phase 1 — survey, probe, design
- [x] Phase 2 — implement the guard + peering fix + Part 2
- [x] Phase 3 — suite green at 2729, 8 revert proofs, window statements, sweep
- [ ] Phase 4 — artifact verification, report
