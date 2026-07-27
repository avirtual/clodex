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
//   D5 `maxBufferBytes` — RESOLVED IN t48, no longer a divergence. It was: the
//      GUI bounded residue at 8MB and the CLI had no bound at all, AND the GUI's
//      bound could never fire (it was checked inside the drain loop, so it
//      needed one push carrying both a frame terminator and >8MB behind it —
//      impossible, since Node delivers response bytes in 64KB chunks). Both
//      halves are fixed below: ONE default limit, checked ON ACCUMULATION.
//      Still an option, because a test must be able to reach it without moving
//      megabytes; neither head overrides it.
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

// The residual-buffer ceiling: how many bytes may sit UNFRAMED before we
// conclude the producer is not going to terminate a frame. Not a guess —
// derived from what the wire can legitimately carry.
//
// The largest frame remote.js ever writes is `replay`, whose payload is a
// session's scrollback ring: SCROLLBACK_MAX is 256KB (engine.js:496), base64'd
// to ~342KB, plus JSON escaping. 1MB is ~3x the largest legitimate frame — room
// for the escaping worst case and for the ring to grow a generation, while
// still catching an unterminated stream three orders of magnitude before the
// old 8MB number would have (had it been reachable).
//
// One number for both heads. They consume the same producer over the same
// protocol, so a limit that fits one fits the other; splitting it would mean
// claiming remote.js writes bigger frames to one client than the other, which
// it does not. If that ever stops being true this becomes a parameter with the
// reason at the parameter, as D4 is.
const MAX_BUFFER_BYTES = 1024 * 1024;

// A stateful decoder over a chunked utf8 stream.
//
//   onEvent(name, data)  — one complete frame. `name` defaults to 'message'.
//                          `data` is the JSON-parsed payload.
//   dropUnparsableData   — true: a `data:` line that is not JSON drops the
//                          whole frame (GUI). false: the raw string is
//                          delivered instead (CLI). See D4.
//   maxBufferBytes       — unframed-residue ceiling; MAX_BUFFER_BYTES by
//                          default, 0 disables. Both heads take the default.
//   onOverflow(bytes)    — the ceiling was passed; `bytes` is how much unframed
//                          residue had accumulated. The decoder owns no socket
//                          (deliberately — it must never grow one), so tearing
//                          the transport down is the caller's job, and so is
//                          SAYING SO: a bound that fires silently is one nobody
//                          can diagnose.
//
// THE CHECK IS ON ACCUMULATION, NOT ON DRAIN (t48). It used to sit inside the
// drain loop, which made it unreachable: firing needed a single push carrying
// both a frame terminator and >limit of residue behind it, and Node delivers
// response bytes in 64KB chunks — so the one case the bound exists for, an
// unterminated multi-megabyte line, never entered the loop at all. Checking
// where the bytes ARRIVE is what makes it a bound rather than a decoration.
//
// push(chunk) returns false once overflow has fired, true otherwise. A decoder
// that has overflowed stays dead: further pushes are no-ops, so a caller that
// destroys its socket asynchronously cannot be re-entered mid-teardown.
function makeSseDecoder({ onEvent, dropUnparsableData = false, maxBufferBytes = MAX_BUFFER_BYTES, onOverflow = null } = {}) {
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
      // Whatever is LEFT is unframed residue. Checked here — after draining
      // every complete frame, so a well-framed stream of any total size passes
      // (only the tail of a partial frame is ever measured), and before the
      // next push, so an unterminated line is caught within one chunk of
      // crossing the line rather than never.
      if (maxBufferBytes > 0 && buf.length > maxBufferBytes) {
        overflowed = true;
        const n = buf.length;
        buf = '';                      // drop it: nothing downstream can use it
        if (onOverflow) onOverflow(n);
        return false;
      }
      return true;
    },
    // Residual bytes not yet forming a complete frame. Exposed for tests and
    // for anyone diagnosing a producer that never terminates a frame.
    buffered() { return buf.length; },
  };
}

module.exports = { parseSseBlock, makeSseDecoder, MAX_BUFFER_BYTES };
