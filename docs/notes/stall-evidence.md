# stall-evidence.js

## lastToolFrom

Claude Code 2.1.286, resuming a session SIGKILLed mid-tool-call, appends an `is_error` `tool_result` for the orphaned call whose record carries `toolDenialKind: "interrupted"` and `toolUseResult` "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. …]"; a user interrupt (Esc) writes the same field with "Error: [Request interrupted by user for tool use]", so the reading keys on the field plus the `[Tool call interrupted:` prefix.
