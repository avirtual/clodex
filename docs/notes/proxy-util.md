# docs/notes/proxy-util.md

## QUOTA_WINDOW_LABEL

The API's window keys (`5h`, `7d`, `7d_oi`, `overage`) against the names Claude
Code's own panel shows the operator — "Current session", "Current week (all
models)", "Current week (Fable)". The operator compares the two side by side, so
the chip's `short` and the tooltip's `long` must come from one table: them
disagreeing about which window is which is the confusion this replaced.

## quotaWindows

Only windows carrying a percentage are returned, and `quotaChip` scans the
level over exactly those. An org with overage disabled publishes `overage` at
status `rejected` with a null `used_pct` on every single payload, so a level
scan over the raw map would hold the chip permanently loud over a segment it
never renders.

## quotaChips

One chip per ACCOUNT, because the account is the unit the quota is charged
against: with two subscriptions in use the point is watching which pool empties
first, and a readout keyed on whichever org header arrived last just alternates
between them. The `pickQuota` selection rule runs unchanged WITHIN a label, so
a wirescope fallback still loses to a wire reading for the same account.

The label is prefixed only when two or more chips survive. One subscription must
read exactly as it did before this existed, and a lone `default · ` prefix is
noise for an operator with nothing to tell apart.
