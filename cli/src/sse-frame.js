// sse-frame.js — ONE SSE frame decoder for both consumer heads (t47 / L3).
//
// Two hand-rolled copies used to exist: peer-client.js's inline framing (the
// GUI's peer streams) and cli/src/client.js's openEventStream + parseSseBlock
// (clodexctl attach / logs -f). Same wire, same producer (remote.js), same
// `\n\n` blocks, same `: ping` comments, same Bearer header — written twice.
// t41 proved what that costs: the half-open watchdog was written on the CLI
// side and sat there for months while the GUI read a dead socket as live,
// because a fix on one side had no path to the other. This module is the path.
//
// WHAT IS HERE: bytes in, (event, data) out. Buffering across chunk
// boundaries, block framing, SSE field parsing, the JSON payload parse, and an
// optional buffer bound. WHAT IS NOT: sockets, agents, headers, status codes,
// reconnect, backoff, watchdogs, and every decision about what an event MEANS.
// The decoder has no socket, so it CANNOT reconnect — which is the point. The
// GUI's reconnect is unbounded-and-calm (peer-client.js:8-9); the CLI's is
// bounded at 3 tries (sse-guard.js openGuarded); t41 refused to unify those and
// that refusal stands. A module with nothing to reconnect cannot grow a
// reconnect flag one ticket at a time.
//
// ── THE TWO COPIES HAD DRIFTED (t47 phase 1) ────────────────────────────────
//
// Resolved TOWARD THE SPEC, because these are not two policies — there is one
// SSE grammar and the GUI's copy was an incomplete implementation of it. Each
// resolution is a strict SUPERSET of what the GUI accepted, and every frame
// remote.js actually writes (`event: X\ndata: <json>\n\n`, `: ping\n\n`) parses
// identically under both. Pinned in test/sse-frame-parity.test.js.
//
//   D1 separator: GUI matched '\n\n' literally, the CLI tolerates CRLF. Taken:
//      CRLF-tolerant. A CRLF-normalizing hop made the GUI find NO boundary at
//      all and grow its buffer to the 8MB kill.
//   D2 fields: GUI matched the literal prefixes 'event: ' / 'data: '. A
//      space-less `event:activity` fell through to 'message' (which no GUI
//      consumer handles) and a space-less `data:` dropped the frame outright.
//      Taken: split at the first colon, strip ONE optional space — the spec.
//   D3 multi-line data: SSE joins repeated `data:` lines with '\n'. The GUI
//      OVERWROTE, keeping only the last. Taken: join.
//
// Two divergences are NOT resolved here — they are real policy, so they are
// parameters and the drift is preserved at its parameter (the dial.js rule):
//
//   D4 `dropUnparsableData` — a `data:` line that is not JSON. The GUI dropped
//      the frame; the CLI delivers the raw string (documented, client.js:88).
//      Preserved per side.
//   D5 `maxBufferBytes` — the GUI destroys the socket past 8MB of residue
//      (peer-client.js:615); the CLI has NO bound at all. Preserved: the GUI
//      passes 8MB, the CLI passes nothing. Naming rather than fixing, since the
//      CLI is the side that runs unattended.
//      The bound's PLACEMENT is preserved verbatim too, weakness included: it
//      is checked inside the drain loop, so it can only fire once a complete
//      frame has been found. One unterminated 100MB line never enters the loop
//      and is never bounded. Moving the check is a behaviour change and a
//      separate decision.
//
// A consumer callback that THROWS is not caught here — the GUI swallowed and
// the CLI did not. That drift stays at peer-client's call site (it wraps its
// own consumer), not behind a flag: which throws you tolerate is the head's
// business, and it is one line where it belongs.
//
// Leaf by construction: no requires at all. The direction is app → cli/, the
// same one peer-client.js:29, peer-tunnel.js:35 and web-tunnel.js:73 already
// take; cli/ ships in the DMG (build.files).
'use strict';

// Parse one SSE block (the text between blank lines) into { event, data }.
// Multiple `data:` lines concatenate with '\n' (SSE spec); `:`-lead lines are
// comments. Returns null for a comment-only / dataless block — which is what
// makes a `: ping` heartbeat yield no event while still being bytes on the
// wire (the liveness signal the watchdog reads; see sse-guard.js).
function parseSseBlock(block) {
  let event = null;
  const dataLines = [];
  for (const raw of block.split(/\r?\n/)) {
    if (!raw || raw[0] === ':') continue;
    const colon = raw.indexOf(':');
    const field = colon === -1 ? raw : raw.slice(0, colon);
    let value = colon === -1 ? '' : raw.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

// A stateful decoder over a chunked utf8 stream.
//
//   onEvent(name, data)  — one complete frame. `name` defaults to 'message'.
//                          `data` is the JSON-parsed payload.
//   dropUnparsableData   — true: a `data:` line that is not JSON drops the
//                          whole frame (GUI). false: the raw string is
//                          delivered instead (CLI). See D4.
//   maxBufferBytes       — 0 (default) = unbounded (CLI). >0 = onOverflow()
//                          fires and decoding stops once the residual buffer
//                          passes it (GUI, 8MB). See D5.
//   onOverflow()         — the bound was passed. The decoder owns no socket,
//                          so tearing one down is the caller's job.
//
// push(chunk) returns false once overflow has fired, true otherwise. A decoder
// that has overflowed stays dead: further pushes are no-ops, so a caller that
// destroys its socket asynchronously cannot be re-entered mid-teardown.
function makeSseDecoder({ onEvent, dropUnparsableData = false, maxBufferBytes = 0, onOverflow = null } = {}) {
  let buf = '';
  let overflowed = false;

  return {
    push(chunk) {
      if (overflowed) return false;
      buf += chunk;
      // Frames are separated by a blank line. Tolerate CRLF and LF (D1); the
      // separator's own length is re-measured so the slice stays correct for
      // either.
      let idx;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + buf.slice(idx).match(/^\r?\n\r?\n/)[0].length);
        // Bound check AFTER the slice, before delivering — peer-client's exact
        // order, preserved (D5).
        if (maxBufferBytes > 0 && buf.length > maxBufferBytes) {
          overflowed = true;
          if (onOverflow) onOverflow();
          return false;
        }
        const frame = parseSseBlock(block);
        if (!frame) continue;             // comment-only / dataless
        let data;
        try {
          data = JSON.parse(frame.data);
        } catch {
          if (dropUnparsableData) continue;
          data = frame.data;
        }
        if (onEvent) onEvent(frame.event || 'message', data);
      }
      return true;
    },
    // Residual bytes not yet forming a complete frame. Exposed for tests and
    // for anyone diagnosing a producer that never terminates a frame.
    buffered() { return buf.length; },
  };
}

module.exports = { parseSseBlock, makeSseDecoder };
