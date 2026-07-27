# t50 — not every successful open is a good one

Branch `peer-backoff-open` off master `803233d` (which carries the t49 merge).
Worktree: `/Users/bogdan/projects/tmux/wb-wrap-ui-hand`.

## The ticket, in one line

`onOpen` resets `_eventsBackoff` to the 1s floor on every successful connect. A
200 costs the producer nothing to emit, so a stream that opens and immediately
dies — overflow, byte-zero close, anything — cycles at the floor forever.

## What I have to decide (clodex reserved these for me)

1. What is the right EVIDENCE of a good open? General shape, not the overflow
   instance. Must also catch "opens 200, closes at byte zero, loops". Must NOT
   punish a healthy-but-idle peer.
2. Does the attach stream have the same reset? Check both; if only one, say so.
3. Policy stays unbounded-and-calm (t41). This changes WHEN the backoff resets,
   never whether it gives up.

## Phase log

### Phase 1 — read + decide (DONE)

**Re-found.** Two resets, not one:
- `peer-client.js:270` — events stream, `this._eventsBackoff = RECONNECT_MIN_MS`
  inside `onOpen`.
- `peer-client.js:360` — attach stream, `att.backoff = RECONNECT_MIN_MS` inside
  its `onOpen`. **Answer to clodex's (b): BOTH have it, identically.** The attach
  stream is the worse of the two: there is one per attached session, so N
  attachments to a malformed box means N cycles at the floor. Both get the fix.

Both backoffs double in `onClose` and cap at `RECONNECT_MAX_MS` (20s); floor
`RECONNECT_MIN_MS` (1s). Nothing gives up — t41's position, untouched.

**Choosing the criterion.** Three candidates, two eliminated by a concrete case:

1. *At least one chunk arrived after the 200.* Attractive because heartbeats
   count as chunks (the watchdog already relies on exactly that), so it does not
   punish idle. **Eliminated:** an overflowing producer sends a megabyte of
   chunks. It would reset on the first one — the motivating case survives.
2. *At least one well-formed event was decoded.* Kills overflow and byte-zero.
   **Eliminated:** a healthy idle peer emits only `: ping` comment frames, which
   yield no event. This is precisely the "punish a healthy quiet connection"
   error clodex named.
3. *The open LASTED.* Handles all three: overflow dies inside one pass,
   byte-zero dies instantly, idle-but-healthy lives indefinitely. **Chosen.**

**Why the threshold is derived from the watchdog and not picked.** `STALE_MS`
(60s, `cli/src/sse-guard.js:15`) is the point at which the watchdog destroys a
stream that has not been petted. `res.on('data')` pets on EVERY chunk including
heartbeat comments. Therefore a stream that outlives `STALE_MS` has, by
construction, carried at least one chunk after its 200 — the watchdog would have
killed it otherwise. That makes "carried usable traffic" an entailment of the
lifetime test rather than a second thing to check, and it rules out any threshold
BELOW `STALE_MS`: a half-open socket carrying nothing survives the full 60s, so a
30s bar would certify it as good. The bar is `this._staleMs` (the per-instance,
test-overridable one, so the pair can never be inconsistent) plus a margin, the
margin existing only so a watchdog kill resolves as not-stable rather than tying
with the stability timer on the same tick.

**Framing note for clodex — a departure from the literal phrasing.** The spec
says "demonstrably carried usable traffic". I do not test usefulness, and I think
testing it would be wrong here: backoff paces RETRIES, so the question it needs
answered is whether the retry cycle is cheap or expensive, not whether the bytes
were good. A producer dribbling junk slowly enough to survive an hour before
overflowing IS cheap and should reset. Lifetime measures that directly, and via
the watchdog it still entails that bytes arrived.

**Mechanism.** A second one-shot timer armed at the same moment as the watchdog
(on 200) and stopped in the same `close()`, riding the SAME injected `_timers`
seam — no clock injection, no new seam, and no stray timer on a closed stream.
Reset moves out of `onOpen` and into that timer's callback.

### Phase 2 — implement (DONE, commit `7edf094`)

`STABLE_MARGIN_MS = 1000`; `_sse` takes an optional `onStable`; a `stableTimer`
armed beside the watchdog on the same `this._timers` seam at
`_staleMs + STABLE_MARGIN_MS`, cleared in the same one-shot `close()` door; both
`onOpen` resets moved to `onStable`. Also rewrote the t48 comment in `onOverflow`
that documented this cost as unfixed — it is now bounded and says so.

**Fallout I did not anticipate, and did not paper over.** All three tests in
`test/peer-client-sse-watchdog.test.js` failed immediately: they assert
`clock.pending() === 1` (and `=== 2` for two streams) as the proof a stream is
armed, on a comment claiming the watchdog is the only thing on that clock. My
stable timer rides the same injected seam by design, so a live stream now arms
TWO. I corrected the counts via a named `TIMERS_PER_STREAM = 2` and updated the
stale comment — the tests were right about the property (one live stream, fully
armed) and only wrong about the arithmetic. Sharing the seam is the point (see
the derivation), so bending the product to keep the literal `1` would have been
the wrong repair. Watchdog file re-run: 3/3 green.

### Phase 3 — tests (DONE)

`test/peer-client-backoff-open.test.js`, 5 tests: byte-zero death backs off ·
overflow death backs off · idle-but-healthy resets · attach backs off too ·
a closed stream leaves nothing armed and resets nothing late.

**How growth is observed, and the trap I avoided.** By READING the backoff
field, never by timing the reconnect gaps. `onClose`'s `setTimeout` is
deliberately not on the injected seam, so a timing assertion would measure the
machine's load as much as the policy — precisely the shape that has been green
over a defect six times this run. Every test additionally anchors on the
server-side reconnect COUNT, so "the backoff grew" cannot pass without the
reconnects that grew it having happened.

**The assertion that would have been green over the defect, and why it is not.**
My first instinct was `backoff > FLOOR_MS`. That is satisfied by the PRE-FIX
code: resetting on open does not pin the backoff at the floor, it oscillates
floor → floor×2 on every cycle, so `> 1000` holds at any moment after the first
close. Only the SECOND doubling is unreachable pre-fix. Hence `> ONE_DOUBLING_MS`
— and the revert below confirms the pre-fix value is exactly 2000ms, i.e. the
test sits one step above the highest value the defect can produce.

**Revert proofs — four separate reverts, each restored from a pristine copy.**

| revert | line removed | result |
|---|---|---|
| A — the full original defect (reset back in both `onOpen`s) | both | all 5 fail; 1/2/4 by message at exactly `was 2000ms` |
| B — events `onStable` body only, timer still armed | events reset | ONLY test 3 fails, by message |
| C — the `clearTimeout` in `close()` | teardown | test 5 fails by message; test 3 also fails (a stale timer poisons its arm-count precondition) |
| D — attach reset moved back to `onOpen` | attach only | ONLY test 4 fails, by message |

No failure was a crash or a hang. B and D each isolate one call site, which is
what proves test 4 pins the ATTACH code rather than spilling over from the
events fix.

**Does each test ENTER its window?** Test 3's `: ping` write is load-bearing,
not decoration: without it the watchdog kills the stream at `STALE_MS` and the
stability deadline is never reached — revert C demonstrates exactly that, the
test failing on its arming precondition rather than its assertion. Tests 1/2/4
are anchored on `state.events >= 3` / `attaches >= 3`, so two complete
close→backoff cycles are known to have run before anything is read.

**One test bug found and fixed by running it** (not by inspection): test 3
originally asserted `state.events === 2` after flipping the box to healthy, but
which open number the held stream turns out to be is a race with the in-flight
reconnect. Now read into `heldAt` at the moment the held stream appears — the
property is that the stream survives, not that it was the Nth.

**Leak scanner:** nothing to add. t50 created no new module; the scanner gates
extractions, and `peer-client.js` was already (correctly) absent from
`SCANNED_MODULES`. Suite total therefore moves by the 5 new tests only.
