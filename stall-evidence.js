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

// A ticket whose assignee resolves to NO live seat. Not a stall — nothing is
// quiet, because nothing exists to be quiet — so it must not borrow the stall
// wording. Measured on t376: "hand quiet 31m (no commits)" and then "STILL
// stalled (repeat 1): hand quiet 1h" about a seat retired an hour earlier. The
// lead's first move on a stall (look at what the seat is doing) has no referent
// here, and an alarm that sends the lead looking for a seat that does not exist
// is the noise that teaches it to dismiss the alarm that matters.
//
// So the wording names the ONE fact — no seat holds this — and the three exits.
// `who` is the role or the dead seat's name; it is what the ticket still claims,
// which is precisely the thing to disbelieve, so it is quoted as a claim rather
// than stated as an actor.
//
// The git evidence rides along because it is what decides between the exits: a
// branch with commits on it is worth reassigning, an untouched one is worth
// cancelling. The transcript field never appears — there is no seat to read one
// from, and `_stallEvidence` returns `tool: null` for exactly that reason.
function formatOrphanBody({ ticketId, who, age, commits = null, dirty = null }) {
  const head = `[ticket ${ticketId}] assigned to "${who}", which is not a live seat — not stalled, UNASSIGNED (quiet ${age})`;
  const bits = [];
  if (commits != null) bits.push(commits === 0 ? 'no commits' : `${commits} commit${commits === 1 ? '' : 's'}`);
  if (dirty != null) bits.push(dirty ? 'tree dirty' : 'tree clean');
  const ev = bits.length ? ` (${bits.join(', ')})` : '';
  return `${head}${ev} — reassign it, cancel it, or park it; nothing is working on it and nothing will`;
}

// `ps -o time=` output -> milliseconds of accumulated CPU, or null.
//
// Two formats, both real: `MM:SS.cc` and `HH:MM:SS.cc` (ps switches at an hour).
// The CENTISECONDS are the whole reason this is parsed rather than compared as a
// string — a composing turn accrues ~0.57s over 40s, which is invisible at
// second resolution and is exactly the signal that separates it from a wedge.
//
// Null on anything unrecognized rather than a guessed 0: 0 reads as "no CPU
// accrued", which is the WEDGE verdict, so a parse failure would alarm about a
// healthy seat with a confidently wrong number behind it.
function parseCpuTime(text) {
  if (!text) return null;
  const m = /(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/.exec(String(text).trim());
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || !Number.isFinite(sec)) return null;
  return Math.round(((h * 3600) + (min * 60) + sec) * 1000);
}

// Is a reviewer seat alive? Two signals, and it takes BOTH being flat to call a
// wedge.
//
// Measured live on clodex-reviewer-377-r1, 2026-08-14, and every branch here is
// one of those observations:
//   03:08Z  transcript +135KB/8min, CPU rising   -> HEALTHY, working
//   03:11Z  transcript FLAT 3 minutes, CPU 0:52.00->0:53.13 in 40s (~2.5%)
//                                                -> HEALTHY, composing a long turn
// The second is why transcript growth alone is not the test: a big assistant
// message burns CPU and writes NOTHING to the transcript until it flushes, so a
// growth-only probe calls a healthy seat wedged — the false alarm this exists to
// remove, arrived at from the other side.
//
// `prev` is the previous sweep's sample; samples come from consecutive sweeps
// rather than a sleep inside one, because the sweep is already periodic and a
// 60s timer must not block on a second reading.
//
// Verdicts: 'moving' (suppress the alarm), 'wedged', 'idle-alive' (CPU moving,
// transcript flat for longer than the stall window — alive but producing
// nothing, which the spec keeps reportable), 'unknown' (no baseline yet, or the
// gap is too short to read).
//
// CPU_RATE_MS_PER_MIN defends against both measured numbers at once: 200ms/min
// is 0.33% CPU, 7.5x below the composing seat's 2.5%, and far above what a
// process blocked in a syscall accrues. Rate-normalized, so a sweep that runs
// late does not silently tighten the threshold.
//
// PLATFORM: the margin above assumes macOS `ps`, which reports CPU to
// CENTISECONDS. Linux procps reports whole seconds, and this repo runs there —
// headless-main.js and the container sandbox are both real targets. At 1s
// resolution a composing turn accruing 0.35s over a 16s gap reads as 0, i.e. as
// wedged, which is precisely the false alarm this module exists to remove. The
// caller's answer is not a bigger threshold (that would blind it to real
// wedges) but requiring the verdict to REPEAT — see `_probeReviewSeat`.
// Did the transcript grow between two samples? THE ONLY copy of this predicate:
// a second one drifted from this within a single ticket, missing the `>= 0`
// guards below and reintroducing the bug they exist to fix.
//
// A NEGATIVE size is the probe's "could not read", not a byte count, and both
// ends must be real for a comparison to mean anything. Without the `>= 0` terms
// an unreadable baseline (-1) followed by a readable but EMPTY transcript (0)
// satisfies `0 > -1` and reads as growth — phantom evidence that a seat wrote
// something, suppressing the alarm on a seat that has produced nothing at all.
function didGrow(prevSize, curSize) {
  return typeof prevSize === 'number' && typeof curSize === 'number'
    && prevSize >= 0 && curSize >= 0 && curSize > prevSize;
}

const CPU_RATE_MS_PER_MIN = 200;
// MUST stay BELOW the ticket watchdog's sweep interval (`startTicketWatchdog`,
// 60s by default and parameterized). Samples come from consecutive sweeps, so a
// sweep interval under this returns 'unknown' for every probe forever — and the
// caller defers the alarm on 'unknown', so the review-step alarm disappears
// silently, with no error and no log line.
const MIN_GAP_MS = 30 * 1000;

function classifyReviewSeat(prev, cur, { stallMs = 30 * 60 * 1000 } = {}) {
  if (!prev || !cur) return { verdict: 'unknown', cpuRead: !!(cur && cur.cpuMs != null) };
  const gap = cur.at - prev.at;
  if (!(gap >= MIN_GAP_MS)) return { verdict: 'unknown', cpuRead: cur.cpuMs != null };
  const grew = didGrow(prev.size, cur.size);
  const cpuRead = cur.cpuMs != null && prev.cpuMs != null;
  const cpuAccrued = cpuRead
    && (cur.cpuMs - prev.cpuMs) >= ((gap / 60000) * CPU_RATE_MS_PER_MIN);
  if (grew) return { verdict: 'moving', cpuRead };
  if (cpuAccrued) {
    // Alive, but the transcript has not moved in longer than the whole stall
    // window. Composing does not reach here: the measured composing stretch was
    // 3 minutes against a 30m window. Reported with its own wording because the
    // lead's next move differs — a wedged seat gets poked, a seat that has burned
    // CPU for half an hour without writing gets read.
    const flatFor = cur.lastGrowthAt != null ? (cur.at - cur.lastGrowthAt) : 0;
    if (flatFor >= stallMs) return { verdict: 'idle-alive', cpuRead, flatFor };
    return { verdict: 'moving', cpuRead };
  }
  return { verdict: 'wedged', cpuRead };
}

// The seat clause appended to a loop-held review alarm. Returns '' when there is
// nothing true to say, so the caller can concatenate unconditionally.
//
// `cpuRead: false` is stated rather than swallowed. Without CPU the test is
// growth-only, which is the probe that misfires on composing — so the alarm says
// which of its two signals it actually had, instead of presenting a one-signal
// reading with a two-signal alarm's authority.
function formatReviewSeatClause({ seat, verdict, cpuRead = true, flatFor = null, age = null } = {}) {
  if (!seat) return '';
  if (verdict === 'wedged') {
    return cpuRead
      ? ` — reviewer ${seat} is WEDGED: no transcript growth and no CPU since the last sweep`
      : ` — reviewer ${seat} has written nothing since the last sweep, and its CPU could not be sampled, so a long composing turn cannot be ruled out`;
  }
  if (verdict === 'idle-alive') {
    const how = flatFor != null && age ? ` for ${age}` : '';
    return ` — reviewer ${seat} is running (CPU is accruing) but has written nothing${how}`;
  }
  return '';
}

module.exports = {
  readTail, lastToolFrom, formatStallBody, formatOrphanBody,
  parseCpuTime, classifyReviewSeat, formatReviewSeatClause, didGrow,
  CPU_RATE_MS_PER_MIN, MIN_GAP_MS,
};
