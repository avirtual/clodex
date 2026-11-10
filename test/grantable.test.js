'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initStores } = require('../stores');
const { createSessionManager } = require('../session-manager');
const { withoutLocalOnly, withoutExecGrants } = require('../session-args');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ROOT = path.join(__dirname, '..');

function store() {
  const dir = mkTmpRoot('clx-grantable-');
  const { persistence } = initStores(dir, { log: { warn() {}, info() {}, error() {} }, registryDir: path.join(dir, 'run') });
  persistence.upsert({ name: 'lead', type: 'claude', cwd: os.tmpdir(), execCommands: ['clodex-team'] });
  return persistence;
}

test('setGrantable stores the three lists, an empty value clears it, and execCommands stay untouched', () => {
  const p = store();
  p.setGrantable('lead', { execCommands: ['avh-chat', 'avh-chat', 7], intents: ['workbench'], flags: ['--dangerously-skip-permissions'] });
  assert.deepStrictEqual(p.get('lead').grantable, { execCommands: ['avh-chat'], intents: ['workbench'], flags: ['--dangerously-skip-permissions'] });
  assert.deepStrictEqual(p.get('lead').execCommands, ['clodex-team']);
  p.upsert({ name: 'lead', label: 'L' });
  assert.deepStrictEqual(p.get('lead').grantable.execCommands, ['avh-chat']);
  p.setGrantable('lead', { execCommands: [], intents: [], flags: [] });
  assert.ok(!('grantable' in p.get('lead')));
});

test('setGrantable leaves an omitted sub-list unchanged, and null clears the field', () => {
  const p = store();
  p.setGrantable('lead', { execCommands: ['avh-chat'], intents: ['workbench'], flags: ['--dangerously-skip-permissions'] });
  p.setGrantable('lead', { intents: ['avh-select'] });
  assert.deepStrictEqual(p.get('lead').grantable, { execCommands: ['avh-chat'], intents: ['avh-select'], flags: ['--dangerously-skip-permissions'] });
  p.setGrantable('lead', null);
  assert.ok(!('grantable' in p.get('lead')));
});

test('a restart re-seeds grantable onto the record', () => {
  const upserts = [];
  const SessionManager = createSessionManager({
    knownSkillNames: () => [], os, fs, path,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ upsert: (e) => upserts.push(e), get: () => null }),
    ensureDir: () => {},
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    DEFAULT_WORKSPACE_ID: 'default',
    REGISTRY_DIR: mkTmpRoot('clx-grantable-reg-'),
  });
  const m = new SessionManager();
  m._stripClaimedTree = (e) => e;
  const grantable = { execCommands: ['avh-chat'], intents: [], flags: [] };
  m._preserveAcrossRestart('lead', { name: 'lead', grantable }, []);
  assert.deepStrictEqual(upserts, [{ name: 'lead', grantable }]);
});

test('the peer and ctl args strips drop a grantable key', () => {
  const patch = { type: 'claude', grantable: { execCommands: ['avh-chat'] } };
  assert.deepStrictEqual(withoutLocalOnly(patch), { type: 'claude' });
  assert.deepStrictEqual(withoutExecGrants(patch), { type: 'claude' });
});

test('a peer move omits grantable from the record it ships', () => {
  const src = fs.readFileSync(path.join(ROOT, 'session-manager.js'), 'utf8');
  const omit = /const MOVE_TO_PEER_OMIT = \[([^\]]*)\]/.exec(src);
  assert.ok(omit, 'ENTER: MOVE_TO_PEER_OMIT found');
  assert.ok(omit[1].includes("'grantable'"), omit[1]);
});

test('the Args dialog and the intents popover draw a may-grant toggle and save it through setSessionGrantable', () => {
  const lists = fs.readFileSync(path.join(ROOT, 'renderer', 'lib', 'checklists.js'), 'utf8');
  const rnd = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
  const pop = fs.readFileSync(path.join(ROOT, 'renderer', 'popovers', 'checklist-popovers.js'), 'utf8');
  assert.ok(lists.includes("function mayGrantToggle(value, checked, cls = 'may-grant', text = 'may grant')"));
  assert.ok(lists.includes("'may-grant-flags', 'may grant the Claude bypass flag (--dangerously-skip-permissions)'"));
  assert.ok(lists.includes("if (mayGrantSet) row.appendChild(mayGrantToggle(c.name, mayGrantSet.has(c.name)));"));
  assert.ok(lists.includes(":checked:not(.may-grant):not(.may-grant-flags)')"));
  assert.ok(rnd.includes('renderExecChecklist(argsExecList, new Set(res.execCommands || []), argsGrantable ? new Set(argsGrantable.execCommands) : null)'));
  assert.ok(rnd.includes('const gr = await window.api.setSessionGrantable(name, grantableNext);'));
  assert.ok(pop.includes('const gr = await window.api.setSessionGrantable(name, grantableNext);'));
});

test('session:setGrantable and session:grantable write and read the record through the operator IPC', () => {
  const { registerIpcHandlers } = require('../ipc-handlers');
  const handlers = new Map();
  const persistence = store();
  const stub = () => () => {};
  registerIpcHandlers(new Proxy({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    persistence,
    log: { info() {}, error() {}, warn() {} },
  }, { get(t, p) { return p in t ? t[p] : stub(); } }));
  assert.deepStrictEqual(handlers.get('session:grantable')(null, 'lead'), { ok: true, grantable: { execCommands: [], intents: [], flags: [] } });
  const set = handlers.get('session:setGrantable')(null, 'lead', { execCommands: ['avh-chat'], flags: ['--dangerously-skip-permissions'] });
  assert.deepStrictEqual(set, { ok: true, grantable: { execCommands: ['avh-chat'], intents: [], flags: ['--dangerously-skip-permissions'] } });
  assert.deepStrictEqual(persistence.get('lead').execCommands, ['clodex-team']);
  assert.deepStrictEqual(handlers.get('session:grantable')(null, 'ghost'), { ok: false, error: 'Session not found in persistence' });
});
