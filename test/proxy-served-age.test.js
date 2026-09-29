'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert');
const { stampServedAge, proxyReceivedAt } = require('../proxy-util');
const { registerIpcHandlers } = require('../ipc-handlers');
const { restoreSessionsForWorkspace } = require('../session-restore');

const HOST_AHEAD_MS = 60000;

function hostPoller(rec) {
  const last = new Map([['s', rec]]);
  return { last, snapshot: (name) => last.get(name) || null };
}

function rendererAgeMs(served) {
  const rendererNow = Date.now() - HOST_AHEAD_MS;
  return rendererNow - proxyReceivedAt(served, rendererNow);
}

function assertTwoSecondsOld(served, rec, label) {
  assert.notStrictEqual(served, rec, `${label}: the served payload is a copy`);
  assert.ok(!('ageMs' in rec), `${label}: the cached record is not mutated`);
  const age = rendererAgeMs(served);
  assert.ok(age >= 2000 && age < 3000, `${label}: a host 60s ahead serving a 2s-old payload reads ${age}ms`);
}

test('proxy:snapshot serves a host-relative age on a copy of the cached record', () => {
  const rec = { linked: true, ts: Date.now() - 2000 };
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    proxyPoller: hostPoller(rec),
    workspaceOfSender: () => 'ws-1',
    log: { info() {}, error() {} },
  });
  assertTwoSecondsOld(handlers.get('proxy:snapshot')(null, 's'), rec, 'snapshot');
});

function restoreManager(onCreate = () => {}) {
  const manager = {
    sessions: new Map(),
    async create(name) { onCreate(name); manager.sessions.set(name, { backend: 'claude-code' }); },
    resumeCwdOf: (e) => e.cwd,
    pendingCountFor: () => 0,
    teamNameFor: () => null,
  };
  return manager;
}

function restoreArgs(manager, entries, poller) {
  return {
    workspaceId: 'ws1', manager, readCtxFor: () => ({}), proxyPoller: poller,
    persistence: { listForWorkspace: () => entries },
    maybeCompactBeforeResume: async () => {},
    log: { error: () => {} },
  };
}

test('a reattached row and a restored row carry the host-relative age', async () => {
  const manager = restoreManager();
  manager.sessions.set('s', { name: 's' });
  const live = { linked: true, ts: Date.now() - 2000 };
  const reattached = await restoreSessionsForWorkspace(
    restoreArgs(manager, [{ name: 's', type: 'claude', cwd: '/w' }], hostPoller(live)));
  assert.strictEqual(reattached.length, 1, 'ENTER: the live session was reattached');
  assertTwoSecondsOld(reattached[0].proxy, live, 'reattach');

  const restored = { linked: true, ts: Date.now() - 2000 };
  const out = await restoreSessionsForWorkspace(
    restoreArgs(restoreManager(), [{ name: 's', type: 'claude', cwd: '/w' }], hostPoller(restored)));
  assert.strictEqual(out.length, 1, 'ENTER: the missing session was restored');
  assertTwoSecondsOld(out[0].proxy, restored, 'restore');
});

test('every row is aged when the batch returns, not when it was built', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    const SLOW_CREATE_MS = 5000;
    const recs = new Map(['live', 'early', 'slow'].map((n) => [n, { linked: true, ts: Date.now() - 2000 }]));
    const manager = restoreManager((name) => { if (name === 'slow') mock.timers.tick(SLOW_CREATE_MS); });
    manager.sessions.set('live', { name: 'live' });
    const entries = ['live', 'early', 'slow'].map((name) => ({ name, type: 'claude', cwd: '/w' }));
    const out = await restoreSessionsForWorkspace(
      restoreArgs(manager, entries, { snapshot: (n) => recs.get(n) || null }));
    assert.deepStrictEqual(out.map((r) => r.name), ['live', 'early', 'slow'], 'ENTER: all three rows came back');
    for (const r of out) {
      assert.strictEqual(r.proxy.ageMs, 2000 + SLOW_CREATE_MS, `${r.name}: aged at return, after the slow create`);
      assert.ok(!('ageMs' in recs.get(r.name)), `${r.name}: the cached record is not mutated`);
    }
  } finally {
    mock.timers.reset();
  }
});

test('an older host payload with no ageMs is fresh at receipt', () => {
  const now = 1_000_000;
  assert.strictEqual(proxyReceivedAt({ linked: true, ts: now - HOST_AHEAD_MS }, now), now);
  assert.strictEqual(proxyReceivedAt(null, now), now);
  assert.strictEqual(stampServedAge(null), null);
  const untimed = { linked: false };
  assert.strictEqual(stampServedAge(untimed), untimed);
});
