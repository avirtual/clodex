# t89 — a seat that finishes a ticket does not start the next one it holds

Branch: `t89-seat-self-advance` off master `de6f0a1` (t86 merged).

## The spec, preserved verbatim from clodex's dispatch

> [ticket t89] tasks/t85-seat-self-advance — a seat that finishes a ticket does
> not start the next one it holds
>
> Filed from three observations today, now the highest-value process fix on the
> board. Full context is in the backlog ticket; the short version:
>
> You completed t82, reported, went idle holding t79/t81/t80. Woken by hand →
> completed t79, went idle holding t81/t80. Woken by hand → same again. Each
> time a CLEAN stop at a turn boundary with a clean tree. Not a crash, not a
> wedge, not context pressure — there is simply no trigger on the completion
> edge.
>
> WHY t82 DID NOT COVER IT: t82 made ticket DISPATCH wake the assignee
> (urgent=true at the dispatch and reassign sites). That is the ARRIVAL edge. A
> seat already holding a queue received those tickets turns ago; the delivery
> that would have woken it is long past. I twice told Bogdan the queue would
> self-advance after t82. Both times wrong.
>
> SCOPE:
>   - The natural trigger is the _taskDone path: when a seat closes a ticket,
>     does it still hold an open one? If so, redeliver that spec. The ticket
>     record already stores the full spec text — the reassign path depends on
>     that, so the mechanism exists.
>   - Do NOT fire when the seat closed its LAST ticket. A wake that delivers
>     nothing actionable is exactly the cost t82 was careful to avoid for
>     notices.
>   - ORDER IS THE REAL DESIGN QUESTION. I have been giving you priority order
>     in dm bodies, which is invisible to the registry. If the host starts
>     auto-advancing, it picks — and lowest-id-first would have run t80 before
>     t79, contradicting the order I actually wanted. Decide whether order
>     belongs on the ticket record, and say what you chose. If you add a field,
>     a lead who sets nothing must still get sane behaviour.
>   - Consider whether reject (:4917, done→open) should re-trigger too. A
>     rejected ticket returns to open on a seat that may have already gone idle
>     — same defect, different edge. Verify before assuming.
>
> WATCH FOR THE ADJACENT DEFECT: t84 (watchdog fires per queued ticket rather
> than per stalled seat) is downstream of this one — this creates the idle seat,
> t84 then reports it N times. Do not fix t84 here, but if your change makes
> part of it moot, say so.
>
> CONSTRAINTS:
>   - Do NOT touch master. Do NOT push. Branch; I merge.
>   - Do NOT edit .claude/CLAUDE.md — frozen.
>   - No emojis.
>   - Tests must distinguish their two outcomes; where a pin asserts a
>     pre-existing value, an anti-revert is the proof.
>   - VERIFY THE TEST RUN'S TREE. Per t88, the test-runner subagent ran in the
>     wrong worktree during t86 and reported a plausible green number for code
>     it never executed. Dispatch it with an absolute cd and sanity-check the
>     count moved.
>   - Journal into your task artifact as you go.
>
> REPORT: full report in the TICKET CLOSE BODY, not a separate dm (per my note).
> Include the ordering decision and its reasoning, whether reject re-triggers,
> sites with file:line, and the test digest with the tree it ran in.

## Standing context carried in

- Report goes in the TICKET CLOSE BODY. No completion dm (clodex's convention
  change, this session). Dm only for a blocker/question/finding needed BEFORE
  the close.
- Test baseline after t86: **2994**. The count MUST move, and I must confirm
  the runner's tree — it silently ran in `/Users/bogdan/projects/tmux/wb-wrap-ui`
  during t86 and reported a plausible-but-wrong green.
- Work only in `/Users/bogdan/projects/tmux/wb-wrap-ui-hand`.
- `git reset -q node_modules` before staging; explicit path lists.
- Product commit separate from tests+journal commit.

## Phase A — verification

### The defect: CONFIRMED. There is no trigger on the completion edge.

`_taskDone` (`session-manager.js:4859-4910`) ends with: deliver the report to
the lead (`:4893`, `urgent=false`), stamp `state='done'` + `closedAt` +
`closedBy` (`:4896-4904`), save, `_reconcileTickets`, broadcast, log, reply.
**Nothing consults the seat's remaining tickets.** Same for `_taskCancel`
(`:4938`). clodex's reading is exact.

### The wake mechanism to REUSE (not reinvent)

`_deliverTicketSpec(team, ticket, specText, fromName, urgent)`
(`session-manager.js:4766-4775`) is the shared path. Both t82 sites call it
with `urgent=true`:
- `:4812` (`_taskAdd`) — comment: *"a ticket is a WORK ASSIGNMENT, not
  conversation. Parking it leaves the board saying 'assigned' while nothing
  runs."*
- `:4848` (`_taskAssign`) — *"same reasoning as dispatch."*

It returns UNFLATTENED outcomes (`self` / `delivered` / `parked` / `held` /
`undelivered`), and `_ticketDeliverySuffix` (`:4779`) renders them for the lead.
The advance must go through this, so parked/held stays distinguishable.

**Why urgent matters here, mechanically** (`proxy-util.js:506-521`): a
non-urgent dm to a seat idle past `DM_HOLD_IDLE_MS` with a cold cache is HELD.
`urgent` bypasses that — but NOT a permission-dialog hold (`:507-513` returns
`noUrgent: true`). A seat that just finished a ticket is by definition at a turn
boundary and about to go idle, which is precisely the state that holds.

### Spec text field: `ticket.spec` — CONFIRMED, not assumed

Set at `_taskAdd:4798` (`spec` in the record literal), read at `_taskAssign:4848`
(`this._deliverTicketSpec(team, ticket, ticket.spec, …)`). The header comment at
`:4707-4709` states it outright: *"the ticket record also carries the full
`spec` text … reassign must redeliver the spec to the new assignee, which is
impossible without storing it."* So the mechanism clodex remembered does exist.

### The "does it hold another?" query ALREADY EXISTS

`_reconcileTickets:5015` runs exactly it, per live seat:
```js
tickets.find((t) => t.state === 'open' && t.assignee != null
  && (t.assignee === name || t.assignee === role))
```
and it is already called from `_taskDone:4906`. So the completion edge already
computes the next held ticket to paint the badge — it just does not deliver it.
That is a strong signal the fix belongs here and not in a new subsystem.

### No ordering field exists

Ticket record fields (`_taskAdd:4797-4803`): `id, title, spec, assignee, opener,
state, openedAt, closedAt, lastActivityAt, nudgedAt`, plus optional `taskDir`,
plus `closedBy` on close. **No priority/order.**
`nextTicketId` (`tickets-store.js:55-65`) is `max+1`, so ids ascend with
creation, and the array is push-ordered (`:4804`) — meaning array order, oldest
order and lowest-id order are ALL THE SAME THING for minted tickets. There is no
third derivable ordering hiding in the record.

### CORRECTION to the spec's ordering example

clodex wrote: *"lowest-id-first would have run t80 before t79."* Numerically t79
is the lower id, so lowest-id-first runs t79 FIRST — that part matches what
happened. The real collision is one step later: after t79 closed I held
{t80, t81}, lowest-id picks **t80**, and clodex wanted **t81**. So the conflict
is t80 before t81. **The point stands entirely** — a derived order contradicts
the intended one — the pair named is just off by one step.

Worth stating plainly because it sharpens the conclusion: the wanted sequence
was t82 → t79 → t81 → t80. That is not id order, not creation order, not array
order. **No orderable field in the record reproduces it**, because the priority
lived only in clodex's dm prose. So the honest finding is that ordering CANNOT
be derived — it must be recorded or the host must not claim to know it.

### Reject: SAME DEFECT, different edge — verified

`_taskReject:4912-4936` reopens (`state='open'`, `:4924`) and delivers the
reason at `:4931` with **`urgent=false`**. So on a seat that has already gone
idle, the reason is held/parked and nothing wakes it — the ticket sits open,
assigned, and unstarted. Confirmed by reading, not assumed: `_gatedDeliver` →
`shouldHoldDm` holds a non-urgent dm to an idle/cold seat.

Note `_taskCancel:4952` also delivers non-urgent — correctly, since cancel
creates no work.

## Ordering decision: FIFO, and NO new field — because the promote lever
## already exists

**Chosen: advance in FIFO order — `openedAt` ascending, ties broken by numeric
id. No `priority` field, no new grammar.**

I first designed an optional `priority` field (default 0, so one ticket can be
pulled forward or pushed back without annotating the rest). I am not shipping
it, because while checking what it would cost I found the lever is already
there:

**`[agent:task assign <id> <same-assignee>]` re-delivers the spec urgently.**
`_taskAssign:4828` requires only `state === 'open'`; `:4832` computes
`reassigning = prev != null && prev !== assignee`, which merely changes the
REPLY wording — it does not gate anything. `:4848` then calls
`_deliverTicketSpec(…, urgent=true)` unconditionally. So a lead who wants a
different ticket next re-assigns it to the seat that already holds it, and it
lands urgently, now. That is a promote operation in the shipped grammar, and
after this ticket it composes correctly with the advance.

Given that, a `priority` field would be a second way to express an order the
lead can already express, and it is the expensive one: it needs a record field,
a `key:val` token in `parseTask` (the `add` bracket currently spends its only
positional on `who`), a way to CHANGE it after mint (priority you can only set
at mint time does not solve clodex's actual case — reordering an
already-dispatched queue), a `clodex-team.json` schema property, and prompt-doc
grammar. **That is a feature, not part of this defect**, and per the dispatch's
"flag it rather than half-shipping" I am flagging it instead.

Why FIFO is the right default on its own terms:
- Oldest-first is the conventional queue meaning, cannot starve a ticket, and is
  stable and predictable.
- Ties break on numeric id so the order is TOTAL and deterministic — two tickets
  minted in the same millisecond must not advance in array-iteration order.
- **I am not inferring priority from dispatch prose.** clodex's real order lived
  in dm bodies; reconstructing it from the registry would be exactly the
  "lie with a high true-rate" failure t81 spent a ticket removing.
- The advance NAMES the ticket it picked in the delivery, so a wrong pick is
  visible and correctable with the assign lever rather than silent.

### An honest note on the wanted order

The sequence clodex wanted was t82 → t79 → t81 → t80. That is not id order, not
creation order, and not array order. **No orderable field in the record
reproduces it**, because the priority existed only in prose. So FIFO is not
merely the cheap choice — it is the only order the host can honestly claim to
know without the lead recording one.

### CORRECTION to the spec's example

clodex wrote *"lowest-id-first would have run t80 before t79."* t79 is the lower
id, so lowest-id-first runs t79 first — which is what was wanted. The real
collision is one step later: after t79 closed I held {t80, t81}, lowest-id picks
t80, and clodex wanted t81. The point stands exactly; the pair named is off by
one step.

## Phase B — implementation

| # | Site | Change |
|---|---|---|
| 1 | `session-manager.js:4786` | `_advanceSeat(team, teamDir, seatName, closedId)` — new, above `_taskAdd` |
| 2 | `session-manager.js:4960` | `_taskDone` calls it, keyed on `_ticketAssigneeSeat(team, ticket)` |
| 3 | `session-manager.js:4962` | the done reply names the ticket handed over |
| 4 | `session-manager.js:5021` | `_taskCancel` calls it |
| 5 | `session-manager.js:5025` | the cancel reply names it |
| 6 | `session-manager.js:4995` | reject reason `urgent` false → **true** |

### Keyed on the TICKET's seat, not the closer

`_taskDone` permits two actors (assignee or lead, `:4878`). The seat that needs
restarting is the ticket's assignee, which is exactly the case where the LEAD
closes over a silent seat — key it on `session.name` and that seat stays idle,
i.e. the whole defect survives in the case it most matters. Revert D proves it.

### `closedId` is redundant on both callers, and stays

Both callers stamp the terminal state and SAVE before calling, so
`state === 'open'` already excludes the just-closed ticket. Revert B changed no
test — a genuine no-op. Rather than delete a guard whose redundancy is an
ORDERING ACCIDENT (move the advance above the save and the seat is handed back
what it just finished), I kept it and **tested it directly against
`_advanceSeat`**, since no caller can distinguish it. Documented in place.

## Phase C — tests: 8 added, 1 existing SPLIT

New (`test/session-manager.test.js`, t89 block):
1. done advances, urgently, id-prefixed
2. closing the LAST held ticket delivers NOTHING (the t82 cost guard)
3. FIFO not id order, with `openedAt` forced to CONTRADICT id order
4. `_advanceSeat` never hands back the closed ticket (direct call)
5. skips cancelled / other-seat / backlog tickets
6. advance follows the TICKET's seat (lead closing over a silent seat)
7. cancel advances too, notice passive but advance urgent
8. reject wakes the assignee

### THE t82 TEST SPLIT — a reversal, not a loosening

`t82 the status NOTICES stay passive: done, reject and cancel must not wake a
seat` FAILED on the reject flip. That test pinned a DELIBERATE lead decision, so
I did not touch the assertion to make it pass. I **split reject out** into its
own t89 test that pins the opposite value with the reasoning, left done and
cancel pinned passive, retitled the t82 test to name what it still covers, and
commented the reversal at both sites. **Flagged in the report: this reverses a
t82 decision and is clodex's to confirm.**

The justification is mechanical, not aesthetic: reject REOPENS the ticket
(`:4924`), so its reason is a work assignment by the same rule t82 itself
applied to dispatch. And its target is by construction a seat that just
reported done and went idle — `shouldHoldDm` (`proxy-util.js:514`) holds exactly
that seat, so at `urgent=false` the rework sat parked while the board said open.

### ENTER checks

- Test 1/6/7 assert `gated.length` and which index is which BEFORE indexing —
  the FIFO test initially failed revert A by TypeError, not by message, because
  it indexed `gated[1]` without that guard. Fixed by adding the length assert;
  a crash is not a proof.
- Test 3 asserts `t3.openedAt < t2.openedAt` before the advance. Without it the
  two orderings agree and the test cannot distinguish them.
- Test 4 asserts t1 is still `open` before the direct call — otherwise
  `state === 'open'` would be doing the work and `closedId` would be untested.
- Test 5 asserts each decoy really is cancelled / other-assignee / backlog.
- Test 8 asserts the reject really reopened.
- Test 2 pins an ABSENCE and is unmoved by revert A (correctly — no revert of
  mine can move it; only forcing an advance on an empty queue would).

Nothing armed: `mkTasks` never calls the real `create()`; no timers, no PTY.

### REVERTS — six attempted, five bite by message, one was a real no-op

Pristine copy of `session-manager.js` taken first; `git diff --numstat` after
every restore and revert, plus a grep confirming each substitution landed.

| # | Change | Tests failed | By |
|---|---|---|---|
| A | delete the `_advanceSeat` call in `_taskDone` | 4 | message |
| B | drop the `t.id !== closedId` filter | **0 — NO-OP** | — |
| B2 | same, after adding the direct guard test | 1 | message |
| C | FIFO sort → numeric-id order | 1 | message |
| D | key the done advance on `session.name` | 1 | message |
| E | delete the `_advanceSeat` call in `_taskCancel` | 1 | message |
| F | reject urgent true → false | 1 | message |

**Revert B is the honest finding of this phase.** It changed nothing, which
means that as first written the `closedId` guard had no test that could see it.
The response was not to delete the guard or wave it through — it was to write
test 4 against `_advanceSeat` directly, then re-run the revert as B2 and watch
it bite. A guard no revert can move is a guard no test is holding.

**F is a GENUINE REVERT, not an anti-revert.** `urgent=false` is the
PRE-EXISTING value, so flipping back to it moves the product away from what the
test asserts and into the old behaviour — the test's window is entered. (An
anti-revert would be needed only where a test pins a value the product already
had before the change, e.g. test 2's absence.)

C, D, E, F each isolate exactly one test, so every guarantee has a named owner.

### Suite

**3002/3002, ESCAPES 0** (2994 + 8).

**Tree verified**: the runner reported `pwd` =
`/Users/bogdan/projects/tmux/wb-wrap-ui-hand`, and the count MOVED from the 2994
baseline. Both checks were required because during t86 this subagent silently
ran in `/Users/bogdan/projects/tmux/wb-wrap-ui` and reported a plausible green
for code it never executed.

## t84 — what this makes moot, and what it does not

t84 is "the watchdog fires per queued ticket rather than per stalled seat". Not
fixed here, and deliberately not touched. But the relationship is worth stating:
this ticket removes the main PRODUCER of the multi-ticket idle seat. A seat
holding three tickets and stopping after one is exactly the state that made the
watchdog nudge three times; after this, that seat is handed its next ticket and
keeps moving, so the N-nudge pileup should become rare in practice.

**It does not make t84 moot.** The fan-out bug is still there for every case
that produces a stalled seat by another route — a held/undelivered advance
(`_deliverTicketSpec` can return `held` or `undelivered` and the seat then does
stall holding N tickets), a seat that stalls mid-ticket, or a Codex seat that
cannot be parked for at all. Those are precisely the cases where the watchdog
matters most, and it still reports them per ticket rather than per seat.
