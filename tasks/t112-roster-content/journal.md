# t112 — what the roster CONTAINS

> Close this as ticket **t111**, not t112. The registry numbered it t111; this
> directory is named t112 because the earlier roster-*delivery* fix
> (`tasks/t111-roster-survives-context-reset/`) was done by the lead directly
> and never took a ticket number. Artifact names and ticket ids are not the
> same sequence.

t111 fixed *delivery*: the roster now rides `hook-digest.json` and is
regenerated on every context reset. This task fixes *content*. A roster that
arrives reliably and still leaves the lead guessing has moved the failure, not
removed it.

## Evidence — four failures, all from one session

Each of these is something I got wrong **while holding the roster**. That is
the bar for inclusion: not "would be nice", but "a seat acted wrongly because
the roster did not say it".

**(a) `template` is never rendered.** `normalizeRoleDef` (team-manifest.js:71)
carries `template` on every role def, and `formatRoster` (`:375`) renders
`role (instantiate) — brief · live: …` — no template. I tried
`[agent:spawn name:clodex-review template:reviewer]`; the real template is
`clodex-team-reviewer`. The spawn bounced with "no template named reviewer".
The tell: `scripts/clodex-team.js` `doRoster` (`:84-88`) **does** render
`tmpl=<name>`. The out-of-band exec is strictly richer than the roster the seat
carries in context — backwards, since the in-context copy is the one present at
the decision point.

**(b) No warmth, only liveness.** `- hand (session) · live: clodex-hand` does
not say that seat has been running 48 minutes in this exact cwd with a warm
cache. I spawned a cold subagent instead of using it. Warm-vs-cold is the
largest single term in cost-per-task, and the host already computes exactly
this label for `[agent:who]`: `peerStatusLabel` (proxy-util.js:302), already
imported into session-manager (`:248`).

**(c) The roster's own last line is a non-working invocation.** Both
`formatRoster` (`:390`) and `formatTeamBlock` (`:371`) print
`[agent:exec clodex-team] roster` and call it "ground truth". That literal
string bounces: the exec schema
(`resources/library/exec/clodex-team.json`) requires
`{"action":"roster","agent":"<own name>"}`, and ipc-prompt.js:171 says a
payload is *always* required — even `{}`. Three of my attempts bounced this
session. A line that names itself ground truth and cannot be executed is worse
than no line: it spends a turn and teaches a wrong form.

**(d) Role → how to instantiate it is never stated.** `(subagent)` does not
tell a lead that a `reviewer` is reached through the `[agent:team-review]`
intent and *not* by spawning a seat — Bogdan had to correct me twice ("you do
not spawn an agent" / "the intent is team-review"). `reviewer` is special-cased
in the code (`RESERVED_ROLE_KEYS`, team-manifest.js:20; session-manager.js:2933
"review-done is only for an ephemeral reviewer seat spawned by
[agent:team-review]") and nothing surfaces that where the decision is made.

**(e), found while specifying.** `_teamLiveSeats` (session-manager.js:1298)
returns every agent session rooted in the team, but `formatRoster` (`:378-379`)
drops any seat whose name matches no role. So an off-convention seat sharing
the project is live, warm, DM-able — and invisible in a listing whose whole job
is to say who is live. Same class as (b): a warm seat you don't know about.

## Shape

```
[team clodex] roster (lead: clodex)
- lead (session) — team lead; holds durable context, dispatches specs, verifies and integrates the work. · live: clodex (you)
- hand (session) — implementer; executes a spec to done, one distilled report per task. · live: clodex-hand (idle 12m, warm)
- reviewer (subagent, tmpl clodex-team-reviewer) — reviewer; an independent verification pass, invoked on demand.
also live, no role: scratch-seat (working)
Dispatch: [agent:task add <role>] <spec>. Review: [agent:team-review] <scope>. New session seat: [agent:spawn name:clodex-<role> template:<tmpl>].
Ground truth on demand: [agent:exec clodex-team] {"action":"roster","agent":"clodex"}
```

Rules, in order of how much they matter:

1. **The exec line is rendered concrete, not as a form to fill in.** The seat's
   own name is substituted. A reader should be able to copy the line. This is
   the single highest-value fix — it converts a line that always bounces into
   one that always works.
2. **`tmpl <name>` appears in the role's parenthetical when the def has a
   template.** Omitted entirely when null — do not print `tmpl none`.
3. **Each live seat carries its `peerStatusLabel` in parentheses.** The label
   must be computed by session-manager, **never** by team-manifest.js:
   team-manifest is a pure leaf (its header says so — no electron, injected
   fs), and warmth lives in the wire layer. The seam: `_teamLiveSeats` returns
   `{ name, label }` objects instead of bare strings, and `formatRoster` renders
   `label` verbatim when present. team-manifest must not learn what a label is.
4. **The reading seat is marked `(you)`** in place of its own label.
5. **Seats matching no role get one `also live, no role:` line**, only when
   non-empty.
6. **The action line is rendered ONLY for the lead seat.** It is a delegation
   surface; a hand does not dispatch, and this text is regenerated into every
   context reset of every seat, so non-leads should pay nothing for it. The
   per-role actions are derived, not stored: `reviewer` → `[agent:team-review]`;
   other `subagent` roles → the harness subagent tool; `session` roles →
   `[agent:spawn …]` with the role's template if it has one.

`formatRoster` needs the reading seat's name for (1), (4) and (6). Add it as an
options arg: `formatRoster(team, liveSeats, { seat = null } = {})`. With no
seat, fall back to the generic form (`"agent":"<your name>"`, no `(you)`, no
action line) — `composeRosterFor` always has a name, so the fallback is only for
defensive callers and tests.

## Also fix `formatTeamBlock`

Line 371 carries the same broken invocation. Fix it there too — it has
`seatName`, so it can render the concrete form. This is a **deliberate,
one-time** edit to cache-stable system-prompt text: the cost is one cache bust
per seat, the benefit is that an always-bouncing instruction stops being
taught. Do not take any other liberty with that function.

## Hard constraints

- **The roster listing stays OUT of `formatTeamBlock`.** The comment at
  team-manifest.js:362 explains why (composition changes over a seat's life;
  that text is cache-stable). Everything above goes in `formatRoster`.
- **team-manifest.js stays a pure leaf.** No `require` of proxy-util,
  session-manager, or electron. Labels arrive as data.
- No emojis. No ALL-CAPS emphasis in comments.
- Comments per `.claude/CLAUDE.md`: a comment earns its place only by naming a
  wrong change it prevents. The one that clearly does: why the label is
  injected rather than computed in the formatter.

## Non-goals

- **Stale-host detection in the roster.** `scripts/clodex-team.js`
  `staleHostLine` (`:187`) is genuinely valuable — this very session ended with
  a committed fix that was not live — but it is a property of the *host*, not of
  the *team*, and belongs in the boot digest alongside the memory block, not
  inside a roster listing. Deliberately omitted; worth its own task.
- Truncating long briefs. Not a problem today; adding a cap now is speculative.
- Any change to `formatCompositionDelta` or the ticket protocol.

## Tests

`test/team-manifest.test.js:630` (`formatRoster lists roles, briefs, class, and
live seats per role`) will fail on the format change — **update it, do not
delete it**, and keep its existing assertions that still hold.

New cases, each named for the property it pins:

1. The exec line renders the reading seat's name into a valid payload, and
   `{"action":"roster","agent":"<seat>"}` matches the schema in
   `resources/library/exec/clodex-team.json`. Assert against the schema file,
   not a hand-copied string — that is what makes this test notice the day the
   schema changes.
2. A role with a `template` renders `tmpl <name>`; a role without one renders
   no `tmpl` token at all.
3. A live seat's label is rendered verbatim; a live seat with a null label
   renders bare; the reading seat renders `(you)` and never a label.
4. A live seat matching no role appears under `also live, no role:`, and that
   line is absent when every live seat has a role.
5. The action line appears for `team.lead` and is absent for a non-lead seat.
6. `formatTeamBlock`'s invocation is concrete and schema-valid (same assertion
   source as case 1).

Then the session-manager side: `_teamLiveSeats` returns `{name, label}` and the
label comes from `peerStatusLabel`. All three `formatRoster` call sites
(`:1319`, `:1381`, `:1417`) must pass the seat name.

**Mutation-check the new tests before reporting.** For each of cases 1-5,
break the property in the source, confirm the test fails, restore. A test that
passes against a broken formatter is the false-green this whole task exists to
remove. Report the pass/fail tally.

## Journal

- Spec written by clodex (lead) from four in-session failures plus one found
  while reading. Dispatched to hand.

### Implementation

Three files: `team-manifest.js`, `session-manager.js`, `test/team-manifest.test.js`.

- **`rosterExecPayload(seatName)`** is the single source of the invocation, used
  by both `formatRoster` and `formatTeamBlock` — the spec asks for the same fix
  in two places, and two literals would drift the moment the schema changes.
  Seatless renders `"agent":"<your name>"`, still the payload *form*: a reader
  with no seat should learn the right shape, not the bare word.
- **`formatRoster(team, liveSeats, { seat = null } = {})`** as specified.
  `liveSeats` entries are `{name, label}`; bare strings are still accepted as a
  label-less form, which is what keeps the old tests and any defensive caller
  working. The label is rendered verbatim, never interpreted — team-manifest
  still requires nothing but `path` and `os`.
- **`leadActionLine(team)`** derives the per-role action from the manifest
  rather than storing it: `reviewer` → `[agent:team-review]`, other `subagent`
  roles → the harness subagent tool, `session` roles → `[agent:spawn …]`. Each
  clause is emitted only when a role of that class exists, so a team with no
  subagent roles pays nothing for the sentence about them.
- **`_teamLiveSeats`** now computes `peerStatusLabel` per seat, wrapped in a
  try/catch — a warmth label is decoration and must never be able to fail a
  roster delivery.

**Deviation, and it is the one thing in this task I would want reviewed first.**
The spec says `_teamLiveSeats` returns `{name, label}` and names the three
`formatRoster` call sites. It has **four other consumers** that treat the return
as bare strings: `_resolveAssignee` (:3093), `_ticketAssigneeSeat` (:3101,
:3106) and `_reconcileTickets` (:3340). Changing the return type alone would
have made `.includes(who)` always false against objects — ticket routing by seat
name, and the ticket-watch broadcast, would have died silently with every test
still green, because no test covers those paths against a live-seat list. I
added `_teamLiveSeatNames(teamRoot)` (a `.map(s => s.name)` over the same
walk) and pointed all four at it. This is scope the spec did not name; I took it
because the alternative was knowingly shipping a break.

Other notes:
- `formatTeamBlock` got exactly the one line changed, nothing else.
- One pre-existing test asserted the old bare-word line
  (`formatTeamBlock: shrunk identity block…`, :251). Updated in place, kept.
- The existing `formatRoster` case was updated, not replaced: its assertions
  still hold except the two the format changed (`hand` now carries `tmpl`, and
  the exec line). I gave the shared fixture a template on `hand` so the tmpl
  case has both a templated and a template-less role to discriminate.

### Tests

Six new cases in `test/team-manifest.test.js`, named for the property each pins.
Cases 1 and 6 parse the payload out of the rendered line and validate it against
`resources/library/exec/clodex-team.json` — read at test time, with a small
`schemaViolations` checker covering the subset of JSON Schema that file uses
(required, additionalProperties, type, enum, maxLength). A hand-copied payload
string would pass forever after a schema change; this fails.

### Mutation check

Harness: scratchpad `mutate-t112.js` (not committed) — applies each mutant to
`team-manifest.js`, runs the file, records which test names failed, restores,
and verifies the baseline was green before and after.

**11 mutants, 11 killed, 0 survived.** Beyond the five the spec asked for, I
added a second mutant per property for the ones where a weak test would still
pass — these are the false-greens worth naming:

| case | mutant | killed |
|---|---|---|
| 1 | exec line reverts to the bare word `roster` | yes |
| 1b | payload form kept, seat name hardcoded to `lead` | yes |
| 2 | tmpl token never rendered | yes |
| 2b | tmpl rendered for a null template (`tmpl none`) | yes |
| 3 | label and `(you)` both dropped | yes |
| 3b | reading seat renders its label instead of `(you)` | yes |
| 3c | a null label renders empty parens | yes |
| 4 | roleless live seats dropped | yes |
| 4b | `also live, no role:` emitted even when empty | yes |
| 5 | action line rendered for every seat | yes |
| 5b | action line never rendered | yes |

A note on the tally, since it is the part of this task that most deserves
distrust: my **first** mutation harness was a shell script that reported all
five mutants SURVIVED. That was the harness lying, not the tests — its
`grep -c "^✖ <name>"` never matched. Verified by hand that mutant 1 kills three
tests, then rewrote the harness in Node to parse the runner output and to assert
the baseline is green before and after each mutant. The table above is from the
rewritten one.

### Gate

- `node --check` on both changed source files.
- `test/team-manifest.test.js` 38/38; `test/session-manager.test.js` 360/360.
- Full suite: **3089 pass, 0 fail, escapes 0.** Baseline was 3081; +6 are mine,
  the other +2 are t111's `test/cli-hooks.test.js` additions, which clodex
  committed while this task was in flight.
- team-manifest.js still requires only `path` and `os` — pure leaf intact, and
  the roster listing stayed out of `formatTeamBlock`.
- The `_injectRoster: rides PASSIVELY` flake reported during t110 did not
  reproduce in either full run here.

### Rework from cold review

The finding was right and the shape of it matters: the formatter half was
pinned, the session-manager half was not, so the highest-value fix in the spec
could be deleted with the suite green. Everything below is about closing that.

**MUST-FIX 1 — the roster call sites.** Three assertions added inside the
existing `_injectRoster: rides PASSIVELY` test (:1902), plus
`peerStatusLabel: () => 'idle 12m, warm'` in its `mkPark` deps: `"agent":"lead"`
pins the call site, `live: lead (you)` pins the seat arg reaching the formatter,
`live: team-dev (idle 12m, warm)` pins the label seam end to end. The old
regexes were unanchored prefixes, as the review said — `live: lead` matches
`live: lead (you)` equally, so they pinned nothing.

**Beyond the review, and this is the part I would look at first.** The spec's
fix pins ONE of the three call sites. I mutated the other two and both survived:
`_settleBoot` (codex boot-settle) and `composeRosterFor` — which t111 made the
digest path, i.e. the roster baked into every context reset, the longest-lived
of the three. A placeholder name there is served to a seat on every compact
forever, and nothing failed. Added an assertion to the existing `_settleBoot`
test and a new `composeRosterFor` test covering both the live-session and the
persistence-only cwd branch. All three call sites are now individually mutable
to a failure.

**MUST-FIX 2 — the two-shapes deviation.** Two cases in the `mkTasks` fixture:
a live seat name resolving as an assignee and receiving its spec (the
name-addressed path through `_resolveAssignee` and `_ticketAssigneeSeat`, which
nothing covered), and a name that is neither role nor live seat being refused.
Mutating any of the four repointed consumers back to the object-shaped walk now
fails.

**Promoted nit — `role === team.lead`.** Correct, and a real bug: `team.lead`
is a seat name, so on a team whose lead seat is named after a role, that role
vanished from the action line. First disjunct dropped, comment names why, and a
test with `lead: 'hand'` pins it.

**Nits taken.** `rosterExecPayload` now `JSON.stringify`s the payload (output
byte-identical, verified); `schemaViolations` proved able to reject three ways
(missing required key, out-of-enum action, unknown key) — an accept-everything
checker is the same false green in a new place; the seatless fallback asserted
as literally `{action:'roster', agent:'<your name>'}`; unguarded `def.brief`
fixed. Declined per the lead: no `{ labels }` flag on `_teamLiveSeats`. Lead
action line unchanged.

### Rework mutation check

Harness: scratchpad `mutate-t112b.js` (not committed) — same method, extended to
session-manager.js, asserting both suites green before and after every mutant.

**24 mutants, 24 killed, 0 survived** (21 in the scripted run, plus SM8/SM9/SM10
for the two call sites and the persistence branch, run separately as they were
written after). New this round:

| id | mutant | killed |
|---|---|---|
| SM1 | `_injectRoster` drops `{ seat }` | yes |
| SM2 | `_teamLiveSeats` reverts to bare strings | yes |
| SM3 | `_teamLiveSeats` stops computing the label | yes |
| SM4 | `_resolveAssignee` wired to the object walk | yes |
| SM5 | `_ticketAssigneeSeat` name branch wired to the object walk | yes |
| SM6 | `_ticketAssigneeSeat` role branch wired to the object walk | yes (10 tests) |
| SM7 | `_reconcileTickets` wired to the object walk | yes (10 tests) |
| SM8 | `composeRosterFor` drops `{ seat }` | yes |
| SM9 | `_settleBoot` drops `{ seat }` | yes |
| SM10 | `composeRosterFor` ignores the persistence cwd | yes |
| TM-lead | role key compared against the lead seat name again | yes |
| 1c | seatless fallback emits an empty agent | yes |

SM6 and SM7 were checked by hand rather than trusted from the harness — their
`expect` patterns were loose enough to match on an unrelated failure. Both
genuinely kill ten ticket tests each.

### Rework gate

- `node --check` on both changed sources; team-manifest still requires only
  `path` and `os`.
- `test/team-manifest.test.js` 39/39; `test/session-manager.test.js` 363/363.
- Full suite: **3093 pass, 0 fail, escapes 0.**
