# scratch-mark.js

## boundaryAt

Claude Code 2.1.278 ends a turn with an `assistant` record carrying
`message.stop_reason: "end_turn"`, immediately followed by a `system` record with
`subtype: "turn_duration"`. One API message with text + tool_use is written as TWO
`assistant` records sharing a `message.id`, both `stop_reason: "tool_use"` — so the
record that carried the intent text is not necessarily the end of the turn.

## validateScratchCut

Cutting a span whose kept set holds a `tool_use` with no matching `tool_result` is
SILENT in 2.1.278: on resume the CLI re-parents the orphan and fabricates a
`No response requested.` assistant turn. Measured with wirescope; that is why the
pairing check refuses instead of trusting the CLI to notice.
