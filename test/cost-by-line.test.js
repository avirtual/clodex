'use strict';
// Run: node --test
// Unit tests for renderer/lib/cost-by-line.js — the cost popover's "By line"
// attribution model.
//
// THE PROPERTY. Nothing this section displays comes from the wire: the
// whole-tree total, the main line's share and every subagent's share are all
// wirescope poll figures. So it must render IDENTICALLY whether or not the W2
// telemetry overlay is on, and that is asserted here against the REAL
// `WireTelemetry.overlay()` rather than a hand-written stand-in — a fixture
// that re-implemented the overlay would pin this test's idea of it, which is
// the one thing that cannot regress.
//
// The overlay replaces `cost` with the wire's persisted all-time ledger and
// leaves `subagents` poll-scoped, so a reading that took `mainUsd` off `p.cost`
// lost the main row, lost the whole section when there were no subagents, and
// divided run-scoped shares by an all-time total. That last one is the
// expensive half and is invisible to a "mainUsd is present" assertion, so every
// property assertion below compares whole models, percentages included.
const { test } = require('node:test');
const assert = require('node:assert');
const { costByLine } = require('../renderer/lib/cost-by-line');
const { WireTelemetry } = require('../wire-telemetry');

// A wire that has seen a main-line turn for 'alice' — the precondition for
// overlay() doing anything at all. Its ledger is deliberately far from the
// poll's cost so an overlay leaking through cannot pass unnoticed.
function wiredTelemetry() {
  const wt = new WireTelemetry({});
  wt.noteTurn({
    agent: 'alice', sessionId: 'sid-1', role: 'parent', sideCall: false,
    model: 'claude-sonnet-5', status: 200,
    billing: { tokens: { input_tokens: 100, cache_read_input_tokens: 40000 } },
    sessionTotals: { requests: 392, est_usd: 113.98, turns: 50, refusals: 0 },
  });
  return wt;
}

// The overlay-OFF payload: what wirescope's poll shapes (proxy-util.js), where
// `cost` IS the run-scoped object and carries `mainUsd`.
function poll(over = {}) {
  return {
    linked: true, sessionId: 'sid-1', model: 'claude-sonnet-5',
    capabilities: { cost_by_line: true },
    cost: { usd: 2, mainUsd: 0.31, requests: 12 },
    subagents: [],
    ...over,
  };
}

// Both payloads for one poll shape, plus the guard that makes comparing them
// mean anything: if the wire ledger equalled the poll's, the property would
// hold no matter how the scope pick was written.
function bothScopes(p) {
  const on = wiredTelemetry().overlay('alice', p);
  assert.strictEqual(on.telemetrySource, 'wire', 'ENTER: the overlay must actually have fired');
  assert.notStrictEqual(on.cost.usd, p.cost.usd,
    'ENTER: the wire ledger must differ from the poll, or scope-mixing is undetectable here');
  assert.strictEqual(on.cost.mainUsd, undefined,
    'ENTER: the wire ledger must carry no mainUsd, or the drop is undetectable here');
  return { on, off: p };
}

test('overlay on and off render the same By-line model — with subagents', () => {
  const { on, off } = bothScopes(poll({
    subagents: [
      { key: 'a', label: 'Explore', estUsd: 0.2 },
      { key: 'b', label: 'Plan', estUsd: 0.9 },
      { key: 'c', label: 'unpriced' },
    ],
  }));
  const m = costByLine(on);
  assert.deepStrictEqual(m, costByLine(off));
  // Non-vacuity: two nulls are deepStrictEqual, and so are two collapsed
  // models. Floor on the rows (not `> 0`) — the realistic degradation drops
  // the main row or the unbilled sub, not every row.
  assert.ok(m && m.rows.length >= 4, `expected >= 4 rows, got ${m && m.rows.length}`);
  assert.deepStrictEqual(m, {
    total: 2,
    rows: [
      { label: 'Plan', usd: 0.9, pct: 45, main: false },
      { label: 'Main line', usd: 0.31, pct: 16, main: true },
      { label: 'Explore', usd: 0.2, pct: 10, main: false },
      { label: 'unpriced', usd: null, pct: null, main: false },
    ],
  });
});

test('overlay on and off render the same By-line model — no subagents (the common case)', () => {
  // The section used to VANISH here under the overlay: no mainUsd on the wire
  // ledger and no billed subs meant "nothing attributed yet".
  const { on, off } = bothScopes(poll());
  const m = costByLine(on);
  assert.deepStrictEqual(m, costByLine(off));
  assert.deepStrictEqual(m, { total: 2, rows: [{ label: 'Main line', usd: 0.31, pct: 16, main: true }] });
});

test('percentages are against the run-scoped total, not the all-time ledger', () => {
  // The half a presence check passes over. With the wire's 113.98 as the
  // denominator both shares round to 0%; the run total makes them 16% and 10%.
  const { on } = bothScopes(poll({ subagents: [{ key: 'a', label: 'Explore', estUsd: 0.2 }] }));
  assert.deepStrictEqual(costByLine(on).rows.map((r) => r.pct), [16, 10]);
  assert.strictEqual(costByLine(on).total, 2);
});

test('unbilled shares stay unbilled and sink; never rendered as $0', () => {
  const m = costByLine(poll({
    cost: { usd: 1, mainUsd: null, requests: 4 },
    subagents: [{ key: 'a', label: 'unpriced' }, { key: 'b', label: 'Plan', estUsd: 0.5 }],
  }));
  assert.deepStrictEqual(m.rows, [
    { label: 'Plan', usd: 0.5, pct: 50, main: false },
    { label: 'unpriced', usd: null, pct: null, main: false },
  ]);
});

test('renders nothing when the capability is off, the cost object is missing, or nothing is attributed', () => {
  assert.strictEqual(costByLine(null), null);
  assert.strictEqual(costByLine({ capabilities: {}, cost: { usd: 2, mainUsd: 0.3 } }), null);
  assert.strictEqual(costByLine({ capabilities: { cost_by_line: true } }), null);
  // Attributed nothing: no mainUsd and no billed sub. Not the same as $0.
  assert.strictEqual(costByLine(poll({ cost: { usd: 2, mainUsd: null }, subagents: [{ key: 'a' }] })), null);
});

test('a cost-less poll degrades to the wire object rather than throwing', () => {
  // overlay() sets costRun = null when the poll carried no cost, so the pick
  // falls through to the wire ledger — which has no mainUsd and no run total,
  // so the section simply does not render. There is nothing better to show.
  const out = wiredTelemetry().overlay('alice', { linked: true, sessionId: 'sid-1', cost: null, capabilities: { cost_by_line: true } });
  assert.strictEqual(out.costRun, null);
  assert.strictEqual(costByLine(out), null);
  // With a billed sub it renders against the only total there is.
  const withSub = wiredTelemetry().overlay('alice', {
    linked: true, sessionId: 'sid-1', cost: null, capabilities: { cost_by_line: true },
    subagents: [{ key: 'a', label: 'Explore', estUsd: 0.2 }],
  });
  assert.deepStrictEqual(costByLine(withSub), {
    total: 113.98,
    rows: [{ label: 'Explore', usd: 0.2, pct: 0, main: false }],
  });
});

test('the input payload is never mutated', () => {
  const p = poll({ subagents: [{ key: 'a', label: 'Explore', estUsd: 0.2 }] });
  const before = JSON.stringify(p);
  costByLine(p);
  assert.strictEqual(JSON.stringify(p), before);
});
