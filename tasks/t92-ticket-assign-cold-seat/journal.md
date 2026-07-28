# t92 — ticket assignment to a cold idle seat parks silently while reporting assigned

Branch `t92-ticket-assign-cold-seat` off master `86f0209`.

## Phase A — source investigation (BEFORE any code change)

clodex posed two hypotheses and asked which the source says:

- (a) the ticket-assign path does not route through t82's wake logic at all;
- (b) it routes through it as a plain non-urgent dm that the cold-seat hold parks.

**The answer is NEITHER, and the evidence is conclusive.** The source on master
already does the right thing on both counts. What failed is the RUNNING HOST,
which predates the fix.

### What the current source actually does

Traced the whole path rather than the two named functions:

- `_taskAdd:4861` — `this._deliverTicketSpec(team, ticket, spec, session.name, true)`.
  **urgent=true**, with a comment giving exactly clodex's reasoning ("a ticket is
  a WORK ASSIGNMENT, not conversation. Parking it leaves the board saying
  'assigned' while nothing runs").
- `_taskAssign:4897` — same call, **urgent=true**, "same reasoning as dispatch".
- `_deliverTicketSpec:4766-4775` — returns the outcome **UNFLATTENED**:
  `{self}`, `{delivered}`, `{parked, reason}`, `{held, reason}`, `{undelivered}`.
  Its header says in terms: "The three non-error outcomes used to be collapsed
  into `{ delivered:true }`, which told the lead the spec landed in the two
  cases where it had not."
- `_ticketDeliverySuffix:4779-4784` — turns each outcome into lead-facing prose,
  and distinguishes parked from held deliberately ("parked WILL arrive (next
  turn), held will NOT").
- Both call sites append that suffix to the reply (`:4862`, `:4898`).
- `shouldHoldDm` (proxy-util.js:514) — `if (urgent || ...) return {hold:false}`.
  Urgent short-circuits the cost gate before it is ever evaluated.

So on master, an assign to a cold idle seat CANNOT silently park: urgent
bypasses the hold, and if something else holds it (the permission-dialog gate at
`:507-513`, which urgent cannot bypass), the suffix says so.

### The observed park file dates the failure precisely

The park file clodex cited is
`~/.clodex/pending/clodex-hand/1785243696137.000000014.bleuq.json`.

1. It has an **id segment** (`bleuq`). Per `parkDelivery` (pending-store.js:82),
   the id-bearing filename shape is minted only by `_parkHeldDelivery`
   (session-manager.js:5872), whose sole caller is `_gatedDeliver:5451` — the
   **cost/dialog-hold** path. Not `_maybeParkDelivery` (which parks id-less) and
   not a passive park. So the delivery was HELD by `shouldHoldDm`, which
   requires `urgent` to have been **false**.
2. Its timestamp prefix, `1785243696` → **2026-07-28 16:01:36 EEST**, matches
   the `Time:` header of clodex's dispatch dm (msg-55910-52) to the second.

So the spec was parked by the cost gate, with urgent false, at 16:01:36.

### Why urgent was false in a build whose source sets it true

- t82 (`16fb784`, "wake the assignee on ticket dispatch, and stop reporting
  parked/held as delivered") landed **2026-07-28 11:13:41**.
- The host process is **PID 55910**, started **Tue Jul 28 02:33:56** — confirmed
  as the host by `engine.js:912`, `msg-${process.pid}-${msgCounter}.txt`, which
  is why every message in this session is `msg-55910-N`.
- **02:33 is 8h40m BEFORE 11:13.** The running Electron main process loaded
  `session-manager.js` at boot and has never reloaded it.

Confirmed by reading the pre-t82 code directly (`git show 16fb784^`):

```
4719:  _deliverTicketSpec(team, ticket, specText, fromName) {        // no urgent param
4723:    const r = this._gatedDeliver(seat, fromName, `[ticket …] …`, false);   // hardcoded FALSE
4724:    return (r && r.error) ? { undelivered: true } : { delivered: true };   // COLLAPSED
```

That is hypothesis (b) exactly — non-urgent dm, cost gate parks it, outcome
flattened to `delivered:true` so the lead's reply says `ticket t91 →
clodex-hand` with no suffix. It is a faithful description of the code that was
RUNNING. It is not a description of the code in the repo.

**Conclusion: the defect clodex observed is real, was diagnosed correctly, and
was already fixed by their own t82 five hours before it bit them.** The board
lied because the process serving the board is from 02:33.

## Phase B — the design question, answered from the source

clodex framed the choice as **force a wake** vs **report honestly**, leaning
honest because forcing a wake re-bills a cold seat's context.

**The source says the choice is a false one, and t82 already took BOTH.** They
are not alternatives, because they answer different questions:

- `urgent: true` at `_taskAdd:4861` / `_taskAssign:4897` decides whether the
  seat is woken.
- the unflattened outcome + `_ticketDeliverySuffix` decides what the LEAD is
  told when the wake does not happen anyway.

The second is needed even with the first, because urgent is only best-effort:
the permission-dialog gate (`proxy-util.js:507-513`) holds regardless and
returns `noUrgent: true` to say so. `_deliverTicketSpec`'s own header makes the
point — that is exactly why the parked/held distinction has to reach the lead.

And the cost objection does not apply the way the framing assumes. Waking a
cold seat re-bills its context, but a ticket assignment is a commitment the
board has already recorded; the re-bill is paid the moment the work starts, and
an assignment that never starts is worth nothing. That is the argument written
into the comment at `:4857-4860` — clodex's own, from t82.

So there is no product change to make. **The correct fix already shipped.**
Anything I added to force a wake harder, or to report more honestly, would be a
second implementation of a decision the code has already made.

## Phase C — the real gap, and what I built

The live incident needs no code, but it did expose a genuine test gap.

**Every t82 parked/held pin drives the ADD path.** `t82 a HELD spec is NOT
reported as delivered` and `t82 a PARKED spec reads as parked` both dispatch
with `sub: 'add'`. But `_taskAssign` builds its reply on its OWN line
(`:4902`), with **two wordings** — the plain `ticket t1 → hand` and the
reassign `ticket t1: hand → reviewer`. Nothing held the suffix on either.

That matters because the assign path is the one the live incident took, and
because a fix applied to one reply wording and not the other is a completely
ordinary mistake that the suite could not have caught. Revert C below is
exactly that mistake, and only the new reassign test sees it.

Added three tests to `test/session-manager.test.js`, in a t92 block above the
t89/t82 status-notice tests:

1. `t92 assign: a PARKED spec reads as parked on the assign reply too` — parks
   from the assign onward (the `add` is left clean so the reply under test is
   unambiguously the assign one), asserts `parked` appears AND `NOT delivered`
   does not.
2. `t92 assign: a HELD spec tells the lead it did NOT land` — held must not read
   as success, and must say why (urgent cannot override a dialog hold).
3. `t92 reassign: the prev → next reply carries the suffix too` — parks only the
   NEW-assignee delivery, and asserts on the reassign wording specifically.

Each asserts the DISTINCTION (parked vs held vs delivered), not merely that a
notice appeared — per the false-green rule, a check that cannot tell the two
apart proves nothing.

## Phase D — revert proofs

Pristine copy taken first; every revert restored from it and verified
byte-identical (`restored clean: true` on all five).

| # | Corruption | Result | Failing message |
|---|---|---|---|
| A | pre-t82 collapse on assign (suffix `''`) | 3 fail | `the lead must be able to tell parked from delivered…` |
| B | suffix computed but dropped from the reply | 3 fail | same three |
| C | suffix kept on plain assign, **dropped on reassign only** | **1 fail** | `the reassign branch builds its own reply string…` |
| D | held wording made identical to parked | 2 fail | mine + the existing t82 add-path test |
| E | `urgent` true→false on assign | 1 fail | `the reassigned spec is a work assignment and must wake` (existing t82 test) |

All five fail **by message**. No crashes, no timeouts.

### ENTER checks

- A is the incident reproduced: it restores precisely the pre-t82 shape
  (`{delivered:true}` collapse, empty suffix) on the assign path, and all three
  new tests bite. This is the strongest evidence that the tests hold the actual
  defect rather than a proxy for it.
- **C is the one worth having.** It fails ONLY the reassign test, which is the
  whole justification for that test existing as a separate case: the two reply
  wordings are independent strings on one line, and a partial fix touches one.
  Without it, the third test would be near-duplicate coverage of the first.
- D failing BOTH my held test and the existing t82 add-path one is the right
  shape: the suffix builder is shared, so a corruption there should be visible
  from both paths. It confirms my tests observe the same seam, not a parallel one.
- **E is the honest negative result.** It fails an EXISTING t82 test and none of
  mine — my three do not pin the wake at all. That is correct and deliberate:
  the wake is already covered, and re-asserting it would be duplicate coverage
  that makes the suite look stronger than it is. Recording it because "my new
  tests did not fire" is the kind of thing worth stating plainly rather than
  quietly leaving out.

## Findings for the lead

1. **No product change. The fix already shipped as t82.** The observed defect is
   real and was diagnosed correctly, but it was a STALE HOST: PID 55910 booted
   02:33:56, t82 landed 11:13:41, the incident was 16:01:36. The running process
   is ~8h40m older than the fix.
2. **Neither hypothesis was right**, though (b) is a faithful description of the
   code that was *running* — just not of the code in the repo.
3. **The forced-wake vs honest-reporting question is already settled, and t82
   took both.** They answer different questions and neither substitutes for the
   other, because urgent is best-effort against the dialog gate.
4. **A real test gap existed on the assign path** and is now closed — including
   the reassign wording, which had no pin at all and which revert C shows is
   separately breakable.
5. **The general hazard: a long-lived Electron main process serves stale
   intent-handling code indefinitely.** Nothing in the source ages out, and no
   restart is implied by merging. Every fix to `session-manager.js` is inert for
   the running host until Bogdan restarts the app — so a lead can merge a fix,
   watch the same bug recur, and reasonably conclude the fix did not work. This
   is the same false-green class one level up, and it is worth a decision (a
   startup version/build stamp somewhere the lead can see?). Flagged, not acted
   on — out of scope for this ticket.

## Deviations / assumptions

- Ticket said "whatever you build, the test must distinguish delivered from
  parked". I built tests only, no product change, because the source already
  behaves correctly. Flagged rather than manufacturing a change to match the
  spec's shape.
- Left the `PENDING_DIR` park file from the incident in place — it is clodex's
  live pending store, not mine to clean.
