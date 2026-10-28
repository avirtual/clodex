# ctx-reminder

## CTX_REMINDER_NUDGE_TOKENS

Baseline 150k nudge / 200k escalate, absolute input tokens. On Opus-shaped
pricing a compact is cheap and a long warm context is expensive, so the baseline
sits low; replaying a real 25-day stream, 150k-175k costs within ~1% and the
curve bends upward past 200k.

## CTX_MODEL_THRESHOLDS

Two rows ship. Fable 5.1 sits at 200k/250k (operator price data, 2026-09-20). Its
price shape is inverted against Opus: a warm cache read is 1/40 of a cold read
and a cache write is 80x a warm read, so Fable reads at about half Opus's rate
and writes at about twice. The compact is the most expensive event in a Fable
session, so it is deferred. This supersedes the earlier "stay under 200k for a
possible long-context surcharge" rule for this family.

Haiku 5.5 sits at 75k/100k with `stop: true`: `ctxReminderFor` then words the
reminder as "stop now, do not compact" instead of a compact nudge. A `stop` row
is exempt from session-manager.js's `_ephemeralSeat` suppression, so a ticket
seat still gets it. An operator override row for the family drops `stop`
(`ctxThresholdsFor` never carries it from settings), turning the wording back
into compact nudges.
