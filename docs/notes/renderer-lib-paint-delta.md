# renderer/lib/paint-delta.js

## isBusyScreen
Codex keeps its composer and `Context N% used` footer on screen while a turn runs, with an `… esc to interrupt)` status row three rows above the input row (codex-idle-with-history fixture, v0.157.1), so the split view stays in split during a turn and the rows it paints are the turn's output, which the rollout already records.

## blockText
Codex echoes a slash command into its history as a bare `/status` row, not `› /status` (codex-after-status fixture, v0.157.0).
