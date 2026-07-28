# t82 — ticket dispatch must wake the assignee; parked must not report as delivered

Branch: `t82-ticket-delivery-wakes` off master `ac6c05e`.
Order: clodex put this FIRST of four (t82 → t79 → t81 → t80) because until it
merges, every dispatch depends on Bogdan hand-carrying.

## Phase A — verification before changing anything

### A1. What `urgent=true` actually bypasses — clodex is RIGHT. Confirmed.

`proxy-util.js:506` `shouldHoldDm({ urgent, state, idleMs, payload, attention })`:

- `:507-513` — **`attention === 'permission'` returns `hold:true, noUrgent:true`
  BEFORE the urgent test is ever reached.** Reason string: "blocked on a
  permission dialog — injecting now would answer the dialog".
- `:514` — `if (urgent || state === 'thinking' || idleMs < DM_HOLD_IDLE_MS)
  return { hold: false }`. So urgent short-circuits the idle test...
- `:515-520` — ...and therefore also the cold-cache hold below it.

**So: `urgent=true` bypasses the idle/cold-cache hold ONLY. It does NOT bypass a
permission-dialog hold, and the `noUrgent:true` flag is the host telling the
caller exactly that.** clodex's stated understanding is confirmed, and their
conclusion follows: waking is BEST-EFFORT, which makes defect (2) — the honest
outcome reporting — the load-bearing fix rather than the cleanup. I agree, and
that ordering is now the plan.

### A2. The three outcomes are real and distinct

`session-manager.js:5260` `_gatedDeliver` returns exactly:

- `{ delivered:true }` — injected (`:5282`).
- `{ parked:<id>, reason, noUrgent }` — held, but parked for later drain
  (`:5279-5280`).
- `{ held:<reason>, noUrgent }` — held and **un-parkable** (`:5280`).
- `{ error:<msg> }` — not a local agent (`:5262`).

`canPark` at `:5274` is `target.agentType === 'claude' && !target._dead`, so
**held is a genuine drop for a Codex seat or a dead target** — the parking drain
rides a UserPromptSubmit hook Codex lacks (comment `:5271-5273`).

### A3. The defect, confirmed verbatim

`session-manager.js:4719-4725` `_deliverTicketSpec`:

```js
const r = this._gatedDeliver(seat, fromName, `[ticket ${ticket.id}] ${specText}`, false);
return (r && r.error) ? { undelivered: true } : { delivered: true };
```

Only `r.error` is inspected. `parked` and `held` both fall into the
`{ delivered: true }` branch. The lead is told the spec landed in all three
cases — including the case where it provably did not. Confirmed as specced.

Note the doc comment at `:4714-4718` already CLAIMS the function returns
`{ delivered }/{ parked }` "via the gated pipeline". It does not. **The comment
is not merely incomplete, it is WRONG** — flag separately in the report.

## Plan

1. Propagate the true outcome out of `_deliverTicketSpec` (parked / held
   distinct from delivered), and surface it in the lead-facing reply.
2. `urgent=true` at the two WORK-ASSIGNMENT sites only: `:4723` dispatch,
   `:4777` reassign. Notices (`:4829` done, `:4867` reject, `:4888` cancel) keep
   riding passively — per clodex, and I agree: waking a seat to say a ticket was
   cancelled re-bills a whole context to deliver nothing actionable.
3. Watchdog `:4981` — judgement call, decide and FLAG for clodex to adjudicate.

## Log

Phase A done. Phase B (product) done — NOT yet tested.

### Edits made

1. **`_deliverTicketSpec`** — now returns `{ parked, reason }` and
   `{ held, reason }` unflattened, plus a new `urgent = false` 5th param
   (default false so the notice sites keep their behaviour by construction).
   Header comment rewritten: the OLD one already claimed it returned
   `{ delivered }/{ parked }` and that was FALSE — flag as doc-wrong.
2. **`_ticketDeliverySuffix(d, assignee)`** — new helper, one place that turns
   an outcome into the lead-facing NOTE. Parked and held read differently on
   purpose: parked WILL arrive next turn, held will NOT arrive at all.
3. **Dispatch (`_taskAdd`)** — `urgent=true`, suffix via the helper.
4. **Reassign (`_taskAssign`)** — `urgent=true`, suffix via the helper.
5. **Notices** (done / reject / cancel) — UNCHANGED, still passive. They do not
   route through `_deliverTicketSpec` and did not need touching.
6. **Watchdog `_sweepTeamTickets`** — kept NOT urgent (decision below), and
   fixed the same defect-(2) shape found locally: `if (!(r && r.error))`
   consumed the one-per-episode nudge even when the delivery was HELD, i.e.
   when the lead provably never saw it. Now `if (r && !r.error && !r.held)`.
   Parked still counts (it drains next turn).

### WATCHDOG DECISION — for clodex to adjudicate, not buried

**Kept passive (urgent=false).** Reasoning: it is an alarm, which argues for
waking, but (a) it is addressed to the LEAD and is not a work assignment — the
whole justification for waking is that an assignment which never starts is
worth nothing, and that does not apply to a notice; (b) it fires on a SCHEDULE,
so waking makes every sweep a potential full context re-bill; (c) a ticket that
has been stalled for hours is not urgent to the minute — parking costs one turn
of latency. clodex's own constraint was "do NOT extend waking to anything
beyond work assignment on this reasoning", and the watchdog is not one.

### Phase C — tests: 8 added, all in test/session-manager.test.js

Harness note: `urgent` is recorded into a SEPARATE `urgents` array on the
`mkTasks` fixture rather than widening the objects pushed to `gated`. Several
existing tests pin `gated` with `deepStrictEqual`; widening the recorded shape
would have forced a rewrite of pins that are not about urgency, which is the
"loosen an assertion to make it pass" the spec forbids.

### REVERTS — every pin proved to bite BY MESSAGE

Pristine copy taken first; `git diff --numstat` checked after each restore
(49/14 every time — no drift, no no-ops).

| # | Change | Test that failed | Failed by |
|---|---|---|---|
| A | restore the `{delivered:true}` flattening | HELD-not-delivered **and** PARKED-reads-parked | message ×2 |
| B | dispatch `urgent` → false | dispatch-WAKES | message |
| C | reassign `urgent` → false | reassign-WAKES | message |
| D | restore `if (!(r && r.error))` | HELD-watchdog-nudge | message |
| E* | done notice → urgent **true** | NOTICES-stay-passive | message |
| F* | watchdog → urgent **true** | watchdog-stays-passive | message |
| G* | append a NOTE on the happy path | DELIVERED-confirms-cleanly | message |

\* E/F/G are ANTI-reverts, not reverts. Those three tests assert `false` /
absence, which is the PRE-EXISTING value — no revert of my change can move them,
so a plain revert would have been a guaranteed no-op and proved nothing. Flipping
the product the OTHER way is the only thing that enters their window. (This is
the "a sweep that cannot distinguish its two outcomes is not a check" rule
applied before the fact rather than after.)

No crashes, no timeouts, no hangs. Nothing armed by these tests needs teardown:
`mkTasks` never calls the real `create()` and the sweep path arms no timer.

### Suite

**2966/2966, ESCAPES 0** (baseline 2958 + 8), via the test-runner subagent.

### Doc-wrong, flagged separately

`_deliverTicketSpec`'s OLD header comment claimed it returned
`{ delivered }/{ parked }` "via the gated pipeline". It never did — it flattened
both into `delivered`. That is worse than a gap: a reader checking the contract
would have concluded the parked case was already handled. Comment rewritten.
