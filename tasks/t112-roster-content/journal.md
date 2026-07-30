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
