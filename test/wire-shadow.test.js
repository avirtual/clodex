'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ShadowDiff } = require('../wire/shadow');

function sinkInto(records) {
  return (r) => records.push(r);
}

test('wire-first match records latency and order', async () => {
  const records = [];
  const d = new ShadowDiff(sinkInto(records), { windowMs: 1000 });
  d.record('wire', 'k1', { agent: 'a' });
  await new Promise((r) => setTimeout(r, 20));
  d.record('jsonl', 'k1', { agent: 'a' });
  d.stop();

  const match = records.find((r) => r.type === 'match');
  assert.ok(match);
  assert.equal(match.first, 'wire');
  assert.ok(match.latencyMs >= 15, `latency ${match.latencyMs}`);
  assert.equal(match.dupes, 0);
  assert.equal(records.filter((r) => r.type === 'sighting').length, 2);
});

test('jsonl-first match flags the ordering', () => {
  const records = [];
  const d = new ShadowDiff(sinkInto(records), { windowMs: 1000 });
  d.record('jsonl', 'k1', {});
  d.record('wire', 'k1', {});
  d.stop();
  assert.equal(records.find((r) => r.type === 'match').first, 'jsonl');
});

test('duplicate from the same side is counted, not matched', (t) => {
  const records = [];
  const d = new ShadowDiff(sinkInto(records), { windowMs: 1000 });
  t.after(() => d.stop());
  d.record('wire', 'k1', {});
  d.record('wire', 'k1', {});
  d.record('wire', 'k1', {});
  const dupes = records.filter((r) => r.type === 'dupe');
  assert.equal(dupes.length, 2);
  assert.equal(dupes[1].count, 2);
  d.record('jsonl', 'k1', {});
  const match = records.find((r) => r.type === 'match');
  assert.equal(match.dupes, 2);
});

test('unmatched fires after the window', async (t) => {
  const records = [];
  const d = new ShadowDiff(sinkInto(records), { windowMs: 30 });
  t.after(() => d.stop());
  d.record('wire', 'lonely', { agent: 'a' });
  await new Promise((r) => setTimeout(r, 60));
  const un = records.find((r) => r.type === 'unmatched');
  assert.ok(un);
  assert.equal(un.source, 'wire');
  assert.equal(un.agent, 'a');
});

test('independent keys do not cross-match', (t) => {
  const records = [];
  const d = new ShadowDiff(sinkInto(records), { windowMs: 1000 });
  t.after(() => d.stop());
  d.record('wire', 'k1', {});
  d.record('jsonl', 'k2', {});
  // Both keys were actually seen: the absence below is the matcher declining to
  // pair them, not `record` failing to emit and leaving nothing to match.
  assert.equal(records.filter((r) => r.type === 'sighting').length, 2,
    'ENTER: two independent sightings reached the differ');
  assert.equal(records.filter((r) => r.type === 'match').length, 0);
});

test('sink exceptions never escape', (t) => {
  const d = new ShadowDiff(() => { throw new Error('boom'); }, { windowMs: 1000 });
  t.after(() => d.stop());
  assert.doesNotThrow(() => d.record('wire', 'k1', {}));
});
