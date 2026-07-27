# t52 — the ticket close path's actor hole

Branch `ticket-close-path` off master `33141d3` (v4.5.0).

## The finding, as it goes into the code

**The stall path requires no actor, so the close path must have one who always
exists.** `_taskDone` is assignee-only; `[agent:task add <role>]` with no
assignee is a legitimate backlog dispatch, and a seat can retire with its ticket
open. Either way the ticket has no actor permitted to close it — while the
watchdog needs none at all to keep nudging. Twelve nudges in one session came off
exactly this.

`team.lead` is structural (reject and cancel already gate on it), so it is the
actor who always exists.

## Phase 1 — read + decide (DONE)

Sites read: `_taskDone` (`:4586-4614`), `_deliverTicketSpec` (`:4513-4519`, the
`{ self }` precedent), `_taskCancel` (`:4641-4659`), `_taskReject`
(`:4616-4639`), and the ticket block in `test/session-manager.test.js`
(`:2659-2900`, fixture `mkTasks` at `:2668`).

### One consequence the spec does not name, taken deliberately

The `isLead` skip also fires when the lead closes a ticket it is **assignee of**
(self-assign — `task self-assign` at `:2781` is a live path). Today that
self-delivers: `_gatedDeliver(lead, lead, …)`. After this change it does not.
That is the same call the `{ self }` precedent already refuses one verb earlier
— the lead does not need its own report echoed at it — so making the two verbs
agree is the point rather than a side effect. Flagged because it is a behaviour
change on a path the ticket describes only as "when the sender IS the lead".

### The bounce message forces one existing-test edit

`test/session-manager.test.js:2821` asserts the exact old sentence
(`only ticket t1's assignee \(hand\) can close it`). Item 1 requires that
sentence to change, so the assertion changes with it. It is the only existing
assertion that moves.

## Phase 2 — product (NEXT)

`_taskDone` gate + delivery skip + `closedBy`; `_taskCancel` `closedBy`;
`_taskReject` clears it; the header comment; the shipped lead prompt line.

## Phase 3 — tests (a)–(d), each with its window checked

The window question for (a) and (b) is the one the ticket names: a test whose
sender happens to be the assignee proves nothing about the lead branch. So both
lead tests assert, before closing, that the sender would have FAILED the
assignee check — `ticket.assignee` is neither the lead's name nor the lead's
role. Without that the test is green on unchanged code.

## Phase 3 — DONE

4 new tests in `test/session-manager.test.js` after the existing non-assignee
test, plus that one existing assertion updated (`:2821`, the bounce sentence).

## Phase 4 — revert proofs (DONE), then suite, commits, report

Seven reverts, all failing BY MESSAGE, pristine copy restored between each.

| # | reverted | fails | message |
|---|---|---|---|
| A | `&& !isLead` dropped from the gate | both lead tests | "a backlog ticket stayed open: … NOTHING could close it while the watchdog nudged on" |
| B | bounce sentence back to assignee-only | old non-assignee test | (falsy `.some`) — **weak, fixed: message added, see below** |
| C | delivery skip removed (`if (!isLead)` → always) | both lead tests | "self-delivering it back is the echo {self} already refuses" |
| D | `closedBy` dropped from `_taskDone` | all three closing tests | "recorded who ended it" |
| E | reply hardcoded to claim delivery | backlog-lead test | "the reply must not claim a delivery that did not happen" |
| F | gate short-circuited to admit everyone | both bounce tests | "a third seat closed a ticket it has no part in" |
| G | keep-open bounce deleted | MF3 test + assignee test | "not closed — report went nowhere" |

**Revert B failed by a bare falsy `.some`, which is a crash-shaped message, not a
by-message failure.** Fixed at the assertion: it now carries a sentence and dumps
the actual close-related injections, so the next person to change that string
reads what it said instead of "expression evaluated to a falsy value".

F and G are the two "did the widening break the narrow path" directions, and
each fires on the PRE-EXISTING test as well as the new one — which is what says
the lead branch was added beside the assignee path rather than over it.

### Window check

The two lead tests assert their precondition before acting: `t1.assignee === null`
in the backlog case, and in the retired-seat case all three of
`assignee === 'hand'`, `assignee !== 'lead'`, and no live `team-hand` seat. Revert
A confirms it: with `!isLead` gone both fail, so neither is passing through the
assignee branch. The non-assignee test's window is likewise real — revert F
shows it distinguishes "lead admitted" from "everyone admitted".
