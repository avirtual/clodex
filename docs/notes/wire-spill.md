# wire/spill notes

Format spec `proxy-lab/SPILL.md`; arbiter `proxy-lab/test_spill.py`, ported into
`test/wire-spill-filter.test.js`. Both compute the same sha over the same
delimited bytes, so a drift here is a drift against a consumer this repo cannot see.

## SpillFilter

Ported from spill.py's `_SpillFilter`, with deliberate deviations, all in one
direction: what this filter writes to a spill file must be BYTE-EQUAL to what
`_extractIntents` would have delimited from the same text — recovery substitutes
the file for the body, so a one-byte divergence dispatches a different spec.
`test/wire-spill-sse.test.js` pins it by running the real scanner, not a literal.

1. A line clodex's scanner would treat as an intent line makes the filter bail
   rather than swallow it. spill.py delimits on the terminator only;
   `_extractIntents` closes a greedy body at the next parseable col-1 intent line,
   so a verbatim port would spill `spec\n[agent:task add b] spec2` as one body.
2. The head-line rest is TRIMMED, where spill.py skips one space: `parseIntent` trims.
3. Trailing blank lines are popped off the held body, as `_extractIntents` pops
   them; the head-line fragment (`firstBody`) never is.
4. `ticketTitle` leads a multi-line body's receipt, `"` folded to `'`, `…` dropped.

The nested-intent test is over-broad on purpose — the filter cannot know fences
without reimplementing `fencedLines`, so it errs SAFE both ways: a fenced head
line spills, a fenced example in a held body bails — the saving, never a spec.

`originalHeld` reconstructs the head line as RECEIVED rather than spill.py's
`head + " " + body_text`, which drops the source newline and adds a space.
Byte-identity on the forward-original paths is the whole failure policy, so that
inexactness is not ported — and why `rawRest` outlives deviation 2's trim: what is
FORWARDED is the original bytes, what is SPILLED is the scanner's delimitation.

## _resolve

First-person parenthesised past tense, no `[agent:`, no `@spill:`, no `…`, and
the closing `[agent:end]` swallowed: the placeholder is the model's own prior
output and became a few-shot example — 19 fabricated pointers in 12 h on two
lead seats, 18 copying the ellipsis title shape byte-for-byte, none before a
seat's first real rewrite. `wire/proxy.js` feeds the intent tee the ORIGINAL
chunk, never this output, so dispatch never depends on the placeholder. And the
filter never feeds itself, so a `RECEIPT_RE`/`TAIL_RECEIPT_RE` line in its INPUT
is model-authored: `onMimic` reports it, bytes untouched, and the seat is told
nothing was sent.

## passthru

The bail-out LATCH, set once and never unset. After a bail the filter has already
emitted bytes its line scanner never consumed, and resynchronising against them is
what split `[agent:end]` across two deltas into `[ag\nent:end]`. It must take hold
MID-BUFFER, not at the next `feed()`: the rest of the current buffer is exactly
where that desync reappears. `bail()` also clears `proseSpill`, so a latched
filter can never hold a tail it will not resolve. Set in the constructor for an
agent name that fails `validAgent`: a stream that could never produce a path is
never held, and a later in-cap intent forwards whole.

## maxBytes

Enforced on HELD bytes before a line is consumed, never per completed line: a
ticket spec is very often ONE long line, so a per-line check would fire only
once that line was fully buffered, and the oversized body would spill anyway.

The same cap bounds the UNTERMINATED head line, before `holding` is set:
`couldBeHead(pending)` with no newline would buffer without limit, and a long
`[agent:dm …]` line can never spill anyway. It bounds the `proseSpill` tail too,
and `SpillTee.buf` at the SSE frame level: a 200 `text/event-stream` that never
sends `\n\n` would buffer the whole response.

## SpillTee

An unchanged delta is forwarded as its ORIGINAL bytes, never re-serialised:
Anthropic's SSE pads events with trailing spaces, so a re-encode changes 100% of
traffic to buy nothing on the ~0% that spills.

The thinking guard is the delta TYPE, not the key name: a `thinking_delta`
carrying a `text` key must pass untouched, since a rewritten thinking block
breaks its signature. `content_block_stop` flushes a held BODY first — a body
cannot outlive its block, or the next `content_block_start` would carry it into
a different index. A `proseSpill` tail does not; see below.

While a body is held the client sees no text deltas, but pings keep flowing, past
a held stop too, or a long upstream pause after a block boundary would send zero
bytes. ~43 chars/delta: an 800 B body holds ~18; a tail holds to the end, same cap.

## _panic

`feed` records `heldRaw`/`heldSrc` BEFORE `filter.feed`, so at panic time the raw
frames can hold text the filter never saw and `bail()` cannot re-materialise,
while `_flushHeld` alone emits only `heldOut` and would delete every accumulated
event. So `_panic` forwards `heldRaw` verbatim only while it is the SUPERSET,
`heldOut.length <= heldSrc.length`; longer means `bail()` released bytes OLDER
than that window — a previous block's tail, whose frames `_flushHeld` dropped —
which only `heldOut` holds, so that case synthesizes. A receipt is never the
excess: a fire always flushes first, in the stop branch as in the delta branch.
`_notify` wraps every listener call, so a throwing one cannot reach that path — a
`_resolve` that threw after `_fired += 1` would lose head, body and terminator
while never dispatching the intent.

## proseSpill

Off, the filter is byte-for-byte pre-S-G2, so every older subject runs against the
default. On, text outside a held body accumulates in `tail`, and any intent head
line FLUSHES it — prose BETWEEN intents stays on the wire.

`foreignBody` covers the verb the filter does NOT hold: a `remind` body is
ordinary text to the line scanner, so without it the reminder would land in `tail`
and fire carrying a receipt. `couldBeHead(pending)` guards a block end likewise:
an unterminated head line is an intent, not a tail. The floor is SHARED with the
body path; the tail's receipt names no verb, since nothing dispatches it.

An operator dm is the ONE injection that leaves the bit CLEAR: `_deliverMessage`
passes `human` for sender `user` and the queue carries it to `onSubmitted` — the
panel is the two of them TALKING, the same input as typing. The bit is read ONCE
per request; a throwing `turnInjected` reads as not-injected.

The tail CROSSES block boundaries: `endBlock()` is `close()` without the tail
decision, and only `close()` — the stream end — resolves one. A non-text
`content_block_start` flushes a standing tail as the original: narration before
a tool call. So the tee must HOLD the last text block's `content_block_stop` and
the frames behind it in `heldRaw` past `heldStopAt`: at that stop it cannot yet
know whether another block follows. Gated on `proseSpill`.
