'use strict';

// peer-outbox: the box-side per-origin DM mailbox. Pure fs discipline (atomic
// publish + whole-dir claim), tested against a real temp dir — no tunnel.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  enqueueOutbox, claimOutbox, outboxHasOrigin, listOutboxOrigins, validOrigin,
} = require('../peer-outbox');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-outbox-'));
}

// Deterministic monotonic seq for ordering assertions.
function seqGen() {
  let n = 0;
  return () => `1000000000000.${String(++n).padStart(9, '0')}`;
}

test('enqueue then claim round-trips messages in arrival order', () => {
  const root = tmpRoot();
  const seq = seqGen();
  enqueueOutbox(root, 'laptop1', { from: 'a', to: 'b', body: 'first', urgent: false, ts: 111 }, seq());
  enqueueOutbox(root, 'laptop1', { from: 'a', to: 'b', body: 'second', urgent: true, ts: 222 }, seq());
  const msgs = claimOutbox(root, 'laptop1');
  assert.equal(msgs.length, 2);
  assert.deepStrictEqual(msgs.map((m) => m.body), ['first', 'second']);
  assert.deepStrictEqual(msgs[0], { from: 'a', to: 'b', body: 'first', urgent: false, ts: 111 });
  assert.strictEqual(msgs[1].urgent, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('relay envelope fields (finalTarget/hops/rv) round-trip; a direct DM stays clean', () => {
  const root = tmpRoot();
  const seq = seqGen();
  // A relay envelope enqueued under origin=hub, and a plain direct DM.
  enqueueOutbox(root, 'hub', {
    from: 'docker@docker', to: 'murmur', body: 'hi', urgent: false, ts: 111,
    finalTarget: 'murmur@murmurfi', hops: 1, rv: 1,
  }, seq());
  enqueueOutbox(root, 'hub', { from: 'x', to: 'y', body: 'plain', ts: 222 }, seq());
  const [relay, direct] = claimOutbox(root, 'hub');
  // The relay fields MUST survive — dropping finalTarget silently demotes the
  // relay DM to a direct one and the hub can't route it (the live bug).
  assert.strictEqual(relay.finalTarget, 'murmur@murmurfi', 'finalTarget round-trips');
  assert.strictEqual(relay.hops, 1, 'hops round-trips');
  assert.strictEqual(relay.rv, 1, 'rv round-trips');
  assert.strictEqual(relay.from, 'docker@docker', 'qualified from preserved');
  // The direct DM must NOT gain any relay fields (absence = direct; discriminator).
  assert.strictEqual('finalTarget' in direct, false, 'direct DM has no finalTarget');
  assert.strictEqual('hops' in direct, false, 'direct DM has no hops');
  assert.strictEqual('rv' in direct, false, 'direct DM has no rv');
  fs.rmSync(root, { recursive: true, force: true });
});

test('claim is a one-shot: a second claim sees nothing', () => {
  const root = tmpRoot();
  const seq = seqGen();
  enqueueOutbox(root, 'box', { from: 'a', to: 'b', body: 'x' }, seq());
  assert.equal(claimOutbox(root, 'box').length, 1);
  assert.deepStrictEqual(claimOutbox(root, 'box'), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('claim on an empty / never-used origin returns []', () => {
  const root = tmpRoot();
  assert.deepStrictEqual(claimOutbox(root, 'nobody'), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a message enqueued AFTER a claim drains on the next claim (fresh dir)', () => {
  const root = tmpRoot();
  const seq = seqGen();
  enqueueOutbox(root, 'p', { from: 'a', to: 'b', body: 'one' }, seq());
  assert.equal(claimOutbox(root, 'p').length, 1);
  enqueueOutbox(root, 'p', { from: 'a', to: 'b', body: 'two' }, seq());
  const second = claimOutbox(root, 'p');
  assert.equal(second.length, 1);
  assert.equal(second[0].body, 'two');
  fs.rmSync(root, { recursive: true, force: true });
});

test('origins are isolated: a claim drains only its own mailbox', () => {
  const root = tmpRoot();
  const seq = seqGen();
  enqueueOutbox(root, 'alpha', { from: 'a', to: 'x', body: 'A' }, seq());
  enqueueOutbox(root, 'beta', { from: 'a', to: 'y', body: 'B' }, seq());
  const a = claimOutbox(root, 'alpha');
  assert.deepStrictEqual(a.map((m) => m.body), ['A']);
  // beta is untouched by alpha's claim.
  assert.deepStrictEqual(claimOutbox(root, 'beta').map((m) => m.body), ['B']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('outboxHasOrigin / listOutboxOrigins reflect only non-empty mailboxes', () => {
  const root = tmpRoot();
  const seq = seqGen();
  assert.equal(outboxHasOrigin(root, 'a'), false);
  assert.deepStrictEqual(listOutboxOrigins(root), []);
  enqueueOutbox(root, 'a', { from: 'x', to: 'y', body: 'hi' }, seq());
  enqueueOutbox(root, 'b', { from: 'x', to: 'y', body: 'yo' }, seq());
  assert.equal(outboxHasOrigin(root, 'a'), true);
  assert.deepStrictEqual(listOutboxOrigins(root).sort(), ['a', 'b']);
  // Draining 'a' drops it from the advertised set; 'b' remains.
  claimOutbox(root, 'a');
  assert.equal(outboxHasOrigin(root, 'a'), false);
  assert.deepStrictEqual(listOutboxOrigins(root), ['b']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a bad origin charset is rejected by enqueue and never touches disk', () => {
  const root = tmpRoot();
  const seq = seqGen();
  const r1 = enqueueOutbox(root, 'has space', { from: 'a', to: 'b', body: 'x' }, seq());
  assert.strictEqual(r1.ok, false);
  const r2 = enqueueOutbox(root, '..', { from: 'a', to: 'b', body: 'x' }, seq());
  assert.strictEqual(r2.ok, false);
  const r3 = enqueueOutbox(root, 'a/b', { from: 'a', to: 'b', body: 'x' }, seq());
  assert.strictEqual(r3.ok, false);
  // The root has no stray dirs from the rejected writes.
  assert.deepStrictEqual(listOutboxOrigins(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('validOrigin: name charset yes, dot-entries and traversal no', () => {
  assert.equal(validOrigin('laptop2'), true);
  assert.equal(validOrigin('a.b-c_d'), true);
  assert.equal(validOrigin('.'), false);
  assert.equal(validOrigin('..'), false);
  assert.equal(validOrigin('a/b'), false);
  assert.equal(validOrigin(''), false);
  assert.equal(validOrigin('x'.repeat(65)), false);
  assert.equal(validOrigin(null), false);
});
