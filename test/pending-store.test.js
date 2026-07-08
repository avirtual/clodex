'use strict';

// pending-store: layer-3 delivery parking. Verifies the zero-loss, order-
// preserving, single-delivery guarantees the DM channel needs (unlike the
// lossy ack channel). No CLI required — pure fs behavior.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parkDelivery, drainPending, hasPending, agentDir } = require('../pending-store');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pending-test-'));
}

test('park then drain round-trips the text', () => {
  const root = tmpRoot();
  parkDelivery(root, 'alice', '[agent:from bob] hi', '0001');
  const out = drainPending(root, 'alice', 't1');
  assert.deepStrictEqual(out, ['[agent:from bob] hi']);
});

test('drain preserves arrival order (lexical seq sort)', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'first', '1736900000000.000001');
  parkDelivery(root, 'a', 'second', '1736900000000.000002');
  parkDelivery(root, 'a', 'third', '1736900000001.000000');
  assert.deepStrictEqual(drainPending(root, 'a', 't'), ['first', 'second', 'third']);
});

test('drain empties the store — a second drain returns nothing', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'x', '0001');
  assert.deepStrictEqual(drainPending(root, 'a', 't1'), ['x']);
  assert.deepStrictEqual(drainPending(root, 'a', 't2'), []);
});

test('drain of an empty/absent store returns [] (no throw)', () => {
  const root = tmpRoot();
  assert.deepStrictEqual(drainPending(root, 'nobody', 't'), []);
});

test('two concurrent drainers: the atomic claim gives all to one, none double-delivered', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'm1', '0001');
  parkDelivery(root, 'a', 'm2', '0002');
  // Simulate the hook and the cap-fire both draining "at once": whichever
  // renames the dir first wins the whole snapshot; the other gets nothing.
  const first = drainPending(root, 'a', 'hook');
  const second = drainPending(root, 'a', 'cap');
  const all = [...first, ...second].sort();
  assert.deepStrictEqual(all, ['m1', 'm2'], 'every message delivered exactly once');
  assert.ok(first.length === 2 || second.length === 2, 'one drainer got the whole batch');
  assert.ok(first.length === 0 || second.length === 0, 'the other got nothing');
});

test('a message parked after a claim lands in a fresh store and drains next turn', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'early', '0001');
  const first = drainPending(root, 'a', 'hook');   // claims + removes the dir
  parkDelivery(root, 'a', 'late', '0002');          // recreates the dir
  const second = drainPending(root, 'a', 'cap');
  assert.deepStrictEqual(first, ['early']);
  assert.deepStrictEqual(second, ['late']);
});

test('hasPending reflects parked state without claiming', () => {
  const root = tmpRoot();
  assert.equal(hasPending(root, 'a'), false);
  parkDelivery(root, 'a', 'x', '0001');
  assert.equal(hasPending(root, 'a'), true);
  // peek must not consume — a following drain still sees it
  assert.equal(hasPending(root, 'a'), true);
  assert.deepStrictEqual(drainPending(root, 'a', 't'), ['x']);
  assert.equal(hasPending(root, 'a'), false);
});

test('a stray .tmp in the store is ignored by drain (never a partial read)', () => {
  const root = tmpRoot();
  const dir = agentDir(root, 'a');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.0001.json.tmp'), '{"text":"half');  // simulated in-flight publish
  parkDelivery(root, 'a', 'whole', '0002');
  assert.deepStrictEqual(drainPending(root, 'a', 't'), ['whole']);
});

test('multi-line delivery text survives verbatim', () => {
  const root = tmpRoot();
  const body = '[agent:from bob] line one\nline two\n(reply: start a line with [agent:dm bob])';
  parkDelivery(root, 'a', body, '0001');
  assert.deepStrictEqual(drainPending(root, 'a', 't'), [body]);
});
