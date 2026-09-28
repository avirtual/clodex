'use strict';
// Unit tests for renderer/lib/turn-stat.js — the shared "which turn number do
// we show" decision. The statusbar reshape (live count front, cumulative in
// the tooltip) is pinned here.

const test = require('node:test');
const assert = require('node:assert');
const { turnStat, turnSeg, turnLine, reqSeg, reqLine, costSeg, costLine } = require('../renderer/lib/turn-stat');

const full = { turns: 143, context: { turns: 12 } };

test('turnStat: both counts present', () => {
  assert.deepStrictEqual(turnStat(full), { now: 12, total: 143 });
});

test('turnStat: nulls for missing halves, null when neither exists', () => {
  assert.deepStrictEqual(turnStat({ turns: 143 }), { now: null, total: 143 });
  assert.deepStrictEqual(turnStat({ context: { turns: 3 } }), { now: 3, total: null });
  assert.strictEqual(turnStat({}), null);
  assert.strictEqual(turnStat(null), null);
});

test('turnSeg: live count leads, cumulative rides the tip', () => {
  assert.deepStrictEqual(turnSeg(full), {
    text: 'turn 12',
    tip: 'Turns in the live context (resets at compact) — 143 completed since session start',
  });
});

test('turnSeg: degrades to cumulative with a tip that says so', () => {
  const seg = turnSeg({ turns: 143 });
  assert.strictEqual(seg.text, 'turn 143');
  assert.match(seg.tip, /since session start/);
});

test('turnSeg: zero live turns (fresh post-compact poll) still renders live', () => {
  assert.strictEqual(turnSeg({ turns: 143, context: { turns: 0 } }).text, 'turn 0');
});

test('turnLine: hovercard shows both inline', () => {
  assert.strictEqual(turnLine(full), 'turn 12 (143 total)');
  assert.strictEqual(turnLine({ context: { turns: 3 } }), 'turn 3');
  assert.strictEqual(turnLine({ turns: 143 }), 'turn 143 total');
  assert.strictEqual(turnLine({}), null);
});

const scPayload = {
  cost: { requests: 1008 },
  sinceCompact: { turns: 12, requests: 61, estUsd: 0.4, boundaryTs: 1e9, compacted: true },
};

test('reqSeg: since-compact leads when the rollup is present, total in tip', () => {
  const seg = reqSeg(scPayload);
  assert.strictEqual(seg.text, 'req 61');
  assert.match(seg.tip, /since the last compact/);
  assert.match(seg.tip, /1008 total/);
});

test('reqSeg: never-compacted rollup says since-start honestly, no redundant total', () => {
  const seg = reqSeg({ cost: { requests: 61 }, sinceCompact: { ...scPayload.sinceCompact, requests: 61, compacted: false } });
  assert.strictEqual(seg.text, 'req 61');
  assert.match(seg.tip, /never compacted/);
  assert.ok(!seg.tip.includes('total'));
});

test('reqSeg: older proxy (no sinceCompact) degrades to cumulative with spans-compacts tip', () => {
  const seg = reqSeg({ cost: { requests: 1008 }, sinceCompact: null });
  assert.strictEqual(seg.text, 'req 1008');
  assert.match(seg.tip, /spans compacts/);
});

test('reqSeg: no counts at all → null', () => {
  assert.strictEqual(reqSeg({}), null);
  assert.strictEqual(reqSeg(null), null);
});

test('reqLine leads with reqSeg\'s headline when the session never compacted but p.cost is the all-time scope', () => {
  const p = { cost: { requests: 500 }, costRun: { usd: 1, requests: 20 }, sinceCompact: { requests: 20, compacted: false } };
  assert.strictEqual(reqSeg(p).text, 'req 20', 'ENTER: the fixture reaches the never-compacted branch');
  assert.strictEqual(reqLine(p), 'req 20 (500 all-time)');
});

test('reqLine: both inline post-compact, plain otherwise', () => {
  assert.strictEqual(reqLine(scPayload), 'req 61 (1008 total)');
  assert.strictEqual(reqLine({ cost: { requests: 61 }, sinceCompact: { requests: 61, compacted: false } }), 'req 61');
  assert.strictEqual(reqLine({ cost: { requests: 1008 } }), 'req 1008');
  assert.strictEqual(reqLine({}), null);
});

// ── costSeg / costLine (live-first cost, operator ruling 07-15) ──────────────
// The three-scopes incident pinned here: under the W2 overlay p.cost.usd is
// the ALL-TIME ledger (additive across restarts) and p.costRun.usd is
// wirescope's per-registration figure (zeroes at process spawn) — both are
// shown, scopes named. Without costRun the tooltip calls p.cost just "total"
// (its scope varies by producer) — only since-compact is stable.

const costPayload = { cost: { usd: 225.35 }, sinceCompact: { estUsd: 15.07, compacted: true } };

test('costSeg: since-compact spend leads, cumulative in tooltip as plain total', () => {
  const seg = costSeg(costPayload);
  assert.strictEqual(seg.text, '~$15.07');
  assert.match(seg.tip, /since the last compact/);
  assert.match(seg.tip, /\$225\.35 total/);
});

test('costSeg: with costRun both cumulatives ride the tooltip, scopes named', () => {
  const seg = costSeg({ ...costPayload, cost: { usd: 247.30 }, costRun: { usd: 96.12 } });
  assert.strictEqual(seg.text, '~$15.07', 'since-compact still leads');
  assert.match(seg.tip, /\$96\.12 this run/);
  assert.match(seg.tip, /\$247\.30 all-time/);
  assert.ok(!seg.tip.includes(' total'), 'named scopes replace the neutral "total"');
});

test('costSeg: costRun without sinceCompact leads with the run figure, all-time in tip', () => {
  const seg = costSeg({ cost: { usd: 247.30 }, costRun: { usd: 96.12 }, sinceCompact: null });
  assert.strictEqual(seg.text, '~$96.12');
  assert.match(seg.tip, /this run/);
  assert.match(seg.tip, /\$247\.30 all-time/);
});

test('costLine: run and all-time inline when costRun is present', () => {
  assert.strictEqual(
    costLine({ cost: { usd: 247.30 }, costRun: { usd: 96.12 }, sinceCompact: { estUsd: 15.07, compacted: true } }),
    '~$15.07 ($96.12 run · $247.30 all-time)');
  assert.strictEqual(
    costLine({ cost: { usd: 247.30 }, costRun: { usd: 96.12 } }),
    '~$96.12 ($247.30 all-time)');
});

test('costSeg: never-compacted says since-start honestly, no redundant total', () => {
  const seg = costSeg({ cost: { usd: 15.07 }, sinceCompact: { estUsd: 15.07, compacted: false } });
  assert.strictEqual(seg.text, '~$15.07');
  assert.match(seg.tip, /never compacted/);
  assert.ok(!seg.tip.includes('total'));
});

test('costSeg: sub-dollar keeps 4 decimals', () => {
  const seg = costSeg({ cost: { usd: 0.4321 }, sinceCompact: { estUsd: 0.1234, compacted: true } });
  assert.strictEqual(seg.text, '~$0.1234');
});

test('costSeg: older proxy (no sinceCompact) degrades to cumulative with spans-compacts tip', () => {
  const seg = costSeg({ cost: { usd: 225.35 }, sinceCompact: null });
  assert.strictEqual(seg.text, '~$225.35');
  assert.match(seg.tip, /spans compacts/);
});

test('costSeg: no cost at all → null (renderer falls through to CLI side-channel)', () => {
  assert.strictEqual(costSeg({}), null);
  assert.strictEqual(costSeg(null), null);
  assert.strictEqual(costSeg({ cost: { usd: null } }), null);
});

test('costLine leads with the since-start figure like costSeg when never compacted and costRun is absent', () => {
  const p = { cost: { usd: 247.30 }, sinceCompact: { estUsd: 3.5, compacted: false } };
  assert.strictEqual(costSeg(p).text, '~$3.50', 'ENTER: the statusbar headline is the since-start figure');
  assert.strictEqual(costLine(p), '~$3.50');
});

test('the hovercard req and cost lines lead with the statusbar headline for every scope shape', () => {
  const heads = (line, seg) => line === seg.text || line.startsWith(`${seg.text} (`);
  for (const compacted of [true, false]) {
    for (const costRun of [null, { usd: 96.12, requests: 20 }]) {
      const p = { cost: { usd: 247.30, requests: 500 }, costRun, sinceCompact: { requests: 12, estUsd: 3.5, compacted } };
      const shape = JSON.stringify({ compacted, costRun: Boolean(costRun) });
      assert.ok(heads(reqLine(p), reqSeg(p)), `req ${shape}: ${reqLine(p)} vs ${reqSeg(p).text}`);
      assert.ok(heads(costLine(p), costSeg(p)), `cost ${shape}: ${costLine(p)} vs ${costSeg(p).text}`);
    }
  }
});

test('costLine: both inline post-compact, plain otherwise', () => {
  assert.strictEqual(costLine(costPayload), '~$15.07 ($225.35 total)');
  assert.strictEqual(costLine({ cost: { usd: 15.07 }, sinceCompact: { estUsd: 15.07, compacted: false } }), '~$15.07');
  assert.strictEqual(costLine({ cost: { usd: 225.35 } }), '~$225.35');
  assert.strictEqual(costLine({}), null);
});
