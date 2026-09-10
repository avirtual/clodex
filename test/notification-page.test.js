// Run: node --test
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initStores } = require('../stores');
const { mkTmpRoot } = require('./lib/tmp-roots');

function freshNotifications(entries) {
  const userData = mkTmpRoot('notif-ud-');
  const registryDir = mkTmpRoot('notif-reg-');
  fs.writeFileSync(path.join(userData, 'notifications.json'), JSON.stringify(entries, null, 2));
  const stores = initStores(userData, { log: console, registryDir,
    resourcesDir: path.join(registryDir, '__no_seed__'),
    skillsResourcesDir: path.join(registryDir, '__no_seed_skills__'),
    envDefaultsFile: path.join(registryDir, '__no_env_defaults__.json') });
  return { notifications: stores.notifications,
    cleanup() {
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(registryDir, { recursive: true, force: true });
    } };
}

const note = (n) => ({ id: `n${n}`, from: 'a', workspaceId: null, body: `b${n}`, createdAt: n, readAt: null });
const FIVE = [note(1), note(2), note(3), note(4), note(5)];

test('page: newest-first first window of five', () => {
  const { notifications, cleanup } = freshNotifications(FIVE);
  try {
    const p = notifications.page({ limit: 2 });
    assert.deepStrictEqual(p.items.map((n) => n.createdAt), [5, 4]);
    assert.strictEqual(p.hasMore, true);
  } finally { cleanup(); }
});

test('page: before=4 takes strictly older notes', () => {
  const { notifications, cleanup } = freshNotifications(FIVE);
  try {
    const p = notifications.page({ limit: 2, before: 4 });
    assert.deepStrictEqual(p.items.map((n) => n.createdAt), [3, 2]);
    assert.strictEqual(p.hasMore, true);
  } finally { cleanup(); }
});

test('page: the last page reports hasMore false', () => {
  const { notifications, cleanup } = freshNotifications(FIVE);
  try {
    const p = notifications.page({ limit: 2, before: 2 });
    assert.deepStrictEqual(p.items.map((n) => n.createdAt), [1]);
    assert.strictEqual(p.hasMore, false);
  } finally { cleanup(); }
});

test('page: limit 0 clamps to 1', () => {
  const { notifications, cleanup } = freshNotifications(FIVE);
  try {
    const p = notifications.page({ limit: 0 });
    assert.deepStrictEqual(p.items.map((n) => n.createdAt), [5]);
    assert.strictEqual(p.hasMore, true);
  } finally { cleanup(); }
});

test('page: no options gives the newest 30 of 40', () => {
  const forty = [];
  for (let i = 1; i <= 40; i++) forty.push(note(i));
  const { notifications, cleanup } = freshNotifications(forty);
  try {
    const p = notifications.page();
    assert.strictEqual(p.items.length, 30);
    assert.strictEqual(p.items[0].createdAt, 40);
    assert.strictEqual(p.items[29].createdAt, 11);
    assert.strictEqual(p.hasMore, true);
  } finally { cleanup(); }
});

test('page: limit null falls back to the default 30, not to the clamp floor', () => {
  const forty = [];
  for (let i = 1; i <= 40; i++) forty.push(note(i));
  const { notifications, cleanup } = freshNotifications(forty);
  try {
    const p = notifications.page({ limit: null });
    assert.strictEqual(p.items.length, 30);
    assert.strictEqual(p.items[0].createdAt, 40);
    assert.strictEqual(p.items[29].createdAt, 11);
    assert.strictEqual(p.hasMore, true);
  } finally { cleanup(); }
});

test('page: limit Infinity falls back to the default 30, not to the clamp ceiling', () => {
  const forty = [];
  for (let i = 1; i <= 40; i++) forty.push(note(i));
  const { notifications, cleanup } = freshNotifications(forty);
  try {
    const p = notifications.page({ limit: Infinity });
    assert.strictEqual(p.items.length, 30);
    assert.strictEqual(p.items[0].createdAt, 40);
    assert.strictEqual(p.items[29].createdAt, 11);
    assert.strictEqual(p.hasMore, true);
  } finally { cleanup(); }
});

test('page: a numeric string limit is honoured as that number', () => {
  const forty = [];
  for (let i = 1; i <= 40; i++) forty.push(note(i));
  const { notifications, cleanup } = freshNotifications(forty);
  try {
    const p = notifications.page({ limit: '7' });
    assert.deepStrictEqual(p.items.map((n) => n.createdAt), [40, 39, 38, 37, 36, 35, 34]);
    assert.strictEqual(p.hasMore, true);
  } finally { cleanup(); }
});

// --- onChange (t806): the store is the single emitter for every surface -----
// The phone's /api/inbox routes and the six IPC handlers both mutate this store,
// and each has to move the OTHER surface's badge. These pin the literal payload
// per mutation kind, since remote.js broadcasts it verbatim as the `inbox` SSE
// frame and the app builds against that shape.

test('onChange: add emits {kind:added, id, unread, note} with the stored record', () => {
  const { notifications, cleanup } = freshNotifications([]);
  try {
    const seen = [];
    notifications.onChange((p) => seen.push(p));
    const rec = notifications.add({ from: 'agent-a', workspaceId: 'ws-1', body: 'decide' });
    assert.strictEqual(seen.length, 1, 'exactly one event per add');
    assert.deepStrictEqual(seen[0], { kind: 'added', id: rec.id, unread: 1, note: rec });
  } finally { cleanup(); }
});

test('onChange: markRead emits {kind:read, id, unread} once, and NOT on the idempotent repeat', () => {
  const { notifications, cleanup } = freshNotifications([note(1), note(2)]);
  try {
    const seen = [];
    notifications.onChange((p) => seen.push(p));
    notifications.markRead('n1');
    assert.deepStrictEqual(seen, [{ kind: 'read', id: 'n1', unread: 1 }]);
    // ENTER: the second call still returns true (the id exists) but changes
    // nothing, so a second frame would tell every phone to repaint for no change.
    assert.strictEqual(notifications.markRead('n1'), true, 'still reports the id exists');
    assert.strictEqual(seen.length, 1, 'an already-read note emits nothing');
    // An unknown id is not a mutation either.
    assert.strictEqual(notifications.markRead('nope'), false);
    assert.strictEqual(seen.length, 1, 'an unknown id emits nothing');
  } finally { cleanup(); }
});

test('onChange: markAllRead emits {kind:read-all, unread:0}, and nothing when none were unread', () => {
  const { notifications, cleanup } = freshNotifications([note(1), note(2)]);
  try {
    const seen = [];
    notifications.onChange((p) => seen.push(p));
    assert.strictEqual(notifications.markAllRead(), 2);
    assert.deepStrictEqual(seen, [{ kind: 'read-all', unread: 0 }]);
    assert.strictEqual(notifications.markAllRead(), 0);
    assert.strictEqual(seen.length, 1, 'a no-op mark-all emits nothing');
  } finally { cleanup(); }
});

test('onChange: remove emits {kind:removed, id, unread}, and nothing for an unknown id', () => {
  const { notifications, cleanup } = freshNotifications([note(1), note(2)]);
  try {
    const seen = [];
    notifications.onChange((p) => seen.push(p));
    assert.strictEqual(notifications.remove('n1'), true);
    assert.deepStrictEqual(seen, [{ kind: 'removed', id: 'n1', unread: 1 }]);
    assert.strictEqual(notifications.remove('n1'), false);
    assert.strictEqual(seen.length, 1, 'removing what is gone emits nothing');
  } finally { cleanup(); }
});

test('onChange: a throwing listener does not break the mutation or starve the next listener', () => {
  const { notifications, cleanup } = freshNotifications([]);
  try {
    const seen = [];
    notifications.onChange(() => { throw new Error('listener blew up'); });
    notifications.onChange((p) => seen.push(p.kind));
    const rec = notifications.add({ from: 'a', body: 'b' });
    assert.strictEqual(rec.readAt, null, 'add still returned its record');
    assert.deepStrictEqual(notifications.list().map((n) => n.id), [rec.id], 'and still wrote it');
    assert.deepStrictEqual(seen, ['added'], 'the second listener still ran');
  } finally { cleanup(); }
});
