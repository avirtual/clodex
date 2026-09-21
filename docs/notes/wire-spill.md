# wire/spill notes

Format spec `proxy-lab/SPILL.md`; arbiter `proxy-lab/test_spill.py`, ported into
`test/wire-spill-filter.test.js`: same sha over the same delimited bytes, so a
drift here is a drift against a consumer this repo cannot see.

## SpillFilter

Ported from spill.py's `_SpillFilter`, with deliberate deviations, all in one
direction: what this filter writes to a spill file must be BYTE-EQUAL to what
`_extractIntents` would have delimited from the same text — recovery substitutes
the file for the body, so a one-byte divergence dispatches a different spec
(`test/wire-spill-sse.test.js` pins it by running the real scanner).

1. A line clodex's scanner would treat as an intent line makes the filter bail
   rather than swallow it. spill.py delimits on the terminator only;
   `_extractIntents` closes a greedy body at the next parseable col-1 intent line,
   so a verbatim port would spill `spec\n[agent:task add b] spec2` as one body.
2. The head-line rest is TRIMMED, where spill.py skips one space: `parseIntent` trims.
3. Trailing blank lines are popped off the held body, as `_extractIntents` pops
   them; the head-line fragment (`firstBody`) never is.

The nested-intent bail is over-broad on purpose — the filter cannot know fences
without reimplementing `fencedLines`, so it errs SAFE: a fenced example in a held
body bails, costing the saving, never a spec.

`originalHeld` reconstructs the head line as RECEIVED rather than spill.py's
`head + " " + body_text` (source newline dropped, space added): byte-identity on
the forward-original paths is the whole failure policy, which is why `rawRest`
outlives deviation 2's trim — FORWARDED is original bytes, SPILLED is the
scanner's delimitation.

## _resolve

A spilled block resolves to the EMPTY string — head, body and `[agent:end]`
gone. Two placeholders preceded this and both were imitated: a `@spill:<id>`
pointer (19 fabrications in 12 h), then a first-person receipt (6 in 15 long
bodies, one on a fresh context holding a single prior receipt): anything the tee
authors in the ASSISTANT role with a copyable shape gets copied. The confirmation
rides `onSpill` (`head` = head words, `null` for the tail) into the notice queue,
the USER role. `wire/proxy.js` feeds the intent tee the ORIGINAL chunk, so
dispatch never depends on the record. The filter never feeds itself, so a
`RECEIPT_RE`/`TAIL_RECEIPT_RE`/`SPILL_FILLER` line in its INPUT is model-authored:
`onMimic` reports it, bytes untouched, judging only lines it is NOT holding.

## _stopBlock

Anthropic rejects, on the NEXT request, an assistant `text` block whose text is
whitespace-only, and a turn that is one long dispatch is the common shape. At a
text block's stop the tee emits one `SPILL_FILLER` delta (`(sent)`) on the
block's index before the stop, only if the filter fired during the block AND all
it forwarded is whitespace. Gating on a fire leaves the text→text boundary
alone: the first block's bytes live on in the filter tail (see `_panic`).

## passthru

The bail-out LATCH, set once and never unset. After a bail the filter has already
emitted bytes its line scanner never consumed, and resynchronising against them is
what split `[agent:end]` across two deltas into `[ag\nent:end]`; it takes hold
MID-BUFFER, since the rest of the current buffer is where that desync reappears.
`bail()` also clears `proseSpill`, so a latched filter never holds a tail it will
not resolve. Set in the constructor for an agent name that fails `validAgent`: a
stream that could never produce a path is never held.

## maxBytes

Enforced on HELD bytes before a line is consumed, never per completed line: a ticket
spec is often ONE long line, so a per-line check would fire only once that line
was fully buffered, and the oversized body would spill anyway. The same cap bounds the UNTERMINATED head line, before `holding` is set — a long
`[agent:dm …]` line can never spill, and `couldBeHead(pending)` with no newline
would buffer without limit — plus the `proseSpill` tail and `SpillTee.buf` at the
SSE frame level (a 200 `text/event-stream` that never sends `\n\n`).

## SpillTee

An unchanged delta is forwarded as its ORIGINAL bytes, never re-serialised:
Anthropic's SSE pads events with trailing spaces, so a re-encode changes 100% of
traffic to buy nothing on the ~0% that spills. The thinking guard is the delta TYPE, not the key name: a `thinking_delta`
carrying a `text` key must pass untouched, since a rewritten thinking block
breaks its signature. `content_block_stop` flushes a held BODY first — a body
cannot outlive its block, or the next `content_block_start` would carry it into
a different index. A `proseSpill` tail does not; see below. While a body is held
the client sees no text deltas, but pings keep flowing, past a held stop too, or a
long pause after a block boundary would send zero bytes. ~43 chars/delta: an 800 B
body holds ~18; a tail holds to the end, same cap.

## _panic

`feed` records `heldRaw`/`heldSrc` BEFORE `filter.feed`, so at panic time the raw
frames can hold text the filter never saw and `bail()` cannot re-materialise,
while `_flushHeld` alone emits only `heldOut` and would delete every accumulated
event. So `_panic` forwards `heldRaw` verbatim only while it is the SUPERSET,
`heldOut.length <= heldSrc.length`; longer means `bail()` released bytes OLDER
than that window — a previous block's tail, whose frames `_flushHeld` dropped —
which only `heldOut` holds, so that case synthesizes.
`_notify` wraps every listener call, so a throwing one cannot reach that path — a
`_resolve` that threw after `_fired += 1` would lose head, body and terminator
while never dispatching the intent.

## proseSpill

Off, the filter is byte-for-byte pre-S-G2, so every older subject runs against the
default. On, text outside a held body accumulates in `tail`, and any intent head
line FLUSHES it — prose BETWEEN intents stays on the wire.

`foreignBody` covers the verb the filter does NOT hold: a `remind` body is
ordinary text to the line scanner, so without it the reminder would land in `tail`
and be spilled out from under it; it fences `onMimic` too. `couldBeHead(pending)`
guards a block end likewise: an unterminated head line is an intent, not a tail.
The floor is SHARED with the body path. An operator dm is the ONE injection that
leaves the bit CLEAR: `_deliverMessage` passes `human` for sender `user` and the
queue carries it to `onSubmitted` — the two of them TALKING. Read ONCE per
request; a throwing `turnInjected` is not-injected.

The tail CROSSES block boundaries: `endBlock()` is `close()` without the tail
decision, and only `close()` — the stream end — resolves one. A non-text
`content_block_start` flushes a standing tail as the original: narration before
a tool call. So the tee must HOLD the last text block's `content_block_stop` and
the frames behind it in `heldRaw` past `heldStopAt`: at that stop it cannot yet
know whether another block follows. Gated on `proseSpill`.
