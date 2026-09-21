# Files a seat references, over the phone-access server: contract

Purpose: let a client that cannot open local paths (ClodexApp on iPhone, the web
host in a browser) discover and read the files an agent's transcript points at —
spilled intent bodies, context handoffs, spilled inbound messages, tool-touched
files. Written by the Clodex lead with the clodex-ios lead (2026-09-21); the
Clodex side implements it in `engine.js` / `remote.js` / `session-manager.js`,
the app side in ClodexKit. Both sides build against this file.

## What exists today (Clodex repo, reference)

- `POST /api/sessions/:name/query` body `{kind, args}` (`remote.js` `_handleQuery`
  → `remote-wiring.js` `query` → engine fetchers). Same operator-token auth as
  every route. Advertised as `"query"` in `/api/peer/hello` `caps`.
  - `files` → `{ok, cwd, files: Touch[]}` — the seat's tool-touched files
    (`engine.js` `fetchSessionFiles`, `session.fileTouches`).
  - `filePeek` args `{path}` → `{ok, size, mtime, truncated, binary, content}` —
    first 512 KB (`file-edit.js` `PEEK_MAX_BYTES`) as UTF-8, `content: null` when
    binary. Reads ANY absolute path.
  - `fileDiff` args `{path}` → git diff of that path in the seat's repo.
- Three writers put pointers into a seat's transcript, into two directories:
  - `~/.clodex/spill/<seat>/<16hex>.md` — long intent bodies filed by the wire
    tee (`intent-spill.js` `writeSpill`; terminal shows
    `<head> [<title> — ]<size> filed at <abs path>`), and context handoffs
    (`session-manager.js` `_handoffText`, shown as
    `Continue from your handoff: @<abs path>`).
  - `~/.clodex/messages/<seat>/msg-<pid>-<n>.txt` — inbound message bodies over
    500 bytes (`engine.js` `spillToFile`, `MSG_SPILL_THRESHOLD`), shown as
    `[agent:from X] Message (N bytes) attached: @<abs path>`; also rejected and
    denied intent bodies (`spillToFile('<verb> (rejected)', …)`).
- The global SSE `/api/events` already carries `dm-mail {origin}` as a payload-free
  refetch signal (`remote.js` `notifyDmMail`). The iOS app holds exactly one
  stream — this one — and polls the transcript; it never holds a per-session
  attach stream, so anything emitted only on `/attach` does not reach it.

`~/.clodex` above is this host's default; every path in this document is really
`<REGISTRY_DIR>/…` — see the confinement section.

## Changes to the host

### 1. `files` gains `filed`

```
POST /api/sessions/:name/query   {kind: "files"}
  -> 200 { ok: true, cwd, files: Touch[], filed: Filed[] }
```

`Filed = { path, kind, head, bytes, ts }`
- `path` — absolute, `path.resolve`d, byte-identical to the string as it appears
  in transcript text. Never `~`-abbreviated. The client matches these literals
  against transcript text to make rows tappable; a mismatch is a silently dead
  row, so this is the invariant the whole feature rests on.
- `kind` — `"intent"` (wire-tee spill), `"handoff"` (context handoff),
  `"message"` (inbound message spill, incl. rejected/denied bodies).
- `head` — one line, ≤ 120 UTF-8 BYTES, cut back to a character boundary
  (never a replacement character): the intent head + title for `intent`
  (`[agent:task add hand] Regenerate the append prompt…`), `handoff` for
  handoffs, `From: <sender>` for messages.
- `bytes` — body size on disk. `ts` — ms epoch of the filing.

`filed` is newest first, capped at 50 entries INDEPENDENTLY of `files` (one list
cannot push the other out). Entries whose file no longer exists at list time are
dropped. Source: a per-seat in-memory ring appended at each writer (`writeSpill`
callers via the `wire.on('spill')` listener and `_handoffText`; `spillToFile`
call sites), seeded on `create()`/resume by listing both directories by mtime so
a restarted host still lists earlier filings.

### 2. `filePeek` gains a range and hard error codes

```
POST /api/sessions/:name/query   {kind: "filePeek", args: {path, offset?, length?}}
  -> 200 { ok: true, path, size, mtime, offset, length, truncated, binary, content }
  -> 4xx { ok: false, code, error }
```

- `offset` (default 0) and `length` (default and max: server's `PEEK_MAX_BYTES`)
  are BYTES. The server clamps `length` and echoes the range it actually
  returned, so the client needs no arithmetic; `truncated` is
  `offset + length < size`.
- `content` is always valid UTF-8: if the cut lands inside a multibyte sequence
  the server trims back to a boundary and reports the trimmed `length`. Never a
  replacement character.
- `binary: true, content: null` for a file with a NUL in its first 8 KB; the
  client renders "binary, N bytes" and offers nothing.
- Error codes (machine-readable `code`, human `error`):
  - `outside` (403) — path is outside what the client may read (see 3).
  - `not-found` (404) — nothing at that path.
  - `gone` (410) — path was listed in `filed` for this seat but the file has
    since been removed (the ordinary case for a cleaned-up spill, not an edge).
  - `not-a-file` (400) — directory, symlink, device.
  - `unreadable` (500) — stat/read failed for another reason.

### 3. Confinement

A `filePeek` (and `fileDiff`) arriving over the phone-access server may read only:
- the seat's `cwd` tree (resolved; symlinks inside must not escape),
- `<REGISTRY_DIR>/spill/<seat>/`,
- `<REGISTRY_DIR>/messages/<seat>/`,
- the project's task-artifact dir `<REGISTRY_DIR>/projects/<leaf>-<hash>/tasks/`.

`<REGISTRY_DIR>` is the RUNNING host's registry root (`engine.js` builds
`MSG_DIR` from it), never a literal `~/.clodex` and never `os.homedir()` +
`.clodex`: a second Clodex on the same Mac (clodex-ios runs one at
`~/.clodex-ios`) would otherwise answer `outside` for every one of its own
filings. The same root drives the directory listing that seeds `filed` on
resume (section 1).

Anything else is `outside`. The check runs on the resolved real path, so a
symlink planted inside cwd pointing at `~/.ssh` is refused. Desktop peer
behaviour (the peer file drawer over the peer link) is unchanged — confinement
is applied in the remote query path, not in `fetchFilePeek` itself.

### 4. Live signal on `/api/events`

Event name `filed`, data `{ name }` — pure refetch signal, no payload, same shape
as `dm-mail`. Fires from every writer in 1 (intent spill, handoff, message
spill) for the seat named. The client refetches `files` for that session and
re-scans the visible transcript for the new literal.

### Capability flag

`/api/peer/hello` `caps` gains the string `"filed"`. `query` is a subresource
route only (`/api/sessions/:name/query`), so a host advertising `filed` serves
subresource routes by construction; no host will advertise `filed` while serving
legacy top-level routes, and the client may treat the flag as the only
discriminator. A host without it serves the
old `files` reply (no `filed` array) and an unconfined, rangeless `filePeek`;
the client must treat a missing `filed` as an empty list, not an error.

## App-side behaviour (ClodexApp) — owned by clodex-ios

- Transcript detail: on load and on each `filed{name}` event, fetch `files`;
  make every `filed[].path` literal in the visible transcript tappable.
- Tap → file sheet: `filePeek` with `{path, offset: 0, length: 64*1024}`,
  "load more" advances `offset`; render `binary` and each error `code` with its
  own sentence.
- No regex over terminal bytes; no per-session SSE; no mtime polling.
- Send side needs nothing: the composer already mirrors `MSG_SPILL_THRESHOLD`.
