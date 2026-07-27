# t60 — render what actually changed, and stop calling compacts busts

Branch `bust-panel-divergence` off master `a15e2d3`.

Two defects in `renderer/lib/render-html.js` `bustRow` (78-108). Clodex-side
only; no wirescope change, no re-vendor, no new state.

## Phase 1 — what `/_bust` actually returns (verified against live data)

Session `a68b0455-…` on `http://127.0.0.1:7800/_bust`: 3488 transitions, 69
busts — tools 4, conversation 22, preamble 39, system 3, lapse 1. Matches the
ticket's counts exactly.

Locus keys observed across the 69: `segment, index, label, appended` always;
`role, block, char_offset, old, new` only for text-diff loci.

| class | `old`/`new` | `char_offset` |
|---|---|---|
| tools (4) | **absent** | absent |
| lapse (1) | locus is `{}` entirely | absent |
| conversation (22 sampled) | present but **`''`** | present |
| system (3) | present, 80 chars | present |
| preamble (39) | present, 40–80 chars | present |

So the "degrade gracefully" case is three distinct shapes, not one: no locus at
all, a locus with no `old`/`new` keys, and a locus whose `old`/`new` are both
empty strings. All three must produce today's row. (The ticket predicted the
tools shape; conversation is a fourth population with the same requirement.)

## Phase 2 — the compact predicate (defect B)

Both compact shapes, in the data:

- **collapse** — 30 of 39. `prev_messages` 152–386 → `cur_messages` 4 or 7.
- **tail append** — 8 of 39. `prev_messages` N → N+1 (once N→N+4), with
  `old` = `"…break never happened."` and `new` = the same **plus `"\n"`**.
- **neither** — exactly 1 (turn 1090), which is the genuine one: label
  `messages[0].user claudeMd bundle`, `restart_between: true`, and its `old`/
  `new` show the CLAUDE.md `cli/deploy/` paragraph being inserted. That is a
  real static-bundle edit and must stay actionable.

### Signal chosen, and why

**Primary: the block label.** `_block_label` (report.py:1020-1038) tags
`messages[0]`'s diverging content block, and the tag rides inside `loc.label`
as `messages[0].<role> <tag>`. The vocabulary is closed: `claudeMd bundle`,
`currentDate`, `system-reminder`, `thinking`, `tool_use:*`, `tool_result`,
`text`. Every injected static-context block gets a *named* tag; only the
operator's own prose falls through to the generic `text`.

That is the semantic split the ticket is asking for. `messages[0]`'s own text
is the first user turn — it cannot change during a session by any mechanism
except the thread being rewritten under it (`/compact`, `/clear`). A change in
a *named* block is the static bundle moving, which is exactly what
`fix_hint` is about. All 38 compacts label `text`; turn 1090 labels
`claudeMd bundle`.

**Corroborating: the shape must also be a compact shape** — either the
contraction wirescope itself uses (`cur <= prev * 0.5`, the client-side twin of
`BUST_COMPACT_MSG_RATIO`, warmth.py:248) or a pure tail append
(`new.startsWith(old) && new.length > old.length`).

Both clauses are required. The label says *what* moved; the shape says the
thread was rewritten. Requiring both means mislabelling a real bust as inherent
takes two independent signals being wrong at once — and the failure direction of
each clause alone is the safe one (fall through to today's actionable row).

Note on the tail-append test: `_text_first_diff` (report.py:980-990) returns
`i = len(x)` when `x` is a pure prefix of `y`, so in that case — and only that
case — the 40-char `old` window is genuinely a prefix of the `new` window. For
an insertion in the *middle* of a block the two windows diverge at the offset
and `startsWith` is false. So this clause means specifically "the block's text
was appended to", which is the `/compact` local-command marker shape.

Verified: predicate fires on 38 of 39, and not on turn 1090.

### Rejected

- **Message-count delta alone** — the ticket already rules it out, and the data
  agrees: shape 2 is `N -> N+1`, indistinguishable from a normal turn.
- **`restart_between`** — turn 1090 is the only preamble bust with it set, and
  it is the *actionable* one. Orthogonal signal; already spoken for by deployTax.
- **Contraction alone** — misses the 8 tail-append compacts (23% of a real
  session's preamble rows).

## Phase 3 — the changes

| Defect | Change |
|---|---|
| A | `-`/`+` block from `loc.old`/`loc.new`, both through `esc()`, newlines rendered as a visible glyph; `char_offset` shown when present; nothing rendered when both are empty/absent |
| B | `inherentCompact` → calm fault remap + badge + suppressed hint, following the existing `deployTax` pattern at :89-92 |

Precedence when a compact also straddles a restart: the compact badge wins (a
restart does not stop it being a compact) and only one badge renders.

## Phase 4 — tests

`test/renderer-render-html.test.js`, new. `esc()` needs a real `document`, which
this module's header says keeps it untested — so the file installs the same
minimal `global.document` stub other renderer tests already use
(`api-shim.test.js:58`, `plugin-host.test.js:133`) and the header comment is
updated to say so. That is the one structural addition; flagged.

Pins, each with the ENTER question asked separately:

- (a) `<`, `&`, backtick and `\n` in `old`/`new` are escaped, do not break out
  of the markup, and the newline is visible rather than a layout break.
- (b) absent locus / locus without `old`/`new` / both-empty (the tools and
  conversation shapes) → today's row, no empty diff block.
- (c) a compact-shaped transition (both shapes) → inherent badge, no generic hint.
- (d) a non-compact preamble transition (turn 1090's shape) → no badge, hint present.

## Phase 5 — reverts (each fails BY MESSAGE; pristine restored between)

| Revert | Fails | Message |
|---|---|---|
| A: `bustSnip` passes bytes through instead of `esc()` | (a) | "a `<script>` tag from a captured request body must not reach the markup verbatim…" |
| B: render the diff block unconditionally | (b) | "tools: a locus carrying no text must render no diff block…" |
| C: `inherentCompact = false` | (c) ×2 | "collapse: a /compact necessarily rewrites messages[0]…" |
| D: drop the label clause from the predicate | (d) | "a named static-context block changing is an actionable edit even across a contraction…" |
| E: drop the `appendedTail` clause | (c) | "appended markers: a /compact necessarily rewrites messages[0]…" |

D and E are the two halves of the predicate, reverted separately, so neither
clause can rot into decoration.

## Phase 6 — checked against the live session

Ran the real `bustRow` over all 69 busts of `a68b0455-…`:

- preamble: **38 inherent, 1 actionable — turn 1090**, exactly the ticket's
  expected outcome ("no preamble row should present as actionable").
- diff block rendered for: preamble 39, **system 3** (the three now read as
  `ipc-prompt.js` text changes with the inserted text visible, as the ticket
  predicted). Not rendered for: tools 4, lapse 1.
- no compact badge leaked onto any non-preamble class.

## Phase 7 — result

- `test/renderer-render-html.test.js`: 8 pass, new file.
- `test/free-identifier-leaks.test.js`: 83 pass.
- `npm run build:web` re-run (render-html.js and styles.css are both bundled).
- Full suite: **2893 pass, 0 fail, ESCAPES: 0** (baseline 2885 + 8).

## Flags

1. **The label clause is not load-bearing on this session's data.** Dropping it
   (revert D) leaves the live split unchanged at 38/1 — every compact here also
   contracts or appends, and turn 1090 does neither. It earns its place as a
   second, independent signal (the ticket asked for a predicate that does not
   mislabel real busts, and a single-signal one is a guess), and pin (d)'s
   "shape only" case pins it against a bust that contracts *and* touches a named
   block. But it is redundant on this evidence. Say the word and it comes out.
2. **`test/renderer-render-html.test.js` installs a `global.document` stub** —
   the first test to exercise this module, whose header previously said it stays
   untested for exactly that reason. No jsdom: it is the same hand-rolled shape
   `api-shim.test.js:41` and `plugin-host.test.js:133` already use, with one
   deliberate difference — the stub's `textContent`→`innerHTML` really escapes
   `& < >`, because a pass-through stub would make the XSS pin vacuous. Module
   header updated to say the module is now partly tested.
3. **`renderer/styles.css` touched** (three new rules: `.bust-diff`, `.bust-at`,
   `.bust-nl`) and `web-dist/index.html` rebuilt. The ticket said "no new state",
   which I read as no new runtime state rather than no styling; a diff block with
   no CSS would render as unstyled wrapped prose. Flagged as an addition beyond
   the two files named.
4. **A one-sided divergence renders.** The guard is `old || new`, not
   `old && new`, so a truncation (one window empty) still shows. Only both-empty
   means the locus located no text. Not specified either way; this is the
   reading that loses no information.
5. The ticket's "decide the predicate yourself, or conclude none exists" —
   a reliable predicate **does** exist and is implemented. Not the no-predicate
   outcome.
6. **The first full-suite run was RED on `web-dist-portable.test.js`** — not a
   t60 logic failure, but exactly the hazard that test exists for: `npm run
   build:web` in this worktree makes esbuild write its inlined-module markers
   relative to the build dir, so all 9 read `../wb-wrap-ui/node_modules/…` and
   name the original checkout. Fixed by rewriting the prefix to bare
   `node_modules/` after the build. Proved that is the *only* worktree artifact
   rather than assuming it: rebuilt with master's sources checked out,
   de-prefixed, and compared to the bundle already committed at `a15e2d3` from
   the repo root — **byte-identical**. So the committed bundle is what a root
   build produces.
