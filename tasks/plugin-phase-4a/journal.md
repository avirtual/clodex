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

## T14 — pot-drawer migration (NOT STARTED)

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
