# transcript-records.js

## midTurnRecords

Claude-only: codex and muse write no queue record for a message typed mid-turn, so `claudeShaped` has nothing to map to a `queued_command` attachment.

Every record parsed from the attachment (prompt, inbound or reply card) is stamped `source:'mid-turn'` and none of them opens a turn; only the prompt carries `state`.

## recordsOf

A `queue-operation` `enqueue` (string `content`) is written when the operator sends while the agent works; `remove` with `reason:'absorbed_mid_turn'` and the same `content` lands 1-2 lines before the `queued_command` attachment that carries the enqueue's timestamp.
`dequeue` carries no `content` and pops the queue FIFO when the CLI starts the next turn; the popped message then arrives as an ordinary `user` record.
