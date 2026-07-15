'use strict';
// file-heat.js — the boiling pot's tier-1 producer (docs/boiling-pot-plan.md).
// Pure leaf: estimate/rangeSig/dateKey/recordInto/pruneDays/aggregateStates over
// plain objects. Factory: lazy load + debounced flush + async stat, all seams
// injected (no real FS, no real timers, a fixed clock).

const { test } = require('node:test');
const assert = require('node:assert');

const {
  createFileHeat,
  dateKey, estimateReadTokens, rangeSig, emptyState, normalizeState,
  recordInto, pruneDays, aggregateStates,
  DEFAULT_KEEP_DAYS, MAX_RANGES_PER_FILE_DAY,
} = require('../file-heat');

// A fixed clock — 2026-07-16T12:00:00Z — so day buckets are deterministic.
const T0 = Date.parse('2026-07-16T12:00:00Z');
const DAY = 86_400_000;

// ── estimateReadTokens ───────────────────────────────────────────────────────

test('estimateReadTokens: whole-file read is bytes/4', () => {
  assert.strictEqual(estimateReadTokens(4000, null, null), 1000);
  assert.strictEqual(estimateReadTokens(4001, null, null), 1001); // ceil
});

test('estimateReadTokens: empty file is 0, a failed stat is null', () => {
  assert.strictEqual(estimateReadTokens(0, null, null), 0);
  assert.strictEqual(estimateReadTokens(null, null, null), null);
  assert.strictEqual(estimateReadTokens(undefined, 1, 50), null);
});

test('estimateReadTokens: a line-limited read is the slice, capped at the file', () => {
  // 50 lines * 40 bytes/line / 4 = 500 tokens, well under a 1e6-byte file.
  assert.strictEqual(estimateReadTokens(1_000_000, 100, 50), 500);
  // a slice larger than the file is capped at whole-file bytes.
  assert.strictEqual(estimateReadTokens(400, 1, 50), 100); // min(400, 2000)/4
});

test('estimateReadTokens: offset without limit uses the 2000-line default cap', () => {
  // 2000 * 40 / 4 = 20000, capped at the file if smaller.
  assert.strictEqual(estimateReadTokens(10_000_000, 500, null), 20000);
  assert.strictEqual(estimateReadTokens(8000, 500, null), 2000); // min(8000, 80000)/4
});

// ── rangeSig ─────────────────────────────────────────────────────────────────

test('rangeSig: full vs ranged signatures are distinct + stable', () => {
  assert.strictEqual(rangeSig(null, null), 'full');
  assert.strictEqual(rangeSig(0, 0), 'full');       // 0/0 is a whole read
  assert.strictEqual(rangeSig(100, 50), '100:50');
  assert.strictEqual(rangeSig(100, null), '100:');
  assert.strictEqual(rangeSig(null, 50), ':50');
});

// ── dateKey ──────────────────────────────────────────────────────────────────

test('dateKey: UTC YYYY-MM-DD, timezone-independent', () => {
  assert.strictEqual(dateKey(T0), '2026-07-16');
  assert.strictEqual(dateKey(Date.parse('2026-01-02T23:59:59Z')), '2026-01-02');
});

// ── recordInto ───────────────────────────────────────────────────────────────

test('recordInto: reads accumulate carriage + distinct ranges; edits count', () => {
  const s = emptyState();
  recordInto(s, { file: '/a.js', kind: 'read', tokens: 500, sig: '0:50' }, T0);
  recordInto(s, { file: '/a.js', kind: 'read', tokens: 500, sig: '50:50' }, T0);
  recordInto(s, { file: '/a.js', kind: 'read', tokens: 500, sig: '0:50' }, T0); // dup range
  recordInto(s, { file: '/a.js', kind: 'edit' }, T0);
  const f = s.days['2026-07-16']['/a.js'];
  assert.strictEqual(f.reads, 3);
  assert.strictEqual(f.edits, 1);
  assert.strictEqual(f.tokens, 1500);          // carriage accumulates every read
  assert.deepStrictEqual(f.ranges, ['0:50', '50:50']); // distinct only
});

test('recordInto: a null token weight still counts the read', () => {
  const s = emptyState();
  recordInto(s, { file: '/x', kind: 'read', tokens: null, sig: 'full' }, T0);
  const f = s.days['2026-07-16']['/x'];
  assert.strictEqual(f.reads, 1);
  assert.strictEqual(f.tokens, 0);
});

test('recordInto: the per-day distinct-range set is capped', () => {
  const s = emptyState();
  for (let i = 0; i < MAX_RANGES_PER_FILE_DAY + 20; i++) {
    recordInto(s, { file: '/big', kind: 'read', tokens: 1, sig: `${i}:10` }, T0);
  }
  const f = s.days['2026-07-16']['/big'];
  assert.strictEqual(f.ranges.length, MAX_RANGES_PER_FILE_DAY);
  assert.strictEqual(f.reads, MAX_RANGES_PER_FILE_DAY + 20); // reads still all count
});

// ── pruneDays ────────────────────────────────────────────────────────────────

test('pruneDays: keeps today + (keepDays-1) prior, drops older', () => {
  const s = emptyState();
  recordInto(s, { file: '/f', kind: 'read', tokens: 1, sig: 'full' }, T0);
  recordInto(s, { file: '/f', kind: 'read', tokens: 1, sig: 'full' }, T0 - 13 * DAY); // edge, kept
  recordInto(s, { file: '/f', kind: 'read', tokens: 1, sig: 'full' }, T0 - 14 * DAY); // dropped
  pruneDays(s, 14, T0);
  const keys = Object.keys(s.days).sort();
  assert.ok(keys.includes('2026-07-16'));
  assert.ok(keys.includes(dateKey(T0 - 13 * DAY)));
  assert.ok(!keys.includes(dateKey(T0 - 14 * DAY)));
});

// ── aggregateStates ──────────────────────────────────────────────────────────

test('aggregateStates: ranks by carriage (not read count), merges across states', () => {
  // Agent 1: a widely-walked file (many small reads, high carriage).
  const s1 = emptyState();
  for (let i = 0; i < 20; i++) recordInto(s1, { file: '/hot.js', kind: 'read', tokens: 1000, sig: `${i}:100` }, T0);
  // Agent 2: a file read FEWER times but each read is huge (higher carriage).
  const s2 = emptyState();
  recordInto(s2, { file: '/whale.js', kind: 'read', tokens: 50000, sig: 'full' }, T0);
  recordInto(s2, { file: '/hot.js', kind: 'read', tokens: 1000, sig: '0:100' }, T0); // same file, other agent

  const snap = aggregateStates([s1, s2], { now: T0, topN: 10 });
  assert.strictEqual(snap.files[0].file, '/whale.js', 'carriage ranks first, not read count');
  assert.strictEqual(snap.files[0].approxReadTokens, 50000);
  assert.strictEqual(snap.files[0].reads, 1);

  const hot = snap.files.find((f) => f.file === '/hot.js');
  assert.strictEqual(hot.reads, 21, 'reads merge across agents');
  assert.strictEqual(hot.approxReadTokens, 21000);
  assert.strictEqual(hot.segments, 20, '20 distinct ranges walked (the grok-skill signal)');
  // tier-2 columns are null in tier 1; no suggestions engine in v1.
  assert.strictEqual(hot.redundantReads, null);
  assert.strictEqual(hot.redundantTokens, null);
  assert.strictEqual(hot.lastSuggestion, null);
});

test('aggregateStates: segments distinguishes walking from same-range re-reading', () => {
  const walked = emptyState();
  for (let i = 0; i < 10; i++) recordInto(walked, { file: '/walk', kind: 'read', tokens: 400, sig: `${i * 100}:100` }, T0);
  const reread = emptyState();
  for (let i = 0; i < 10; i++) recordInto(reread, { file: '/reread', kind: 'read', tokens: 400, sig: 'full' }, T0);

  const snap = aggregateStates([walked, reread], { now: T0 });
  const w = snap.files.find((f) => f.file === '/walk');
  const r = snap.files.find((f) => f.file === '/reread');
  assert.strictEqual(w.reads, 10);
  assert.strictEqual(w.segments, 10);  // walked in 10 segments
  assert.strictEqual(r.reads, 10);
  assert.strictEqual(r.segments, 1);   // same range 10× — tier-2 redundancy territory
});

test('aggregateStates: honors the window even on an unpruned state; topN caps', () => {
  const s = emptyState();
  recordInto(s, { file: '/recent', kind: 'read', tokens: 100, sig: 'full' }, T0);
  recordInto(s, { file: '/old', kind: 'read', tokens: 9999, sig: 'full' }, T0 - 30 * DAY);
  const snap = aggregateStates([s], { now: T0, keepDays: 14, topN: 1 });
  assert.strictEqual(snap.files.length, 1);
  assert.strictEqual(snap.files[0].file, '/recent'); // /old is outside the window
});

test('normalizeState: corrupt / foreign input starts empty', () => {
  assert.deepStrictEqual(normalizeState(null), emptyState());
  assert.deepStrictEqual(normalizeState({ nope: 1 }), emptyState());
  assert.deepStrictEqual(normalizeState('garbage'), emptyState());
  const good = { version: 1, days: { '2026-07-16': { '/a': { reads: 1, edits: 0, tokens: 4, ranges: [] } } } };
  assert.deepStrictEqual(normalizeState(good).days, good.days);
});

// ── factory (seams injected) ─────────────────────────────────────────────────

function fakeDeps(overrides = {}) {
  let clock = T0;
  const written = [];
  const timers = [];
  return {
    clock: () => clock,
    setClock: (t) => { clock = t; },
    written,
    fireTimers: () => { const q = timers.splice(0); for (const fn of q) fn(); },
    deps: {
      filePath: '/run/alice/file-heat.json',
      now: () => clock,
      flushMs: 30000,
      statBytes: async (p) => (overrides.bytes ? overrides.bytes[p] ?? null : 4000),
      read: () => overrides.initial ?? null,
      write: (state) => written.push(JSON.parse(JSON.stringify(state))),
      setTimer: (fn) => { timers.push(fn); return timers.length; },
      clearTimer: () => {},
      ...overrides.deps,
    },
  };
}

test('factory: recordRead stats + estimates, recordEdit counts, flush persists', async () => {
  const h = fakeDeps({ bytes: { '/proj/a.js': 8000 } });
  const fh = createFileHeat(h.deps);
  await fh.recordRead('/proj/a.js', 100, 50); // 50*40/4 = 500 tokens
  fh.recordEdit('/proj/a.js');
  fh.flush();
  assert.strictEqual(h.written.length, 1);
  const f = h.written[0].days['2026-07-16']['/proj/a.js'];
  assert.strictEqual(f.reads, 1);
  assert.strictEqual(f.edits, 1);
  assert.strictEqual(f.tokens, 500);
  assert.deepStrictEqual(f.ranges, ['100:50']);
});

test('factory: a debounced flush coalesces writes until the timer fires', async () => {
  const h = fakeDeps();
  const fh = createFileHeat(h.deps);
  await fh.recordRead('/a', null, null);
  await fh.recordRead('/b', null, null);
  assert.strictEqual(h.written.length, 0, 'no synchronous write — debounced');
  h.fireTimers();
  assert.strictEqual(h.written.length, 1, 'one coalesced write when the timer fires');
  assert.strictEqual(Object.keys(h.written[0].days['2026-07-16']).length, 2);
});

test('factory: snapshot loads lazily, prunes, and ranks the agent view', async () => {
  const h = fakeDeps();
  const fh = createFileHeat(h.deps);
  await fh.recordRead('/big', null, null); // 4000/4 = 1000
  h.setClock(T0 + 60_000);
  const snap = fh.snapshot(5);
  assert.strictEqual(snap.files[0].file, '/big');
  assert.strictEqual(snap.files[0].approxReadTokens, 1000);
});

test('factory: a corrupt on-disk state is replaced, not thrown on', async () => {
  const h = fakeDeps({ initial: 'not-json-shaped', deps: {} });
  const fh = createFileHeat(h.deps);
  await fh.recordRead('/x', null, null);
  fh.flush();
  assert.strictEqual(h.written[0].version, 1);
  assert.ok(h.written[0].days['2026-07-16']['/x']);
});

test('factory: an unweighable read (stat fails) still counts', async () => {
  const h = fakeDeps({ bytes: {} }); // every stat → null
  const fh = createFileHeat(h.deps);
  await fh.recordRead('/gone', 10, 20);
  const snap = fh.snapshot();
  assert.strictEqual(snap.files[0].reads, 1);
  assert.strictEqual(snap.files[0].approxReadTokens, 0);
  assert.strictEqual(snap.files[0].segments, 1);
});
