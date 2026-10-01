# stall-evidence.js

## lastToolFrom

Claude Code 2.1.286, resuming a session SIGKILLed mid-tool-call, appends a `tool_result` for the orphaned call (`is_error: true`, text "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. …]") on a record carrying the top-level marker `toolDenialKind: "interrupted"`, which a real result lacks.
