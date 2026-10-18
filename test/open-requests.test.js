'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { noteKind, isReplyable, annotate, partitionNotes, coverageText, createOpenRequests } = require('../open-requests');

const AT_1852 = new Date(2026, 0, 1, 18, 52).getTime();

test('noteKind / isReplyable over literal senders', () => {
  const rows = [
    { from: 'alice', kind: 'shout', replyable: true },
    { from: 'alice@box', kind: 'shout', replyable: false },
    { from: 'plugin:ntfy', kind: 'other', replyable: false },
    { from: 'Clodex library', kind: 'other', replyable: false },
    { from: '...', kind: 'other', replyable: false },
    { from: 'plugin:ntfy@box', kind: 'other', replyable: false },
    { from: '', kind: 'other', replyable: false },
    { from: null, kind: 'other', replyable: false },
  ];
  for (const r of rows) {
    assert.strictEqual(noteKind(r.from), r.kind, `noteKind(${JSON.stringify(r.from)})`);
    assert.strictEqual(isReplyable(r.from), r.replyable, `isReplyable(${JSON.stringify(r.from)})`);
  }
});

test('annotate adds kind and replyable without dropping fields', () => {
  assert.deepStrictEqual(annotate({ id: 'n1', from: 'alice', body: 'b', createdAt: 1, readAt: null }),
    { id: 'n1', from: 'alice', body: 'b', createdAt: 1, readAt: null, kind: 'shout', replyable: true });
});

test('partitionNotes: unread shout → shouts, unread plugin note → other, read and replied shouts → resolved', () => {
  const notes = [
    { id: 'shout', from: 'alice', createdAt: 10, readAt: null },
    { id: 'plug', from: 'plugin:ntfy', createdAt: 20, readAt: null },
    { id: 'read', from: 'bob', createdAt: 30, readAt: 31 },
    { id: 'replied', from: 'bob', createdAt: 40, readAt: 41, repliedAt: 41, reply: 'ok' },
  ];
  const p = partitionNotes(notes);
  assert.deepStrictEqual(p.shouts.map((n) => n.id), ['shout'], 'ENTER: the unread shout');
  assert.deepStrictEqual(p.other.map((n) => n.id), ['plug'], 'ENTER: the unread plugin note');
  assert.deepStrictEqual(p.resolved.map((n) => n.id), ['replied', 'read'], 'ENTER: read and replied, newest first');
});

function seat(name, extra = {}) {
  return { name, workspaceId: 'w1', agentType: 'claude', io: 'pty', attn: null, pending: 0, ...extra };
}

function storeOf(notes) {
  return { list: () => notes };
}

function rig(seats, notes, now = () => AT_1852) {
  return createOpenRequests({ listSeatAttention: () => seats, getNotifications: () => storeOf(notes), now });
}

test('summary().open counts permission rows and unread shouts, excluding kind:other facts and unread other notes', () => {
  const r = rig(
    [
      seat('perm', { attn: { kind: 'permission', ts: 5, message: 'Bash: git push' } }),
      seat('stall', { attn: { kind: 'other', ts: 6, message: 'stalled' } }),
    ],
    [
      { id: 'a', from: 'alice', createdAt: 1, readAt: null },
      { id: 'b', from: 'plugin:ntfy', createdAt: 2, readAt: null },
      { id: 'c', from: 'alice', createdAt: 3, readAt: 4 },
    ],
  );
  const s = r.summary();
  assert.deepStrictEqual(s.requests.map((q) => q.name), ['perm'], 'ENTER: the permission row survives, the other fact does not');
  assert.strictEqual(s.open, 2);
  assert.strictEqual(s.at, AT_1852);
  assert.deepStrictEqual(r.count(), { open: 2, unread: 2 });
});

test('requests are sorted by ts ascending and carry the row fields', () => {
  const r = rig([
    seat('late', { attn: { kind: 'permission', ts: 300, message: 'Edit: x' } }),
    seat('early', { io: 'stream', attn: { kind: 'permission', ts: 100, message: 'Bash: ls' }, pending: 2 }),
  ], []);
  assert.deepStrictEqual(r.summary().requests, [
    { name: 'early', workspaceId: 'w1', ts: 100, message: 'Bash: ls', pending: 2 },
    { name: 'late', workspaceId: 'w1', ts: 300, message: 'Edit: x', pending: 0 },
  ]);
});

test('blindSeats are the live non-stream non-claude seats', () => {
  const r = rig([
    seat('cl', { agentType: 'claude', io: 'pty' }),
    seat('cx-term', { agentType: 'codex', io: 'pty' }),
    seat('cx-stream', { agentType: 'codex', io: 'stream' }),
    seat('mu-term', { agentType: 'muse', io: 'pty' }),
  ], []);
  assert.deepStrictEqual(r.summary().blindSeats, ['cx-term', 'mu-term']);
});

test('coverageText exact sentences', () => {
  const tail = 'not shown: seats that are busy or idle (no claim is made about them), tickets owned by a lead, exec runs';
  assert.strictEqual(coverageText({ open: 0, at: AT_1852, blindSeats: [] }), `No open requests for you · last update 18:52 · ${tail}`);
  assert.strictEqual(coverageText({ open: 1, at: AT_1852, blindSeats: [] }), `Showing 1 open request · last update 18:52 · ${tail}`);
  assert.strictEqual(coverageText({ open: 3, at: AT_1852, blindSeats: [] }), `Showing 3 open requests · last update 18:52 · ${tail}`);
  assert.strictEqual(coverageText({ open: 3, at: AT_1852, blindSeats: ['codex-2', 'muse-1'] }),
    `Showing 3 open requests · last update 18:52 · ${tail} · approval prompts on codex-2, muse-1 (terminal-mode seats report none)`);
});

test('snapshot pages resolved with hasMore under a small limit', () => {
  const notes = [1, 2, 3].map((i) => ({ id: `r${i}`, from: 'alice', createdAt: i, readAt: i + 1 }));
  const r = rig([], notes);
  const snap = r.snapshot({ limit: 2 });
  assert.deepStrictEqual(snap.resolved.items.map((n) => n.id), ['r3', 'r2']);
  assert.strictEqual(snap.resolved.hasMore, true);
  assert.strictEqual(r.snapshot({ limit: 3 }).resolved.hasMore, false);
});

test('workspaceId filter drops a foreign permission row and leaves shouts', () => {
  const r = rig([
    seat('mine', { workspaceId: 'w1', attn: { kind: 'permission', ts: 1, message: 'm' } }),
    seat('theirs', { workspaceId: 'w2', attn: { kind: 'permission', ts: 2, message: 'Bash: rm -rf x' } }),
  ], [{ id: 's', from: 'theirs', createdAt: 1, readAt: null }]);
  const snap = r.snapshot({ workspaceId: 'w1' });
  assert.deepStrictEqual(snap.requests.map((q) => q.name), ['mine']);
  assert.deepStrictEqual(snap.shouts.map((n) => n.id), ['s']);
  assert.strictEqual(snap.open, 2);
  assert.deepStrictEqual(r.snapshot().requests.map((q) => q.name), ['mine', 'theirs'], 'ENTER: unscoped sees both');
});
