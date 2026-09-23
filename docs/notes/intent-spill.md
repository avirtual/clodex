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
per lead; a compact summary can carry a stub's path as prose indefinitely, and
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

## FILED_POINTER_RE

ONE line, `[<title> — ]<size>[ of prose] filed at <abs path>`: ≤80 chars of
title, the path under `spill/<seat>/`, basename the 16-hex id (`pointerText`
writes it; `spillSize`: `858 B` under 1024, else `5.2 KB`). The size is
REQUIRED: a body that merely names a spill file is an agent pointing a peer at
it. `POINTER_RE`/`TITLED_POINTER_RE` keep the pre-t1065 `@spill:<id>` shape
readable from transcripts on disk; `trailingPointerOf` is the t1062 guard's view
(either token ending any text, non-spill verbs). Resolved on the jsonl and
recovery scans only: the wire never carries a stub to the model
(`wire/spill-cut.js`), so one there is typed and `_handleIntent` bounces it
under `fromWire`. On those scans `_expandReceipts` expands the stub BEFORE
`shadowIntentKey` is taken, so a tee-failure replay keys equal to the wire's
claim and drops as a cross-path overlap; a stub whose file is gone is left for
`_handleIntent` to bounce. A stub resolves only against the SENDER's directory.

## RECEIPT_RE

The tee's FORMER placeholder (t1047–t1052), `(I sent <words> — "<title>" in
full, N B; Clodex kept my text at <path>.)`; `SPILL_FILLER` is the t1052-era
empty-block note. The tee writes neither any more; both stay recognised because
`wire/spill-cut.js` still cuts them out of older transcripts and live seats can
still copy them. Receipts are expanded only on the non-wire scans (the
sentinel's recovery replay, `_scanJsonlText`). `mimicKindOf` is what the spill
filter runs on its input: a receipt, a lone filler line, or a bare / titled /
intent-headed stub line, old or new shape (kind `pointer`), can only have been typed
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

## SPILLED_BODY_FIRST

The first two over-limit intent bodies of a session are never spilled: they
ride the transcript exactly as typed, no file, no `onSpill` (Bogdan's ruling
2026-09-23: a seat that has only ever seen stand-ins learns the stand-in as the
way a body is written; two real examples early teach the shape). The rule is
decided at the moment the body first appears (`SpillFilter._resolve`, counter
`intentSpills.count` on the proxy registration, owned by the session record)
and never revisited: re-rendering an older message on a later request rewrites
every byte behind it and busts the prompt cache. The prose arm (`_resolveTail`)
is neither counted nor exempt. The counter lives in process memory only, so a
restart (`--resume`, reload) grants two more full bodies — accepted.

From the third spill on, the wire cut renders the stand-in; the FIRST
stub-bearing assistant message of a request gets the long form
`[Runtime note: Clodex kept your first two long intent bodies in full as
examples and files later ones; this body was delivered in full and is not
carried in the transcript. Every new intent still needs its complete body;
never write this note.]`, every later one `SPILLED_BODY`. Message order is
fixed within a transcript, so the same message is first on every request until
a compact — cache-stable. Both literals are the `spilled` mimic kind and both
are refused as a typed body (`spilledBodyOf`), on the same bounce path.
