# scratch-mark.js

## boundaryAt

Claude Code 2.1.278 ends a turn with an `assistant` record carrying `message.stop_reason:
"end_turn"` followed by a `system` record with `subtype: "turn_duration"`; one API message with text
+ tool_use is written as TWO `assistant` records sharing a `message.id`, both `stop_reason:
"tool_use"`.

## validateScratchCut

Cutting a span whose kept set holds a `tool_use` with no matching `tool_result` is SILENT in
2.1.278: on resume the CLI re-parents the orphan and fabricates a `No response requested.` assistant
turn.
