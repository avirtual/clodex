'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createPluginHostEngine } = require('../plugin-host-engine');
const { HOST_API_VERSION } = require('../plugin-api');
const { createRemindScheduler } = require('../remind-scheduler');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ENGINE_PATH = require.resolve('../plugins/reminders-viewer/engine');

function fileStore(file) {
  const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
  const save = (all) => fs.writeFileSync(file, JSON.stringify(all, null, 2));
  return {
    list: load,
    get: (id) => load().find((r) => r.id === id) || null,
    listForAgent: (agent) => load().filter((r) => r.agent === agent),
    remove: (id) => { const all = load(); save(all.filter((r) => r.id !== id)); return all.some((r) => r.id === id); },
  };
}

const rec = (over) => ({
  kind: 'every', spec: 'every 30m', body: 'check the board', nextFireAt: 1800000000000,
  createdAt: 1700000000000, lastFiredAt: null, ...over,
});

function boot({ records, live = [], saved = [], libraryKinds } = {}) {
  const dir = mkTmpRoot('clodex-rv-data-');
  const file = path.join(dir, 'reminders.json');
  if (records !== undefined) fs.writeFileSync(file, typeof records === 'string' ? records : JSON.stringify(records));
  const sessions = new Map(live.map((s) => [s.name, s]));
  const calls = { listAll: 0, saved: [] };
  const manager = {
    sessions,
    list: () => { calls.listAll += 1; return [...sessions.values()]; },
    listForWorkspace: (wsId) => [...sessions.values()].filter((s) => s.workspaceId === wsId),
    savedForWorkspace: (wsId) => { calls.saved.push(wsId); return saved.filter((e) => e.workspaceId === wsId); },
    _broadcast() {}, _sendToSession() {}, windowForWorkspace: () => null,
  };
  const sched = createRemindScheduler({
    now: () => 1700000000000, setTimer: () => null, clearTimer: () => {},
    store: fileStore(file), deliver: () => {},
  });
  const removals = [];
  const kinds = libraryKinds || {
    reminder: (ref) => {
      removals.push(ref);
      const ok = sched.cancel(ref.agent, ref.id);
      return ok ? { ok: true } : { ok: false, error: 'no such reminder for that agent' };
    },
  };
  const host = createPluginHostEngine({
    manager,
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    log: { info: () => {}, error: () => {} },
    userDataPath: dir,
    fs, path,
    gitWorktree: {},
    libraryKinds: kinds,
  });
  delete require.cache[ENGINE_PATH];
  host.register('reminders-viewer', require(ENGINE_PATH), { hostApi: HOST_API_VERSION });
  const cleanup = () => { fs.rmSync(dir, { recursive: true, force: true }); };
  return { host, file, removals, calls, cleanup };
}

const LIVE = [
  { name: 'lead', type: 'claude', cwd: '/r', workspaceId: 'ws-1' },
  { name: 'stranger', type: 'claude', cwd: '/x', workspaceId: 'ws-2' },
];
const SAVED = [
  { name: 'sleeper', type: 'claude', cwd: '/r', workspaceId: 'ws-1', env: { SECRET: 'x' } },
  { name: 'far', type: 'claude', cwd: '/x', workspaceId: 'ws-2' },
];

test('reminders-viewer: list returns only the asked workspace, live and saved seats, never via listAll', async () => {
  const { host, calls, cleanup } = boot({
    live: LIVE, saved: SAVED,
    records: [
      rec({ id: 'aaa111', agent: 'lead', ticket: 't9' }),
      rec({ id: 'bbb222', agent: 'sleeper', kind: 'oncompact', spec: 'on compact', nextFireAt: null }),
      rec({ id: 'ccc333', agent: 'stranger' }),
      rec({ id: 'ddd444', agent: 'far' }),
      rec({ id: 'eee555', agent: 'nobody' }),
    ],
  });
  try {
    const res = await host.dispatch('reminders-viewer', 'list', ['ws-1'], 'desktop');
    assert.deepStrictEqual(res, {
      ok: true,
      rows: [
        { id: 'aaa111', agent: 'lead', kind: 'every', spec: 'every 30m', body: 'check the board', nextFireAt: 1800000000000, createdAt: 1700000000000, lastFiredAt: null, ticket: 't9', live: true },
        { id: 'bbb222', agent: 'sleeper', kind: 'oncompact', spec: 'on compact', body: 'check the board', nextFireAt: null, createdAt: 1700000000000, lastFiredAt: null, ticket: null, live: false },
      ],
    });
    assert.deepStrictEqual(calls.saved, ['ws-1']);
    assert.strictEqual(calls.listAll, 0);
  } finally { cleanup(); }
});

test('reminders-viewer: list without a workspace id is refused, a missing file is empty, a corrupt one is an error', async () => {
  const a = boot({ live: LIVE });
  try {
    assert.deepStrictEqual(await a.host.dispatch('reminders-viewer', 'list', [], 'desktop'), { ok: false, error: 'a workspace id is required' });
    assert.deepStrictEqual(await a.host.dispatch('reminders-viewer', 'list', ['ws-1'], 'desktop'), { ok: true, rows: [] });
  } finally { a.cleanup(); }
  const b = boot({ live: LIVE, records: '{not json' });
  try {
    assert.deepStrictEqual(await b.host.dispatch('reminders-viewer', 'list', ['ws-1'], 'desktop'), { ok: false, error: 'reminders.json could not be read' });
  } finally { b.cleanup(); }
});

test('reminders-viewer: cancel routes agent+id to library.remove and the record leaves the file', async () => {
  const { host, file, removals, cleanup } = boot({
    live: LIVE, records: [rec({ id: 'aaa111', agent: 'lead' }), rec({ id: 'zzz999', agent: 'lead' })],
  });
  try {
    const res = await host.dispatch('reminders-viewer', 'cancel', [{ agent: 'lead', id: 'aaa111' }], 'desktop');
    assert.deepStrictEqual(res, { ok: true });
    assert.deepStrictEqual(removals, [{ agent: 'lead', id: 'aaa111' }]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((r) => r.id), ['zzz999']);
  } finally { cleanup(); }
});

test('reminders-viewer: a foreign-agent cancel is refused by the scheduler and the record survives', async () => {
  const { host, file, removals, cleanup } = boot({ live: LIVE, records: [rec({ id: 'aaa111', agent: 'lead' })] });
  try {
    const res = await host.dispatch('reminders-viewer', 'cancel', [{ agent: 'stranger', id: 'aaa111' }], 'desktop');
    assert.deepStrictEqual(res, { ok: false, error: 'no such reminder for that agent', gone: false });
    assert.deepStrictEqual(removals, [{ agent: 'stranger', id: 'aaa111' }]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((r) => r.id), ['aaa111']);
  } finally { cleanup(); }
});

test('reminders-viewer: cancelling an already-gone row reports gone', async () => {
  const { host, cleanup } = boot({ live: LIVE, records: [] });
  try {
    const res = await host.dispatch('reminders-viewer', 'cancel', [{ agent: 'lead', id: 'aaa111' }], 'desktop');
    assert.deepStrictEqual(res, { ok: false, error: 'no such reminder for that agent', gone: true });
  } finally { cleanup(); }
});

test('reminders-viewer: malformed cancel refs never reach the library seam', async () => {
  const { host, removals, cleanup } = boot({ live: LIVE, records: [] });
  try {
    assert.deepStrictEqual(await host.dispatch('reminders-viewer', 'cancel', [{ agent: '..', id: 'aaa111' }], 'desktop'),
      { ok: false, error: 'a valid agent name is required' });
    assert.deepStrictEqual(await host.dispatch('reminders-viewer', 'cancel', [{ agent: 'lead', id: '../x' }], 'desktop'),
      { ok: false, error: 'a valid reminder id is required' });
    assert.deepStrictEqual(removals, []);
  } finally { cleanup(); }
});

test('host.sessions.listSavedWorkspace projects saved records to name/type/cwd/workspaceId', () => {
  const { host, cleanup } = boot({ live: LIVE, saved: SAVED });
  try {
    const h = host.register('probe', { activate() {} }, { hostApi: HOST_API_VERSION });
    assert.deepStrictEqual(h.sessions.listSavedWorkspace('ws-1'),
      [{ name: 'sleeper', type: 'claude', cwd: '/r', workspaceId: 'ws-1' }]);
  } finally { cleanup(); }
});

test('engine.js wires the reminder library kind to remindScheduler.cancel, after the scheduler exists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  const kinds = src.match(/libraryKinds: \{([\s\S]*?)\n {8}\},\n/);
  assert.ok(kinds, 'libraryKinds block found');
  assert.match(kinds[1], /reminder: \(ref\) => \{\s*const ok = remindScheduler\.cancel\(ref\.agent, ref\.id\);\s*return ok \? \{ ok: true \} : \{ ok: false, error: 'no such reminder for that agent' \};/);
  const built = src.indexOf('remindScheduler = createRemindScheduler(');
  const host = src.indexOf('pluginHost = createPluginHostEngine(');
  assert.ok(built !== -1 && host !== -1 && built < host, 'the scheduler is built before the plugin host');
});
