'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');

const { createSessionManager } = require('../session-manager');

const CTX = { ctx: 40, ctxTok: 4, ctxSize: 10, ctxCost: 0.5, ctxModel: 'opus' };
const PROXY = { warm: true };

const WORKSPACES = [
  { id: 'ws1', name: 'Home' },
  { id: 'ws2', name: 'Research' },
  { id: 'ws3', name: '' },
];

function mkFixture({ entries = [], openWindows = ['ws1', 'ws2'] } = {}) {
  const store = entries.map((e) => ({ ...e }));
  const persistence = {
    list: () => store,
    get: (n) => { const e = store.find((x) => x.name === n); return e ? { ...e } : null; },
    upsert: (e) => {
      const i = store.findIndex((x) => x.name === e.name);
      if (i >= 0) store[i] = { ...store[i], ...e }; else store.push({ ...e });
    },
    remove: (n) => { const i = store.findIndex((x) => x.name === n); if (i >= 0) store.splice(i, 1); },
  };
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    getPersistence: () => persistence,
    getWorkspaces: () => ({
      list: () => WORKSPACES,
      get: (id) => WORKSPACES.find((w) => w.id === id) || null,
    }),
    readCtxFor: () => ({ ...CTX }),
    countPending: () => 3,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    fs: fsReal,
    path: pathReal,
    DEFAULT_WORKSPACE_ID: 'ws1',
    resolveTeam: () => null,
    findProjectRoot: () => null,
    stripLevelOf: () => 0,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    notifyOS: () => {},
  });
  const m = new SessionManager();
  m._proxyPoller = { snapshot: () => ({ ...PROXY }) };
  const windows = {};
  for (const id of openWindows) {
    const received = [];
    windows[id] = { received };
    m.windows.set(id, {
      isDestroyed: () => false,
      webContents: { send: (channel, ...args) => received.push([channel, ...args]) },
    });
  }
  return { m, store, persistence, windows };
}

function seedLive(m, name, { workspaceId = 'ws1', pendingOutput = '' } = {}) {
  const s = {
    name,
    agentType: 'claude',
    backend: 'pty',
    workspaceId,
    pendingOutput,
    activityState: 'thinking',
    needsAttention: null,
    pty: { pid: 4242, kill() {} },
  };
  m.sessions.set(name, s);
  return s;
}

const LIVE_ENTRY = {
  name: 'seat', type: 'claude', cwd: '/work', workspaceId: 'ws1',
  label: 'My Seat', createdAt: 111,
};

test('moveToWorkspace refuses an unknown name, an unknown workspace and a same-workspace move — and writes NOTHING', () => {
  const { m, store } = mkFixture({ entries: [LIVE_ENTRY] });
  seedLive(m, 'seat');
  const before = JSON.parse(JSON.stringify(store));

  assert.deepStrictEqual(m.moveToWorkspace('ghost', 'ws2'),
    { ok: false, error: 'Session not found: ghost' });
  assert.deepStrictEqual(m.moveToWorkspace('seat', 'nope'),
    { ok: false, error: 'unknown workspace' });
  assert.deepStrictEqual(m.moveToWorkspace('seat', 'ws1'),
    { ok: false, error: 'seat is already in Home' });

  assert.deepStrictEqual(store, before, 'no refusal touched the record');
  assert.strictEqual(m.sessions.get('seat').workspaceId, 'ws1', 'nor the live Session');
});

test('a persisted-but-not-live row moves: the refusals resolve by RECORD, not by the live map', () => {
  const { m } = mkFixture({ entries: [{ ...LIVE_ENTRY, archivedAt: 7 }] });
  assert.deepStrictEqual(m.moveToWorkspace('seat', 'ws1'),
    { ok: false, error: 'seat is already in Home' });
});

test('a workspace with no name refuses and reports by id', () => {
  const { m } = mkFixture({ entries: [{ ...LIVE_ENTRY, workspaceId: 'ws3' }] });
  assert.deepStrictEqual(m.moveToWorkspace('seat', 'ws3'),
    { ok: false, error: 'seat is already in ws3' });
});

test('a live move rewrites both fields, tells the OLD window moved-out and the NEW one moved-in with the drained buffer', () => {
  const { m, store, windows } = mkFixture({ entries: [LIVE_ENTRY] });
  const s = seedLive(m, 'seat', { pendingOutput: 'buffered bytes' });
  assert.strictEqual(s.pendingOutput, 'buffered bytes', 'ENTER: the buffer is seeded');

  const res = m.moveToWorkspace('seat', 'ws2');
  assert.deepStrictEqual(res,
    { ok: true, name: 'seat', workspaceId: 'ws2', workspaceName: 'Research', live: true });

  assert.strictEqual(store[0].workspaceId, 'ws2', 'the record moved');
  assert.strictEqual(s.workspaceId, 'ws2', 'and so did the live Session');
  assert.strictEqual(s.pendingOutput, '', 'the buffer was drained into the replay');

  assert.deepStrictEqual(windows.ws1.received, [['session:moved-out', { name: 'seat' }]],
    'the old window is told directly — _sendToSession would resolve the NEW one');
  assert.deepStrictEqual(windows.ws2.received, [['session:moved-in', {
    name: 'seat',
    type: 'claude',
    cwd: '/work',
    label: 'My Seat',
    backend: 'pty',
    team: null,
    replay: 'buffered bytes',
    activity: 'thinking',
    attention: null,
    pendingCount: 3,
    createdAt: 111,
    ...CTX,
    proxy: PROXY,
  }]], 'the destination gets the restore loop\'s own live row shape');
});

test('the moved-in row carries the persisted config flags the restore loop stamps', () => {
  const { m, windows } = mkFixture({ entries: [{ ...LIVE_ENTRY, noWire: true, fixFor: 'host' }] });
  seedLive(m, 'seat');
  m.moveToWorkspace('seat', 'ws2');
  const [, row] = windows.ws2.received[0];
  assert.strictEqual(row.noWire, true, 'wire-off is persisted config, not derived from the session');
  assert.strictEqual(row.fixFor, 'host');
});

test('after the move _sendToSession reaches the NEW window', () => {
  const { m, windows } = mkFixture({ entries: [LIVE_ENTRY] });
  seedLive(m, 'seat');
  m.moveToWorkspace('seat', 'ws2');
  windows.ws1.received.length = 0;
  windows.ws2.received.length = 0;

  m._sendToSession('seat', 'pty-data', 'seat', 'after');
  assert.deepStrictEqual(windows.ws2.received, [['pty-data', 'seat', 'after']]);
  assert.deepStrictEqual(windows.ws1.received, [], 'and nothing goes to the old one');
});

test('with the destination window closed nothing is sent and the buffer keeps accumulating', () => {
  const { m, store, windows } = mkFixture({ entries: [LIVE_ENTRY], openWindows: ['ws1'] });
  const s = seedLive(m, 'seat', { pendingOutput: 'buffered bytes' });

  const res = m.moveToWorkspace('seat', 'ws2');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(store[0].workspaceId, 'ws2', 'the record still moved');
  assert.strictEqual(s.pendingOutput, 'buffered bytes',
    'no window to write the replay, so the buffer is NOT drained — the ordinary restore mounts it');
  assert.deepStrictEqual(windows.ws1.received, [['session:moved-out', { name: 'seat' }]],
    'the source window still loses the row');

  m._sendToSession('seat', 'pty-data', 'seat', ' more');
  assert.strictEqual(s.pendingOutput, 'buffered bytes more');
});

test('with the SOURCE window closed the destination is still told', () => {
  const { m, windows } = mkFixture({
    entries: [{ ...LIVE_ENTRY, workspaceId: 'ws3' }], openWindows: ['ws2'],
  });
  seedLive(m, 'seat', { workspaceId: 'ws3' });
  assert.strictEqual(m.moveToWorkspace('seat', 'ws2').ok, true);
  assert.strictEqual(windows.ws2.received[0][0], 'session:moved-in');
});

test('an archived row moves record-only and its moved-in carries archived:true', () => {
  const { m, store, windows } = mkFixture({
    entries: [{ ...LIVE_ENTRY, archivedAt: 900, movedTo: null }],
  });

  const res = m.moveToWorkspace('seat', 'ws2');
  assert.deepStrictEqual(res,
    { ok: true, name: 'seat', workspaceId: 'ws2', workspaceName: 'Research', live: false });
  assert.strictEqual(store[0].workspaceId, 'ws2');

  assert.deepStrictEqual(windows.ws1.received, [],
    'nothing is live here, so the source window gets no moved-out');
  assert.deepStrictEqual(windows.ws2.received, [['session:moved-in', {
    name: 'seat',
    type: 'claude',
    cwd: '/work',
    label: 'My Seat',
    backend: null,
    team: null,
    archived: true,
    archivedAt: 900,
    createdAt: 111,
    movedTo: null,
  }]]);
});

const RENDERER = fsReal.readFileSync(
  pathReal.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

test('the restore loop and the moved-in handler mount through the SAME function', () => {
  const calls = RENDERER.split('mountRestoredSession(entry)').length - 1;
  assert.ok(RENDERER.includes('function mountRestoredSession(entry) {'),
    'ENTER: the extracted builder exists');
  assert.strictEqual(calls, 3,
    'the definition plus exactly two call sites — the restore loop and onSessionMovedIn; '
    + 'a second hand-rolled mount is the drift this extraction exists to prevent');
  const handler = RENDERER.slice(RENDERER.indexOf('window.api.onSessionMovedIn('));
  const body = handler.slice(0, handler.indexOf('\n});'));
  assert.ok(body.includes('mountRestoredSession(entry)'), 'the handler calls it');
  assert.ok(body.includes('addArchivedSessionToSidebar(entry)'), 'and routes an archived row');
});

test('moved-out keeps the record and drops only this window\'s tab', () => {
  const handler = RENDERER.slice(RENDERER.indexOf('window.api.onSessionMovedOut('));
  const body = handler.slice(0, handler.indexOf('\n});'));
  assert.ok(/removeSession\(name, \{ keepPersisted: true \}\)/.test(body),
    'the session is alive and homed elsewhere — dropping the record would delete it');
  assert.ok(body.includes('refreshSidebarView()'));
});
