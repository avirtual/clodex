# ctx-reminder

## CTX_REMINDER_NUDGE_TOKENS

Baseline 150k nudge / 200k escalate, absolute input tokens. On Opus-shaped
pricing a compact is cheap and a long warm context is expensive, so the baseline
sits low; replaying a real 25-day stream, 150k-175k costs within ~1% and the
curve bends upward past 200k.

## CTX_MODEL_THRESHOLDS

Fable 5.1 ships the only row, 200k/250k (operator price data, 2026-09-20). Its
price shape is inverted against Opus: a warm cache read is 1/40 of a cold read
and a cache write is 80x a warm read, so Fable reads at about half Opus's rate
and writes at about twice. The compact is the most expensive event in a Fable
session, so it is deferred. This supersedes the earlier "stay under 200k for a
possible long-context surcharge" rule for this family.
