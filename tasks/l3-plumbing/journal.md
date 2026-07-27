# t47 — L3 plumbing: one SSE framing under the two consumer heads

Branch `l3-plumbing` off master `03da603`. Baseline 2770 / ESCAPES 0.
Behaviour-preserving. Consumer heads untouched.

## Phase 1 — the diff of the two framings

The two implementations, read side by side:

- **GUI**: `peer-client.js:570-631` — `PeerConnection._sse(path, {onEvent,
  onOpen, onClose})`. Inline framing inside the response handler.
- **CLI**: `cli/src/client.js:96-141` (`openEventStream`) + `:147-161`
  (`parseSseBlock`, exported).

### THEY HAD SILENTLY DRIFTED — five ways, and they are not cosmetic

This is the ticket's highest-value finding, so it leads. Every one of these is
a real behavioural difference on bytes `remote.js` can actually emit.

**D1 — frame separator: LF-only vs CRLF-tolerant.**
peer-client: `buf.indexOf('\n\n')`. CLI: `buf.search(/\r?\n\r?\n/)`, and it
re-measures the matched separator's length to slice correctly. Against
`remote.js` (which writes `\n\n` literally, e.g. `:355`) both work. Against
anything that normalizes to CRLF — a proxy, a future non-Clodex producer, an
SSE-spec-conformant server — the GUI **never finds a frame boundary at all**
and the buffer grows until the 8MB bound destroys the socket. The CLI handles
it. Pure drift: neither side chose this over the other.

**D2 — field parsing: prefix-match vs spec parse.**
peer-client matches the literal strings `'event: '` and `'data: '` (7 and 6
chars, hardcoded slices). The CLI splits at the first `:` and strips ONE
optional leading space, which is what the SSE spec says. Consequences:

  - `event:activity` (no space) — CLI parses it, GUI **silently ignores the
    field** and the frame falls back to `event = 'message'`. peer-client's
    consumer has no `'message'` branch, so the event is dropped entirely.
  - `data:  x` (two spaces) — CLI yields `' x'`, GUI yields `' x'` too here
    (its slice(6) keeps the second space). Agrees by accident.
  - a `data:` line with no space — GUI drops the frame's payload → `data`
    stays `null` → **the whole frame is discarded** (`if (data !== null)`).

**D3 — multi-line `data:`.** SSE says multiple `data:` lines in one frame
concatenate with `\n`. The CLI implements this (`dataLines.join('\n')`).
peer-client **overwrites**: the last `data:` line wins and every earlier one is
lost. `remote.js` only ever writes single-line JSON, so this is latent, not
live — but it is exactly the shape of bug that bites the day someone writes a
frame with an embedded newline.

**D4 — unparseable `data:`.** GUI: `JSON.parse` failure → `data = null` →
frame **dropped**. CLI: parse failure → the **raw string** is delivered to
`onEvent`. Two different contracts for the same wire byte. (The CLI's is
documented at `client.js:88-89`; the GUI's is not documented at all.)

**D5 — the 8MB buffer bound exists on the GUI side ONLY.**
`peer-client.js:615` destroys the socket when the residual buffer passes 8MB.
`cli/src/client.js` has **no equivalent — the CLI's `buf` is unbounded.**
Spec asked me to check and report if it does not: **it does not.** A wire that
sends a very long line with no frame terminator grows the CLI's buffer without
limit. Not a live defect against `remote.js` (every frame it writes is short
and terminated), but it is a real asymmetry and the CLI is the side that runs
unattended in `logs -f`.

Also note the GUI's bound is placed **oddly**: it is checked *after* the slice,
inside the drain loop, so it only fires when at least one complete frame was
already found in the chunk. A single unterminated 100MB line never enters the
loop and is never bounded. Preserving the check verbatim (behaviour-preserving
ticket) and naming the weakness rather than fixing it.

### What is genuinely SHARED (the extract)

Both sides do exactly this and nothing else in common:

1. buffer incoming utf8 chunks,
2. find frame boundaries at the blank line,
3. within a frame, read `event:` / `data:` and ignore `:`-lead comments,
4. JSON-parse the payload,
5. hand `(event, data)` to a consumer,
6. hand every raw chunk to a liveness observer (CLI's `onChunk`; the GUI's
   inline `watchdog.pet()`).

Everything else differs and is CONSUMER or TRANSPORT policy: agents, auth
header construction, status handling, error typing (`CliError` vs a bare
`onClose`), reconnect, and what a reconnect re-establishes.

### The three hard decisions

**(a) Reconnect policy — the shared module stays BELOW it entirely.**
Not a parameter. The extract is a *frame decoder*: it never owns a socket,
never opens a request, and therefore has nothing to reconnect. peer-client
keeps its unbounded-and-calm backoff (`:8-9`, `RECONNECT_MIN/MAX`), `sse-guard`
keeps its bounded 3-try `openGuarded`. Neither learns about the other. This is
the strongest available form of my t41 refusal: a module with no socket cannot
grow a reconnect flag later, whereas a "reconnect policy parameter" is an
invitation to unify supervision one ticket at a time.

**(b) `keepAlive:false` on the SSE agent — PEER-SPECIFIC. No latent CLI bug.**
Established rather than assumed:

  - The peer's documented reason (`peer-client.js:76-85`) is **pool
    contention on ONE origin**: SSE streams never end while live, so pooling
    them with short requests let 4 attaches pin all 4 sockets and starve
    hello/control/input. The fix is the *two separate agents*; `keepAlive:false`
    on the stream agent is the second half of the same thought — a stream
    socket is per-stream and must not linger in a free pool where a later
    request could pick it up (the "stale queued socket" at `:67`).
  - **The CLI cannot have that shape.** Its short requests go through global
    `fetch` (undici) — `client.js:42` — and its streams through `node:http`.
    They are in *different stacks with different pools*. There is no origin on
    which a CLI stream can starve a CLI request. Verified, not reasoned from
    the comment alone.
  - Residual question — could a *stream* socket be pooled and reused staler
    by a *later stream*? `http.globalAgent` is `keepAlive:true` on this Node
    (v25.8.1, checked). But every path that ends a CLI stream destroys the
    socket rather than releasing it clean: `openGuarded` reconnects only after
    a transport error, a server `end`, or a watchdog `req.destroy()`. A socket
    that FIN'd or was destroyed is not returned to the free pool. So the reuse
    hazard has no path.

  Conclusion: peer-specific, and it stays in peer-client where the two-agent
  reasoning lives. Not a parameter of the shared module (which has no agent),
  and **not a latent CLI bug** — reported as checked, not as unexamined.

**(c) Reconnect re-establishment stays in the heads.** Untouched: attach
re-replays/re-acquires (`sse-guard.js:117-122` onOpen), the GUI resyncs its
session list (`peer-client.js:263`). The extract never sees a reconnect.

### Placement

`cli/src/sse-frame.js`. Follows the t41/t42 rule: `cli/` is a strict leaf,
app → cli/ is the established direction (`peer-client.js:29`,
`peer-tunnel.js:35`, `web-tunnel.js:73`), and `cli/` ships in the DMG
(`build.files`). No upward import. Not proposing an alternative.

## Progress

- [x] phase 1: read both implementations, diff, five drifts found
- [x] phase 1: decisions (a) below-reconnect, (b) peer-specific, (c) heads
- [x] phase 2: `cli/src/sse-frame.js`, both call sites rewired (`d6ff26d`)
- [x] phase 3: tests + revert proofs, and a hole the reverts caught
- [x] phase 4: suite, journal, report

## Phase 2 — the extract

`cli/src/sse-frame.js`, 143 lines: `parseSseBlock` (moved verbatim from
`cli/src/client.js`) + `makeSseDecoder`, a stateful chunk→frame decoder.

D1/D2/D3 resolved TOWARD THE SPEC. Each is a strict superset of what the GUI
accepted, and every frame `remote.js` actually writes parses identically under
both — so this is behaviour-preserving on the live wire while fixing three
latent GUI defects. D4/D5 are real policy: preserved per side as options, the
dial.js rule (a divergence becomes a parameter, never a branch on the caller).

Two things deliberately did NOT move into the decoder:

- **the consumer-throw swallow.** The GUI wrapped `onEvent` in try/catch, the
  CLI did not. Left at peer-client's call site — which throws you tolerate is
  the head's business, and it is one line where it belongs.
- **the `data: null` drop.** `null` PARSES, so `dropUnparsableData` never sees
  it; the old guard was `if (data !== null)`. Every peer consumer dereferences
  the payload (`data.b64`, `data.name`, `data.exitCode`) and the CLI's render
  text, so this is a property of THESE consumers. Kept at the call site.
  It is the one piece of the old framing that didn't move, hence the piece most
  likely to be lost by the move — pinned by its own test.

`cli/src/client.js` **re-exports** `parseSseBlock` rather than repointing its
importers, so `cli/test/client.test.js` needs no edit. No existing test on
either side was touched.

## Phase 3 — tests

`cli/test/sse-frame.test.js` (21) — the decoder. Partial frames across chunk
boundaries (including the separator itself split byte-wise), the comment-only
heartbeat, one test per drift D1–D5, plus the grammar edges both copies shared.

`test/peer-client-sse-framing.test.js` (5) — that peer-client USES it, over a
real socket with real bytes. Every case is one the OLD inline framing answers
differently, so a call site that kept hand-rolling would fail them.

### A hole the reverts caught (again)

The two drop cases were first written on the `activity` event — and **passed
with `dropUnparsableData` reverted**. `activity`'s handler guards on
`data && data.name`, so a delivered raw string produces no emit for a reason
that has nothing to do with dropping. *A guard that cannot fail for the reason
it exists is not a guard.* Moved to `sessions` (`peer-client.js:252`), the one
branch that acts on ARRIVAL alone and never reads the payload: delivered → a
session refetch, dropped → none. Now fails on the revert, by message.

Found by running the revert, not by reading the test. Second ticket running.

### The 8MB bound is UNREACHABLE over a real socket — no test, deliberately

I tried to pin peer-client's `maxBufferBytes` wiring end-to-end and could not,
for a reason worth reporting rather than working around.

The check sits INSIDE the drain loop, so it evaluates only after a complete
frame has been sliced off. Firing therefore needs ONE `push` carrying both a
frame terminator and >8MB of residue behind it. **Measured**: Node delivers
response bytes in 64KB chunks (12MB arrived as 194 chunks, max 65536). No
single push can carry 8MB, and an unterminated multi-megabyte line never enters
the loop at all — so the bound cannot fire on any real stream.

This predates the refactor; the placement is preserved verbatim. A test
asserting it does not fire would pin a defect as intended behaviour, and one
asserting it does would hang. Named here and reported; fixing it is a
behaviour change and a separate decision.

### Revert proof — seven, all by message, none by crash

| revert | fails |
|---|---|
| D1 `indexOf('\n\n')` (the GUI's) | 2 decoder + 1 peer test; peer one by `timed out waiting for: the CRLF frame to be parsed and emitted` |
| D2 literal `'event: '`/`'data: '` prefixes | 2 decoder + 1 peer, `a prefix-matching parser yields ["message", null] here` |
| D3 overwrite instead of join | 3 decoder tests |
| D4 ignore `dropUnparsableData` | 2 decoder + 1 peer, `the bad frame triggered no refetch` |
| D5 drop the bound | 2 decoder, `overflow fired once` / `later pushes are no-ops` |
| drop the call-site `data === null` guard | 1 peer, `the null frame produced no consumer action` |
| `buf = chunk` (no cross-chunk carry) | 3 decoder + 1 peer |

Each was restored from a pristine copy before the next, and the un-reverted
baseline was re-run between the D4 fix and its proof.

### free-identifier-leaks

`cli/src/sse-frame.js` added to `SCANNED_MODULES` with the same honest caveat
`dial.js` carries: it is a `cli/` leaf never carved out of `main.js`, so the
forward scan can only catch it accidentally. Listed because the convention says
every new extraction joins. The real guard here is its leaf property — **no
requires at all**.
