# verdict-nudge

## proseVerdictNeedsNudge

Measured: a cold reviewer seat wrote a 6 KB verdict as ordinary output and the ticket sat in verify for twenty minutes; the watchdog's reviewer clause reads growth and CPU only, so a prose-verdict turn looks healthy to it.

`reviewFor` is the reviewer-seat key rather than `reviewTicket`, which a manual `[agent:team-review]` never stamps.

## PROSE_VERDICT_NUDGE

The `_verdictNudged` latch is set before delivery, never cleared: a second prose verdict is the watchdog's case, not a second nudge.
