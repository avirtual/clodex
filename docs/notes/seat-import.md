# seat-import.js

| route | method |
| --- | --- |
| `POST /api/import/begin` | `begin({name, record})` |
| `PUT /api/import/<id>/file/<relPath...>` | `putFile({id, relPath, bytes, offset})` |
| `POST /api/import/<id>/commit` | `commit({id})`, then the injected `importCreate` |
| `DELETE /api/import/<id>` | `abort({id})` |

## createSeatImport

The owner-side fs half of Move-to-peer: the destination stages a seat under
`<root>/import/<id>/` and installs it atomically. Staging is `manifest.json`
(`{name, record, startedAt}`, 0600 — it holds `record.env`) plus
`files/<relPath>`, dirs 0700; one per name, so two transfers cannot race.

## ID_RE

Exactly the 16 hex `begin` mints, required by every entry point along with a
readable manifest. The charset regex guarding a relPath SEGMENT is not enough
for an id, which is a whole path component fed to `path.join`, and `path.join`
NORMALIZES: `.` and `..` are spelled in that charset, so `join(root, 'import',
'..')` is the registry root and `abort` would `rm -rf` it. Both are
attacker-controlled; neither gets a looser grammar than `begin` mints.

## putFile

The route layer turns `Content-Range` chunks into these calls, so `offset` must
equal the file's current size — a reordered or duplicated chunk is refused
instead of corrupting the file, and the size on disk is the only resume cursor.
Confinement is a whitelist of shapes, not a blacklist of escapes: every segment
matches `[A-Za-z0-9._-]+` and is neither `.` nor `..`, the first segment is one
of five known entries, and under `seat/` the second is a `SEAT_KINDS` key other
than `run` — regenerated at spawn, so moving it would carry a dead socket. A cap
breach writes `<staging>/failed` and both `putFile` and `commit` refuse while it
exists; the byte total is re-walked from disk per call, because the bytes
outlive a restart mid-transfer and an in-memory counter does not.

## commit

Checked entirely, then written, so a CHECK-phase refusal leaves the tree
byte-identical. The write phase cannot promise that: an fs error there (the
transcript copy, a seat-kind rename, the pending or loadlog rename, a reminder
add) comes back as `install failed: <msg>` carrying `installed`, which names
what did land — a return rather than a throw, but not a rollback. The collision
set is `renameTargets` plus `pending/<name>`, reused from seat-layout, so
rename's refusal and this one cannot drift apart.

Transcript bytes are OPAQUE and never parsed: the CLI owns that format and
`--resume` only needs the file under the far encoding of the far cwd, which is
`claudeProjectSlug` (in clodex-paths, so engine.js cannot disagree) of the cwd
VERBATIM — which is why `begin` refuses a `record.cwd` that is not already
`path.resolve`d: the far `importCreate` spawns in the resolved path, so `/a/b/`
would slug the transcript under a dir the resumed CLI never reads and `--resume`
would silently start a new conversation. An existing
transcript is a refusal UNLESS its size and sha256 match the staged one, making
a commit that died after the transcript landed re-runnable: the retry reports
`installed.transcript = 'identical'` and installs the rest. Never overwrite —
the file may be a live seat's. `ensureSeatLink` then runs per importable kind;
on an UNMIGRATED box it is inert, so the dir installs and the legacy spelling
waits for the next launch's migration. `seat.json` is not written here — the
persistence store writes it on the far `create()`. Reminder rows are re-added
through the far store so ids are minted there, and `ticket` is dropped to null:
it names a row on the SOURCE box's board, so a bound reminder would be cancelled
by whatever reused that id, or never. Counted in `dropped`, as is `account` when
the record has `env.CLAUDE_CONFIG_DIR` — this module reports it; the route layer
replaces that entry with the account-by-label outcome.

## sweep

Removes stagings older than 1h. A crash between `begin`'s mkdir and its manifest
write leaves a dir nothing else reaps, so an unreadable manifest falls back to
the directory's `mtimeMs` rather than skipping it. NOT `birthtimeMs`: it is the
one stat field `utimesSync` cannot move, so a backdated subject would pin this
branch only on a filesystem that records a birthtime at all.

## begin

The far cwd's PARENT is what must exist, not the leaf: `importCreate` creates the
leaf on purpose (`ensureDir`, exactly as a local spawn does), while a path from
another box's home fails at the parent — which is the shape of the only move that
has ever gone wrong here. `refuseUnder` is injected rather than computed so this
module needs no knowledge of Electron's userData.
