# seat-import.js

## createSeatImport

The owner-side fs half of "Move Session… to a peer": the destination stages a
seat's bytes under `<root>/import/<id>/` and installs them atomically. Pure fs,
deps injected — no HTTP, no session-manager. M-A2 wraps it in routes and calls
the far `create()` with the `record` this returns unchanged.

Staging is `<root>/import/<id>/manifest.json` (`{name, record, startedAt}`) plus
`<root>/import/<id>/files/<relPath>`, mode 0o700, `id` 16 hex. One staging per
name at a time: a second `begin` for a live name refuses rather than racing two
transfers onto one install path.

## putFile

The route layer turns `Content-Range` chunks into `putFile` calls, so `offset`
must equal the file's current size — a reordered or duplicated chunk is refused
instead of corrupting the file, and the size on disk is the only resume cursor.

Confinement is a whitelist of shapes, not a blacklist of escapes: every segment
matches `[A-Za-z0-9._-]+` and is neither `.` nor `..`, the first segment is one
of five known entries, and under `seat/` the second is a `SEAT_KINDS` key other
than `run`. `run` is regenerated at spawn and moving it would carry a dead
socket, which is why `migrateSeatLayout` deletes it too.

A cap breach writes `<staging>/failed`; `putFile` and `commit` both refuse while
that file exists. The running total is re-walked from disk per call rather than
held in memory: the bytes survive a process restart mid-transfer and a counter
in a factory instance does not.

## commit

Checked entirely, then written, so every refusal leaves the tree byte-identical.
The collision set is `renameTargets` plus `pending/<name>`, reused from
seat-layout rather than re-derived — one list, and rename's refusal and this one
cannot drift apart.

Transcript bytes are OPAQUE and never parsed: the CLI owns that format, a
partial parse here would reject a transcript the far CLI reads fine, and
`--resume` only needs the file to exist under the far encoding of the far cwd.
`claudeProjectSlug` is that encoding and lives in clodex-paths so engine.js and
this module cannot disagree about it.

An existing transcript at the target is a refusal UNLESS its size and sha256
match the staged one, which makes a commit that died after the transcript
landed re-runnable: the retry reports `installed.transcript = 'identical'`,
skips the write, and installs the rest. Never overwrite — the file may be a live
seat's.

`ensureSeatLink` is called for every importable kind after the seat dirs land.
On an UNMIGRATED box it is inert (no marker), so the seat dir still installs and
the legacy spelling stays absent until the next launch's migration adopts it —
correct, not a gap.

`seat.json` is deliberately not written: the persistence store writes it on the
far `create()`, and a copy written here would be a snapshot of the record before
M-A2 strips exec grants from it.

Reminder rows are re-added through the far store so ids are minted there, and
`ticket` is dropped to null: a ticket id names a row on the SOURCE box's board,
which the far box never had, so a bound reminder would be cancelled by whatever
happened to reuse that id — or never. The count rides `dropped` as
`reminders.ticket-bound:<n>`.

`dropped` also carries `account` when the record has `env.CLAUDE_CONFIG_DIR`.
This module maps nothing; it reports the field is present so M-A2 can resolve it
by label through accounts.js.
