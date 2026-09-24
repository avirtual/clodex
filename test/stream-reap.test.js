'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { reapDecision, reapBeforeResume } = require('../stream-reap');

const RECORD = { pid: 5150, startTime: 1790000000000 };

const DECISIONS = [
  [{ alive: true, startTime: 1790000000000 }, 'kill'],
  [{ alive: true, startTime: 1790000001999 }, 'kill'],
  [{ alive: true, startTime: 1789999998000 }, 'kill'],
  [{ alive: true, startTime: 1790000002001 }, 'recycled'],
  [{ alive: true, startTime: 1790000900000 }, 'recycled'],
  [{ alive: true, startTime: null }, 'recycled'],
  [{ alive: false, startTime: 1790000000000 }, 'dead'],
  [{ alive: false, startTime: null }, 'dead'],
];

for (const [input, want] of DECISIONS) {
  test(`reapDecision alive=${input.alive} startTime=${input.startTime} → ${want}`, () => {
    assert.strictEqual(reapDecision({ record: RECORD, ...input }), want);
  });
}

test('reapDecision: a record without a start time is never killed', () => {
  assert.strictEqual(reapDecision({ record: { pid: 5150 }, alive: true, startTime: 1790000000000 }), 'recycled');
});

function harness({ exitsOnTerm }) {
  const calls = [];
  let alive = true;
  const out = {
    calls,
    kill: (pid, sig) => {
      calls.push(['kill', pid, sig]);
      if (sig === 'SIGKILL' || exitsOnTerm) alive = false;
    },
    isAlive: () => alive,
    startTimeOf: (pid) => { calls.push(['startTimeOf', pid]); return 1790000000500; },
    wait: async (done, ms) => { calls.push(['wait', ms]); return done(); },
  };
  return out;
}

test('reapBeforeResume: a child that ignores SIGTERM gets SIGTERM, a 3s wait, then SIGKILL', async () => {
  const h = harness({ exitsOnTerm: false });
  const decision = await reapBeforeResume({ record: RECORD, ...h });
  assert.strictEqual(decision, 'kill');
  assert.deepStrictEqual(h.calls, [
    ['startTimeOf', 5150],
    ['kill', 5150, 'SIGTERM'],
    ['wait', 3000],
    ['kill', 5150, 'SIGKILL'],
  ]);
});

test('reapBeforeResume: a child that exits on SIGTERM is not SIGKILLed', async () => {
  const h = harness({ exitsOnTerm: true });
  const decision = await reapBeforeResume({ record: RECORD, ...h });
  assert.strictEqual(decision, 'kill');
  assert.deepStrictEqual(h.calls, [
    ['startTimeOf', 5150],
    ['kill', 5150, 'SIGTERM'],
    ['wait', 3000],
  ]);
});

test('reapBeforeResume: a recycled pid and a missing record signal nothing', async () => {
  const h = harness({ exitsOnTerm: true });
  h.startTimeOf = (pid) => { h.calls.push(['startTimeOf', pid]); return 1790000500000; };
  assert.deepStrictEqual(
    [await reapBeforeResume({ record: RECORD, ...h }), await reapBeforeResume({ record: null, ...h }),
      await reapBeforeResume({ record: { pid: -1, startTime: 1 }, ...h })],
    ['recycled', 'dead', 'dead']);
  assert.deepStrictEqual(h.calls, [['startTimeOf', 5150]]);
});
