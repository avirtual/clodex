'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mk } = require('./lib/session-fixtures');

function fakeStore(notes) {
  const calls = [];
  return {
    calls,
    list: () => notes,
    markReplied(id, reply) {
      calls.push(['markReplied', id, reply]);
      const rec = notes.find((n) => n.id === id);
      if (!rec) return false;
      if (rec.readAt == null) rec.readAt = 500;
      rec.repliedAt = 500;
      rec.reply = reply;
      return rec;
    },
  };
}

function rig({ notes = [], remote = null } = {}) {
  const store = fakeStore(notes);
  const m = mk({
    getNotifications: () => store,
    getRemoteServer: () => remote,
    registry: { unregister: () => {} },
    cleanupClaudeHook: () => {}, cleanupSkills: () => {}, cleanupAgentPlugin: () => {},
    path, fs,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  const broadcasts = [];
  const sent = [];
  const order = [];
  m._broadcast = (ch, ...a) => { broadcasts.push([ch, ...a]); };
  m._sendToSession = (name, ch, ...a) => { sent.push([name, ch, ...a]); };
  const delivered = [];
  m._deliverMessage = (...a) => { order.push('deliver'); delivered.push(a); };
  const origMark = store.markReplied.bind(store);
  store.markReplied = (...a) => { order.push('stamp'); return origMark(...a); };
  return { m, store, broadcasts, sent, delivered, order };
}

const PERM = { kind: 'permission', ts: 7, message: 'Bash: git push' };

test('_setAttention broadcasts attention:changed on set and null on clear, keeps session-attention, notifies the remote', () => {
  const remoteCalls = [];
  const { m, broadcasts, sent } = rig({ remote: { notifyAttention: (...a) => remoteCalls.push(a) } });
  const s = { name: 'alice', agentType: 'claude', workspaceId: 'w1', _dead: true };
  m.sessions.set('alice', s);
  m._setAttention(s, PERM);
  m._setAttention(s, null);
  assert.deepStrictEqual(broadcasts, [
    ['attention:changed', { name: 'alice', workspaceId: 'w1', attn: PERM }],
    ['attention:changed', { name: 'alice', workspaceId: 'w1', attn: null }],
  ]);
  assert.deepStrictEqual(sent, [
    ['alice', 'session-attention', 'alice', PERM],
    ['alice', 'session-attention', 'alice', null],
  ]);
  assert.deepStrictEqual(remoteCalls, [['alice', 'w1', PERM], ['alice', 'w1', null]]);
});

test('_cleanup of a seat holding a fact broadcasts the clear before the seat leaves the map', () => {
  const { m, broadcasts } = rig();
  const s = { name: 'alice', agentType: 'claude', workspaceId: 'w1', _dead: true, needsAttention: PERM };
  m.sessions.set('alice', s);
  let inMapAtClear = null;
  m._broadcast = (ch, ...a) => { broadcasts.push([ch, ...a]); if (ch === 'attention:changed') inMapAtClear = m.sessions.has('alice'); };
  m._cleanup('alice');
  assert.deepStrictEqual(broadcasts.filter((b) => b[0] === 'attention:changed'),
    [['attention:changed', { name: 'alice', workspaceId: 'w1', attn: null }]]);
  assert.strictEqual(inMapAtClear, true);
  assert.strictEqual(m.sessions.has('alice'), false);
});

test('_cleanup of a seat with no fact broadcasts nothing', () => {
  const { m, broadcasts } = rig();
  m.sessions.set('bob', { name: 'bob', agentType: 'claude', workspaceId: 'w1', _dead: true, needsAttention: null });
  m._cleanup('bob');
  assert.deepStrictEqual(broadcasts.filter((b) => b[0] === 'attention:changed'), []);
});

test('listSeatAttention excludes dead, clone and non-agent seats and reports pending', () => {
  const { m } = rig();
  m.sessions.set('live', { name: 'live', agentType: 'claude', workspaceId: 'w1', io: 'stream', needsAttention: { ...PERM, extra: 1 }, streamPermissions: new Map([['a', {}], ['b', {}]]) });
  m.sessions.set('idle', { name: 'idle', agentType: 'codex', workspaceId: 'w2' });
  m.sessions.set('dead', { name: 'dead', agentType: 'claude', _dead: true, needsAttention: PERM });
  m.sessions.set('clone', { name: 'clone', agentType: 'claude', clone: true, needsAttention: PERM });
  m.sessions.set('sh', { name: 'sh', type: 'bash' });
  assert.deepStrictEqual(m.listSeatAttention(), [
    { name: 'live', workspaceId: 'w1', agentType: 'claude', io: 'stream', attn: PERM, pending: 2 },
    { name: 'idle', workspaceId: 'w2', agentType: 'codex', io: 'pty', attn: null, pending: 0 },
  ]);
});

function shout(extra = {}) {
  return { id: 'n1', from: 'alice', workspaceId: 'w1', body: 'need a decision\nmore', createdAt: new Date(2026, 0, 1, 9, 5).getTime(), readAt: null, ...extra };
}

test('replyToNote refuses an unknown id, an empty reply and a non-replyable sender without touching the note', () => {
  const plugin = shout({ id: 'p1', from: 'plugin:ntfy' });
  const { m, store, delivered } = rig({ notes: [shout(), plugin] });
  m.sessions.set('alice', { name: 'alice', agentType: 'claude' });
  assert.strictEqual(m.replyToNote('nope', 'hi').code, 'unknown');
  assert.strictEqual(m.replyToNote('n1', '   ').code, 'empty');
  assert.strictEqual(m.replyToNote('n1', 'x'.repeat(16 * 1024 + 1)).code, 'too-long');
  assert.strictEqual(m.replyToNote('p1', 'hi').code, 'not-replyable');
  assert.deepStrictEqual(delivered, []);
  assert.deepStrictEqual(store.calls, []);
  assert.strictEqual(plugin.readAt, null);
});

test('replyToNote refuses a gone seat (absent, dead, clone, streamless stream) and leaves the note unread', () => {
  const cases = [
    null,
    { name: 'alice', agentType: 'claude', _dead: true },
    { name: 'alice', agentType: 'claude', clone: true },
    { name: 'alice', agentType: 'claude', io: 'stream', stream: null },
  ];
  for (const s of cases) {
    const note = shout();
    const { m, store, delivered } = rig({ notes: [note] });
    if (s) m.sessions.set('alice', s);
    const r = m.replyToNote('n1', 'go ahead');
    assert.deepStrictEqual(r, { ok: false, code: 'gone', error: 'alice is no longer running' });
    assert.deepStrictEqual(delivered, []);
    assert.deepStrictEqual(store.calls, []);
    assert.strictEqual(note.readAt, null);
  }
});

test('replyToNote delivers the operator dm first, then stamps the note, and stamps operator input', () => {
  const note = shout();
  const { m, delivered, order } = rig({ notes: [note] });
  m.sessions.set('alice', { name: 'alice', agentType: 'claude' });
  m._lastOperatorInputAt = 0;
  const r = m.replyToNote('n1', '  go ahead  ', '(via web)');
  assert.deepStrictEqual(order, ['deliver', 'stamp']);
  assert.deepStrictEqual(delivered, [['alice', 'user', 'go ahead\n> replying to your shout from 09:05: need a decision', 'dm', '(via web)']]);
  assert.deepStrictEqual(r, { ok: true, id: 'n1', repliedAt: 500 });
  assert.strictEqual(note.readAt, 500);
  assert.strictEqual(note.repliedAt, 500);
  assert.strictEqual(note.reply, 'go ahead');
  assert.ok(m._lastOperatorInputAt > 0);
});

test('replyToNote: a delivery that throws leaves the note untouched', () => {
  const note = shout();
  const { m, store } = rig({ notes: [note] });
  m.sessions.set('alice', { name: 'alice', agentType: 'claude' });
  m._deliverMessage = () => { throw new Error('boom'); };
  const r = m.replyToNote('n1', 'go ahead');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'delivery');
  assert.deepStrictEqual(store.calls, []);
  assert.deepStrictEqual(note, shout());
});

test('replyToNote: a stamp failure after delivery reports ok with a warning', () => {
  const { m, store } = rig({ notes: [shout()] });
  m.sessions.set('alice', { name: 'alice', agentType: 'claude' });
  store.markReplied = () => { throw new Error('disk full'); };
  assert.deepStrictEqual(m.replyToNote('n1', 'go ahead'),
    { ok: true, id: 'n1', repliedAt: null, warn: 'delivered, but the note could not be marked resolved' });
});
