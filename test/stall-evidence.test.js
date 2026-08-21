'use strict';
// Run: node --test test/stall-evidence.test.js
//
// t322 — the evidence a stall alarm carries.
//
// The subject is a MEASURED dismissal, not a hypothetical: on t312 the watchdog
// fired on time ("hand quiet 30m") and the lead waved it off after checking that
// the worktree was dirty with 130 lines of real work. The seat had been
// SIGKILLed mid-write. A dirty tree is identical in both cases, so the tests
// below are mostly about what the module REFUSES to say — a wrong field in an
// alarm is worse than a missing one, because it carries the alarm's authority.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  readTail, lastToolFrom, lastApiErrorFrom, formatStallBody, formatOrphanBody,
  parseCpuTime, sumTreeCpuMs, classifyReviewSeat, formatReviewSeatClause, API_ERROR_MAX,
} = require('../stall-evidence');

// t384 — the two-signal reviewer liveness test.
//
// Every fixture below is one of the two LIVE observations of
// clodex-reviewer-377-r1 on 2026-08-14, because the ticket's whole claim is
// about which of them a probe can tell apart:
//   03:08Z  transcript +135KB/8min, CPU rising  -> HEALTHY (working)
//   03:11Z  transcript FLAT 3 minutes, CPU 0:52.00 -> 0:53.13 in 40s -> HEALTHY
//           (composing a long turn: it burns CPU and writes nothing until flush)
// A growth-only probe calls the second one wedged. That is the false alarm this
// ticket exists to remove, so it gets its own test rather than a branch of one.
const MIN = 60 * 1000;
const STALL = 30 * MIN;
const sample = (at, size, cpuMs, lastGrowthAt = null) => ({ at, size, cpuMs, lastGrowthAt });

function jsonl(...entries) {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}
const use = (name, id) => ({ message: { content: [{ type: 'tool_use', name, id }] } });
const result = (id, isError) => ({ message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } });

// ── lastToolFrom ───────────────────────────────────────────────────────────

test('a tool_use with no matching result reads as pending — the t312 shape', () => {
  // The exact measured sequence: a Bash call killed by SIGKILL mid-run. The kill
  // ended the TURN, so no tool_result was ever written.
  const t = lastToolFrom(jsonl(use('Read', 'a1'), result('a1', false), use('Bash', 'a2')));
  assert.deepStrictEqual(t, { tool: 'Bash', outcome: 'pending' },
    'the unreturned call is the one reported, not the completed Read before it');
});

test('a tool_result carrying is_error reads as error', () => {
  const t = lastToolFrom(jsonl(use('Bash', 'b1'), result('b1', true)));
  assert.deepStrictEqual(t, { tool: 'Bash', outcome: 'error' });
});

test('a clean result reads as ok — a working seat must not look wedged', () => {
  const t = lastToolFrom(jsonl(use('Edit', 'c1'), result('c1', false)));
  assert.deepStrictEqual(t, { tool: 'Edit', outcome: 'ok' });
  // The inverse of the t312 failure: over-reporting a wedge on a seat that is
  // simply writing trains the lead to dismiss the alarm, which is how the
  // measured dismissal happened in the first place.
});

test('nothing readable returns null rather than a guess', () => {
  for (const input of ['', null, undefined, 'not json at all\n{"broken":', jsonl({ message: { content: 'plain text' } })]) {
    assert.strictEqual(lastToolFrom(input), null, `no field for input ${JSON.stringify(input)}`);
  }
});

test('a truncated leading line is skipped, not fatal', () => {
  // readTail starts mid-file by construction, so the first line is usually a
  // fragment. If that threw or aborted the walk, every alarm would lose its
  // strongest field on exactly the long transcripts a stall produces.
  const text = '{"message":{"conte' + '\n' + jsonl(use('Bash', 'd1'));
  assert.deepStrictEqual(lastToolFrom(text), { tool: 'Bash', outcome: 'pending' });
});

test('a subagent`s tool call is not reported as the seat`s own', () => {
  // isSidechain entries are a DIFFERENT actor's turns. A seat whose last activity
  // was a Task subagent would otherwise have the subagent's tool named in its
  // alarm — the alarm's whole value is being literally true about the seat.
  // transcript.js skips them for the same reason.
  const text = jsonl(
    use('Bash', 'p1'),
    { isSidechain: true, message: { content: [{ type: 'tool_use', name: 'Grep', id: 's1' }] } },
    { isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 's1', is_error: false }] } },
  );
  assert.deepStrictEqual(lastToolFrom(text), { tool: 'Bash', outcome: 'pending' },
    'the seat`s own unreturned Bash, not the subagent`s completed Grep');
});

test('a sidechain tool_result cannot close the seat`s own pending call', () => {
  // The id-collision direction of the same rule: if sidechain results were
  // collected, one carrying the seat's tool_use_id would flip a wedged `pending`
  // to a reassuring `ok` — the alarm suppressing itself on another actor's work.
  const text = jsonl(
    use('Bash', 'x1'),
    { isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 'x1', is_error: false }] } },
  );
  assert.deepStrictEqual(lastToolFrom(text), { tool: 'Bash', outcome: 'pending' });
});

test('the LAST tool wins when several completed calls precede it', () => {
  const t = lastToolFrom(jsonl(
    use('Read', 'e1'), result('e1', false),
    use('Grep', 'e2'), result('e2', false),
    use('Bash', 'e3'), result('e3', true),
  ));
  assert.deepStrictEqual(t, { tool: 'Bash', outcome: 'error' }, 'the newest call, not the first');
});

// ── readTail ───────────────────────────────────────────────────────────────

test('readTail returns only the tail of a large file, and the tail is what parses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-tail-'));
  const file = path.join(dir, 'transcript.jsonl');
  const filler = jsonl(...Array.from({ length: 4000 }, (_, i) => use('Filler', `f${i}`)));
  fs.writeFileSync(file, filler + jsonl(use('Bash', 'last')));
  assert.ok(fs.statSync(file).size > 64 * 1024, 'ENTER: the fixture file really is bigger than the tail window');

  const tail = readTail(fs, file);
  assert.ok(tail.length <= 64 * 1024, 'only the tail is read');
  assert.deepStrictEqual(lastToolFrom(tail), { tool: 'Bash', outcome: 'pending' },
    'and the last call is still recoverable from it');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readTail on a missing file returns empty, never throws', () => {
  assert.strictEqual(readTail(fs, '/nonexistent/nope.jsonl'), '');
});

// ── formatStallBody ────────────────────────────────────────────────────────

test('an unavailable datum is omitted, never approximated', () => {
  const body = formatStallBody({ ticketId: 't1', who: 'hand', age: '30m' });
  assert.strictEqual(body, '[ticket t1] stalled: hand quiet 30m');
  assert.ok(!/commit|dirty|clean|tool/.test(body), 'no field is invented when nothing was measurable');
});

test('a dirty tree is never reported without the tool outcome beside it', () => {
  // The t312 trap, encoded. Dirty alone is what the lead reasoned from, and it
  // is TRUE of both a seat writing and a seat killed mid-write.
  const wedged = formatStallBody({
    ticketId: 't312', who: 'hand', age: '30m',
    tool: { tool: 'Bash', outcome: 'pending' }, commits: 0, dirty: true,
  });
  const working = formatStallBody({
    ticketId: 't312', who: 'hand', age: '30m',
    tool: { tool: 'Edit', outcome: 'ok' }, commits: 0, dirty: true,
  });
  assert.ok(/tree dirty/.test(wedged) && /tree dirty/.test(working),
    'ENTER: both bodies really do carry the dirty flag — otherwise the contrast below is vacuous');
  assert.notStrictEqual(wedged, working,
    'two states the lead could not tell apart must not produce the same alarm');
  assert.ok(/never returned/.test(wedged), 'the wedged one names the unreturned call');
  assert.ok(!/never returned|errored/.test(working), 'the working one makes no wedge claim');
});

test('a repeat says it is a repeat and carries the updated age', () => {
  const first = formatStallBody({ ticketId: 't1', who: 'hand', age: '30m' });
  const again = formatStallBody({ ticketId: 't1', who: 'hand', age: '1h', repeat: 1 });
  assert.ok(!/STILL|repeat/.test(first), 'the first alarm is not marked as a repeat');
  assert.match(again, /STILL stalled \(repeat 1\)/, 'the second is');
  assert.match(again, /quiet 1h/, 'and it carries the new age, not the old one');
});

test('the body stays one line — it fires into the lead prompt stream', () => {
  const body = formatStallBody({
    ticketId: 't1', who: 'hand', age: '2h', repeat: 1,
    tool: { tool: 'Bash', outcome: 'error' }, commits: 3, dirty: true,
  });
  assert.ok(!body.includes('\n'), 'no newlines');
  assert.ok(body.length < 220, `short enough to read at a glance (was ${body.length})`);
});

test('zero commits and no commits are distinguished from an unmeasurable branch', () => {
  const zero = formatStallBody({ ticketId: 't1', who: 'hand', age: '30m', commits: 0 });
  const some = formatStallBody({ ticketId: 't1', who: 'hand', age: '30m', commits: 1 });
  const unknown = formatStallBody({ ticketId: 't1', who: 'hand', age: '30m', commits: null });
  assert.match(zero, /no commits/);
  assert.match(some, /1 commit\b/);
  assert.ok(!/commit/.test(unknown), 'a failed git probe says nothing about commits');
});

// ── t400: the wake clause ──────────────────────────────────────────────────
//
// Rung 2 injects one automated line into a wedged-confirmed seat before the lead
// is told anything. When that wake produced no turn, the alarm that follows must
// say so: the lead needs to know the cheap option was already spent, or its first
// move is to spend it again by hand.

test('t400: an unanswered wake gets its own sentence, on the bare body and the evidence body alike', () => {
  const bare = formatStallBody({ ticketId: 't1', who: 'hand', age: '35m', wake: { age: '2m' } });
  const full = formatStallBody({
    ticketId: 't1', who: 'hand', age: '35m', commits: 0, dirty: true,
    tool: { tool: 'Bash', outcome: 'pending' }, wake: { age: '2m' },
  });
  const clause = /an automated wake was injected 2m ago and produced no turn/;
  assert.match(bare, clause,
    'the bare-head case carries it too — a seat with no evidence to show is exactly where a wake is most telling');
  assert.match(full, clause, 'and so does the body that already has bits and a verdict');
  assert.ok(!full.includes('\n'), 'still one line: it fires into the lead prompt stream');
});

test('t400: no wake, no clause — the sentence never rides an alarm that had no rung 2', () => {
  const body = formatStallBody({ ticketId: 't1', who: 'hand', age: '30m', commits: 0 });
  assert.ok(!/automated wake|produced no turn/.test(body),
    'a clause on every alarm carries no information and teaches the lead to skip the line on the alarms where it does');
});

test('t400: the wake clause states the MEASUREMENT and never a verdict', () => {
  const body = formatStallBody({ ticketId: 't1', who: 'hand', age: '35m', wake: { age: '2m' } });
  // The design's explicit refusal. Under the I/O-blocked-child case the tree-CPU
  // probe cannot see, a wake fired at a HEALTHY seat queues behind the running
  // tool and produces a turn later — so "a write cannot recover this seat" is not
  // merely unproven, it is sometimes false. `formatStallBody`'s existing verdict
  // clauses are inferences the tool outcome DOES support; this one has no such
  // support and must stay a bare fact.
  assert.ok(!/cannot be recovered|cannot recover|beyond|dead|unrecoverable|give up|kill/i.test(body),
    'no verdict: the fact alone tells the lead rung 2 was spent, and what to do with that is the lead`s call '
    + 'against the other evidence in the same alarm');
  assert.match(body, /produced no turn/, 'ENTER: the clause IS present — the absence above is about its wording');
});

test('t400: the wake clause and the swallowed-dm clause coexist, and the dm reading comes first', () => {
  // Both are cause sentences and both can be true at once: a seat that was never
  // told anything, then woken. Order matters — whether the seat ever received the
  // work changes what an unanswered wake means, so it must be read first.
  const body = formatStallBody({
    ticketId: 't1', who: 'hand', age: '35m',
    dmLatch: { count: 2, age: '40m' }, wake: { age: '2m' },
  });
  assert.match(body, /swallowed delivery/, 'ENTER: the dm clause is present');
  assert.match(body, /automated wake/, 'ENTER: and so is the wake clause');
  assert.ok(body.indexOf('swallowed delivery') < body.indexOf('automated wake'),
    'the dm reading first: "was it ever told anything" reframes "and then it ignored a wake"');
});

// ── formatOrphanBody (t377) ────────────────────────────────────────────────
//
// Measured on t376: a retired hand's ticket alarmed `stalled: hand quiet 31m
// (no commits)` and then `STILL stalled (repeat 1): hand quiet 1h`. No hand was
// quiet; no hand existed. The tests below are about the alarm not borrowing the
// stall's wording, because the wording is what tells the lead where to look.

test('t377: an orphan alarm cannot be mistaken for a stall — the wording diverges', () => {
  const orphan = formatOrphanBody({ ticketId: 't376', who: 'hand', age: '1h', commits: 0 });
  const stall = formatStallBody({ ticketId: 't376', who: 'hand', age: '1h', commits: 0 });
  // ENTER: the two bodies are built from IDENTICAL inputs. Without this the test
  // could be contrasting two different situations and pass for no reason.
  assert.notStrictEqual(orphan, stall, 'same inputs, different alarms');
  assert.match(stall, /stalled: hand quiet 1h/, 'ENTER: the stall phrasing is what it is');
  assert.ok(!/stalled: /.test(orphan),
    'the orphan never opens with "stalled:" — that phrase is the lead`s cue to go look at a seat');
  assert.match(orphan, /not stalled/, 'it denies the reading explicitly rather than merely omitting it');
  assert.match(orphan, /not a live seat/, 'it names the one fact that matters');
  assert.match(orphan, /UNASSIGNED/, 'and the state the ticket is actually in');
});

test('t377: the orphan alarm names the three exits, since none of them is "wait"', () => {
  // A stall alarm is actionable by waiting — the seat may come back. An orphan
  // never resolves itself, so a body that does not name an exit leaves the lead
  // with an alarm and no move.
  const b = formatOrphanBody({ ticketId: 't376', who: 'hand', age: '1h' });
  assert.match(b, /reassign/i);
  assert.match(b, /cancel/i);
  assert.match(b, /park/i);
  assert.match(b, /nothing is working on it/, 'and says plainly that no work is in flight');
});

test('t377: the orphan alarm carries git evidence but never a tool outcome', () => {
  // Commits/dirty decide between the exits, so they ride. A tool outcome cannot:
  // there is no seat, so there is no transcript to have read one from, and a
  // field claiming otherwise would carry the alarm's authority behind a fiction.
  const b = formatOrphanBody({ ticketId: 't376', who: 'hand', age: '1h', commits: 3, dirty: true });
  assert.match(b, /3 commits/, 'ENTER: the evidence really is in the body');
  assert.match(b, /tree dirty/);
  assert.ok(!/last tool|never returned|errored/.test(b), 'no tool claim is possible without a seat');
  const bare = formatOrphanBody({ ticketId: 't376', who: 'hand', age: '1h' });
  assert.ok(!/commit|dirty|clean/.test(bare), 'an unmeasurable branch invents nothing');
});

test('t377: the orphan body stays one line, like every alarm in the prompt stream', () => {
  const b = formatOrphanBody({ ticketId: 't376', who: 'clodex-hand-376', age: '2h', commits: 3, dirty: true });
  assert.ok(!b.includes('\n'), 'no newlines');
});

// ── t384: parsing the CPU sample ───────────────────────────────────────────

test('t384: ps time is parsed at CENTISECOND resolution, both of its formats', () => {
  // The centiseconds ARE the signal. The composing seat accrued 0.57s over 40
  // seconds; truncated to whole seconds that is 0 -> 0, which is the wedge
  // verdict, and the healthy seat is alarmed about.
  assert.strictEqual(parseCpuTime('0:52.00'), 52000);
  assert.strictEqual(parseCpuTime('0:52.57'), 52570, 'the fractional part survives');
  assert.strictEqual(parseCpuTime('0:53.13'), 53130);
  assert.strictEqual(parseCpuTime(' 1:02:03.50 '), 3723500, 'HH:MM:SS.cc, past the hour');
  assert.strictEqual(parseCpuTime('711:00.21'), 42660210, 'a big MM value is minutes, not an hour field');
});

test('t384: an unparseable sample is null, NEVER zero', () => {
  // Zero means "no CPU accrued", which is half the wedge verdict. A parse
  // failure that returned 0 would alarm about a healthy seat with a fabricated
  // number behind it — the confidently-wrong field this module refuses.
  for (const bad of ['', null, undefined, 'no such process', '  ', 'PID TIME']) {
    assert.strictEqual(parseCpuTime(bad), null, `${JSON.stringify(bad)} reads as unknown`);
  }
});

// ── t384: the two-signal classifier ────────────────────────────────────────

test('t384: a transcript that GREW is alive — the 03:08Z observation', () => {
  const prev = sample(0, 1_135_000, 50_000);
  const cur = sample(8 * MIN, 1_270_000, 52_000, 8 * MIN);
  const r = classifyReviewSeat(prev, cur, { stallMs: STALL });
  assert.strictEqual(r.verdict, 'moving', '+135KB in 8 minutes is a seat working');
});

test('t384: growth alone is sufficient — a seat that WROTE is alive with no CPU reading', () => {
  // The converse of the composing test, and it exists because a mutant SURVIVED
  // without it: every other growth fixture had CPU rising too, so the CPU signal
  // was silently covering for the growth signal and a CPU-only implementation
  // passed the whole suite. Growth is the STRONGER evidence — bytes on disk are
  // proof of a turn, where CPU is only proof of a process burning cycles — so a
  // box where `ps` is unavailable must still suppress on a writing seat.
  const prev = sample(0, 1_000_000, null, 0);
  const cur = sample(2 * MIN, 1_100_000, null, 2 * MIN);
  const r = classifyReviewSeat(prev, cur, { stallMs: STALL });
  assert.strictEqual(r.cpuRead, false, 'ENTER: there really is no CPU signal here');
  assert.strictEqual(r.verdict, 'moving', '+100KB is a seat working, whatever ps could not say');
});

test('t384: THE COMPOSING CASE — flat transcript, rising CPU, is ALIVE', () => {
  // The load-bearing test, and the one that dies to a growth-only probe: this is
  // the 03:11Z observation, byte for byte. The transcript had not moved for 3
  // minutes while CPU went 0:52.00 -> 0:53.13 across 40 seconds. A probe keying
  // on growth alone calls this a wedge and fires the alarm the ticket exists to
  // remove.
  const prev = sample(0, 1_270_000, parseCpuTime('0:52.00'), -3 * MIN);
  const cur = sample(40 * 1000, 1_270_000, parseCpuTime('0:53.13'), -3 * MIN);
  const r = classifyReviewSeat(prev, cur, { stallMs: STALL });
  assert.strictEqual(cur.size, prev.size, 'ENTER: the transcript really is flat — the growth signal says WEDGE here');
  assert.strictEqual(r.verdict, 'moving', 'the CPU signal is what saves it');
  assert.strictEqual(r.cpuRead, true);
});

test('t384: BOTH flat is the wedge — and it is the only shape that is', () => {
  const prev = sample(0, 1_270_000, 52_000, 0);
  const cur = sample(2 * MIN, 1_270_000, 52_000, 0);
  const r = classifyReviewSeat(prev, cur, { stallMs: STALL });
  assert.strictEqual(r.verdict, 'wedged');
  assert.strictEqual(r.cpuRead, true, 'and it says it had both signals');
});

test('t384: the CPU threshold clears the measured composing rate by a wide margin', () => {
  // Defended against the numbers, not chosen by taste. Composing ran at ~2.5%
  // (0.57s/40s); the threshold is 200ms per 60s = 0.33%, so a composing seat is
  // 7.5x clear of it. A seat accruing a hair under the line is still a wedge.
  const rate = (ms, gapMs) => classifyReviewSeat(
    sample(0, 100, 0, 0), sample(gapMs, 100, ms, 0), { stallMs: STALL },
  ).verdict;
  assert.strictEqual(rate(570, 40 * 1000), 'moving', 'the measured composing rate is alive');
  assert.strictEqual(rate(199, 60 * 1000), 'wedged', 'just under the rate is not');
  assert.strictEqual(rate(201, 60 * 1000), 'moving', 'just over it is');
  assert.strictEqual(rate(400, 120 * 1000), 'moving',
    'the threshold is a RATE: a late sweep must not change the verdict');
  assert.strictEqual(rate(399, 120 * 1000), 'wedged', 'and the rate holds in both directions');
});

test('t384: no baseline and too-short a gap both read as UNKNOWN, not as wedged', () => {
  // The first sweep after a seat appears has nothing to compare against, and a
  // few-second gap is noise. Guessing "wedged" from either is the false alarm
  // arriving from a third direction.
  assert.strictEqual(classifyReviewSeat(null, sample(MIN, 100, 1000)).verdict, 'unknown');
  assert.strictEqual(
    classifyReviewSeat(sample(0, 100, 1000, 0), sample(5000, 100, 1000, 0)).verdict, 'unknown',
    'a 5s gap cannot separate a wedge from a pause between writes',
  );
});

test('t384: CPU accruing with a transcript flat PAST the stall window is reported, not suppressed', () => {
  // The spec keeps this reportable: a seat burning CPU for half an hour without
  // writing is worth a look. Composing cannot reach here — that stretch was 3
  // minutes against a 30m window — so the WINDOW is what separates them.
  const prev = sample(0, 100, 0, -STALL);
  const cur = sample(MIN, 100, 1000, -STALL);
  const r = classifyReviewSeat(prev, cur, { stallMs: STALL });
  assert.strictEqual(r.verdict, 'idle-alive');
  const composing = classifyReviewSeat(
    sample(0, 100, 0, -3 * MIN), sample(MIN, 100, 1000, -3 * MIN), { stallMs: STALL },
  );
  assert.strictEqual(composing.verdict, 'moving', 'ENTER: the same CPU shape inside the window is just composing');
});

test('t384: an unreadable CPU sample degrades to growth-only and SAYS SO', () => {
  // Not silence (that deletes the alarm) and not a confident wedge (that is the
  // growth-only misfire). It alarms, and it states which signal it lacked.
  const prev = sample(0, 100, null, 0);
  const cur = sample(2 * MIN, 100, null, 0);
  const r = classifyReviewSeat(prev, cur, { stallMs: STALL });
  assert.strictEqual(r.verdict, 'wedged', 'a flat transcript still alarms');
  assert.strictEqual(r.cpuRead, false, 'but the reading is marked one-signal');
  const clause = formatReviewSeatClause({ seat: 'rv', verdict: 'wedged', cpuRead: false });
  assert.match(clause, /could not be sampled/, 'and the body admits it');
  assert.match(clause, /composing turn cannot be ruled out/, 'naming the case it cannot exclude');
  assert.ok(!/WEDGED/.test(clause), 'so it must not claim the two-signal verdict');
});

// ── t384: the clause the alarm carries ─────────────────────────────────────

test('t384: a live verdict adds NOTHING to the alarm body', () => {
  // 'moving' suppresses the alarm entirely at the call site, so a clause for it
  // would be dead text; 'unknown' means the probe had no reading, and an alarm
  // that narrates its own lack of data is noise.
  assert.strictEqual(formatReviewSeatClause({ seat: 'rv', verdict: 'moving' }), '');
  assert.strictEqual(formatReviewSeatClause({ seat: 'rv', verdict: 'unknown' }), '');
  assert.strictEqual(formatReviewSeatClause({ seat: null, verdict: 'wedged' }), '',
    'and with no seat there is nothing true to say about one');
});

test('t384: the wedge clause names the seat and both signals, on one line', () => {
  const c = formatReviewSeatClause({ seat: 'clodex-reviewer-377-r1', verdict: 'wedged' });
  assert.match(c, /clodex-reviewer-377-r1/, 'the seat the lead must go look at');
  assert.match(c, /WEDGED/);
  assert.match(c, /no transcript growth and no CPU/, 'both signals, since one alone proves nothing');
  assert.ok(!c.includes('\n'), 'one line, like every alarm in the prompt stream');
});

test('t384: the idle-alive clause does not call a running seat wedged', () => {
  const c = formatReviewSeatClause({ seat: 'rv', verdict: 'idle-alive', flatFor: STALL, age: '31m' });
  assert.match(c, /is running/);
  assert.match(c, /written nothing for 31m/);
  assert.ok(!/WEDGED/.test(c), 'a seat with CPU accruing is not wedged, and the wording must not blur that');
});

test('t384: an UNREADABLE transcript never counts as growth against a readable one', () => {
  // The probe returns -1 for "could not read" and 0 for "read it, it is empty" —
  // and the distinction is load-bearing here, not bookkeeping. Collapsing the two
  // to 0 was a mutant that SURVIVED the first draft of this file: a -1 baseline
  // followed by a 0 satisfies `0 > -1`, so an fs error healing into an empty file
  // reads as a seat that wrote something, and the alarm is suppressed on a seat
  // that has produced nothing at all.
  const r = classifyReviewSeat(
    sample(0, -1, 0, 0), sample(2 * MIN, 0, 0, 0), { stallMs: STALL },
  );
  assert.strictEqual(r.verdict, 'wedged', 'a phantom -1 -> 0 step is not evidence of a turn');
  const back = classifyReviewSeat(
    sample(0, 500, 0, 0), sample(2 * MIN, -1, 0, 0), { stallMs: STALL },
  );
  assert.strictEqual(back.verdict, 'wedged', 'and neither is losing the file mid-review');
});

// ── t388: the swallowed-dm cause clause ────────────────────────────────────
//
// A seat that was written to and never took a turn is silent, and the sweep
// reads that silence as a stalled seat. Every exit that follows from "stalled"
// (ask it what is taking so long, nudge it, kill it) is wrong if the seat was
// never told anything in the first place — so the clause does not add evidence,
// it changes which actor the alarm is about.

test('t388: a stall on a seat with an unconfirmed dm latch names the swallow as a possible cause', () => {
  const plain = formatStallBody({ ticketId: 't1', who: 'hand', age: '30m', commits: 0 });
  const withDm = formatStallBody({
    ticketId: 't1', who: 'hand', age: '30m', commits: 0, dmLatch: { count: 1, age: '31m' },
  });
  // ENTER: both bodies are built from IDENTICAL inputs but for the latch, so the
  // difference below cannot be some other field doing the work.
  assert.notStrictEqual(plain, withDm, 'same inputs but the latch, different bodies');
  assert.ok(!/swallowed/.test(plain),
    'ENTER: the cause sentence must be ABSENT without a latch — unconditional, it would appear on every stall '
    + 'alarm in the system and mean nothing on any of them');
  assert.match(withDm, /a dm written to it 31m ago never produced a turn/,
    'the clause states the observation, with the age of the write rather than of the ticket');
  assert.match(withDm, /may be a swallowed delivery rather than a stalled seat/,
    'and it names the alternative READING — that is the whole content of the line, since the lead defaults to '
    + '"stalled" and every action that follows from it is wrong for a seat that was never told');
  assert.match(withDm, /no commits/, 'without displacing the git evidence the alarm already carried');
});

test('t388: the cause clause rides a bare stall body too, where it matters most', () => {
  // A swallowed dm is MOST likely on a seat with no evidence to show: it never
  // started, so there is no tool, no commit, no dirty tree. A clause appended
  // only to the parenthesised evidence list would be missing from exactly the
  // shape it was built for.
  const bare = formatStallBody({ ticketId: 't1', who: 'hand', age: '30m', dmLatch: { count: 1, age: '30m' } });
  assert.ok(!/\(/.test(bare), 'ENTER: no evidence bits, so this is the bare-head shape');
  assert.match(bare, /may be a swallowed delivery/, 'and the clause is still there');
});

test('t388: the clause counts the outstanding dms and stays singular for one', () => {
  const one = formatStallBody({ ticketId: 't1', who: 'hand', age: '30m', dmLatch: { count: 1, age: '30m' } });
  const many = formatStallBody({ ticketId: 't1', who: 'hand', age: '30m', dmLatch: { count: 3, age: '45m' } });
  assert.match(one, /a dm written to it/, 'one reads as "a dm"');
  assert.match(many, /3 dms written to it/, 'three reads as a count — the lead needs to know how much is unread');
  assert.ok(!/1 dms/.test(one), 'and the singular is not the plural with a number in front of it');
});

test('t388: the body with a cause clause is still one glanceable line', () => {
  const body = formatStallBody({
    ticketId: 't1', who: 'hand', age: '2h', repeat: 1,
    tool: { tool: 'Bash', outcome: 'error' }, commits: 3, dirty: true,
    dmLatch: { count: 2, age: '2h' },
  });
  assert.ok(!body.includes('\n'), 'no newlines — this fires into the lead prompt stream');
});

// t399 — the tree-CPU probe. The subject is a MEASURED false wedge: on
// 2026-08-15 a seat inside a long tool call read idle, flat, and ~zero CLI CPU
// while 16 children burned ~88% each. All three signals lie in the same
// direction, so the probe's own root-pid sample was the thing that had to change.
//
// Rows are the parsed shape of `ps -axo pid=,ppid=,time=`.
const psRow = (pid, ppid, timeText) => ({ pid, ppid, timeText });

test('t399: a busy CHILD counts toward the root — the measured false-wedge shape', () => {
  const rows = [
    psRow(100, 1, '0:00.30'),      // the CLI: essentially idle, mid tool call
    psRow(200, 100, '5:00.00'),    // the tool: burning CPU
  ];
  assert.strictEqual(sumTreeCpuMs(rows, 100), 300 + 300_000,
    'the root alone reads 300ms — the child is the entire signal');
});

test('t399: a busy child under a quiet CLI classifies MOVING, not wedged', () => {
  // The end-to-end point of the helper: same transcript (flat), same root pid
  // CPU (flat), and the ONLY difference is whether the sampler saw the child.
  const flatRoot = [psRow(100, 1, '0:00.30')];
  const withChild = (t) => [psRow(100, 1, '0:00.30'), psRow(200, 100, t)];
  const gap = 60 * 1000;
  const at0 = 1_000_000;

  const rootOnly = {
    prev: { at: at0, size: 500, cpuMs: sumTreeCpuMs(flatRoot, 100), lastGrowthAt: at0 },
    cur: { at: at0 + gap, size: 500, cpuMs: sumTreeCpuMs(flatRoot, 100), lastGrowthAt: at0 },
  };
  assert.strictEqual(classifyReviewSeat(rootOnly.prev, rootOnly.cur).verdict, 'wedged',
    'ENTER: root-only sampling really does produce the false wedge this fixes');

  const tree = {
    prev: { at: at0, size: 500, cpuMs: sumTreeCpuMs(withChild('1:00.00'), 100), lastGrowthAt: at0 },
    cur: { at: at0 + gap, size: 500, cpuMs: sumTreeCpuMs(withChild('1:30.00'), 100), lastGrowthAt: at0 },
  };
  assert.strictEqual(classifyReviewSeat(tree.prev, tree.cur).verdict, 'moving',
    'the same seat, sampled over its tree, is correctly alive');
});

test('t399: an ABSENT root pid is null, never a guessed 0', () => {
  const rows = [psRow(100, 1, '0:10.00'), psRow(200, 100, '0:20.00')];
  assert.strictEqual(sumTreeCpuMs(rows, 555), null,
    'the process died — 0 would read as the WEDGE verdict about a seat that is merely gone');
  assert.strictEqual(sumTreeCpuMs([], 100), null, 'an empty table is not a flat tree');
  assert.strictEqual(sumTreeCpuMs(null, 100), null, 'a failed ps is not a flat tree');
});

test('t399: a deep tree sums every level, not just direct children', () => {
  const rows = [
    psRow(100, 1, '0:01.00'),
    psRow(200, 100, '0:02.00'),
    psRow(300, 200, '0:04.00'),
    psRow(400, 300, '0:08.00'),   // great-grandchild: a shell running a build running a compiler
  ];
  assert.strictEqual(sumTreeCpuMs(rows, 100), 15_000,
    'a stop at one level would read 3000 and call a working toolchain wedged');
});

test('t399: an ORPHANED child (ppid 1) is excluded ON PURPOSE', () => {
  // Measured 2026-08-15: a backgrounded subshell reparents to init when its
  // parent exits. A walk rooted at the pty pid therefore loses it, which is
  // CORRECT here — widening the walk to catch it would let any unrelated
  // process on the box suppress a real wedge (suppression-by-stranger). This
  // pins the exclusion so the obvious "why doesn't the tree see my background
  // build" fix cannot land silently.
  const rows = [
    psRow(100, 1, '0:01.00'),      // our root
    psRow(200, 100, '0:02.00'),    // a real child
    psRow(900, 1, '99:00.00'),     // orphan: was ours, now init's. NOT counted.
  ];
  assert.strictEqual(sumTreeCpuMs(rows, 100), 3000,
    'the orphan is a stranger to the tree, and counting it would suppress real wedges');
});

test('t399: a pid that is its own ancestor TERMINATES, and is counted once', () => {
  // `ps` is a snapshot of a moving table, so a racy read can name a pid inside
  // its own descendant chain. Without the visited set the walk revisits it
  // forever and the sweep hangs — silently, since the probe is awaited. The
  // obvious "simplify the walk" edit is what this pins.
  const rows = [
    psRow(100, 1, '0:01.00'),
    psRow(200, 100, '0:02.00'),
    psRow(100, 200, '0:01.00'),   // impossible in a consistent table; not in a snapshot
  ];
  assert.strictEqual(sumTreeCpuMs(rows, 100), 3000,
    'the cycle is walked once, not forever, and contributes its CPU a single time');
});

test('t399: a tree-CPU DROP does not on its own produce a wedge-confirm', () => {
  // Tree sums are NOT monotonic (a single pid's TIME is). A child that exits
  // between samples takes its accumulated CPU OUT of the total, so the delta can
  // go negative while the root is accruing normally. `cpuAccrued` is a `>=` on
  // that delta, so the drop falls straight through to `wedged` — and the caller's
  // two-consecutive-wedged confirm is the ONLY thing that keeps one such gap from
  // reading as a real wedge.
  const at0 = 2_000_000;
  const gap = 60 * 1000;
  const prevRows = [psRow(100, 1, '0:10.00'), psRow(200, 100, '4:00.00')];
  const curRows = [psRow(100, 1, '0:15.00')];   // child exited; root accrued 5s
  const prev = { at: at0, size: 500, cpuMs: sumTreeCpuMs(prevRows, 100), lastGrowthAt: at0 };
  const cur = { at: at0 + gap, size: 500, cpuMs: sumTreeCpuMs(curRows, 100), lastGrowthAt: at0 };

  assert.ok(cur.cpuMs < prev.cpuMs, 'ENTER: the sum really did DROP across the gap');
  assert.ok(sumTreeCpuMs(curRows, 100) > sumTreeCpuMs(prevRows, 100) - 240_000,
    'ENTER: and the root itself really was accruing while it dropped');

  const r = classifyReviewSeat(prev, cur);
  assert.strictEqual(r.verdict, 'wedged',
    'the drop DOES read as wedged here — which is exactly why the confirm step must survive');
  // That the confirm step ABSORBS this is pinned against the real sampler, in
  // ticket-loop-verify.test.js ('a one-off tree-CPU DROP is absorbed by the
  // confirm step'). Re-implementing the downgrade here would be a copy of
  // `_sampleSeatLiveness`'s logic that drifts silently — the failure this
  // file's header records for `didGrow`.
});

// t389 — the stall alarm says a seat is SILENT, but not that it stopped on an
// API error.
//
// The alarm infers a wedge from silence (flat transcript + flat tree CPU over
// two samples) and so reports only the step: "no progress for 31m". The
// transcript separately holds a record that says WHY, in the file `readTail`
// already opens. The tests below pin BOTH directions with equal weight — the
// positive (the cause is named) and the negative (with no such record the alarm
// is byte-identical to what it was) — because a clause is as easy to pin
// vacuously as it is to pin.
//
// Fixtures are the REAL record shape, captured from ~/.claude/projects: an
// `isApiErrorMessage: true` marker on an otherwise ordinary `type: "assistant"`
// record whose `message.model` is `"<synthetic>"` and whose content is an array
// of text blocks (measured: 0 of 753 ending-error records used a string body).
const apiErr = (text, extra = {}) => ({
  type: 'assistant',
  isSidechain: false,
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
  error: 'server_error',
  isApiErrorMessage: true,
  ...extra,
});
// The same record WITHOUT the marker — `<synthetic>` and all. This is the shape
// the over-match would catch: measured over 400 transcripts, `<synthetic>`
// matched 95 non-errors against 32 errors, and almost all the non-errors are
// these `"No response requested."` sidechain records of healthy seats.
const synthetic = (text, extra = {}) => ({
  type: 'assistant',
  isSidechain: false,
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
  ...extra,
});
const say = (text) => ({ type: 'assistant', message: { model: 'claude-x', role: 'assistant', content: [{ type: 'text', text }] } });

const E529 = 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.';

// ── lastApiErrorFrom ───────────────────────────────────────────────────────

test('t389: a transcript ending on an API error reports the error TEXT', () => {
  const tail = jsonl(say('working on it'), use('Bash', 'b1'), result('b1', false), apiErr(E529));
  assert.deepStrictEqual(lastApiErrorFrom(tail), { text: E529 },
    'the text verbatim — it is what classifies the error, and this module does not classify');
});

test('t389: THE OVER-MATCH — a <synthetic> record without the marker is NOT an error', () => {
  // The measured trap, encoded. Keying on `model === "<synthetic>"` would fire
  // about 3x too often, and the majority of those extra fires are on seats that
  // are perfectly healthy.
  const healthy = jsonl(say('done'), synthetic('No response requested.'));
  assert.ok(/<synthetic>/.test(healthy), 'ENTER: the fixture really does carry the tempting discriminator');
  assert.strictEqual(lastApiErrorFrom(healthy), null,
    'only isApiErrorMessage counts — "No response requested." is a healthy seat, not a stopped one');
});

test('t389: an error the seat RECOVERED from is not reported as where it stopped', () => {
  // A 529 followed by a real turn: the seat retried and kept going. Reporting
  // this in a stall alarm would name a cause that had already resolved, which is
  // the confidently-wrong field this module's header forbids.
  const tail = jsonl(apiErr(E529), say('retried, continuing'));
  assert.ok(tail.includes('isApiErrorMessage'), 'ENTER: an error record really is present in the tail');
  assert.strictEqual(lastApiErrorFrom(tail), null, 'but it is not what the transcript ENDS on');
});

test('t389: trailing BOOKKEEPING records do not hide the error the seat stopped on', () => {
  // Measured over ~97k transcripts: of 1088 non-sidechain error records, 753 are
  // the last CONVERSATIONAL record — yet the file almost always continues, with
  // `last-prompt` (685), `system` (254) and `file-history-snapshot` (103)
  // entries after it. A "must be the last LINE" test would report almost nothing.
  const tail = jsonl(
    apiErr(E529),
    { type: 'system', subtype: 'post_error' },
    { type: 'file-history-snapshot', snapshot: {} },
    { type: 'last-prompt', prompt: 'continue' },
  );
  const lines = tail.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(lines.findIndex((d) => d.isApiErrorMessage === true), 0,
    'ENTER: the error is the FIRST line, so three bookkeeping records really do follow it');
  assert.strictEqual(lines.length, 4);
  assert.deepStrictEqual(lastApiErrorFrom(tail), { text: E529 },
    'those are bookkeeping, not the seat producing output');
});

test('t389: a SUBAGENT`s API error is not reported as the seat`s own stop', () => {
  // Same reason lastToolFrom skips sidechains: a different actor. The seat's own
  // turn may have continued right past it.
  const tail = jsonl(say('spawning'), apiErr(E529, { isSidechain: true }));
  assert.ok(tail.includes('isApiErrorMessage'), 'ENTER: the error record is in the tail');
  assert.strictEqual(lastApiErrorFrom(tail), null, 'but it belongs to the subagent');
});

test('t389: an error record with no readable text is OMITTED, never quoted empty', () => {
  // `ends on an API error: ""` claims a reading the probe does not have.
  const empty = jsonl(say('x'), apiErr(''));
  const blocky = jsonl(say('x'), { type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'tool_use', name: 'Bash', id: 'z' }] } });
  assert.strictEqual(lastApiErrorFrom(empty), null);
  assert.strictEqual(lastApiErrorFrom(blocky), null, 'a non-text body is not a message to quote');
});

test('t389: nothing readable returns null rather than a guess', () => {
  assert.strictEqual(lastApiErrorFrom(''), null);
  assert.strictEqual(lastApiErrorFrom(null), null);
  assert.strictEqual(lastApiErrorFrom('not json at all\n{"truncated'), null);
});

test('t389: the error is reachable through readTail on a megabyte transcript', () => {
  // The whole field depends on the BOUNDED read seeing it. Measured over ~97k
  // transcripts: when a transcript ends on an API error, the record starts at
  // most 2957 bytes from EOF (p90 1985) — so the existing 64KB window reaches it
  // in every observed case, and this pins that end to end rather than trusting it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-apierr-'));
  const file = path.join(dir, 'transcript.jsonl');
  const filler = jsonl(...Array.from({ length: 4000 }, (_, i) => use('Filler', `f${i}`)));
  fs.writeFileSync(file, filler + jsonl(apiErr(E529), { type: 'last-prompt', prompt: 'go' }));
  assert.ok(fs.statSync(file).size > 64 * 1024, 'ENTER: the fixture really is bigger than the tail window');

  const tail = readTail(fs, file);
  assert.ok(tail.length <= 64 * 1024, 'ENTER: and only the tail was read');
  assert.deepStrictEqual(lastApiErrorFrom(tail), { text: E529 }, 'the cause survives the bounded read');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── the clause the alarm carries ───────────────────────────────────────────

test('t389: the stall alarm NAMES the error instead of only the silence', () => {
  const plain = formatStallBody({ ticketId: 't1', who: 'hand', age: '31m', commits: 0, dirty: true });
  const withErr = formatStallBody({
    ticketId: 't1', who: 'hand', age: '31m', commits: 0, dirty: true, apiError: { text: E529 },
  });
  // ENTER: identical inputs but the one field, so nothing else can be producing
  // the difference asserted below.
  assert.notStrictEqual(plain, withErr, 'same inputs but the error, different bodies');
  assert.ok(!/API error/.test(plain),
    'ENTER: the clause is ABSENT without an error — unconditional, it would ride every alarm and mean nothing');
  assert.match(withErr, /its transcript ends on an API error: "API Error: 529 Overloaded\./,
    'the alarm quotes what the seat itself reported');
  assert.match(withErr, /no commits, tree dirty/, 'without displacing the evidence the alarm already carried');
});

test('t389: THE NEGATIVE DIRECTION — with no error record the alarm is BYTE-IDENTICAL', () => {
  // As important as the positive half, and pinned with the same weight: this
  // change must be invisible on every alarm that is not about an API error, and
  // that is a claim about exact bytes, not about a substring being absent.
  const shapes = [
    { ticketId: 't1', who: 'hand', age: '30m' },
    { ticketId: 't1', who: 'hand', age: '30m', commits: 0 },
    { ticketId: 't1', who: 'hand', age: '2h', repeat: 1, tool: { tool: 'Bash', outcome: 'pending' }, commits: 3, dirty: true },
    { ticketId: 't1', who: 'hand', age: '30m', dmLatch: { count: 2, age: '31m' } },
    { ticketId: 't1', who: 'hand', age: '30m', commits: 1, wake: { age: '5m' } },
  ];
  for (const shape of shapes) {
    const before = formatStallBody(shape);
    assert.strictEqual(formatStallBody({ ...shape, apiError: null }), before, 'an explicit null changes nothing');
    assert.strictEqual(formatStallBody({ ...shape, apiError: { text: '' } }), before,
      'and neither does an error record whose text was unreadable');
    assert.ok(!/API error/.test(before), 'ENTER: none of these shapes mentions an API error to begin with');
  }
});

test('t389: the quoted error is collapsed onto ONE line and capped', () => {
  // Measured over 263 error texts: median 151 chars, max 567, and 85 of them
  // contain newlines. This fires into the lead's prompt stream, where a
  // multi-line quote breaks every other alarm's shape.
  const multi = 'API Error: 529 Overloaded.\n\nThis is a server-side issue,\n  usually temporary.';
  const body = formatStallBody({ ticketId: 't1', who: 'hand', age: '31m', apiError: { text: multi } });
  assert.ok(multi.includes('\n'), 'ENTER: the fixture text really is multi-line');
  assert.ok(!body.includes('\n'), 'the alarm is not');
  assert.match(body, /"API Error: 529 Overloaded\. This is a server-side issue, usually temporary\."/,
    'whitespace collapsed to single spaces rather than stripped');

  const long = `API Error: ${'x'.repeat(600)}`;
  const capped = formatStallBody({ ticketId: 't1', who: 'hand', age: '31m', apiError: { text: long } });
  assert.ok(long.length > API_ERROR_MAX, 'ENTER: the fixture really is over the cap');
  assert.ok(capped.length < long.length, 'the long text does not ride whole into the prompt stream');
  assert.match(capped, /"API Error: xxx/,
    'and the truncation is from the TAIL — the first words are what classify the error');
  assert.match(capped, /…"/, 'marked as truncated, so a cut message does not read as the whole one');
});

test('t389: the error clause LEADS the trailing sentences it can coexist with', () => {
  // The dm-latch and wake sentences are readings about DELIVERY — was the seat
  // ever told anything, did an automated write reach it. Neither explains
  // anything once the seat's own last turn says why it stopped, so the measured
  // cause comes first and the hypotheses follow it.
  const body = formatStallBody({
    ticketId: 't1', who: 'hand', age: '2h', repeat: 1,
    tool: { tool: 'Bash', outcome: 'error' }, commits: 3, dirty: true,
    dmLatch: { count: 2, age: '2h' }, wake: { age: '10m' }, apiError: { text: E529 },
  });
  assert.ok(!body.includes('\n'), 'still one glanceable line with every clause on it');
  const iErr = body.indexOf('ends on an API error');
  const iDm = body.indexOf('swallowed delivery');
  const iWake = body.indexOf('automated wake');
  assert.ok(iErr > 0 && iDm > 0 && iWake > 0, 'ENTER: all three clauses really are present at once');
  assert.ok(iErr < iDm && iDm < iWake, 'measured cause, then the delivery readings, in their existing order');
});

test('t389: the clause rides a BARE stall body too — the shape it matters most on', () => {
  // A seat stopped by an API error has often produced nothing else: no tool
  // outcome, no commits, no dirty tree. A clause appended only to the
  // parenthesised evidence list would be missing from exactly that shape.
  const bare = formatStallBody({ ticketId: 't1', who: 'hand', age: '31m', apiError: { text: E529 } });
  assert.ok(!/\(/.test(bare), 'ENTER: no evidence bits, so this is the bare-head shape');
  assert.match(bare, /ends on an API error/, 'and the cause is still named');
});

test('t389: the alarm REPORTS the error and never grades it', () => {
  // Measured over this repo's 77 API errors: 54 are Fable safeguard refusals,
  // terminal 53/54; the transient class is 11 of 77. A retry verdict on "an API
  // error was seen" would mostly re-hit the same guard, so the distinction stays
  // a REPORTING one — the text classifies itself and the lead reads it.
  const refusal = formatStallBody({
    ticketId: 't1', who: 'hand', age: '31m',
    apiError: { text: "API Error: Fable 5's safeguards flagged this message" },
  });
  const transient = formatStallBody({ ticketId: 't1', who: 'hand', age: '31m', apiError: { text: E529 } });
  assert.match(refusal, /safeguards flagged/, 'the refusal text reaches the lead intact');
  assert.match(transient, /usually temporary/, 'and so does the transient one');
  for (const body of [refusal, transient]) {
    assert.ok(!/retry|resume|retryable|transient|terminal/i.test(body),
      'but the alarm suggests no action and assigns no class — that judgement is not this module’s');
  }
});

test('t389: the ORPHAN alarm never grows a cause clause', () => {
  // formatOrphanBody takes no seat-derived field at all: there is no live seat,
  // so there is no transcript to have ended on anything. Pinned because the
  // obvious symmetry ("both are stall alarms") is the wrong one.
  const body = formatOrphanBody({ ticketId: 't1', who: 'hand', age: '1h', commits: 2, dirty: true, apiError: { text: E529 } });
  assert.ok(!/API error/.test(body), 'an unknown extra field is ignored, not rendered');
});
