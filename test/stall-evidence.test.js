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

const { readTail, lastToolFrom, formatStallBody } = require('../stall-evidence');

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
