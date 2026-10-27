'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createPluginHostEngine } = require('../plugin-host-engine');
const { HOST_API_VERSION } = require('../plugin-api');
const { createRemindScheduler, reminderLibraryKinds } = require('../remind-scheduler');
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
    markFired: (id, at, next) => { save(load().map((r) => (r.id === id ? { ...r, lastFiredAt: at, nextFireAt: next } : r))); },
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
  const adds = [];
  const prod = reminderLibraryKinds({ scheduler: sched, seatExists: () => true });
  const kinds = libraryKinds || {
    reminder: (ref) => { removals.push(ref); return prod.remove(ref); },
  };
  const addKinds = {
    reminder: (ref, payload) => { adds.push({ ref, payload }); return { ok: true, id: 'new111' }; },
  };
  const fires = [];
  const fireKinds = {
    reminder: (ref) => { fires.push(ref); return prod.fire(ref); },
  };
  const host = createPluginHostEngine({
    manager,
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    log: { info: () => {}, error: () => {} },
    userDataPath: dir,
    fs, path,
    gitWorktree: {},
    libraryKinds: kinds,
    libraryAddKinds: addKinds,
    libraryFireKinds: fireKinds,
  });
  delete require.cache[ENGINE_PATH];
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'reminders-viewer', 'manifest.json'), 'utf8'));
  host.register('reminders-viewer', require(ENGINE_PATH), { ...manifest, hostApi: HOST_API_VERSION });
  const cleanup = () => { fs.rmSync(dir, { recursive: true, force: true }); };
  return { host, file, removals, adds, fires, calls, cleanup };
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

test('reminders-viewer: cancel is desktop-only; the manifest lists every other method as any', async () => {
  const { host, removals, cleanup } = boot({ live: LIVE, records: [rec({ id: 'aaa111', agent: 'lead' })] });
  try {
    assert.deepStrictEqual(await host.dispatch('reminders-viewer', 'cancel', [{ agent: 'lead', id: 'aaa111' }], 'web'),
      { ok: false, error: 'plugin method not available on this surface' });
    assert.deepStrictEqual(removals, []);
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'reminders-viewer', 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(manifest.surfaces, { list: 'any', seats: 'any', add: 'any', fire: 'any' });
  } finally { cleanup(); }
});

test('reminders-viewer: the panel cancels an operator-set row its seat cannot', async () => {
  const { host, file, removals, cleanup } = boot({ live: LIVE, records: [rec({ id: 'aaa111', agent: 'lead', by: 'operator' })] });
  try {
    const res = await host.dispatch('reminders-viewer', 'cancel', [{ agent: 'lead', id: 'aaa111' }], 'desktop');
    assert.deepStrictEqual(res, { ok: true });
    assert.deepStrictEqual(removals, [{ agent: 'lead', id: 'aaa111' }]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
  } finally { cleanup(); }
});

test('reminders-viewer: list marks an operator-set row with by', async () => {
  const { host, cleanup } = boot({ live: LIVE, records: [rec({ id: 'aaa111', agent: 'lead', by: 'operator' })] });
  try {
    const res = await host.dispatch('reminders-viewer', 'list', ['ws-1'], 'desktop');
    assert.deepStrictEqual(res.rows.map((r) => [r.id, r.by]), [['aaa111', 'operator']]);
  } finally { cleanup(); }
});

test('reminders-viewer: add routes agent + { spec, body } to library.add; a bad agent, missing workspace or foreign seat never reaches it', async () => {
  const { host, adds, cleanup } = boot({ live: LIVE, records: [] });
  try {
    assert.deepStrictEqual(await host.dispatch('reminders-viewer', 'add', [{ wsId: 'ws-1', agent: '..', spec: 'every 1h', body: 'x' }], 'desktop'),
      { ok: false, error: 'a valid agent name is required' });
    assert.deepStrictEqual(await host.dispatch('reminders-viewer', 'add', [{ agent: 'lead', spec: 'every 1h', body: 'x' }], 'desktop'),
      { ok: false, error: 'a workspace id is required' });
    assert.deepStrictEqual(await host.dispatch('reminders-viewer', 'add', [{ wsId: 'ws-1', agent: 'stranger', spec: 'every 1h', body: 'x' }], 'desktop'),
      { ok: false, error: 'no such seat' });
    assert.deepStrictEqual(adds, []);
    const res = await host.dispatch('reminders-viewer', 'add', [{ wsId: 'ws-1', agent: 'lead', spec: ' every 1h ', body: '[agent:context clear] Fresh start' }], 'desktop');
    assert.deepStrictEqual(res, { ok: true, id: 'new111' });
    assert.deepStrictEqual(adds, [{ ref: { agent: 'lead' }, payload: { spec: 'every 1h', body: '[agent:context clear] Fresh start' } }]);
  } finally { cleanup(); }
});

test('reminders-viewer: seats lists the workspace seats, live first then saved', async () => {
  const { host, cleanup } = boot({ live: LIVE, saved: SAVED });
  try {
    assert.deepStrictEqual(await host.dispatch('reminders-viewer', 'seats', ['ws-1'], 'desktop'),
      { ok: true, seats: [{ name: 'lead', live: true }, { name: 'sleeper', live: false }] });
  } finally { cleanup(); }
});

test('reminders-viewer: cancelling an already-gone row reports gone', async () => {
  const { host, cleanup } = boot({ live: LIVE, records: [] });
  try {
    const res = await host.dispatch('reminders-viewer', 'cancel', [{ agent: 'lead', id: 'aaa111' }], 'desktop');
    assert.deepStrictEqual(res, { ok: false, error: 'no such reminder', gone: true });
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

test('reminders-viewer: fire routes agent+id to library.fire and passes kept through', async () => {
  const { host, file, fires, cleanup } = boot({
    live: LIVE, records: [rec({ id: 'aaa111', agent: 'lead' }), rec({ id: 'bbb222', agent: 'lead', kind: 'in', spec: 'in 5m', nextFireAt: 1700000300000 })],
  });
  try {
    assert.deepStrictEqual(await host.dispatch('reminders-viewer', 'fire', [{ agent: 'lead', id: 'aaa111' }], 'desktop'), { ok: true, kept: true });
    assert.deepStrictEqual(await host.dispatch('reminders-viewer', 'fire', [{ agent: 'lead', id: 'bbb222' }], 'desktop'), { ok: true, kept: false });
    assert.deepStrictEqual(await host.dispatch('reminders-viewer', 'fire', [{ agent: 'lead', id: 'aaa111' }], 'web'), { ok: true, kept: true });
    assert.deepStrictEqual(fires, [{ agent: 'lead', id: 'aaa111' }, { agent: 'lead', id: 'bbb222' }, { agent: 'lead', id: 'aaa111' }]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((r) => r.id), ['aaa111']);
  } finally { cleanup(); }
});

test('reminders-viewer: malformed fire refs never reach the library seam', async () => {
  const { host, fires, cleanup } = boot({ live: LIVE, records: [] });
  try {
    assert.deepStrictEqual(await host.dispatch('reminders-viewer', 'fire', [{ agent: '..', id: 'aaa111' }], 'desktop'),
      { ok: false, error: 'a valid agent name is required' });
    assert.deepStrictEqual(await host.dispatch('reminders-viewer', 'fire', [{ agent: 'lead', id: '../x' }], 'desktop'),
      { ok: false, error: 'a valid reminder id is required' });
    assert.deepStrictEqual(fires, []);
  } finally { cleanup(); }
});

test('reminders-viewer renderer offers a Fire button that invokes fire', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'reminders-viewer', 'renderer.js'), 'utf8');
  assert.match(src, /el\('button', 'rv-fire', 'Fire'\)/);
  assert.match(src, /rhost\.invoke\('fire', \{ agent: r\.agent, id: r\.id \}\)/);
});

test('engine.js wires the reminder fire kind to reminderLibraryKinds', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  assert.match(src, /libraryFireKinds: \{ reminder: \(ref\) => reminderKinds\.fire\(ref\) \},/);
});

test('host.sessions.listSavedWorkspace projects saved records to name/type/cwd/workspaceId', () => {
  const { host, cleanup } = boot({ live: LIVE, saved: SAVED });
  try {
    const h = host.register('probe', { activate() {} }, { hostApi: HOST_API_VERSION });
    assert.deepStrictEqual(h.sessions.listSavedWorkspace('ws-1'),
      [{ name: 'sleeper', type: 'claude', cwd: '/r', workspaceId: 'ws-1' }]);
  } finally { cleanup(); }
});

test('engine.js wires the reminder remove and add kinds to reminderLibraryKinds, after the scheduler exists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  const kinds = src.match(/libraryKinds: \{([\s\S]*?)\n {8}\},\n/);
  assert.ok(kinds, 'libraryKinds block found');
  assert.match(kinds[1], /reminder: \(ref\) => reminderKinds\.remove\(ref\),/);
  const addKinds = src.match(/libraryAddKinds: \{([\s\S]*?)\n {8}\},\n/);
  assert.ok(addKinds, 'libraryAddKinds block found');
  assert.match(addKinds[1], /reminder: \(ref, payload\) => reminderKinds\.add\(ref, payload\),/);
  const built = src.indexOf('remindScheduler = createRemindScheduler(');
  const wired = src.indexOf('reminderLibraryKinds({\n      scheduler: remindScheduler,');
  const host = src.indexOf('pluginHost = createPluginHostEngine(');
  assert.ok(built !== -1 && wired !== -1 && host !== -1 && built < wired && wired < host, 'scheduler, then kinds, then plugin host');
  assert.match(src, /deliver: \(agent, id, spec, body, by, born\) => manager\._deliverReminder\(agent, reminderText\(id, spec, body, by\), born\),/);
});
