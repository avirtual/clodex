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
