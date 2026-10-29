'use strict';

const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { createMemoryStore } = require('../memory-store');

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
afterEach(() => { mock.timers.reset(); });

function rig(records) {
  const recs = new Map(Object.entries(records).map(([k, v]) => [k, { name: k, ...v }]));
  const persistence = {
    list: () => [...recs.values()],
    get: (n) => recs.get(n) || null,
    remove: (n) => { recs.delete(n); },
    upsert: (e) => { recs.set(e.name, { ...(recs.get(e.name) || {}), ...e }); },
    setArchived: (n, v) => { const r = recs.get(n); if (r) r.archivedAt = v ? Date.now() : null; },
    clearSessionId: () => {},
  };
  const memoryStore = createMemoryStore(mkTmpRoot('clodex-profile-mem-'));
  const m = mk({
    getPersistence: () => persistence, log: QUIET, memoryStore,
    REGISTRY_DIR: mkTmpRoot('clodex-profile-reg-'), ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
  });
  return { m, recs, memoryStore };
}

function seed(memoryStore, name) {
  const out = memoryStore.profileSet(name, { game: { name: 'Bob' } });
  assert.strictEqual(out.ok, true, `ENTER: a profile was written for ${name}`);
}

const ASSISTANT = { class: 'assistant', type: 'claude', cwd: '/w' };

test('destroy() of a dead seat erases its profile', async () => {
  const { m, recs, memoryStore } = rig({ asst: ASSISTANT });
  seed(memoryStore, 'asst');
  assert.deepStrictEqual(await m.destroy('asst'), { ok: true, live: false });
  assert.ok(!recs.has('asst'));
  assert.deepStrictEqual(memoryStore.profileGet('asst'), { ok: true, profile: null });
});

test('forgetSeatFiles on an assistant record erases its profile', () => {
  const { m, memoryStore } = rig({ asst: ASSISTANT });
  seed(memoryStore, 'asst');
  m.forgetSeatFiles('asst', { name: 'asst', ...ASSISTANT });
  assert.deepStrictEqual(memoryStore.profileGet('asst'), { ok: true, profile: null });
});

test('a respawn kill and a sleep keep the profile', async () => {
  const { m, recs, memoryStore } = rig({ re: ASSISTANT, nap: ASSISTANT });
  seed(memoryStore, 're');
  seed(memoryStore, 'nap');
  let streamKills = 0;
  for (const name of ['re', 'nap']) {
    m.sessions.set(name, { name, agentType: 'claude', io: 'stream', stream: { kill: () => { streamKills += 1; } } });
  }
  await m.kill('re', { respawn: true });
  assert.ok(recs.has('re'), 'ENTER: the respawn kept the record');
  const slept = await m.sleep('nap');
  assert.deepStrictEqual(slept, { ok: true, state: 'asleep' });
  assert.strictEqual(streamKills, 2, 'ENTER: both seats were stopped');
  assert.deepStrictEqual(memoryStore.profileGet('re').profile, { game: { name: 'Bob' }, notes: {} });
  assert.deepStrictEqual(memoryStore.profileGet('nap').profile, { game: { name: 'Bob' }, notes: {} });
});
