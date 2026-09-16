# cli/src/verbs.js

## logsFollow

`seq` is an index into the merged message list of whatever jsonl
`run/<name>/transcript.jsonl` currently points at (transcript.js `jsonlToMessages`),
and a restart repoints that symlink at a fresh file (session-manager.js, the
SessionStart hook at CLI boot). So the follow cursor can legitimately need to move
BACKWARDS: after a restart the new transcript's seqs start at 0 and every
`since=<old lastSeq+1>` page comes back empty forever. The node-wide `/api/events`
stream survives the restart, so nothing else signals it — an empty-page streak is
the only evidence available to the client.
