'use strict';
// web-notify.test.js — the browser frontend's OS-notification leaf (web-frontend
// Phase 5, Chunk 3). Guards the pure notice-builders (title/body/tag from an
// attention or mention event), the "(N)" title-badge string, and the injectable
// Notification wrapper's permission-asked-once + granted-gate behaviour. All
// pure/injected — no real Notification, no DOM.

const test = require('node:test');
const assert = require('node:assert');
const { attentionNotice, mentionNotice, badgeTitle, createWebNotifier } = require('../renderer/lib/web-notify');

test('attentionNotice distinguishes a permission block from a plain one, keyed by session', () => {
  const perm = attentionNotice('agent-x', { kind: 'permission', message: 'Allow write?' });
  assert.equal(perm.title, 'agent-x needs permission');
  assert.equal(perm.body, 'Allow write?');
  assert.equal(perm.tag, 'clx-attn-agent-x', 'one coalescing tag per session');

  const other = attentionNotice('agent-x', { kind: 'other' });
  assert.equal(other.title, 'agent-x needs you');
  assert.equal(other.body, 'Wants your attention.', 'falls back when no message');
});

test('mentionNotice reads as a DM vs a plain mention', () => {
  assert.deepEqual(mentionNotice('bob', 'dm'), { title: 'bob', body: 'sent you a direct message', tag: 'clx-mention-bob' });
  assert.equal(mentionNotice('bob', undefined).body, 'mentioned you');
});

test('badgeTitle prefixes a positive count and is invisible at zero', () => {
  assert.equal(badgeTitle('Clodex (2 sessions)', 3), '(3) Clodex (2 sessions)');
  assert.equal(badgeTitle('Clodex', 0), 'Clodex');
  assert.equal(badgeTitle('', 1), '(1) Clodex', 'defaults the base');
});

// A fake Notification: constructable (records the last instance), with the
// static permission/requestPermission surface the wrapper reads.
function fakeNotification(permission) {
  let asks = 0;
  const F = function (title, opts) { F.last = { title, opts }; };
  F.permission = permission;
  F.requestPermission = () => { asks++; return Promise.resolve('granted'); };
  F.asks = () => asks;
  return F;
}

test('ensurePermission asks exactly once, and only from the default state', async () => {
  const F = fakeNotification('default');
  const n = createWebNotifier({ Notification: F });
  n.ensurePermission();
  n.ensurePermission();
  assert.equal(F.asks(), 1, 'idempotent — asked once despite repeated gestures');

  const G = fakeNotification('granted');
  createWebNotifier({ Notification: G }).ensurePermission();
  assert.equal(G.asks(), 0, 'already-granted needs no prompt');
});

test('raise builds a Notification only when granted', () => {
  const denied = fakeNotification('denied');
  assert.equal(createWebNotifier({ Notification: denied }).raise(mentionNotice('a', 'dm')), null,
    'no notification while permission is denied');

  const granted = fakeNotification('granted');
  const n = createWebNotifier({ Notification: granted });
  n.raise(attentionNotice('a', { kind: 'permission', message: 'ok?' }));
  assert.deepEqual(granted.last, { title: 'a needs permission', opts: { body: 'ok?', tag: 'clx-attn-a' } });
});

test('the whole wrapper is a safe no-op when Notification is unavailable', () => {
  const n = createWebNotifier({ Notification: null });
  assert.doesNotThrow(() => n.ensurePermission());
  assert.equal(n.raise(mentionNotice('a', 'dm')), null);
});
