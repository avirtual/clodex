// stall-evidence.js — the evidence a stall alarm carries, so the lead can tell a
// seat that is WRITING from a seat that is WEDGED without probing by hand.
//
// Measured failure this exists to prevent (t312, 2026-08-12): the watchdog fired
// on time with "hand quiet 30m" and the lead dismissed it as benign after
// checking that the worktree was dirty with real work. It was dirty because the
// seat had been SIGKILLed mid-write — a tool exited 137, that killed the whole
// turn, and the harness's contentless "Continue" nudge produced a no-op turn.
// A dirty tree is IDENTICAL in both cases, so it is not evidence and this module
// never presents it as such: `dirty` is only ever reported next to the outcome of
// the last tool call, which is what actually separates them.
//
// Every field is best-effort and OMITTED when unavailable. A confidently wrong
// field in an alarm is worse than a missing one — it re-creates the dismissal
// this module exists to prevent, with the alarm's own authority behind it.
//
// Pure: fs is injected, no electron, no clock of its own.

// Read the last `bytes` of a file. Transcripts run to megabytes and this is
// called from a 60s sweep timer, so the whole file is never read; the last tool
// call is at the END by construction.
function readTail(fs, file, bytes = 64 * 1024) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* best-effort */ } }
  }
}

// The last tool call in a transcript tail, and how it ended.
//
//   { tool: 'Bash', outcome: 'error'   }  the call returned an error result
//   { tool: 'Bash', outcome: 'pending' }  NO result ever arrived
//   { tool: 'Bash', outcome: 'ok'      }  the call returned cleanly
//   null                                  nothing readable — say nothing
//
// `pending` is the strongest wedge signal available anywhere in this repo. A
// tool_use with no matching tool_result means the call never returned inside the
// transcript — the turn died holding it, which is exactly the t312 shape (the
// SIGKILL ended the turn, not just the call). It is NOT the same as "a slow call
// is still running": both look identical here, and that ambiguity is deliberate
// and stated in the alarm's own wording rather than hidden behind a guess.
//
// A truncated first line is normal (the tail starts mid-file) and is skipped by
// the JSON.parse guard, not specially handled.
//
// KNOWN BLIND SPOT, not a bug to patch by reinstating sidechain entries: a seat
// blocked on a long `Task` subagent writes sidechain lines continuously, so the
// 64KB tail can hold nothing BUT sidechain volume and the seat's own
// `tool_use Task` falls outside the window. This returns null there, and the
// alarm loses its strongest field on the seat most likely to be wedged. It is
// the fail-safe direction — omitting beats misattributing a subagent's call to
// the seat — and consistent with the module's stated policy above. The fix, if
// this is ever measured to matter, is to keep scanning BACKWARD past the
// sidechain volume (re-read with a larger window when a tail yields no
// non-sidechain `tool_use`), never to widen what counts as the seat's own call.
function lastToolFrom(text) {
  if (!text) return null;
  let use = null;          // { name, id } — the most recent tool_use seen
  const results = new Map(); // tool_use_id -> is_error
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let d = null;
    try { d = JSON.parse(s); } catch { continue; }
    // Subagent turns are a DIFFERENT actor's tool calls. Counting them names the
    // subagent's tool as the seat's own — matching transcript.js, which skips
    // them for the same reason.
    if (d && d.isSidechain) continue;
    const content = d && d.message && d.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && b.name) use = { name: String(b.name), id: b.id || null };
      else if (b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, b.is_error === true);
    }
  }
  if (!use) return null;
  if (use.id == null || !results.has(use.id)) return { tool: use.name, outcome: 'pending' };
  return { tool: use.name, outcome: results.get(use.id) ? 'error' : 'ok' };
}

// One glanceable line. This fires into the lead's prompt stream, so it stays on
// one line and leads with the ticket id.
//
// `age` is pre-humanized by the caller (the sweep owns the clock and its own
// formatter). `repeat` marks a re-escalation: an unmarked repeat reads as a new
// stall and invites the lead to re-answer a question it already answered.
function formatStallBody({ ticketId, who, age, repeat = 0, tool = null, commits = null, dirty = null }) {
  const head = repeat > 0
    ? `[ticket ${ticketId}] STILL stalled (repeat ${repeat}): ${who} quiet ${age}`
    : `[ticket ${ticketId}] stalled: ${who} quiet ${age}`;
  const bits = [];
  if (tool && tool.tool) {
    if (tool.outcome === 'pending') bits.push(`last tool ${tool.tool} never returned`);
    else if (tool.outcome === 'error') bits.push(`last tool ${tool.tool} errored`);
    else bits.push(`last tool ${tool.tool} ok`);
  }
  if (commits != null) bits.push(commits === 0 ? 'no commits' : `${commits} commit${commits === 1 ? '' : 's'}`);
  if (dirty != null) bits.push(dirty ? 'tree dirty' : 'tree clean');
  if (!bits.length) return head;
  // The reading, not just the facts. The lead dismissed t312 by reasoning from a
  // dirty tree alone; naming which way the evidence points is what makes the
  // alarm cheaper to act on than a hand probe.
  let verdict = '';
  if (tool && tool.outcome === 'pending') verdict = ' — wedged mid-call, or a legitimately slow one';
  else if (tool && tool.outcome === 'error') verdict = ' — the last call failed; a killed turn looks like this';
  return `${head} (${bits.join(', ')})${verdict}`;
}

module.exports = { readTail, lastToolFrom, formatStallBody };
