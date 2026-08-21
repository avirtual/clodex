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
const fs = require('node:fs');
const path = require('node:path');
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

// The case a `costRun || cost` fallback got wrong, and the reason the pick is
// keyed on `telemetrySource` instead: falling through reaches `p.cost`, which
// under the overlay is ALWAYS the wire ledger, and rendered a wire total over
// run-scoped rows — the mix this leaf removes, asserted as correct. Both
// directions are pinned because the property is symmetric: the overlay may not
// change what this section shows, and "shows nothing" is a rendering.
test('a cost-less poll renders nothing, with the overlay on and off alike', () => {
  const bare = { linked: true, sessionId: 'sid-1', cost: null, capabilities: { cost_by_line: true } };
  const out = wiredTelemetry().overlay('alice', bare);
  assert.strictEqual(out.telemetrySource, 'wire', 'ENTER: the overlay must actually have fired');
  assert.strictEqual(out.costRun, null, 'ENTER: a cost-less poll must leave costRun null, or this case is not the one under test');
  assert.strictEqual(costByLine(out), null);
  assert.strictEqual(costByLine(bare), null);

  // A billed subagent must not resurrect it: the wire ledger is not a total
  // these rows can be divided by, so there is nothing to render against.
  const withSub = { ...bare, subagents: [{ key: 'a', label: 'Explore', estUsd: 0.2 }] };
  const onSub = wiredTelemetry().overlay('alice', withSub);
  assert.strictEqual(onSub.cost.usd, 113.98, 'ENTER: the wire ledger must be present and non-null, or the fallback this pins against is unreachable');
  assert.strictEqual(costByLine(onSub), null);
  assert.strictEqual(costByLine(withSub), null);
});

// The property tests above cover the LEAF; nothing covered the WIRING. Revert
// the popover to reading `p.cost`/`p.costRun` inline and every one of them stays
// green while the operator sees the pre-fix numbers again, because the popover
// is DOM-bound and untested. Two directions, because either alone is passable:
// keeping the require while reading the payload directly, or dropping it.
// Precedent for asserting on source shape: test/ctl-service.test.js's
// electron-free check.
test('the cost popover reads the model through this leaf, never the payload directly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'popovers', 'cost-popover.js'), 'utf8');
  assert.match(src, /require\('\.\.\/lib\/cost-by-line'\)/, 'the popover must import the leaf');

  // Comments are stripped first: this file's own prose names the fields, and a
  // scan that matched them would be unfixable by construction.
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const direct = [...code.matchAll(/\bp(?:ayload)?\.(cost|costRun|subagents)\b/g)].map((m) => m[0]);
  assert.deepStrictEqual(direct, [],
    `cost-popover.js reads the telemetry payload's cost fields directly (${direct.join(', ')}) — `
    + 'the scope pick is the leaf\'s job (renderer/lib/cost-by-line.js). Reading them here reintroduces '
    + 'the overlay-scope mix in a file no test can see.');

  // ENTER: the scan must be looking at a file that still HAS the section, or
  // the absence above is trivially true of a popover that stopped rendering it.
  assert.match(code, /renderCostByLine/, 'ENTER: the By-line renderer is gone from the popover');
  assert.match(code, /costByLine\(/, 'ENTER: the popover no longer calls the leaf at all');
});

test('the input payload is never mutated', () => {
  const p = poll({ subagents: [{ key: 'a', label: 'Explore', estUsd: 0.2 }] });
  const before = JSON.stringify(p);
  costByLine(p);
  assert.strictEqual(JSON.stringify(p), before);
});
