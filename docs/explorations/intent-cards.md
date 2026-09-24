# Intent cards, a glyph vocabulary, and runtime replies without a seat name

Status: design (t1148), base master 6df98e2c. Nothing here is implemented yet.
This builds on `pane-app-view.md` §2.5 and revises it. It does not repeat it.

## 0. Decisions

1. **The `clodex` entry leaves `SYSTEM_GLYPHS`.** This fixes what Bogdan saw.
   The team lead's seat is literally named `clodex`. `classifySender('clodex')`
   (renderer/lib/sender-class.js:32) returns `◆ clodex` for the app's own
   replies, and it returns the same badge for a real `[agent:from clodex]` dm
   from the lead. The confusion is not about wording: the one name stands for
   two parties. Any seat can be called `clodex`, because the name regex allows
   it, so the app's identity must not be a sender name at all. Runtime replies
   become their own record kind, `reply`, with no `from` field (§3). t1144's
   `◆` pin in test/sender-class.test.js:19 and :37 is the only thing that
   depends on the entry.
2. **Parsing moves to the main process. The renderer only paints.**
   transcript-records.js is required by the main process: through
   transcript-spike.js from ipc-handlers.js:33, and never by the renderer. Only
   the main process's intent registry holds plugin rows. The renderer's copy of
   `parseIntent`, the one intent-marks.js requires, has no plugin rows at all.
   So a card built in the renderer would show every plugin verb as
   "won't fire". Segments are therefore computed in transcript-records.js and
   travel on the record (§4). intent-marks.js is left alone and keeps serving
   the xterm overlay.
3. **The greedy body loop is extracted, not copied.** The loop is
   session-manager.js `_extractIntents` (:5113), specifically lines :5128–:5195.
   It depends on `parseIntent`, `fencedLines`, `looksLikeIntent`, `bodyModeFor`
   and `execBodyCap`, and nothing else. Receipt expansion (`_expandReceipts`)
   is a separate pre-pass. So the fallback in §2.5 ("head row only if too
   tangled") is not needed.
4. **A card is a block with a one-line head. The body is optional and clamped.**
   The normal state shows no state word (§2).
5. **Runtime reply: the badge is the verb's glyph plus the verb's label. No name
   is shown.** A reply is painted as a continuation of the intent card when it
   directly follows it (§3).

## 1. Glyph vocabulary

Rules. A glyph must fail both `/\p{Emoji}/u` and `/\p{Extended_Pictographic}/u`.
Every glyph in the table below was checked with node. For contrast, these
tempting choices fail the check: `✉ ⚠ ▶ ✔ ☑ ↩`. Chromium falls back from the
SF stack to Apple Symbols for these code points, and that fallback is a text
font, not the emoji font. The **badge** column gives the `SYSTEM_GLYPHS` sender
this verb must agree with, where one exists. In those rows the card glyph *is*
that sender's glyph. All the `SYSTEM_GLYPHS` choices stay as they are, except
`clodex` (§0.1).

| verb / sub | glyph | label | badge agreement |
|---|---|---|---|
| dm | → | message | — (target named in head; peer target keeps `⇢` on its name) |
| dm … urgent | → | message | — plus an `urgent` chip |
| resend | ⇉ | resend | — |
| who | ◎ | who | — |
| name | @ | name | — |
| context compact | ⊟ | compact | — |
| context clear | ⌫ | clear | — |
| context reload | ↺ | reload | (↻ is reboot: same family, opposite turn) |
| scratch begin | ⌜ | scratch | — |
| scratch end | ⌟ | result | — |
| scratch rewind | ⇤ | rewind | — |
| scratch mark | ⌖ | mark | — |
| scratch cancel | ⊗ | cancel | — |
| memory (all subs) | ◈ | sub word: remember / recall / pin / unpin / forget / list | `memory` ◈ |
| file | ▢ | show | — |
| term | ▤ | terminal | `terminal` ▤ |
| exec | ▸ | run | `exec` ▸ |
| remind (every/in/at/cron/on) | ◷ | remind | `reminder` ◷ |
| remind list / cancel | ◷ | reminders / unremind | `reminder` ◷ |
| shout | ⚑ | shout | — (target is always "you", in the operator's `●` colour) |
| team-review | ◐ | review | — |
| review-done | ⊨ | verdict | — |
| reboot | ↻ | reboot | `reboot` ↻ |
| task add (incl. dup) | ⊕ | file | `ticket-loop` ⇄ |
| task add … start | ⊕ | dispatch | `ticket-loop` ⇄ |
| task assign | ⇥ | assign | ⇄ |
| task start | ⇄ | start | ⇄ |
| task park | ‖ | park | ⇄ |
| task respec | ✎ | respec | ⇄ |
| task reject | ↶ | reject | ⇄ |
| task cancel | ⊗ | cancel | ⇄ |
| task accept | ⤓ | accept (merge) | ⇄ |
| task done | ✓ | done | ⇄ |
| task list | ≡ | tickets | ⇄ |
| team-create, team (all subs) | ⊞ | sub word: role-add / role-set / template-save / prompt-save / template-rm / prompt-rm / sandbox / trunk / set-lead; team-create → create | `team` / `clodex-team` ⊞ |
| spawn | ✦ | spawn | — |
| *reply-only:* intent (interrupted / near-miss bounce) | ⊘ | bounced | — |
| *reply-only:* peers | ⇢ | peers | peer badge ⇢ |
| inert (any line that won't parse) | ⊘ | won't fire | — |
| plugin, no declared glyph | ◇ | verb name | — |

Notes that decide rows:
- **Several task subs share the ⇄ badge.** A `[agent:task] …` reply has no sub
  on it (team-tickets.js:3332 `reply`), so the reply badge is always ⇄. The
  card glyph changes per sub because the lead's add, reject and accept mean
  different things.
- **`⊗` means cancel, whichever family uses it.** It is the same glyph under
  task and under scratch on purpose.
- **`end` and `escape` never render.** `end` is the card's closing edge. An
  escaped `\[agent:…]` line stays prose, backslash included, exactly as it
  reads today.
- **`gh` is not in `CORE_ROWS` at 6df98e2c.** `grep -rn "agent:gh"` only finds
  CHANGELOG.md and test/intent-registry.test.js. If it is a plugin, it declares
  `⎇` (U+2387, which passes the check). If it becomes core, it gets `⎇` with the
  sub word as its label.

**Plugin rule.** `registerIntent` (intent-registry.js:300) takes an optional
`spec.glyph`, which is frozen into the row at :320 as `glyph`.

- **Validation.** The glyph must be exactly one code point, must fail both emoji
  properties, and must not be any glyph in the core table.
- **Invalid values are dropped, not thrown.** Validation falls back to `◇`
  rather than throwing, because a cosmetic field must not quarantine a plugin.
  Log a warning.
- **The label is the verb name.** `spec.label` is the checklist sentence, which
  is too long for a head.
- **git-branches.** It should declare `glyph: '⎇'` for `branch` in
  plugins/git-branches/engine.js:484.

Put the table in one new pure module, `intent-glyphs.js`, at the repo root. It
is main-side and has no deps.
- `glyphFor(intent) → { glyph, label }` covers core rows and falls through to
  `rowFor(type).glyph || '◇'` for plugins.
- `REPLY_GLYPHS` maps reply verbs (the core verbs plus `intent` and `peers`) to
  `{ glyph, label }`.

Test it in test/intent-glyphs.test.js with a literal row per sub, following the
CLAUDE.md table rule: each row states its expected glyph and never looks it up.
Also add a universal assertion that every glyph fails `\p{Emoji}`. That test
must include an `ENTER` check that the set is non-empty.

## 2. The card

Anatomy, revising §2.5:

- **Head.** One line, in the UI font rather than monospace, since there is no
  grammar left to align. It holds the glyph, the label, then the target words,
  then chips.
- **State.**
  - **fire** shows no state word. Every card saying "fired" is noise, and a
    parse only predicts a fire. The adjacent reply confirms it (§3).
  - **inert** shows `⊘ won't fire` on the right in `--warn`, and the body is the
    raw line in monospace. This is the only place brackets are shown: the
    malformed grammar is exactly what the reader needs to see.
  - **filed** replaces the body with `▢ 6.2 KB filed · <title or basename>`, a
    link opened through the existing `linkNode` path. The head is still parsed
    from the stand-in line.
- **Body.** Rendered as prose, clamped to 2 lines with `+ N more lines`, and a
  click expands it. If there is no body (who, name, reboot, task start/park,
  file, spawn, resend), the card is the head row alone.
- **Chrome.**
  - Keep `--surface-raised` and `--radius-md`.
  - Drop §2.5's full 1px border. t1144 already removed the marks' left bar.
  - Use a 2px left rule only for inert (`--warn`) and filed (`--info`). A card
    in the fire state has no rule.

Target words come from the parsed fields, never from the line.
`headOf(intent)` in intent-glyphs.js returns `{ glyph, label, target, chips }`:

| verb | target | chips |
|---|---|---|
| dm | `target` (peer form keeps the `name@box`) | `urgent` |
| task | `id` or `who` (`add hand` → "hand") | `start`, `park`, `dup`, `reviewer:<x>` |
| exec | `cmd` | — |
| remind | `spec` ("in 10m") | — |
| file | `path`, basename, linked | `sub` if not `view` |
| team | `name` | each non-null kv as `key:value` |
| spawn / resend / review-done | `name` / `id` / `id` | verdict |
| shout | "you" | — |
| plugin | none, unless the parse returned a `target`/`name`/`id` | — |

The table reads `KEY_FIELDS`-style field names (intent-scanner.js:152). It is a
presentation map over parse output, not a second grammar.

Examples (┃ marks the rule; the text is what renders):

```
→ message  clodex
  Design saved at docs/explorations/intent-cards.md — glyph table in §1,
  runtime replies in §3 …                                  + 12 more lines

⊕ dispatch  hand   start
  Fix the reply badge: drop `clodex` from SYSTEM_GLYPHS and add the reply …
                                                           + 30 more lines
✓ done  t1148
  Report: design written, five decisions, one open question on gh.

⚑ shout  you
  Merge is blocked on a dirty tree in the shared checkout.

▸ run  clodex-team
  {"action":"roster","agent":"clodex-designer-1148"}      (monospace: exec body is JSON)

◷ remind  in 10m
  Check whether t1147's stream seat landed.

⊟ compact
  Keep: the glyph table decisions and the t1147 dependency.

⎇ branch                                                  (plugin, declared glyph)
┃ ⊘ won't fire
┃ [agent:task done] report without an id                  (inert: raw, monospace)
┃ → message  clodex                                       (filed)
┃ ▢ 6.2 KB filed · msg-87028-6.md
```

**Multi-intent.** Consecutive intent segments, with only blank lines between
them, form one `.intent-stack`. It is one surface with a hairline between
cards, and that makes the lead's usual "dm + task add + task done" reply a
single visual unit. Any non-blank prose line ends the stack. Prose after the
last intent renders below the stack as ordinary prose. That is the
operator-facing tail, and the stack makes it obvious that it was not part of
any body.

## 3. Runtime replies

Take the reply `[agent:task] ticket t1147 created and started → spawning …`.
It renders as:

```
⇄ task   ticket t1147 created and started → spawning …
```

- **Badge.** The badge is the reply verb's glyph and label from `REPLY_GLYPHS`,
  in a new `tr-sender-app` class. It has no avatar disc and uses the muted
  foreground colour, so it cannot be mistaken for a seat, even one whose name
  is a verb. The `title` tooltip reads "Clodex runtime".
- **Continuation.** When the reply record directly follows the assistant turn
  that holds a card of the same verb (nothing between them except that turn's
  tool rows), the reply row gets `tr-reply-attached`. That adds a `↳` lead-in,
  pulls it up against the card, and indents it by the card's inset. This is
  purely positional: no DOM is moved between keyed rows, so the reconcile in
  §4.1 of headless-seats.md stays row-local. If the next turn holds several
  cards and several replies, pair them in order within the verb.
- **Reply order.** Replies arrive in the same order as the intents fired,
  because `_scanJsonlText` loops in that order. If the counts disagree, attach
  nothing.

Why this option and not the others:

- **"◆ clodex" or any app word.** The word is the collision. A glyph with no
  word still needs a meaning, and the verb supplies one.
- **Reparenting the reply into the card.** This gives the best picture, but it
  crosses record boundaries. The reply is a separate `inbound` turn (it is in
  TURN_KINDS), and moving it breaks turn folding (§2.4) and the keyed
  reconcile. Adjacency styling gives about 90% of the reading for none of that
  cost.

## 4. Classifier contract

**New pure module `intent-segments.js`** (repo root, electron-free, requires
only intent-scanner and intent-registry):

```js
// lines: string[]; opts: { execBodyCap: number }
scanIntentLines(lines, opts) → Array<
  | { kind: 'prose', from, to }                      // line index range, half-open
  | { kind: 'intent', from, to, intent, closed }     // intent = parseIntent output with body folded in
  | { kind: 'near-miss', at, text }                  // looksLikeIntent && !parseIntent, outside fences
  | { kind: 'end', at }                              // a bare [agent:end] line
>
```

- **It is the loop at session-manager.js:5137–5195, moved.** Fenced lines
  become prose. JSON-mode bodies grow until `JSON.parse` succeeds or the
  `execBodyCap` byte cap is reached. Greedy bodies run to the next column-1
  intent line other than an escape. `closed === false` is today's `bodyOpen`.
- **`_extractIntents` becomes a thin caller.** It keeps the receipt pre-pass,
  the `spillAt` stamping and the `unknown` aggregation (the `more++` coalescing
  over near-miss segments). Existing session-manager tests are the behaviour
  lock. Run them unchanged before and after.
- **The transcript side gets `execBodyCap`.** engine.js:1266 wires
  `DEFAULT_MAX_BYTES` into session-manager. Export the same constant to
  transcript-records.js, so both sides cut at the same byte.

**transcript-records.js** gains `segmentsOf(text) → Segment[]`, which is
exported and used by `assistantRecords` (:178):

```js
Segment =
  | { kind: 'prose', text }
  | { kind: 'intent', verb, sub, fields, body, state: 'fire' | 'filed', spill, open }
  | { kind: 'inert', text }            // raw line, for the ⊘ card
// fields = the parse minus type/sub/body; spill = { path, bytes, title } | null
```

- **State.** `state: 'filed'` is set when `pointerMatch(intent.body)`
  (intent-spill.js, already exported) matches the stand-in. Then `body` is
  null and `spill` comes from the FILED_POINTER_RE groups. A `receiptOf(line)`
  hit (the `(I sent …)` form) also becomes a filed card, with the head taken
  from `rc.head`.
- **Prose pointers.** A bare `FILED_POINTER_RE` line with no intent head (a
  spilled prose tail) becomes a prose segment that carries `spill`. It renders
  as a filed chip, not a card.
- **Which records get segments.** They are attached only when the text holds a
  line where `looksLikeIntent` passes or `FILED_POINTER_RE` matches. Records
  that are all prose keep their exact current shape, so existing
  deepStrictEqual fixtures stay valid.
- **Caps.** Segment on the uncapped block text. Then cap each prose or body
  string at PROSE_CAP, sharing the budget across the record, and set
  `truncated` on the record as now.
- **Runtime replies.** RUNTIME_RE (:11) becomes `/^\[agent:([a-z-]+)\][ \t]*/`,
  which captures the verb. The closing bracket is required: every
  `_injectText` reply head is a bare `[agent:<verb>]`, and plugin replies use
  `[agent:${intent.type}]`, whose glyph comes from `glyphFor`. The emission at :172 becomes
  `{ ...base, kind: 'reply', verb, text: rest }`, with `rest` capped at
  PROMPT_CAP. Add `'reply'` to TURN_KINDS (:9), since it is a turn exactly as
  inbound was. The test at test/transcript-records.test.js:155 is rewritten to
  the new shape.

**renderer/transcript-rows.js**:
- The `assistant` case (:261) branches on `rec.segments`. If segments are
  present, it runs a new `appendSegments(doc, row, segs, ctx)`, which builds
  stacks and cards and calls `appendLinked` for prose. If they are absent, it
  uses the current `appendProse`.
- `appendProse` (:83) stays, because typed prompts use it, but its
  intent-marks call is only for prompts now.
- A new `case 'reply'` builds the §3 row, and it also needs the `tr-reply-attached` pass.
- **Adjacency.** It is computed in `createTranscriptRows`'s list build, from the
  previous record run. A row builder only sees one record at a time.
- **Where the glyph comes from.** The renderer never calls `glyphFor`. The
  head (`{ glyph, label, target, chips }`) is computed in main by `headOf` and
  carried on the segment as `head`. That keeps plugin glyphs correct, and it is
  what lets `intent-glyphs.js` stay main-side.

**sender-class.js**: delete `clodex: '◆'` (:15), and update the pin at
test/sender-class.test.js:19/:37. After that, `classifySender('clodex')` falls
through to the seat branch and returns `C clodex`, which is what the lead seat
is.

## 5. Sequencing

**Ticket A: one hand ticket, which can start now, independent of H1.** Every
pane record today comes from the file (`transcript:pull`), and all of this
works on file-backed records:

1. Extract `intent-segments.js` and make `_extractIntents` its caller. Keep the
   session-manager suite green with no test edits. This is its own commit,
   because it is move-only.
2. Add `intent-glyphs.js` and its table test. Add the `glyph` field to
   `registerIntent`, and declare `⎇` in git-branches.
3. In transcript-records.js, add `segmentsOf`, the `reply` kind and the
   RUNTIME_RE capture.
4. In transcript-rows.js, add cards, stacks and reply rows, plus the adjacency
   pass. Add the CSS in renderer/styles.css.
5. In sender-class.js, remove `clodex` and update the pins.
6. Housekeeping:
   - Run `npm run build:web` if transcript-rows is in the web bundle
     (test/web-dist-fresh.test.js will say).
   - New modules ship with zero comments (comment-ratchet), and any facts go in
     `docs/notes/intent-segments.md`.
   - Check whether test/free-identifier-leaks.test.js needs the new modules in
     SCANNED_MODULES. They are pure leaves with direct requires, like
     clodex-paths.js, so probably not, but confirm.
   - Update the module map in docs/architecture.md and the `## Unreleased`
     section of CHANGELOG.md.
7. Do a visual pass on a real transcript at 13px: the lead's three-intent reply,
   a filed dm, a plugin verb, and an inert line. Screenshot it for review. The
   emoji test proves no emoji. It does not prove that `⌖ ⌜ ⌟ ⤓` are legible.
   Swap any that are not, and keep the test row literal.

**What waits for H1 (t1147, the stream seat).** Once the stream seat lands, the
live rows are painted from wire deltas, keyed `messageId:blockIndex`, before the
file catches up:

- Segments on partial text. A card whose body is still streaming renders
  `open: true` as "writing…" in place of the clamp footer. `segmentsOf` already
  returns `closed:false` for this, so it only needs a caller on the overlay.
- A keyed reconcile check that swapping in the file record does not reflow a
  stack when the segment count is unchanged.
- Reply adjacency when the reply lands before the file record for the turn. It
  pairs on the reconciled rows, so it can wait.

**Unchanged in both phases:** the pty seat's xterm overlay. intent-marks.js,
`classifyRows` and the `.intent-mark-*` terminal marks are untouched.

## 6. Risks and open questions

- **A body split across two text blocks.** `assistantRecords` emits one record
  per text block (:183). If the model breaks a text block inside an open body
  (rare, and in practice only around a tool call), the first card is `open` and
  the tail is prose. The real scan joins a whole turn, so it would disagree.
  This is acceptable for v1, and the open card shows it honestly. The fix is to
  segment per assistant run instead, which needs H1's turn keys.
- **The fire state ignores the seat gate.** A verb that parses but is
  gated off for the seat (`intentEnabledForSeat`, intent-registry.js:431)
  shows no warning, and its bounce reply follows it. Carrying the gate onto the
  record would need the seat entry in transcript-records. The recommendation is
  not to do this: the adjacent `⊘ bounced` reply says it. It is open if Bogdan
  wants the card itself to warn.
- **Pre-existing, out of scope.** The renderer-side `parseIntent` has no plugin
  rows, so the xterm overlay marks every plugin intent as `inert` today. Fixing
  it means sending plugin verb heads to the renderer. That deserves its own
  ticket.
- **`gh`: core or plugin?** The answer decides where `⎇` is declared (§1).
