# transcript-records.js

## midTurnRecords

Claude-only: codex and muse write no queue record for a message typed mid-turn, so `claudeShaped` has nothing to map to a `queued_command` attachment.

Every record parsed from the attachment (prompt, inbound or reply card) is stamped `source:'mid-turn'` and none of them opens a turn; only the prompt carries `state`.
