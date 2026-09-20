# wire/spill notes

Format spec: `proxy-lab/SPILL.md`. Conformance arbiter for delimitation and the
sha: `proxy-lab/test_spill.py`, ported into `test/wire-spill-filter.test.js`. Two
implementations compute the same sha over the same delimited bytes, so a drift
here is a drift against a consumer this repo cannot see.

## SpillFilter

Ported from spill.py's `_SpillFilter`, with deliberate deviations, all in one
direction: what this filter writes to a spill file must be BYTE-EQUAL to what
`_extractIntents` would have delimited from the same text. S-B substitutes the
file for the body the unspilled path would have carried, so a one-byte divergence
silently dispatches a different spec than the transcript shows.
`test/wire-spill-sse.test.js` pins it by running the real scanner, not a literal.

1. A line clodex's scanner would treat as an intent line makes the filter bail
   rather than swallow it into the held body. spill.py delimits on the terminator
   only; `_extractIntents` closes a greedy body at the next parseable col-1 intent
   line, so a verbatim port would spill `spec\n[agent:task add b] spec2` as one
   body and lose the second ticket into the first.
2. The head-line rest is TRIMMED, where spill.py skips one space: `intent.body`
   comes from `parseIntent`, which trims.
3. Trailing blank lines are popped off the held body, as `_extractIntents` pops
   them. The head-line fragment is never popped — it is `firstBody`.
4. `ticketTitle` leads a multi-line body's pointer.

The nested-intent test is over-broad on purpose — the filter cannot know fences
without reimplementing `fencedLines`, so it is wrong in the SAFE direction both
ways: a head line inside a fence spills, a fenced example inside a held body
bails, costing the saving on one response, never a spec.

`originalHeld` reconstructs the head line as RECEIVED rather than spill.py's
`head + " " + body_text`, which drops the source newline and adds a space.
Byte-identity on the forward-original paths is the whole failure policy, so that
inexactness is not ported — and it is why `rawRest` outlives the trim in deviation
2: what is FORWARDED is the original bytes, what is SPILLED is the scanner's
delimitation.

## passthru

The bail-out LATCH, set once and never unset. After a bail the filter has already
emitted bytes its line scanner never consumed, and resynchronising against them is
what split `[agent:end]` across two deltas into `[ag\nent:end]`. It must take hold
MID-BUFFER, not at the next `feed()`: the remainder of the current buffer is
exactly where that desync reappears. `bail()` also clears `proseSpill`, so a
latched filter can never hold a tail it will not resolve.

Set in the constructor for an agent name that fails `validAgent`, so a stream
that could never produce a path is never held or re-chunked. The cost is that a
later, in-cap intent in the SAME response forwards whole — no spec is lost, only
the saving, and a fresh response gets a fresh filter.

## maxBytes

Enforced on HELD bytes before a line is consumed, never per completed line: a
ticket spec is very often ONE long line, so a per-line check would fire only
once that line was fully buffered, and the oversized body would spill anyway.

The same cap bounds the UNTERMINATED head line, before `holding` is ever set:
`couldBeHead(pending)` with no newline yet would otherwise buffer without limit,
and a long `[agent:dm …]` line can never spill at all. It bounds the `proseSpill`
tail too, which is otherwise unbounded by construction. `SpillTee.buf` carries
the same bound at the SSE-frame level: a 200-status `text/event-stream` that
never sends `\n\n` would otherwise buffer the whole response.

## SpillTee

An unchanged delta is forwarded as its ORIGINAL bytes, never re-serialised:
Anthropic's SSE uses compact separators and pads events with trailing spaces, so a
re-encode is a different line even when the text is identical — a wire change on
100% of traffic to buy nothing on the ~0% that spills.

The thinking guard is the delta TYPE, not the key name: a `thinking_delta`
carrying a `text` key must still pass untouched, because a rewritten thinking
block breaks its signature. `content_block_stop` flushes a held BODY before the stop
is forwarded — a body cannot outlive its block, or the next `content_block_start`
would carry it into a different index. A `proseSpill` tail does not; see below.

While a body is held the client sees no text deltas, but pings and every non-text
event keep flowing, so the socket never goes idle. wirescope measured ~43
chars/delta, so an 800 B body holds ~18 deltas; a `proseSpill` tail holds to the
end of the response, bounded by the same cap.

## _panic

`feed` records `heldRaw`/`heldSrc` BEFORE calling `filter.feed`, so at panic time
the raw frames can hold text the filter never saw and `bail()` cannot
re-materialise. `_flushHeld` alone would push nothing — it only emits `heldOut` —
deleting every accumulated event from the client stream. So `_panic` forwards
`heldRaw` verbatim whenever it disagrees with `heldOut`. Safe because `heldOut`
can never hold a pointer at panic time: a fire always flushes first. `_notify`
wraps every `onSpill`/`onBail` call, so a throwing listener cannot reach that
path — a `_resolve` that threw after `_fired += 1` would lose the head line, the
body and the terminator while never dispatching the intent.

## proseSpill

Off, the filter is byte-for-byte pre-S-G2, which is why every older subject still
runs against the default. On, text outside a held body accumulates in `tail`, and
any intent head line FLUSHES it — keeping prose BETWEEN intents on the wire.

`foreignBody` covers the verb the filter does NOT hold: a `dm` body is ordinary
text to the line scanner, so without it the message would land in `tail` and leave
as a pointer its recipient cannot read. `couldBeHead(pending)` guards a block end
likewise: an unterminated head line is an intent, not a tail. The floor is SHARED
with the body path; the pointer is BARE, and `POINTER_RE` accepts that form.

An operator dm is the ONE injection that leaves the bit CLEAR: `_deliverMessage`
passes `human` for sender `user`, the queue carries it to `onSubmitted`. Him
sending from the panel is the two of them TALKING — the same input as typing. The
bit is still read ONCE per request under `spillEnabled()`'s contract, and a
throwing `turnInjected` reads as not-injected.

The tail CROSSES block boundaries: `endBlock()` is `close()` without the tail
decision, and only `close()` — the stream end — resolves one. A non-text
`content_block_start` flushes a standing tail as the original, because that text
was narration before a tool call. So the tee must HOLD the last text block's
`content_block_stop`, and the frames behind it, in `heldRaw` past `heldStopAt`:
at that stop frame it cannot yet know whether another block follows. Gated on `proseSpill`.
