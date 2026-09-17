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

## get

`get doc <name>` is the ONE singular get that routes to the describer instead of
answering "takes no name". Every other node resource points you at `describe`,
because its single-get view is a different rendering of a row you already saw in
the list. A doc page is not in its list at all — the list carries name/title/
section, never content — so pointing at `describe doc` would be a redirect with
no information behind it, and `get doc <name> -o json` is how an agent pulls a
page it can pipe. `describe doc <name>` still works and prints the same block.
