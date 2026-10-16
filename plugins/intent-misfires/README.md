# Intent Misfires

A table of every intent the seats of this window's workspace emitted that
Clodex could not act on as written. Opens from the "Misfires" button in the
sidebar footer.

Columns: time, seat, kind, intent (verb and sub-verb or exec command), the nag
or refusal text the seat was shown (the full text on hover), and the seat's
context tokens at that moment (the reply's byte size on hover). A header line
counts misfires per seat and kind. Filters narrow by seat and by kind.

Kinds: `unclosed-body`, `empty-body`, `disabled`, `schema`, `exec-refused`,
`bounce`, `truncated-head`.

## Scope

The engine half answers `list` with the rows whose seat belongs to the asked
workspace — running (`host.sessions.listWorkspace`) or saved
(`host.sessions.listSavedWorkspace`). It never reads the global session list.

## Reading

The rows come from `<userData>/intent-misfires.jsonl`, which core appends one
line to per misfire and prunes to the newest 5000 lines once it passes 6000.
The path is derived as two levels above `host.paths.dataDir`. A missing file is
an empty list; an unparseable line is skipped.
