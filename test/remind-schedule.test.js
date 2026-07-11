// Run: node --test
// Covers remind-schedule.js — the pure parse/timing leaf for [agent:remind …]:
// the every/in/at/cron/on-compact/list/cancel grammar, the runaway guards
// (every < 60s bounce, in <= 0 bounce), the past-HH:MM → tomorrow roll, absolute
// ISO one-shots, and the cron subset (* fixed */step a-b a,b + dom/dow OR).
const { test } = require('node:test');
const assert = require('node:assert');
const {
  MIN_EVERY_MS, parseDuration, parseCron, parseRemindSpec, nextFireAt,
} = require('../remind-schedule');

// A fixed, DST-stable local reference instant for the clock/cron tests:
// Fri 2026-07-03 10:30:00 local.
const NOW = new Date(2026, 6, 3, 10, 30, 0, 0).getTime();
// Local HH:MM on a given day-offset from NOW → epoch ms (mirrors the module's
// own Date math so the assertions stay timezone-agnostic).
const at = (hh, mm, dayOffset = 0) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
};

// ---- parseDuration --------------------------------------------------------

test('parseDuration: units s/m/h/d', () => {
  assert.strictEqual(parseDuration('90s'), 90 * 1000);
  assert.strictEqual(parseDuration('30m'), 30 * 60 * 1000);
  assert.strictEqual(parseDuration('2h'), 2 * 60 * 60 * 1000);
  assert.strictEqual(parseDuration('1d'), 24 * 60 * 60 * 1000);
  assert.strictEqual(parseDuration('5x'), null);
  assert.strictEqual(parseDuration('h'), null);
  assert.strictEqual(parseDuration(''), null);
});

// ---- every ----------------------------------------------------------------

test('every: valid interval → recurring, fires one interval out', () => {
  const s = parseRemindSpec('every 30m');
  assert.deepStrictEqual(s, { ok: true, kind: 'every', intervalMs: 30 * 60 * 1000 });
  assert.strictEqual(nextFireAt(s, NOW), NOW + 30 * 60 * 1000);
});

test('every: under 60s bounces (runaway guard), 60s exactly is allowed', () => {
  assert.strictEqual(parseRemindSpec('every 30s').ok, false);
  assert.strictEqual(parseRemindSpec('every 59s').ok, false);
  assert.strictEqual(MIN_EVERY_MS, 60 * 1000);
  assert.strictEqual(parseRemindSpec('every 60s').ok, true);
  assert.strictEqual(parseRemindSpec('every 1m').ok, true);
});

test('every: missing/garbled interval bounces', () => {
  assert.strictEqual(parseRemindSpec('every').ok, false);
  assert.strictEqual(parseRemindSpec('every soon').ok, false);
});

// ---- in -------------------------------------------------------------------

test('in: relative one-shot fires from now + delay', () => {
  const s = parseRemindSpec('in 90s');
  assert.deepStrictEqual(s, { ok: true, kind: 'in', delayMs: 90 * 1000 });
  assert.strictEqual(nextFireAt(s, NOW), NOW + 90 * 1000);
});

test('in: zero/garbled duration bounces', () => {
  assert.strictEqual(parseRemindSpec('in 0s').ok, false);
  assert.strictEqual(parseRemindSpec('in later').ok, false);
  assert.strictEqual(parseRemindSpec('in').ok, false);
});

// ---- at -------------------------------------------------------------------

test('at HH:MM: still ahead today fires today', () => {
  const s = parseRemindSpec('at 11:00');
  assert.deepStrictEqual(s, { ok: true, kind: 'at', hh: 11, mm: 0 });
  assert.strictEqual(nextFireAt(s, NOW), at(11, 0, 0));
});

test('at HH:MM: already past today rolls to tomorrow', () => {
  const s = parseRemindSpec('at 09:00'); // NOW is 10:30, so 09:00 has passed
  assert.strictEqual(nextFireAt(s, NOW), at(9, 0, 1));
});

test('at HH:MM: equal to now also rolls forward (strictly-after)', () => {
  const s = parseRemindSpec('at 10:30');
  assert.strictEqual(nextFireAt(s, NOW), at(10, 30, 1));
});

test('at HH:MM: tomorrow roll is calendar-day arithmetic, not +24h', () => {
  // The `at()` helper builds tomorrow via setDate(+1)+setHours — the same
  // DST-proof calendar bump the module uses. A flat `NOW + 24h` would only
  // coincide when no DST transition sits between the two, so pinning against
  // the calendar-built expectation guards the DST-safe path (see the module's
  // "NOT `+ 24h`" comment).
  const s = parseRemindSpec('at 08:00'); // past NOW (10:30) → tomorrow 08:00
  assert.strictEqual(nextFireAt(s, NOW), at(8, 0, 1));
});

test('at ISO: future fires once, past yields null (never fires)', () => {
  const future = parseRemindSpec('at 2026-07-03T15:00:00');
  assert.strictEqual(future.ok, true);
  assert.strictEqual(nextFireAt(future, NOW), Date.parse('2026-07-03T15:00:00'));
  const past = parseRemindSpec('at 2020-01-01T00:00:00');
  assert.strictEqual(past.ok, true);
  assert.strictEqual(nextFireAt(past, NOW), null);
});

test('at: missing/garbled time bounces', () => {
  assert.strictEqual(parseRemindSpec('at').ok, false);
  assert.strictEqual(parseRemindSpec('at 25:00').ok, false);
  assert.strictEqual(parseRemindSpec('at noon').ok, false);
});

// ---- cron -----------------------------------------------------------------

test('cron */15: next matching minute', () => {
  const s = parseRemindSpec('cron */15 * * * *');
  assert.strictEqual(s.ok, true);
  // NOW is 10:30 → next 15-aligned minute is 10:45.
  assert.strictEqual(nextFireAt(s, NOW), at(10, 45, 0));
});

test('cron fixed daily: 0 9 * * * rolls to tomorrow 09:00', () => {
  const s = parseRemindSpec('cron 0 9 * * *');
  assert.strictEqual(nextFireAt(s, NOW), at(9, 0, 1));
});

test('cron ranges/lists parse and match', () => {
  const s = parseRemindSpec('cron 0,30 9-17 * * *');
  assert.strictEqual(s.ok, true);
  // 10:30 matches (minute 30 ∈ {0,30}, hour 10 ∈ 9-17) but nextFireAt is
  // strictly-after, so the next is 11:00.
  assert.strictEqual(nextFireAt(s, NOW), at(11, 0, 0));
});

test('cron dom/dow OR semantics when both restricted', () => {
  // Minute 0, hour 0, on the 1st OR any Monday. 2026-07-03 is a Friday, so the
  // next fire is Monday 2026-07-06 00:00 (day-of-week branch), sooner than the
  // 1st of August.
  const s = parseRemindSpec('cron 0 0 1 * 1');
  assert.strictEqual(s.ok, true);
  const monday = new Date(2026, 6, 6, 0, 0, 0, 0).getTime();
  assert.strictEqual(nextFireAt(s, NOW), monday);
});

test('cron: wrong field count and out-of-range/unsupported tokens bounce', () => {
  assert.strictEqual(parseRemindSpec('cron * * * *').ok, false);      // 4 fields
  assert.strictEqual(parseRemindSpec('cron 99 * * * *').ok, false);   // minute > 59
  assert.strictEqual(parseRemindSpec('cron 0 9 * JUL *').ok, false);  // named month
  assert.strictEqual(parseRemindSpec('cron 0 9 * * MON').ok, false);  // named dow
  assert.strictEqual(parseCron('* * * *').error !== undefined, true);
});

// ---- on compact / list / cancel / unknown ---------------------------------

test('on compact: event kind, never timer-fires', () => {
  const s = parseRemindSpec('on compact');
  assert.deepStrictEqual(s, { ok: true, kind: 'oncompact' });
  assert.strictEqual(nextFireAt(s, NOW), null);
  assert.strictEqual(parseRemindSpec('on tuesday').ok, false);
});

test('list: no args, no timer', () => {
  assert.deepStrictEqual(parseRemindSpec('list'), { ok: true, kind: 'list' });
  assert.strictEqual(nextFireAt(parseRemindSpec('list'), NOW), null);
  assert.strictEqual(parseRemindSpec('list extra').ok, false);
});

test('cancel: needs a valid id', () => {
  assert.deepStrictEqual(parseRemindSpec('cancel ab12'), { ok: true, kind: 'cancel', id: 'ab12' });
  assert.strictEqual(nextFireAt(parseRemindSpec('cancel ab12'), NOW), null);
  assert.strictEqual(parseRemindSpec('cancel').ok, false);
  assert.strictEqual(parseRemindSpec('cancel bad/id').ok, false);
});

test('unknown form and empty spec bounce', () => {
  assert.strictEqual(parseRemindSpec('someday soon').ok, false);
  assert.strictEqual(parseRemindSpec('').ok, false);
  assert.strictEqual(parseRemindSpec('   ').ok, false);
});
