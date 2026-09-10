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
