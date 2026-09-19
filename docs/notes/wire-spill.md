# wire/spill notes

Format spec: `proxy-lab/SPILL.md`. Conformance arbiter for delimitation and the
sha: `proxy-lab/test_spill.py`, whose cases are ported into
`test/wire-spill-filter.test.js`. Two implementations now compute the same sha
over the same delimited bytes, so a drift here is a drift against a consumer
this repo cannot see.

## SpillFilter

Ported from spill.py's `_SpillFilter`, with ONE deliberate deviation: a line
that clodex's own scanner would treat as an intent line makes the filter bail
instead of swallowing it into the held body. spill.py delimits on the
terminator only; `_extractIntents` closes a greedy body at the next parseable
col-1 intent line, so a verbatim port would spill one body
`spec\n[agent:task add b] spec2` and the second ticket would vanish into the
first's spec. The deviation only shrinks which bodies spill; the bytes of a
spill are unchanged and every test_spill.py case still passes.

The nested-intent test is `cleanLine(line).startsWith('[agent:')`, which is
over-broad on purpose — a fenced example inside a spec bails too, because the
filter cannot know fences without reimplementing `fencedLines`. A bail costs the
saving on one response, never a spec.

`_originalHeld` reconstructs the head line as RECEIVED (`head + rawRest`) rather
than spill.py's `head + " " + body_text`. For a head line with nothing after the
`]` spill.py's form drops the source newline and adds a space; byte-identity on
the forward-original paths is the whole failure policy, so that inexactness is
not ported.

For that same head-on-its-own-line shape the sha input is `body.join('\n')`,
which has NO leading newline where `_extractIntents` would have produced one.
Every consumer trims or strips a leading newline (`team-tickets.js`,
`_handleContextIntent`), so the round-trip difference is invisible to them.

## passthru

The bail-out LATCH, set once and never unset. After a bail the filter has
already emitted bytes its line scanner never consumed, and resynchronising
against them is what split `[agent:end]` across two deltas into `[ag\nent:end]`.
It must take hold MID-BUFFER, not at the next `feed()`: the remainder of the
current buffer is exactly where that desync reappears, via the partial-line hold
withholding a `[` and re-emitting it after the line that followed it.

Set in the constructor for an agent name that fails `validAgent`, so a stream
that could never produce a path is never held or re-chunked.

The cost is that a later, in-cap intent in the SAME response forwards whole. No
spec is lost, only the saving, on a response that already blew the cap. A fresh
response gets a fresh filter.

## maxBytes

Enforced on HELD bytes before a line is consumed, never per completed line: a
ticket spec is very often ONE long line, so a per-line check fires only once the
line is fully buffered and never mid-line, and the oversized body spills anyway.
The mid-line bail emits `pending` with NO newline appended — the source newline
has not arrived.

## SpillTee

An unchanged delta is forwarded as its ORIGINAL bytes, never re-serialised:
Anthropic's SSE uses compact separators and pads events with trailing spaces, so
a re-encode is a different line even when the text is identical — a wire change
on 100% of traffic to buy nothing on the ~0% that spills.

The thinking guard is the delta TYPE, not the key name: a `thinking_delta`
carrying a `text` key must still pass untouched, because a rewritten thinking
block breaks its signature.

`content_block_stop` flushes held text BEFORE the stop is forwarded — held text
cannot outlive its block, or the next `content_block_start` would carry it into
a different index.

While a body is held the client sees no text deltas, but pings and every
non-text event keep flowing, so the socket never goes idle. wirescope measured
~43 chars/delta, so an 800 B body holds for ~18 deltas.
