# transcript-records.js

## midTurnRecords

Claude-only: codex and muse write no queue record for a message typed mid-turn, so `claudeShaped` has nothing to map to a `queued_command` attachment.

Every record parsed from the attachment (prompt, inbound or reply card) is stamped `source:'mid-turn'` and none of them opens a turn; only the prompt carries `state`.

## recordsOf

A `queue-operation` `enqueue` (string `content`) is written for anything queued while the agent works — operator sends, but also task notifications and typed-in agent messages, which is why the emit step classifies each entry through `userRecords` and keeps only prompts; `remove` with `reason:'absorbed_mid_turn'` and the same `content` lands 1-2 lines before the `queued_command` attachment that carries the enqueue's timestamp.
`dequeue` carries no `content` and pops the queue FIFO when the CLI starts the next turn; the popped message then arrives as an ordinary `user` record. `popAll` pulls the queue back into the editor.

## userRecords

A subagent's report reaches the transcript as a plain `user` record with a string `content`, `promptId` set and no `isMeta`, `origin` or attachment — metadata-identical to a typed prompt (claude CLI 2.1.28x); only the `Another Claude session sent a message:` preamble plus the `<teammate-message teammate_id=…>` tag identifies it.
A subagent's idle notification arrives in the same wrapper with a JSON body `{"type":"idle_notification",…,"result":"<text>"}`; the card shows `result`.
