# t48 — bound the CLI's SSE buffer, fix the GUI bound that cannot fire

Branch `sse-buffer-bound` off master `00bcd2f` (the t47 merge). Baseline 2797 /
ESCAPES 0. **This is a behaviour change** — deliberately, unlike t47.

## The limit: 1MB, ONE number for both heads

Derived from what the wire can legitimately carry, not picked:

- the largest frame `remote.js` ever writes is `replay`, whose payload is a
  session's scrollback ring — `SCROLLBACK_MAX = 256 * 1024` (`engine.js:496`),
  read at `remote-wiring.js:450` and base64'd at `remote.js:505` to ~342KB,
  plus JSON escaping.
- 1MB is ~3x that: room for the escaping worst case and for the ring to grow a
  generation, while catching an unterminated stream **three orders of magnitude
  earlier** than the old 8MB number would have, had it been reachable.

**One number, not two.** Both heads consume the same producer over the same
protocol; splitting the limit would mean claiming `remote.js` writes bigger
frames to one client than the other, which it does not. Kept as an *option* so
tests can trip it with kilobytes; neither head overrides it in production.
(peer-client takes a `sseMaxBufferBytes` constructor seam — the same test-only
seam `staleMs` already has, and for the same reason.)

## Half 2 — the placement, which is what made the old bound fake

Moved from the drain loop to **after the drain, on the residue**. The check now
runs once per `push`, on whatever is left when every complete frame has been
taken out. Two properties, both needed:

- a **well-framed** stream of any total size passes — only the tail of a
  partial frame is ever measured, so volume is not what is bounded;
- an **unterminated** line is caught within one chunk of crossing the limit
  rather than never.

The old placement could only fire on a single push carrying both a frame
terminator and >8MB behind it. Node delivers response bytes in 64KB chunks
(measured in t47: 12MB → 194 chunks, max 65536), so that push does not exist.

`onOverflow` now receives the **byte count**, and the decoder **drops the
buffer** on fire — nothing downstream can use it, and holding a megabyte after
deciding it is garbage would be its own small leak.

**The decoder still owns no socket.** It reports; the heads act. The constraint
held without strain — which is some evidence the t47 split was in the right
place.

## What happens when it fires — ASYMMETRIC, and that is the decision

### GUI: destroy → reconnect, and SAY SO

Reconnect, because the likely causes are transient (a hop mangling a stretch of
stream, a truncated write) and **giving up would be the worse failure**: the
peer keeps reading *online* while its session list goes permanently stale, with
nothing on screen to explain it.

**The cost, named in the code rather than hidden.** If the cause does *not*
pass, this cycles — and reading `peer-client.js:266` changed my answer here.
`onOpen` resets `_eventsBackoff` to `RECONNECT_MIN_MS` on **every successful
connect**, and an overflowing stream **does** reach 200 first. So the cycle sits
at the **1s floor** instead of backing off: a megabyte per second, bandwidth-
bound rather than a CPU spin. Fixing that means teaching the backoff that some
opens are not good ones — reconnect policy, L2's, deliberately not this
ticket's. Recorded at the call site so the next person meets it there.

**And it is not silent.** `_reportSseOverflow` emits an `ipc-message` naming the
peer, the stream path, the size and the limit. t45's lesson applies harder here
than usual: the symptom of a silent overflow is *a peer that flaps for no
visible reason*, which is indistinguishable from a flaky network and would be
debugged as one. Rate-limited to once per minute per connection — the repeating
case is exactly the one where a per-cycle line at the 1s floor would bury the
log it exists to inform.

### CLI: terminal, and the EXIT CODE IS the mechanism

`EXIT.SERVER`, **not** `EXIT.CONNECT`, and the code choice *is* the behaviour:

- `sse-guard` retries anything CONNECT-coded and, on exhaustion, **replaces**
  the error with a generic `event stream lost — 3 reconnect attempts failed`
  (`sse-guard.js:105`). So CONNECT would move three more megabytes and then
  **throw away the only sentence that says what happened**.
- A non-CONNECT code goes straight to `onGiveUp` **carrying this message**
  (`sse-guard.js:102`) — right on a side a human is watching.
- It is also the honest code: a peer emitting unframed megabytes is a
  server-side failure by `EXIT.SERVER`'s own definition, not an unreachable
  wire. And unlike the GUI, giving up strands nothing — the human reads the
  error and decides.

## Three existing tests CHANGED, and all three pinned the defect

Reported rather than quietly edited. Each was pinning behaviour this ticket
exists to remove:

| test | what it pinned | why it had to change |
|---|---|---|
| `D5: maxBufferBytes fires onOverflow…` | the triggering frame was **not** delivered | an artefact of the drain-loop placement — a complete, well-formed frame was discarded because unrelated residue followed it |
| `D5: an overflowed decoder stays dead` | same assertion, same reason | liveness half kept, the discard half corrected |
| `D5: maxBufferBytes=0 (the CLI default) is unbounded` | **the absence of a CLI bound, as intended** | that absence is half 1 of the defect |

`0` still disables the bound — the escape hatch survives and has its own test —
it is simply no longer the default.

## Tests

`cli/test/sse-frame.test.js` +3 (24 total), `cli/test/client-sse-overflow.test.js`
(4, new), `test/peer-client-sse-overflow.test.js` (3, new).

Every new case feeds bytes in **64KB chunks**, the size Node actually delivers —
because a single giant string is precisely the unrealistic shape the old test
used and the old bound survived.

Both sides assert the **false positive** too: a large well-framed stream
(~2.8MB CLI / ~0.5MB GUI, frames sized 7KB so they straddle every 64KB
boundary and the residue is continuously non-empty) must flow untouched. That
is the failure that would get the bound deleted by whoever hit it.

The CLI's give-up is asserted **end-to-end through the real `openGuarded`**, not
by reading sse-guard's source: one connect, no `onNotice`, and the original
diagnosis intact in `onGiveUp`.

### A teardown bug the reverts exposed

The CLI servers hold an SSE response open by design, so `server.close()` waits
on a connection that never ends. On the **failure** path that turned a named
test failure into a **hung runner** — the least diagnosable outcome there is,
and I only saw it because a revert made these tests fail. Now
`closeAllConnections()` first. A test that hangs instead of failing is a test
that reports nothing.

### Revert proof — four, all by message, none by crash

| revert | fails |
|---|---|
| check back **inside the drain loop** (pre-t48 placement) | **9** across all three files: 4 decoder, 2 CLI (`no overflow error arrived — the stream was never bounded`), 2 GUI (`timed out waiting for: the oversized stream to be dropped`), 1 more |
| default `maxBufferBytes` back to **0** | 1 decoder (`the default bound fired`) + 3 CLI |
| `EXIT.SERVER` → `EXIT.CONNECT` | 2 CLI — the unit assertion **and** `openGuarded never gave up`, which is the one that shows what the choice buys |
| drop the `_reportSseOverflow` call | 1 GUI (`timed out waiting for: a system line explaining the drop`) |

Each restored from a pristine copy before the next; all-green re-verified after.

## free-identifier-leaks

**No change, and it does not qualify** — this ticket adds no module. Every edit
lands in files already covered (`cli/src/sse-frame.js` joined SCANNED_MODULES in
t47; `peer-client.js` and `cli/src/client.js` are heads, not extractions).

## Verification

`TOTALS: 2807 pass, 0 fail` / `ESCAPES: 0`. Baseline 2797 + 10 new
(3 decoder + 4 CLI + 3 GUI) = 2807, exactly. No module added, so no
free-identifier-leaks drift this time.
