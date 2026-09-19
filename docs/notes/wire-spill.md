# wire/spill notes

Format spec: `proxy-lab/SPILL.md`. Conformance arbiter for delimitation and the
sha: `proxy-lab/test_spill.py`, whose cases are ported into
`test/wire-spill-filter.test.js`. Two implementations now compute the same sha
over the same delimited bytes, so a drift here is a drift against a consumer
this repo cannot see.

## SpillFilter

Ported from spill.py's `_SpillFilter`, with deliberate deviations, all in one
direction: what this filter writes to a spill file must be BYTE-EQUAL to what
`_extractIntents` would have delimited from the same text. S-B substitutes the
file for the body the unspilled path would have carried, so a one-byte
divergence silently dispatches a different spec than the transcript shows.
`test/wire-spill-sse.test.js` pins it by running the real scanner, not a literal.

1. A line clodex's scanner would treat as an intent line makes the filter bail
   rather than swallow it into the held body. spill.py delimits on the
   terminator only; `_extractIntents` closes a greedy body at the next parseable
   col-1 intent line, so a verbatim port would spill one body
   `spec\n[agent:task add b] spec2` and the second ticket would vanish into the
   first's spec.
2. The head-line rest is TRIMMED, where spill.py skips exactly one space.
   `_extractIntents` takes `intent.body` from `parseIntent`, which trims; a
   one-space skip leaves `'  body'` where the scanner yields `'body'`.
3. Trailing blank lines are popped off the held body, because `_extractIntents`
   pops them (`while (body.length && !body[body.length-1].trim()) body.pop()`).
   The head-line fragment is never popped — it is the scanner's `firstBody`,
   which the pop loop cannot reach.
4. `ticketTitle` leads a multi-line body's pointer.

Every test_spill.py delimitation case is still ported in
`test/wire-spill-filter.test.js`, row 6 rewritten to the trimmed expectation.

The nested-intent test is `cleanLine(line).startsWith('[agent:')`, over-broad on
purpose — the filter cannot know fences without reimplementing `fencedLines`, so
it is wrong in the SAFE direction both ways. A head line inside a fence spills
(the scanner would never dispatch it, and the content-addressed file still holds
the example), and a fenced example inside a held body bails, costing the saving
on one response, never a spec.

`originalHeld` reconstructs the head line as RECEIVED (`head + rawRest`) rather
than spill.py's `head + " " + body_text`. For a head line with nothing after the
`]` spill.py's form drops the source newline and adds a space; byte-identity on
the forward-original paths is the whole failure policy, so that inexactness is
not ported. Note this is the one place `rawRest` is still needed after the trim
in deviation 2: what is FORWARDED is the original bytes, what is SPILLED is the
scanner's delimitation.

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
ticket spec is very often ONE long line, so a per-line check would fire only
once that line was fully buffered, and the oversized body would spill anyway.
The mid-line bail emits `pending` with NO newline appended — the source newline
has not arrived.

The same cap bounds the UNTERMINATED head line, before `holding` is ever set:
`couldBeHead(pending)` with no newline yet is the shape that would otherwise
buffer without limit, and a long `[agent:dm …]` line can never spill at all, so
without it the client sees no text for the whole line's duration.

`SpillTee.buf` carries the same bound at the SSE-frame level: a 200-status
`text/event-stream` that never sends `\n\n` would otherwise buffer the whole
response while the unfiltered path forwarded it.

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

## _panic

`feed` records `heldRaw`/`heldSrc` BEFORE calling `filter.feed`, so at panic time
the raw frames can hold text the filter never saw and `bail()` cannot
re-materialise. `_flushHeld` alone would push nothing — it only emits `heldOut` —
deleting every accumulated event from the client stream. So `_panic` forwards
`heldRaw` verbatim whenever it disagrees with `heldOut`. Safe because `heldOut`
can never hold a pointer at panic time: a fire always flushes first.

`SpillFilter._notify` wraps every `onSpill`/`onBail` call, so a throwing
listener cannot reach that path at all — `proxy.js` re-emits both to arbitrary
listeners, and a `_resolve` that threw after `_fired += 1` would lose the head
line, the body and the terminator while never dispatching the intent.

## close

A model reply whose last line is `[agent:end]` ends exactly there, with no
trailing newline, so the terminator never reaches the line loop in `feed` and is
still in `pending` when `close()` runs. Before the `pending.trim() === TERMINATOR`
branch, `close()` fell straight through to `originalHeld()` and re-emitted the
whole held body verbatim: an 8.8 KB ticket spec reached the operator's screen and
the recipient's context unspilled (2026-09-20, reqId 1789859254044-861a0f, a
wire-turn of textLen 8861 with no wire-spill row). The branch resolves first and
then appends the pending bytes unchanged, so the stream still ends byte-exact on
the terminator the model wrote. Whitespace or text AFTER the terminator on that
last line is not a terminator, fails the `trim()` test, and stays held.
