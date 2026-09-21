# ipc-prompt-cache.js

## readPromptSnapshot

Claude CLI 2.1.278 writes a `{"type":"attachment","attachment":{"type":"prompt_snapshot","systemPrompt":[…],"tools":[…]}}`
row into its transcript at cold boot (two rows seconds apart; the second carries `tools`), after a
`/compact` (two rows, ~90s after the intent, once the summary has landed) and after a `/clear` (two rows
in the newly minted session's file). Our `--append-system-prompt-file` text is the LAST `systemPrompt`
block, byte-identical to `run/<name>/append-prompt.md` at the boot that read it (trailing newlines
included; checked on five live seats). A `--resume` boot usually writes no row at all.

The rows of a cold boot can differ from each other by a few bytes (one seat's first row carried
`���` where the second carried `—`); the LAST row is the one to trust.

Files reach tens of MB, so the scan reads 1 MiB chunks from the tail, decodes complete lines only,
and `JSON.parse`s a line only when it contains the literal `"prompt_snapshot"`.

Two hypotheses fit every measurement above and the code does not distinguish them: H1 — a
`--resume` boot re-reads the append file and a compact does not (clodex's 20:45:28Z resume boot,
whose later compact rows carry the file's text); H2 — a compact re-reads the file at the moment the
`/compact` is issued, before `refreshPrompt` used to rewrite it, and a resume does not (wirescope's
12:30:13Z compact whose 12:31:50Z rows predate nothing but the rewrite). Under either, once the file
is never rewritten under a live CLI and a resume bakes the snapshot block, `session.md`, the file and
the snapshot converge; the only divergence is a one-time over-delivery on a seat damaged before
this shipped.

## readPromptSnapshotMemo

A resumed seat that never compacted has its only rows at the HEAD of the file, so a plain scan is a
full backward read of the whole transcript on the main thread, per seat, at restore-on-launch and
at every compact. Transcripts are append-only, so `promptcache/<name>/snapshot.json` remembers the
real path, the offset of the last complete line and the block found; the next call scans only the
bytes past that offset and falls back to the remembered block when nothing newer is there. A
different real path (a `/clear` repoints the symlink to a new file) is scanned in full.

## followSnapshot

The "last systemPrompt block is ours" invariant holds only when a non-empty block was baked. A lean
seat (`CLODEX_DISABLE_IPC_PROMPT=1`, no appends, no team block — the shipped reviewer templates)
bakes an empty file; if the CLI skips an empty append, that seat's last block is a CLI block, and
following it would duplicate that block into `append-prompt.md` and tell the agent its CLAUDE.md
was "removed", with no self-heal. So an empty snapshot, an empty `session.md`, or no cache at all
with nothing to bake, refuses to follow.

## bakePrompt

Measured on 2026-09-21: the CLI does NOT re-read `--append-system-prompt-file` at a compact or a
clear; the system block it runs afterwards is rebuilt from its own snapshot. `refreshPrompt` used
to rewrite the file and re-bake `session.md`/`notified.md` at both edges, which left every seat that
had compacted running an older prompt than our files claimed, with the gap never staged again.

- wirescope: `/compact` at 2026-09-21T12:30:13Z; `[prompt] refreshed wirescope (compact) — 24617
  bytes` at 12:31:48.972Z; the CLI's `prompt_snapshot` rows at 12:31:50.728Z and 12:31:59.262Z still
  carry the 2026-09-20T22:39 text (24232 bytes, sha256 27544faef480…), as did the rows of its 09:00
  `--resume` boot.
- clodex (the `/clear` finding, verbatim): `[intent] clear clodex → /clear (+continuation)` at
  2026-09-20T20:43:37.141Z; `[prompt] refreshed clodex (clear) — 58009 bytes` at 20:43:37.545Z; the
  minted session `8f2353a5-0fd4-41bd-a117-a52736f29e6b` has `prompt_snapshot` rows at
  20:43:39.220Z and 20:43:45.987Z whose last block is the PREVIOUS text (56320 bytes, sha256
  59e5a95996…), not the 58009-byte file written 1.7s earlier. The 58009-byte text first appears in
  that session's rows at 2026-09-21T00:08:11.044Z, after the seat was respawned with `--resume` at
  20:45:28Z (a boot that read the file) and compacted at 00:06:33Z. So a `/clear` does NOT write a
  fresh snapshot from the current file: the clear site gets the same no-advance treatment as compact.

Hence on a resume the baseline for `session.md` is the transcript's last snapshot block: when it
differs, both `session.md` and `notified.md` are reset to it and the whole snapshot→realIpc gap is
staged. Without a snapshot row (older CLI, transcript missing) the behaviour is the pre-existing one.

## restageAtReset

Runs from `refreshPrompt` at a compact or clear, in the same instant the CLI's SessionStart hook
resets `notified.md := session.md` through a different channel, in either order. The hook keeps a
staged pair whose baseline is `session.md` itself (`notified.md` equal to it) and drops one staged
against an advanced baseline; this function always resets `notified.md` to the baseline before
staging, so both orders leave the full gap staged. The prompt file is never rewritten here.
