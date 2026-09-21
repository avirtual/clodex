# intent-spill notes

The format leaf for intent-body spill. Format spec: `proxy-lab/SPILL.md`;
conformance arbiter: `proxy-lab/test_spill.py`. The line state machine and the
SSE rewriter that consume this live in `wire/spill.js`.

## writeSpill

The file holds the body bytes EXACTLY — no header, no trailing newline. This is
deliberately NOT `engine.js`'s `spillToFile` (message spill), which prepends a
`From:/Time:/Size:` header: the resolver substitutes these bytes verbatim into a
ticket spec, so three lines of chrome inside a spec is a corrupted spec.

Synchronous on purpose: the pointer may not be emitted before the bytes are
durable (write-then-rewrite, never rewrite-then-write), and spills are rare and
capped at 256 KiB. `atomicWriteFileSync` already does temp + fsync(file) +
rename + fsync(dir), which is exactly that durability.

An existing file is left alone rather than rewritten. Content-addressing makes a
re-emission (a retry, a `--resume`) land on the same path, and not rewriting
removes any torn-read window.

Any failure at all returns null, and every caller forwards the original body on
null. A truncated task spec is far worse than a spammy transcript.

Nothing sweeps what this writes. Files are capped at 256 KiB and a handful a day
per lead; a compact summary can carry `@spill:<id>` as prose indefinitely, and
the CLI's own transcript retention is not something Clodex tracks. `spill/` sits
at the ~/.clodex root precisely so it survives the `rm -rf` of `run/<name>/` on
exit, and it is deliberately NOT removed by forget/delete/team-delete — a
re-minted name reuses the dir and content-addressing makes that harmless.
`engine.js`'s `sweepSpilledMessages` must never be pointed here: it deletes by
30-minute age. A future sweep would be mtime-age >= 90 days over the whole root,
one policy, recorded beside that function.

## AGENT_RE

Mirrors clodex's seat-minting rule. Dots are LEGAL and only an all-dots name is
rejected: `.hidden` is a seat name this repo pins elsewhere, and a narrower
charset would have silently denied the feature to a seat called `t42.fix`
rather than failing loudly. `\n` is rejected explicitly because JS `$` has no
trailing-newline leniency to rely on but the value becomes a path component.

Containment does NOT rest on the regex — `..` and `.` are spelled entirely
within that charset. `spillDirFor` runs `confine()` and returns null unless the
join is a direct child.

## resolveSpill

`lstat` plus `O_NOFOLLOW`, so a symlink planted at `<id>.md` reports
`not-a-file` rather than handing back whatever it points at.

An empty file is a refusal (`empty`), never `''`: an empty ticket spec is the
one outcome worse than a stall.

## POINTER_RE

The body must be the pointer alone, or ONE line ending in ` @spill:<id>` with at
most 80 chars of title before it (`TITLED_POINTER_RE`) — the shape the tee
writes, and the shape a resumed seat replays from a transcript already on disk.
Resolved on the jsonl and recovery scans only: on the wire path the model never
receives a stub (`wire/spill-cut.js`), so a pointer body there is typed from
memory and `_handleIntent` bounces it under `fromWire`. On those scans the
tee's stub is expanded by `_expandReceipts` BEFORE `shadowIntentKey` is taken,
so a tee-failure replay keys equal to the wire's original claim and is dropped as
a cross-path overlap; a stub whose file is gone is left for `_handleIntent` to
bounce. Anything else is prose used verbatim. That is what makes a cross-seat read inexpressible: a peer's
`@spill:<id>` copied mid-prose is never resolved, and a pointer resolved at all
is resolved against the SENDER's own directory.

## RECEIPT_RE

The tee's FORMER placeholder (t1047–t1052), `(I sent <words> — "<title>" in
full, N B; Clodex kept my text at <path>.)`; `SPILL_FILLER` is the t1052-era
empty-block note. The tee writes neither any more; both stay recognised because
`wire/spill-cut.js` still cuts them out of older transcripts and live seats can
still copy them. Receipts are expanded only on the non-wire scans (the
sentinel's recovery replay, `_scanJsonlText`). `mimicKindOf` is what the spill
filter runs on its input: a receipt, a lone filler line, or a bare / titled /
intent-headed `@spill:<id>` line (kind `pointer`) can only have been typed
there; the bounce never echoes any of the shapes. The verb words must name a
`SPILL_VERBS` key or a receipt line is prose.

## resolveReceipt

The receipt carries an absolute path, so confinement is a POSITIVE check that
`confine(spillDirFor(root, agent), basename)` resolves to the very same path —
a receipt pasted from another seat's transcript, or with an edited path, is
`outside` before any stat.

The title is DISCARDED at resolution: the file is authoritative, so an edited or
stale title cannot change one byte of what the recipient gets.

## SPILL_VERBS

The set now holds `dm` and `task.done` too: both have exactly one recipient who
reads the text out of a file, so the sender need not carry it. A dm head's SECOND
token is a target (`[agent:dm bob urgent]`), never a sub-verb, which is why the
tee tries the one-word key before the two-word form. `proxylab/spill.py`'s
`_verb_key` does NOT: it would key that head `dm.bob` and hold nothing, so the
ordering is a deviation the next vendor port has to keep.

`context.compact`, `context.clear` and `context.reload` are OUT: a body the
triggering action discards is never carried forward, so there is nothing to
save — the compact summary replaces it and a clear or reload wipes the
conversation. The handoff still reaches the fresh context through
`_handoffText`, which files it once and injects `Continue from your handoff:
@<path>`. `proxylab/spill.py` still lists the three; wirescope owns that file.

The operator-inbox key is `shout`. The vendored conformance suite
(`proxylab/spill.py`) still gives `'notify-user'` as its one-word-verb example —
that spelling was retired here with no alias, so the next vendor port must not
re-derive it from that docstring.

## capResumeSnapshot

The board block is the only part that gives way under the cap. Host, git and
roster answer questions a truncated board cannot, and a resume that lost them
spends the turn it was saving re-asking for them.
