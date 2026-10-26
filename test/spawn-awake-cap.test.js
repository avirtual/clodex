'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createSessionManager } = require('../session-manager');
const { mkTmpRoot } = require('./lib/tmp-roots');

function harness(records) {
  const calls = [];
  const replies = [];
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    os, fs, path,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ get: (n) => records[n] || null, list: () => Object.values(records), upsert() {}, setStripLevel() {}, setAutoCompact() {} }),
    withoutPrivilegedIntentsFor: (x) => x,
    ensureDir: () => {},
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    DEFAULT_WORKSPACE_ID: 'default',
  });
  const m = new SessionManager();
  m.sessions = new Map();
  m._injectText = (_s, t) => replies.push(t);
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._applyTemplatePersistence = () => {};
  m.create = async (...args) => { calls.push(args); return undefined; };
  const dir = mkTmpRoot('clx-awake-cap-');
  const tmpl = path.join(dir, 'avh-tpl.json');
  fs.writeFileSync(tmpl, JSON.stringify({ name: 'avh-tpl', type: 'claude', cwd: dir, class: 'assistant', sleep: { maxAwake: 1 } }));
  return { m, calls, replies, tmpl };
}

const SPAWNER = { name: 'lead', cwd: os.tmpdir(), workspaceId: 'default', type: 'claude' };
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

test('[agent:spawn] of an assistant template at its maxAwake, the awake seat busy, is refused at capacity and spawns nothing', async () => {
  const h = harness({ 'avh-1': { name: 'avh-1', class: 'assistant', template: 'avh-tpl' } });
  h.m.sessions.set('avh-1', { name: 'avh-1', streamBusy: true, activityTs: 1 });
  h.m._handleSpawnIntent(SPAWNER, { name: 'avh-2', template: h.tmpl });
  await flush();
  assert.deepStrictEqual(h.calls, []);
  assert.deepStrictEqual(h.replies, ['[agent:spawn] error: at capacity — retry in 30s']);
});

test('[agent:spawn] of an assistant template with room reserves once and releases after create; awakeHeld skips the reservation', async () => {
  const h = harness({});
  const rooms = [];
  const releases = [];
  const realRoom = h.m.makeAwakeRoom.bind(h.m);
  h.m.makeAwakeRoom = (...a) => { rooms.push(a); return realRoom(...a); };
  const realRelease = h.m.releaseAwakeRoom.bind(h.m);
  h.m.releaseAwakeRoom = (...a) => { releases.push([...a, h.calls.length]); return realRelease(...a); };
  h.m._handleSpawnIntent(SPAWNER, { name: 'avh-2', template: h.tmpl });
  await flush();
  assert.strictEqual(h.calls.length, 1, 'ENTER: it spawned');
  assert.deepStrictEqual(rooms, [['avh-tpl', 1, 'avh-2']]);
  assert.deepStrictEqual(releases, [['avh-tpl', 'avh-2', 1]]);
  assert.strictEqual(h.m._awakeReserved.size, 0);
  h.m._handleSpawnIntent(SPAWNER, { name: 'avh-3', template: h.tmpl }, { awakeHeld: true, onReply: () => {} });
  await flush();
  assert.strictEqual(h.calls.length, 2);
  assert.deepStrictEqual(rooms.length, 1, 'a held room is not reserved twice');
});
