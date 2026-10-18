'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { registerIpcHandlers } = require('../ipc-handlers');
const { createOpenRequests } = require('../open-requests');

const SEATS = [
  { name: 'here', workspaceId: 'ws-a', io: 'stream', agentType: 'claude', pending: 1, attn: { kind: 'permission', ts: 10, message: 'Bash: ls' } },
  { name: 'there', workspaceId: 'ws-b', io: 'stream', agentType: 'claude', pending: 1, attn: { kind: 'permission', ts: 20, message: 'Bash: rm -rf /' } },
];

function fixture(surface) {
  const handlers = new Map();
  const wsCalls = [];
  const replies = [];
  const notifications = { list: () => [], onChange() {} };
  const openRequests = createOpenRequests({ listSeatAttention: () => SEATS, getNotifications: () => notifications, now: () => 1 });
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, warn() {}, error() {} },
    notifications,
    openRequests,
    manager: { replyToNote: (...a) => { replies.push(a); return { ok: true }; } },
    surfaceOfSender: () => surface,
    workspaceOfSender: (e) => { wsCalls.push(e); return 'ws-a'; },
  });
  const sender = { id: 'sender' };
  return { call: (ch, ...a) => handlers.get(ch)(sender, ...a), wsCalls, replies, sender };
}

test('on a web surface requests:* pass workspaceOfSender and filter to that workspace', () => {
  const f = fixture('web');
  const snap = f.call('requests:snapshot', { limit: 5 });
  assert.deepStrictEqual(snap.requests.map((r) => r.name), ['here']);
  assert.ok(!JSON.stringify(snap).includes('rm -rf'), 'another workspace\'s tool preview never crosses');
  assert.deepStrictEqual(f.call('requests:count'), { open: 1, unread: 0 });
  assert.deepStrictEqual(f.wsCalls, [f.sender, f.sender], 'both handlers asked the sender for its workspace');
});

test('on the desktop requests:* are unscoped and never ask for a workspace', () => {
  const f = fixture('desktop');
  assert.deepStrictEqual(f.call('requests:snapshot', {}).requests.map((r) => r.name), ['here', 'there']);
  assert.deepStrictEqual(f.call('requests:count'), { open: 2, unread: 0 });
  assert.deepStrictEqual(f.wsCalls, []);
});

test('notifications:reply applies no workspace guard on any surface', () => {
  for (const [surface, tag] of [['web', '(via web)'], ['desktop', '']]) {
    const f = fixture(surface);
    assert.deepStrictEqual(f.call('notifications:reply', 'n-in-ws-b', 'yes'), { ok: true });
    assert.deepStrictEqual(f.replies, [['n-in-ws-b', 'yes', tag]]);
    assert.deepStrictEqual(f.wsCalls, [], `${surface}: the reply never consults the sender's workspace`);
  }
});
