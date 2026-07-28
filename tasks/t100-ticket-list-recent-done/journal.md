# t100 — default board shows recently-closed context, capped, done counted separately

Branch `ticket-list-recent-done` off master `284cbcc` (v4.9.0). Ticket verified
in `~/.clodex/teams/clodex/tickets.json`: id `t100`, state open, assignee
`clodex-hand`, opener `clodex`. Dispatch confirmed by registry read, not by the dm.

## Premise check (standing rule — 3 of 4 registry-cluster tickets had premise defects)

Both cited line numbers verified at source on this tree.

| Ticket claim | Source | Verdict |
|---|---|---|
| `session-manager.js` `_taskList` at `:5087` | `_taskList(session, team, teamDir, intent, reply) {` is exactly `session-manager.js:5087` | CORRECT |
| `scripts/clodex-team.js` `doTickets` at `:318` | `function doTickets(payload) {` is at `:313`; `:318` is `const filter = payload.filter \|\| 'open';` — the first line of the listing logic proper | CORRECT ENOUGH, flagged |
| the not-shared-code comment at `session-manager.js:5082-5086` | verified verbatim: flat basename copy into `run/bin/`, node builtins only, "Change both together." | CORRECT |

The `:318` reference lands five lines into the function rather than on its
signature. Not a defect — it resolves to the code the ticket is about — but
recording it because t98's whole point is that a reference landing *somewhere*
is not the same as landing on the right thing. Here the neighbourhood is right.

Additional facts established at source (not in the ticket, load-bearing for the build):

- `TICKET_FILTERS = ['open', 'done', 'cancelled', 'all']` is duplicated in both
  files (`session-manager.js:183`, `scripts/clodex-team.js:159`) for the same
  flat-copy reason. Precedent: duplication here is the settled position.
- `closedAt` is written by BOTH close verbs — `_taskDone:4990` and
  `_taskCancel:5055` — with `closedBy` and `lastActivityAt` alongside. So the
  24h window has a real field to read on both states; restricting the recent
  section to `done` is a deliberate filter, not a data limitation.
- The two tails ALREADY differ in wording today: session-manager says
  `[agent:task list done]` (intent syntax), clodex-team says
  `ask for filter "done"` (payload syntax). Byte-identical output is therefore
  NOT the parity property — each names the query in its own caller's vocabulary,
  which is correct. Parity has to be over the *content*: which tickets appear,
  in which section, and the counts.
- `_taskList` does not read `session` at all, so it can be driven directly with
  a plain team object and a `reply` callback — no PTY harness needed.
- `doTickets` is already driven end-to-end by subprocess in
  `test/clodex-team.test.js` (`launch()` + fake `CLODEX_HOME`).

Both implementations are therefore executable from tests, which means the
divergence pin can be BEHAVIOURAL (run both, compare content) rather than
structural. That is the stronger form and the ticket says this pin matters most.

## Existing tests that constrain the change

`test/session-manager.test.js:3585-3696` — the t80 block, `mkBoard()` fixture
(t1 open, t2 done, t3 cancelled). Two of these assert the CURRENT tail:

- `:3643` `assert.match(out, /\(2 closed —/)` — will break under the split tail.
- `:3695` `assert.match(out, /\(3 closed —/)` — same.

These are t80's pins and the ticket explicitly changes what they pin, so
updating them is in scope. Read what each is asserting before editing it: they
assert the COUNT is stated and the QUERY is named, which both survive the split
in a different shape. Do not delete either property, only its wording.

`:3599` and `:3662` assert `!/closed —/` — no count line when nothing is hidden,
and none on an explicit filter. Both must survive verbatim in meaning.

## Plan

1. Product: both implementations, same commit (they must change together).
2. Tests: cap, 24h boundary, done/cancelled split, explicit filters unaffected,
   plus the behavioural parity pin.
3. Revert-prove every assertion by message.

## Log

- Premise check complete, both references good. Branch cut, task dir created.

## Build

Product commit `82334d4`, both implementations together.

- `session-manager.js` — `RECENT_DONE_MS` / `RECENT_DONE_CAP` next to
  `TICKET_FILTERS`; `_taskList` grows a `recently closed:` block (done only,
  window, newest first, capped) and a tail counting done and cancelled apart.
  Both ride the default view only, including the no-open branch.
- `scripts/clodex-team.js` — the same, constants duplicated with the same
  flat-copy rationale, tail phrased in payload vocabulary.

One judgment call not in the spec, flagged: the recent rows print
`closed 2h ago` instead of the open-age column. The section sorts by `closedAt`,
and a list ordered by a number it does not display reads as arbitrary — a
ticket opened 5d ago but closed an hour ago would sit above one opened an hour
ago with nothing on screen explaining why. Reversible; say the word and it
reverts to the plain row.

## Tests

`test/session-manager.test.js` — six new t100 tests over an `mkAged` fixture that
writes `closedAt` DIRECTLY. Driving `_handleTask` cannot place a close 25h in the
past (the close verbs stamp `Date.now()`), so a test built on it could not enter
the window it names at all.

`test/clodex-team.test.js` — three behavioural parity tests. Both
implementations run over the SAME registry and their renderings are reduced to
the facts they must agree on (rows, section marker, tail numbers) and compared.
Content, not bytes: the two tails name the query in their own caller's
vocabulary, so byte equality would fail on correct code and the pin would be
worthless. `listingFacts` keeps row ORDER, which the instrument check below
proves is not decorative.

### t80 pins updated, not repaired

Four of t80's assertions collided. Read what each ASSERTS before touching it:

- `:3643` `(2 closed —` and `:3695` `(3 closed —` → the split counts. Property
  unchanged (the count of what is hidden is stated); only its shape moved.
- `:3599` / `:3662` `!/closed —/` → `!/\d+ done, \d+ cancelled/`. **This is the
  important one.** `closed —` no longer occurs in ANY tail, so leaving those
  two as-is would have left checks that pass whatever the code does — green,
  and pinning nothing. That is the t78 lesson (an assertion whose polarity the
  broken case also satisfies) arriving as a *side effect of someone else's
  change* rather than as a bad assertion.
- `:3639` `!/t2 \[done\]/` → INVERTED deliberately. t80 asserted the done ticket
  was hidden outright; t100 shows the last 24h of it on purpose, and `mkBoard`
  closes t2 a millisecond ago. Not repaired to pass: the property t80 owns (the
  board is not a wall of closed tickets) is pinned by the cap and window tests,
  and the same test still asserts the done row is NOT in ordinary open-list
  format, so a done ticket leaking into the main list would still fail.

## Revert proofs

Restored from md5-verified `cp` copies every time (`session-manager.js`
`d39dd2bd…`, `scripts/clodex-team.js` `3cc7391f…`), `git diff` after each. No
revert was a no-op. Every failure is an AssertionError with its own message —
no crash, no SyntaxError, no timeout.

| # | Revert | Result |
|---|---|---|
| A | `recent = recentAll` (cap removed) | 1 fail — "exactly the cap is rendered, not all 13" |
| B | window filter → `t.closedAt` only | 1 fail — "a close 25h old is NOT in the recent section" |
| C | `recentAll = closed` (cancelled leaks in) | 2 fail — "the equally-recent cancelled one is not" + the t80 cancelled pin |
| D | tail → `${closed.length} closed` | 6 fail — "the two numbers are separate", "the tail counts BOTH", "and the full done count is still there", plus both updated t80 pins |
| E | `closed` unconditional (leaks onto filters) | 2 fail — "no recent section — the caller chose the slice" + the t80 filter pin |
| F1 | leaf `RECENT_DONE_CAP = 5` (one file edited) | 1 fail — "the two listing implementations drifted" |
| F2 | leaf `recentBlock = ''` (forgot the other file) | 2 fail — drift + "the no-open reply paths drifted" |

D failing SIX tests is the useful signal: the tail is read by both the t80 pins
and four t100 assertions, so it is the most load-bearing line in the change.

### Instrument check on the parity reducer

`listingFacts` throws bytes away, which is the whole point — and also the way it
could quietly become a check that cannot fail. So: sorted the LEAF's recent
section ascending. Same tickets, same counts, same section header, same cap —
**only the order differs**, which is precisely the drift a lossy reducer would
miss. It failed. The reducer sees row order, not just membership.

Worth stating why this mattered: F1 and F2 both change WHICH rows appear, so
either would pass for a reducer that only compared sets. The order case is the
one that discriminates, and it is the case a reducer built for convenience would
have dropped.

## Sizing note — SUPERSEDED, IT WAS WRONG

This section originally reported the board at "2723 bytes / 26 lines under the
exec def's maxBytes: 4096" and called the cap comfortable. **Both halves are
wrong.** `maxBytes` (`exec-schema.js:175-182`) caps the INBOUND payload and never
touches the reply. The real limit is the last stderr line sliced to 200 chars
(`session-manager.js:3838`). I cited a margin that does not exist on a limit that
does not apply. Corrected in the rework section below; left visible rather than
deleted, because the shape of the error is the useful part — I measured a real
number against the wrong constant and the number made the claim look grounded.

## REWORK (cold review, clodex-reviewer-1)

Three claims defective, code sound. Verified each at source, and the load-bearing
one by measurement.

### 1. The exec caller receives ONE LINE — measured, not inferred

`session-manager.js:3838` is `stderr.trim().split('\n').pop()` then
`.slice(0, 200)`. Pinned at `test/session-manager.test.js:4231-4243`.

Ran the real script over a real board through that exact discipline:

```
--- full stderr the script writes ---
team proj tickets:
t1 [open] hand 2d — still open
recently closed:
t2 [done] hand closed 1h ago — recent 0
t3 [done] hand closed 2h ago — recent 1
t4 [done] hand closed 3h ago — recent 2
(3 done, 0 cancelled — ask for filter "done", "cancelled" or "all")

--- what the caller actually gets ---
clodex-team: (3 done, 0 cancelled — ask for filter "done", "cancelled" or "all")
```

**No head, no rows, no recent section.** The reviewer is right, and the scope is
wider than t100: the ENTIRE tickets listing has been one line over exec since t80
shipped. t100 did not break this — t100 added a feature exec callers cannot see,
and then named a test as though they could.

`sizing note` above is WRONG and is corrected below. `maxBytes: 4096`
(`exec-schema.js:175-182`) caps the INBOUND payload; it never touches the reply.
The real cap is the last line, 200 chars. My note claimed a margin that does not
exist on a limit that does not apply.

### 2. Fixes applied

**Claim scope corrected.** `scripts/clodex-team.js` header and
`test/clodex-team.test.js:204` now say the parity is over what the two functions
RENDER, and state explicitly that an exec caller receives the tail line only.
The parity test's name says the same. The tests still pin a real property — the
intent path renders in full, and the two functions must not diverge — but they
no longer stand in for a feature nobody gets.

**Stale-notice ordering.** `staleHostLine()` now precedes the tail in
`doTickets`. Flagged as a TRADE, not a fix, in the code: one line cannot carry
two messages, so the notice is now what gets dropped instead of the counts. I
chose the counts because they are the listing's whole payload over exec and the
notice has a second surface (`doRoster`, deliberately untouched). If the reply
ever goes multi-line, both come back and the choice evaporates.

**Cancelled counted directly** (`t.state === 'cancelled'`) instead of
`closed.length - doneAll.length`, in both implementations.

### 3. The nits produced two findings

**The boundary pin's first revert was a NO-OP.** Moving `RECENT_DONE_MS` from 24h
to 20h left the whole t100 block green — including the boundary test I had just
written to catch exactly that. Cause: the test scrapes the constant from source,
so moving the constant moves the fixture with it. The test pins that the FILTER
agrees with the DECLARED constant, not that the constant holds any particular
value. That is the more useful property (a hardcoded 24h in the test would drift
against a renamed or recomputed constant), but it is not what my comment claimed,
and I would have shipped the wrong claim if I had not reverted. Re-proved with
A2 (filter hardcoded to 20h while the constant stays 24h) and A4 (cutoff shifted
2 minutes): both fail by message.

A3 is worth recording as a deliberate non-catch: flipping `<` to `<=` passes.
The pin brackets the boundary at ±60s and says nothing about which side owns the
exact millisecond. Correct — a test asserting the inclusive/exclusive edge of a
24h window would be pinning a coincidence, and a ticket closed at exactly
86400000ms ago is not a case anyone has an opinion about.

**The cancelled fix had no test until I wrote one.** The subtraction only
misbehaves when a state exists that is neither open nor done, and there is no
such state today, so nothing in the suite could see the difference — I verified
by hand that the reverted code prints "2 cancelled" for a board carrying a
`superseded` ticket. Added a test whose fixture invents that fourth state
(written directly, since no verb can produce it). Revert B2 restores the
subtraction and it fails by message.

### Rework revert table

Restored from md5-verified `cp` copies (`session-manager.js` `896de7fa…`,
`scripts/clodex-team.js` `8f919fdc…`). All non-no-op reverts fail by message.

| # | Revert | Result |
|---|---|---|
| A | `RECENT_DONE_MS` 24h → 20h | **NO-OP — 8 pass. A finding; see above.** |
| A2 | filter cutoff hardcoded 20h, constant left 24h | 1 fail — "a close one minute inside the window is shown" |
| A3 | `<` → `<=` at the boundary | no-op, DELIBERATE (the pin does not claim the exact edge) |
| A4 | cutoff shifted `- 120000` | 1 fail — same message |
| B | subtraction restored, probed by hand | prints "2 cancelled" for a 4-state board (no test existed) |
| B2 | subtraction restored, with the new pin | 1 fail — "one cancellation, not two" |
| C | stale notice back after the tail | 1 fail — "the counts survive as the delivered line" |

### What I take from this round

The reviewer's three findings were all about CLAIMS, not code — a test name, a
comment, a journal note. All three would have read as true to someone who did
not go to the delivery layer. That is the same failure as t101's report defect
and t96's header, and it is now four instances: the code was right every time
and the sentence describing it was wrong. Prose about behaviour needs a
measurement behind it exactly as much as a test does.

## THIRD PASS (cold review, must-fix + nits 1-3)

### The must-fix is the branch's own defect class, committed fresh

`scripts/clodex-team.js:328-329` and `test/clodex-team.test.js:220-221` cited
`test/session-manager.test.js:4231-4243`. Verified at source: that range holds
the filename-token/traversal-guard block. The intended test —
`_handleExecIntent: replyStderr:true → clean exit + stderr injects the tail back`
— **was at 4231 on master and sits at 4280 here**, because `e821661`'s own
additions to that file pushed it 49 lines down. The citation was invalidated by
the same commit that wrote it.

Both now cite the test by NAME with no range. This is the sixth instance of the
pattern and the first where the rot was same-commit rather than same-week.

Second defect in that sentence: **"sliced to 200 chars" is pinned by nothing.**
The named test's stderr is `811/811 green` — 14 chars — and nothing in the suite
feeds the dispatcher a line long enough to cut. Grepped the suite to confirm.
The comment now splits the claim: the last-line rule is pinned by the named
test, the slice is unpinned, said in those words. Half a guarded sentence reads
as fully guarded.

### Nit 1 — the literal that revert A proved could go false

Both files rendered `in the last 24h` while the window is `RECENT_DONE_MS`, and
first-pass revert A had already proved that moving the constant leaves the whole
suite green with the sentence unchanged. That is worse than a stale comment: it
is a USER-FACING statement that becomes false silently.

Added `RECENT_DONE_LABEL`, derived from the constant, in both files.
Verified by moving the window to 20h: the tail now reads
`+3 more done in the last 20h`. The parity reducer's tail pattern was widened to
`\d+h` so it does not re-pin the literal it just removed.

### Nit 2 — the leaf's window was unpinned, and I confirmed the gap

The behavioural parity tests cannot see a window divergence: `parityBoard` puts
closes at 1-12h and 30h, so any leaf window in ~[13h,29h] renders identically.
Measured it — set the leaf's `RECENT_DONE_MS` to 20h and skipped only the new
constant test: **18 pass, 0 fail.** The cap is different (F1 caught a cap
divergence) because the fixture straddles it.

Added a scrape-and-compare over both `RECENT_DONE_MS` and `RECENT_DONE_CAP`,
same idiom as the digest grammar and `TICKET_FILTERS`. With it, the 20h leaf
fails by message.

### Nit 3 — the reducer swallowed unrecognized lines

`listingFacts` fell through silently on any line matching none of its three
shapes, so an EXTRA line in one implementation was invisible. My first-pass
instrument check covered ORDER and not this.

Measured: injected a bare extra line into the leaf's output and ran the OLD
reducer — **19 pass, 0 fail**, full parity reported while the two renderings
differed by a whole line. With `OTHER|<line>`, the same injection fails two
tests.

The deliberate drops are now named individually (each head shape, each no-open
sentence, the stale notice) rather than caught by a loose `/tickets/` match. My
first attempt used exactly such a loose pattern and it silently ate the intent
path's head; the reducer went red and I read the failure before assuming it was
a real drift, which it was not. A drop-list that is too generous is the same
defect as no drop-list at all, one layer down.

### Third-pass revert table

Restored from md5-verified `cp` copies (`session-manager.js` `b7b3eed0…`,
`scripts/clodex-team.js` `2410f71b…`, `test/clodex-team.test.js` `682a7f27…`).

| # | Revert | Result |
|---|---|---|
| A | leaf `RECENT_DONE_MS` → 20h | 1 fail — "RECENT_DONE_MS drifted between the two implementations" |
| A′ | same, **new constant test skipped** | **18 pass 0 fail — the gap nit 2 named, reproduced** |
| B | extra line injected into the leaf's render | 2 fail — both parity tests |
| B′ | same injection, **old reducer restored** | **19 pass 0 fail — the gap nit 3 named, reproduced** |
| C | window → 20h, both files | tail renders "in the last 20h" — the sentence follows the constant |

A′ and B′ are the ones worth keeping: each shows the pre-fix code green under
the exact condition the reviewer described. Agreeing with a review is not the
same as verifying it.

## FOURTH PASS — and the rule that ends the cycle

### FIX 1: the doc, the only product-visible defect in four passes

`resources/library/prompts/system/clodex-team-lead.md:60-61` still described the
old board: "the OPEN board, plus a count of the closed tickets it hid." The board
renders up to 10 closed rows now. t80's journal established that line as the doc
site for this verb; t100 had no doc phase, which is the actual miss.

Reworded WITHOUT a window literal or a cap literal — "the tickets closed most
recently (a capped handful, so it stays short)". A prompt file derives nothing,
so any number written there is a claim that cannot track its source. The reviewer
flagged this in advance and was right to: my instinct was to write "the last 24h,
up to 10", which would have planted the next finding.

### FIX 2: two demonstrated false greens

`test/session-manager.test.js:3820` hardcoded `24h` — in the same file whose
policy comment two tests up says a literal would keep passing if the constant
moved. Built from the scraped constant now.

`test/clodex-team.test.js:245` matched `\d+h` and threw it away, so a leaf at 20h
and an intent at 24h reduced to identical facts. Measured: with the constant test
skipped, that divergence was **17 pass, 0 fail** on behavioural parity. The
window is captured into the `TAIL|` fact now, and the same divergence fails.

That is the second time in two passes that a pattern I wrote to avoid pinning a
literal instead stopped checking the thing entirely. Matching past a value and
discarding it is not the same as not depending on it.

### THE DELETION RULE

`session-manager.js:3838` was cited in two live places and had gone stale by
exactly the six lines THIS BRANCH's third pass added — the third same-commit
citation rot, and this time in live code rather than a comment about tests. Not
re-pointed. **Deleted.** The surrounding sentences lose nothing: "the dispatcher
delivers only the LAST stderr line" is the whole claim, and the file name alone
is enough for anyone who wants to look.

Also deleted rather than corrected:
- "14 chars" — it is 13, and wrong under every reading. The substantive claim
  (far under 200, therefore unpinned) survives without a count.
- the `pot-bin.js` seeding attribution — the adjacent ENTER comment already
  states the mechanism correctly, so the sentence was redundant as well as
  wrong. Corrected the one remaining reference to name `seedLibraryDefaults`
  rather than a line number.

**A claim that has rotted once gets deleted, not corrected. Correcting it
re-arms it.** Every one of these had already been fixed at least once in this
branch, and each fix is what put the next wrong version in place. The only
version that cannot rot is the one that is not there.

### The two reducer nits

Blank lines were being dropped with the deliberate ones. Both implementations
build one string with no blank separators, so a blank means a separator appeared
on one side only. Now emitted as `BLANK` — verified it fires by injecting one
into the leaf, which fails two tests.

Zero-ticket sentences ("no tickets" — empty registry) were being swallowed by
the no-open patterns, which are a DIFFERENT branch. Named separately and
anchored with `$`, so an implementation taking the wrong branch surfaces as
`OTHER` instead of matching a pattern broad enough to cover both.

### Fourth-pass reverts

| # | Revert | Result |
|---|---|---|
| A | blank separator injected into the leaf | 2 fail — the BLANK fact fires, so the branch is reachable |
| B | leaf window 20h, **constant test skipped** | 1 fail — behavioural parity now catches it (was 17 pass 0 fail before the capture) |
| C | `RECENT_DONE_MS` → 20h | cap test still passes — it tracks the constant, as intended |
| C2 | filter cutoff diverged from the constant | 1 fail — "a close one minute inside the window is shown" |

## The four-pass tally

Ten defects across four passes. **Every one in prose — a comment, a test name, a
journal note, a doc line, a citation. Zero in the product.** The suite went 3060
to 3067 and the code under test never went red.

What I take from it: I treat code as needing proof and prose as needing care, and
that gap is the entire defect surface here. Three specific habits earned:

1. **Cite by name, never by line.** Adding a test to a file invalidates every
   line citation below it, so a range is most likely to rot exactly when someone
   is working nearby.
2. **A summary must never be stronger than the measurement.** If I cannot point
   at the revert-table row, it does not go in the report.
3. **A claim that has rotted once gets deleted, not corrected.**
