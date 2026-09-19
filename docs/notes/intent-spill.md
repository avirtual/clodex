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

The WHOLE body must be the pointer, or the body is prose used verbatim. That is
what makes a cross-seat read inexpressible: a peer's `@spill:<id>` copied into
prose is never resolved, and a pointer resolved at all is resolved against the
SENDER's own directory.
