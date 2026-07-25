# t24 — docs/ split by audience

Landed: `667ac4f` on `plugin-phase-1`. Suite green 2529/2529.

14 WORKING docs → `~/.clodex/internal-docs/` (removed from the tree), 13 PRODUCT
docs stay. ~120 inbound refs annotated `<name>.md [internal design doc, not in
this repo]` — location-free by ruling, so a public reader learns what the
reference IS, not where our filesystem puts it. Full report in the ticket.

Open, not mine: `vendor/wirescope/proxylab/pot.py` cites `boiling-pot-plan.md`
in a header comment. Reverted deliberately — vendored code, not ours. The
reference is honestly stale; clodex rules on it.

## PROCESS TRIGGER — close-then-report

**The ticket is closed when the intent fires, not when the report reads as
finished.**

Fired twice in one day (t23, t24): both times the work was done, the commit
landed, and the report was complete — and both times the watchdog flagged a
stalled seat, because `[agent:task done <id>]` was never emitted. The failure
mode is specific and worth naming: **a long, satisfying report FEELS like the
completion**, so the close gets skipped precisely when the work went well. The
better the report, the likelier the miss.

Trigger: finishing a report body → emit the close intent BEFORE writing any
operator-facing prose. From outside, an open ticket with no output is
indistinguishable from a crashed seat; nobody can tell a finished job from a
dead one by looking at the board.
