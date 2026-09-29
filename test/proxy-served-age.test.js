'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { stampServedAge, proxyReceivedAt } = require('../proxy-util');
const { registerIpcHandlers } = require('../ipc-handlers');
const { liveSnapshotFor, restoreSessionsForWorkspace } = require('../session-restore');

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

test('a reattached row and a restored row carry the host-relative age', async () => {
  const manager = {
    sessions: new Map(),
    async create(name) { manager.sessions.set(name, { backend: 'claude-code' }); },
    resumeCwdOf: (e) => e.cwd,
    pendingCountFor: () => 0,
    teamNameFor: () => null,
  };
  const entry = { name: 's', type: 'claude', cwd: '/w' };
  const readCtxFor = () => ({});

  const live = { linked: true, ts: Date.now() - 2000 };
  const row = liveSnapshotFor({ manager, entry, session: { name: 's' }, readCtxFor, proxyPoller: hostPoller(live) });
  assertTwoSecondsOld(row.proxy, live, 'reattach');

  const restored = { linked: true, ts: Date.now() - 2000 };
  const out = await restoreSessionsForWorkspace({
    workspaceId: 'ws1', manager, readCtxFor, proxyPoller: hostPoller(restored),
    persistence: { listForWorkspace: () => [entry] },
    maybeCompactBeforeResume: async () => {},
    log: { error: () => {} },
  });
  assert.strictEqual(out.length, 1, 'ENTER: the missing session was restored');
  assertTwoSecondsOld(out[0].proxy, restored, 'restore');
});

test('an older host payload with no ageMs is fresh at receipt', () => {
  const now = 1_000_000;
  assert.strictEqual(proxyReceivedAt({ linked: true, ts: now - HOST_AHEAD_MS }, now), now);
  assert.strictEqual(proxyReceivedAt(null, now), now);
  assert.strictEqual(stampServedAge(null), null);
  const untimed = { linked: false };
  assert.strictEqual(stampServedAge(untimed), untimed);
});
