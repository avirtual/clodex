'use strict';
// The ⓘ panel's rows. What these pin is that the cost scopes stay LABELLED and
// distinct — the 07-15 ruling exists because three surfaces once showed three
// different numbers under near-identical labels, and this panel shows all three
// at once, side by side, where a wrong label is unmissable.

const test = require('node:test');
const assert = require('node:assert');

const { buildSections, fmtUsd, fmtTokens, fmtBytes, fmtAge } = require('../renderer/lib/session-info-view');

const sec = (sections, title) => sections.find((s) => s.title === title);
const keys = (s) => (s ? s.rows.map((r) => r.k) : []);
const val = (s, k) => { const r = s && s.rows.find((x) => x.k === k); return r && r.v; };

test('every cost scope present is shown, each under its own label', () => {
  const s = sec(buildSections({
    agent: { usd: 10, known: 2, total: 2, requests: 50, turns: 17, refusals: 0 },
    session: { usd: 6, requests: 30, turns: 9, refusals: 0 },
    run: { usd: 0.5, requests: 3 },
    sinceCompact: { estUsd: 0.25, compacted: true },
  }), 'Cost');
  assert.deepStrictEqual(keys(s), ['since last compact', 'this run', 'this conversation', 'this agent, all time']);
  assert.strictEqual(val(s, 'since last compact'), '$0.2500');
  assert.strictEqual(val(s, 'this run'), '$0.5000');
  assert.strictEqual(val(s, 'this conversation'), '$6.00');
  assert.strictEqual(val(s, 'this agent, all time'), '$10.00');
  // Four different numbers, four different labels: no two rows may collide.
  const labels = new Set(keys(s));
  assert.strictEqual(labels.size, 4);
});

test('a never-compacted conversation says so rather than implying a boundary', () => {
  const s = sec(buildSections({ agent: { total: 0 }, sinceCompact: { estUsd: 1, compacted: false } }), 'Cost');
  assert.strictEqual(keys(s)[0], 'since start');
  assert.match(s.rows[0].tip, /never compacted/);
});

test('a pruned ledger is disclosed, not silently understated', () => {
  const s = sec(buildSections({ agent: { usd: 4, known: 1, total: 3 } }), 'Cost');
  const r = s.rows.find((x) => x.k === 'this agent, all time');
  assert.match(r.tip, /1 of 3/);
  assert.match(r.tip, /higher/);
  // And a visible row, not only a tooltip — the tip needs a hover to find.
  assert.ok(s.rows.some((x) => typeof x.v === 'string' && /1\/3 conversations/.test(x.v)));
});

test('a complete ledger makes no partial claim', () => {
  const s = sec(buildSections({ agent: { usd: 4, known: 3, total: 3 } }), 'Cost');
  const r = s.rows.find((x) => x.k === 'this agent, all time');
  assert.doesNotMatch(r.tip, /pruned|higher/);
  assert.ok(!s.rows.some((x) => typeof x.v === 'string' && /conversations in the ledger/.test(x.v)));
});

test('compaction reads plainly at zero and at N', () => {
  const never = sec(buildSections({ agent: { total: 0 }, compact: { count: 0 } }), 'Compaction');
  assert.strictEqual(val(never, 'compacted'), 'never');
  const some = sec(buildSections({
    agent: { total: 0 },
    compact: { count: 58, autoCount: 4, dropped: 8201601, last: { pre: 156684, post: 15992 } },
  }), 'Compaction');
  assert.strictEqual(val(some, 'compacted'), '58×');
  assert.strictEqual(val(some, 'auto vs manual'), '4 auto · 54 manual');
  assert.strictEqual(val(some, 'tokens dropped'), '8.2M');
  assert.strictEqual(val(some, 'last compact'), '157k → 16k');
});

test('sections with nothing to say are dropped, not rendered empty', () => {
  const sections = buildSections({ agent: { total: 0 }, compact: { count: 0 } });
  for (const s of sections) assert.ok(s.rows.length > 0, `${s.title} rendered empty`);
  // Compaction always has its "never" row; Cost with no scopes at all must go.
  assert.ok(!sec(sections, 'Cost'));
  assert.ok(sec(sections, 'Compaction'));
});

test('buildSections tolerates a null record', () => {
  assert.deepStrictEqual(buildSections(null), []);
});

test('formatters keep small costs readable and large ones short', () => {
  // A sub-cent turn must not render as $0.00 — the panel is often opened
  // precisely to see whether a cheap seat is actually cheap.
  assert.strictEqual(fmtUsd(0.0004), '$0.0004');
  assert.strictEqual(fmtUsd(6), '$6.00');
  assert.strictEqual(fmtUsd(1234.5), '$1235');
  assert.strictEqual(fmtUsd(null), null);
  assert.strictEqual(fmtUsd(NaN), null);
  assert.strictEqual(fmtTokens(950), '950');
  assert.strictEqual(fmtTokens(156684), '157k');
  assert.strictEqual(fmtTokens(8201601), '8.2M');
  assert.strictEqual(fmtBytes(70123456), '70 MB');
  assert.strictEqual(fmtAge(90 * 60000), '1h 30m');
  assert.strictEqual(fmtAge(50 * 3600000), '2d 2h');
  assert.strictEqual(fmtAge(-1), null);
});
