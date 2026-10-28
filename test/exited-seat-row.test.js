'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { intentEnabled } = require('../intent-catalog');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');
const { pathFor: pathForReal, runDirFor: runDirForReal } = require('../clodex-paths');
const { createSessionManager } = require('../session-manager');
const { initStores } = require('../stores');
const { registerIpcHandlers } = require('../ipc-handlers');
const { restoreSessionsForWorkspace } = require('../session-restore');
const { mkTmpRoot } = require('./lib/tmp-roots');

after(() => setImmediate(() => process.exit(0)));

const STORE_ROOT = mkTmpRoot('clodex-exited-store-');
const { persistence } = initStores(pathReal.join(STORE_ROOT, 'ud'), { registryDir: pathReal.join(STORE_ROOT, 'reg') });

function mkProbe() {
  const root = mkTmpRoot('clodex-exited-');
  const sent = [];
  let onExit = null;
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: root,
    MSG_DIR: pathReal.join(root, 'messages'),
    PENDING_DIR: pathReal.join(root, 'pending'),
    hasActivePending: require('../pending-store').hasActivePending,
    drainPending: require('../pending-store').drainPending,
    fs: fsReal, path: pathReal, os: osReal,
    pathFor: pathForReal, runDirFor: runDirForReal,
    ensureDir: (d) => fsReal.mkdirSync(d, { recursive: true }),
    setupClaudeHook: (n) => {
      fsReal.mkdirSync(runDirForReal(root, n), { recursive: true });
      return pathReal.join(root, 'settings.json');
    },
    bakePrompt: (_r, _n, realIpc) => realIpc,
    promptCacheDir: () => pathReal.join(root, 'cache'),
    readCache: () => null,
    buildIpcPrompt: () => 'IPC\n',
    mergeClaudeSystemPrompt: (extraArgs, ipcPrompt) => ({ cleaned: [...extraArgs], append: ipcPrompt }),
    readAppendBodies: () => [],
    resolveSystemPromptFile: () => null,
    pluginGrammarLines: () => [], intentEnabled,
    resolveTeam: () => null,
    formatTeamBlock: () => '',
    matchSeatRole: () => null,
    getAgentLibrary: () => ({ list: () => [] }),
    unionEnabled: () => [],
    writeAgentPlugin: () => null,
    effectiveInjectedAgents: () => [],
    deliverSkills: () => null, skillDeliveryProviders: () => ['claude', 'codex'],
    effectiveInjectedSkills: () => [],
    getPersistence: () => persistence,
    getUiSettings: () => ({ get: () => ({}) }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => root,
    getRemoteServer: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    resolveProxyBase: () => null,
    resolveProxyAgentId: ({ name }) => `clodex-${name}-rt`,
    normalizeProxyBase: (v) => v,
    lastTranscriptWrite: () => null,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class {
      static async isSocketLive() { return false; }
      async start() {}
      stop() {}
    },
    JsonlWatcher: class { start() {} stop() {} },
    pty: {
      spawn: () => ({
        pid: 4242,
        onData() {},
        onExit(fn) { onExit = fn; },
        kill() {},
        write() {}, resize() {},
      }),
    },
    spawnStreamSeat: (opts) => {
      onExit = ({ exitCode, signal }) => opts.onClose(exitCode, signal);
      return { pid: 7001, startedAt: 1, startTime: 1, stderrTail: '', send: () => Promise.resolve(), close() {}, kill() {} };
    },
    notifyOS: () => {},
    collectSystemDiagnostics: () => ({}),
    whichBin: () => null,
    diagWarning: () => '',
    diagSummary: () => '',
    cleanupClaudeHook: () => {},
    cleanupCodexHook: () => {},
    cleanupSkills: () => {},
    cleanupAgentPlugin: () => {},
    log: { info() {}, warn() {}, error() {} },
    DEFAULT_WORKSPACE_ID: 'default',
  });
  const m = new SessionManager();
  m._sendToSession = (...args) => sent.push(args);
  m._broadcast = () => {};
  const spawn = async (name, type = 'claude', io = 'pty') => {
    await m.create(name, type, osReal.tmpdir(), [], null, 'ws', null, false, null, [], [], [], [], [], null, [], [], null, null, false, false, null, null, null, io);
    const s = m.sessions.get(name);
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
    clearTimeout(s._streamInitWatchdog);
    return s;
  };
  return { m, persistence, spawn, sent, fire: (payload) => onExit(payload) };
}

const EXIT_ROWS = [
  { what: 'agent pty exit 0', type: 'claude', io: 'pty', flag: null, exit: { exitCode: 0 }, kept: true, stamp: { exitCode: 0 } },
  { what: 'agent pty exit 1', type: 'claude', io: 'pty', flag: null, exit: { exitCode: 1 }, kept: true, stamp: { exitCode: 1 } },
  { what: 'agent pty signal', type: 'claude', io: 'pty', flag: null, exit: { exitCode: 0, signal: 9 }, kept: true, stamp: { exitCode: 0, exitSignal: 9 } },
  { what: 'agent stream exit 0', type: 'claude', io: 'stream', flag: null, exit: { exitCode: 0 }, kept: true, stamp: { exitCode: 0 } },
  { what: 'bash exit 0', type: 'bash', io: 'pty', flag: null, exit: { exitCode: 0 }, kept: false, stamp: null },
  { what: 'agent archived exit', type: 'claude', io: 'pty', flag: '_archived', exit: { exitCode: 0, signal: 15 }, kept: true, stamp: null },
  { what: 'agent user-killed exit', type: 'claude', io: 'pty', flag: '_userKilled', exit: { exitCode: 0, signal: 15 }, kept: true, stamp: null },
];

for (const row of EXIT_ROWS) {
  test(`onProcExit: ${row.what} → ${row.stamp ? 'exitedAt stamped' : row.kept ? 'record untouched' : 'record dropped'}`, async () => {
    const { persistence, spawn, fire } = mkProbe();
    const name = `seat-${EXIT_ROWS.indexOf(row)}`;
    const s = await spawn(name, row.type, row.io);
    assert.ok(persistence.get(name), 'ENTER: create() persisted the record');
    if (row.flag) s[row.flag] = true;
    const before = Date.now();
    fire(row.exit);
    const rec = persistence.get(name);
    if (!row.kept) { assert.strictEqual(rec, null); return; }
    assert.ok(rec, 'the agent record survives its exit');
    if (!row.stamp) {
      assert.deepStrictEqual(
        [rec.exitedAt, rec.exitCode, rec.exitSignal], [undefined, undefined, undefined]);
      return;
    }
    assert.ok(rec.exitedAt >= before, `exitedAt stamped, got ${rec.exitedAt}`);
    assert.strictEqual(rec.exitCode, row.stamp.exitCode);
    assert.strictEqual(rec.exitSignal, row.stamp.exitSignal);
  });
}

test('session:retrySpawn clears exitedAt/exitCode/exitSignal on the record it resumes', async () => {
  const { m, persistence, spawn, fire } = mkProbe();
  await spawn('retry-seat');
  fire({ exitCode: 0, signal: 9 });
  assert.ok(persistence.get('retry-seat').exitedAt, 'ENTER: the exit stamped the record');
  assert.ok(!m.sessions.has('retry-seat'), 'ENTER: the seat is gone from the live map');
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: () => {},
    log: { info() {}, warn() {}, error() {} },
    manager: m,
    persistence,
    workspaceOfSender: () => 'ws',
  });
  const res = await handlers.get('session:retrySpawn')({}, 'retry-seat');
  assert.strictEqual(res.ok, true, res.error);
  const s = m.sessions.get('retry-seat');
  try { if (s.sentinel) s.sentinel.stop(); } catch {}
  clearTimeout(s._bootDrainTimer);
  const rec = persistence.get('retry-seat');
  assert.deepStrictEqual(
    ['exitedAt' in rec, 'exitCode' in rec, 'exitSignal' in rec], [false, false, false]);
});

test('restore draws an exitedAt record as an exited row and spawns nothing', async () => {
  let created = 0;
  const saved = [{ name: 'cx', type: 'codex', cwd: '/w/c', sessionId: 'sid', exitedAt: 5, exitCode: 0, createdAt: 1 }];
  const out = await restoreSessionsForWorkspace({
    workspaceId: 'ws',
    persistence: { listForWorkspace: () => saved },
    manager: { sessions: new Map(), teamNameFor: () => 'T', create: async () => { created += 1; } },
    proxyPoller: { snapshot: () => null },
    maybeCompactBeforeResume: async () => {},
    readCtxFor: () => ({}),
    log: { info() {}, warn() {}, error() {} },
  });
  assert.strictEqual(created, 0);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].exited, true);
  assert.deepStrictEqual([out[0].exitedAt, out[0].exitCode, out[0].exitSignal, out[0].team], [5, 0, null, 'T']);
});

const rendererSrc = fsReal.readFileSync(pathReal.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const { classifySender } = require('../renderer/lib/sender-class');

function slice(startMarker, endMarker) {
  const start = rendererSrc.indexOf(startMarker);
  assert.ok(start >= 0, `ENTER: ${startMarker} not found in the shipped renderer`);
  const end = rendererSrc.indexOf(endMarker, start);
  assert.ok(end > start, `ENTER: end of ${startMarker} not found`);
  return rendererSrc.slice(start, end + endMarker.length);
}
const fnSrc = (name) => slice(`function ${name}(`, '\n}\n');

function mkRenderer({ api = {}, confirmAnswer = true } = {}) {
  const rows = [];
  const calls = [];
  const rec = (what) => (...a) => { calls.push([what, ...a]); };
  const mkNode = () => {
    const node = {
      className: '', dataset: {}, innerHTML: '', listeners: {},
      closeBtn: { listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } },
      addEventListener(t, f) { node.listeners[t] = f; },
      querySelector(sel) { return sel === '.session-close' ? node.closeBtn : null; },
      remove() { const i = rows.indexOf(node); if (i >= 0) rows.splice(i, 1); },
    };
    return node;
  };
  const env = {
    document: { createElement: () => mkNode(), body: { classList: { add() {} } } },
    window: { api: { ...api, onSessionExit: (cb) => { env.exitHandler = cb; }, onSessionMovedIn: (cb) => { env.movedInHandler = cb; } } },
    CSS: { escape: (s) => s },
    sessionList: {
      querySelector(sel) {
        const m = /data-name="([^"]*)"/.exec(sel);
        return (m && rows.find((r) => r.dataset.name === m[1])) || null;
      },
    },
    sessions: new Map(),
    sidebarMeta: new Map(),
    streamSeatNames: new Set(),
    archivingSessions: new Map(),
    movingFailed: new Map(),
    restartFailed: new Map(),
    seatViewMemory: new Map(),
    respawnSnapshots: new Map(),
    activeSession: null,
    respawnFocus: new Map(),
    dialogOverlay: { classList: { contains: () => true } },
    isToolInstallSession: () => false,
    removeSession: (name) => { calls.push(['removeSession', name]); env.sessions.delete(name); const i = rows.findIndex((r) => r.dataset.name === name); if (i >= 0) rows.splice(i, 1); },
    insertLocalSessionRow: (item) => rows.push(item),
    esc: (s) => String(s),
    typeGlyph: () => 'C',
    classifySender,
    confirm: (msg) => { calls.push(['confirm', msg]); return confirmAnswer; },
    forgetConfirmText: require('../renderer/lib/format').forgetConfirmText,
    alert: rec('alert'),
    showToast: rec('showToast'),
    markSeatIo: rec('markSeatIo'),
    markSeatEffort: rec('markSeatEffort'),
    refreshSeatMcp: rec('refreshSeatMcp'),
    markSeatPosture: rec('markSeatPosture'),
    createTerminal: rec('createTerminal'),
    addSessionToSidebar: rec('addSessionToSidebar'),
    switchSession: rec('switchSession'),
    refreshSidebarView: rec('refreshSidebarView'),
    addArchivedSessionToSidebar: rec('addArchivedSessionToSidebar'),
    addFailedSessionToSidebar: (entry) => { calls.push(['addFailedSessionToSidebar', entry]); const node = mkNode(); node.className = 'session-item failed'; node.dataset.name = entry.name; rows.push(node); },
    mountRestoredSession: rec('mountRestoredSession'),
    initSidebarView: rec('initSidebarView'),
    switchToNewSession: rec('switchToNewSession'),
    applyCloneChip: rec('applyCloneChip'),
    applyTicketBadge: rec('applyTicketBadge'),
    refreshNewSessionToolGate() {},
    terminalWebglReady: Promise.resolve(),
  };
  const names = Object.keys(env).filter((k) => k !== 'exitHandler' && k !== 'movedInHandler');
  const body = [
    slice('const seatIoKind', ';\n'),
    slice('const RESTART_FAILED_TTL_MS', ';\n'),
    fnSrc('exitedLabel'), fnSrc('rowSnapshot'), fnSrc('archivedRowEntry'), fnSrc('failRowOrStash'),
    `async ${fnSrc('setArgsOrFailRow')}`, `async ${fnSrc('restartOrFailRow')}`, `async ${fnSrc('deleteSessionRow')}`, fnSrc('respawnSnapshotOf'), fnSrc('rebuildLiveRow'), fnSrc('exitedRowSnapshot'), fnSrc('addExitedSessionToSidebar'), `async ${fnSrc('forgetSavedEntry')}`,
    slice('window.api.onSessionExit((name, code, meta) => {', '\n});\n'),
    slice('window.api.onSessionMovedIn((entry) => {', '\n});\n'),
    `const reattach = ({ name, type, cwd, backend, noWire, io, background, clone }) => { switch ('reattach') { ${slice("    case 'reattach':", '      break;\n')} } };`,
    `const respawnFailed = ({ name, type, cwd, error }) => { switch ('respawnFailed') { ${slice("    case 'respawnFailed': {", '      break;\n    }\n')} } };`,
    `return { reattach, respawnFailed, setArgsOrFailRow, restartOrFailRow, deleteSessionRow, restore: () => ${slice('(async function restoreSessions() {', '\n})();\n').trim().replace(/;$/, '')} };`,
  ].join('\n');
  const out = new Function(...names, body)(...names.map((n) => env[n]));
  const liveRow = (name, dataset) => {
    const node = { dataset: { name, ...dataset }, querySelector: (sel) => (sel === '.session-name' ? { textContent: name } : null) };
    rows.push(node);
    env.sessions.set(name, { name });
    return node;
  };
  return { env, rows, calls, liveRow, restore: out.restore, reattach: out.reattach, out };
}

const exitedLabelOf = (row) => (/<span class="session-exited-label">([^<]*)<\/span>/.exec(row.innerHTML) || [])[1];

test('an unexpected agent exit leaves an exited row reading "exited (code 0) — click to resume"', () => {
  const h = mkRenderer();
  h.liveRow('cx', { type: 'codex', cwd: '/w/c', team: 'T' });
  h.env.exitHandler('cx', 0, { expected: false, signal: null, agentType: 'codex', missingTool: null });
  assert.strictEqual(h.rows.length, 1);
  const row = h.rows[0];
  assert.strictEqual(row.className, 'session-item exited');
  assert.deepStrictEqual([row.dataset.name, row.dataset.type, row.dataset.cwd, row.dataset.team], ['cx', 'codex', '/w/c', 'T']);
  assert.strictEqual(exitedLabelOf(row), 'exited (code 0) — click to resume');
  assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'showToast'), [], 'exit 0 toasts nothing');
});

test('a signalled agent exit reads "exited (signal 9)" and keeps the crash toast', () => {
  const h = mkRenderer();
  h.liveRow('cx', { type: 'codex', cwd: '/w/c' });
  h.env.exitHandler('cx', 0, { expected: false, signal: 9, agentType: 'codex', missingTool: null });
  assert.strictEqual(exitedLabelOf(h.rows[0]), 'exited (signal 9) — click to resume');
  assert.strictEqual(h.calls.filter((c) => c[0] === 'showToast').length, 1);
});

for (const row of [
  { what: 'an expected agent exit', meta: { expected: true, signal: 15, agentType: 'claude' } },
  { what: 'a bash exit', meta: { expected: false, signal: null, agentType: null } },
]) {
  test(`${row.what} leaves no exited row`, () => {
    const h = mkRenderer();
    h.liveRow('s', { type: 'claude', cwd: '/w' });
    h.env.exitHandler('s', 0, row.meta);
    assert.deepStrictEqual(h.rows, []);
  });
}

test('clicking the exited row resumes through retrySpawnSession and mounts the seat', async () => {
  const retried = [];
  const h = mkRenderer({ api: { retrySpawnSession: async (n) => { retried.push(n); return { ok: true, io: 'stream' }; } } });
  h.liveRow('cx', { type: 'codex', cwd: '/w/c', team: 'T', effort: 'high', posture: 'bypass' });
  h.env.exitHandler('cx', 0, { expected: false, signal: null, agentType: 'codex' });
  h.calls.length = 0;
  await h.rows[0].listeners.click({ target: { closest: () => null } });
  assert.deepStrictEqual(retried, ['cx']);
  assert.deepStrictEqual(h.rows, [], 'the exited row is replaced');
  assert.deepStrictEqual(h.calls.map((c) => c[0]),
    ['markSeatIo', 'createTerminal', 'addSessionToSidebar', 'markSeatEffort', 'refreshSeatMcp', 'markSeatPosture', 'switchSession', 'refreshSidebarView']);
  assert.deepStrictEqual(h.calls[3], ['markSeatEffort', 'cx', 'high']);
  assert.deepStrictEqual(h.calls[4], ['refreshSeatMcp', 'cx']);
  assert.deepStrictEqual(h.calls[5], ['markSeatPosture', 'cx', 'bypass']);
  assert.deepStrictEqual(h.calls[0], ['markSeatIo', 'cx', 'stream']);
  assert.deepStrictEqual(h.calls[2], ['addSessionToSidebar', 'cx', 'codex', '/w/c', null, null, 'T', false, null, null]);
});

test('✕ on the exited row forgets the record', async () => {
  const forgot = [];
  const h = mkRenderer({ api: { forgetSession: async (n) => { forgot.push(n); } } });
  h.liveRow('cx', { type: 'codex', cwd: '/w/c' });
  h.env.exitHandler('cx', 1, { expected: false, signal: null, agentType: 'codex' });
  await h.rows[0].closeBtn.listeners.click({ stopPropagation() {} });
  assert.deepStrictEqual(forgot, ['cx']);
  assert.deepStrictEqual(h.rows, []);
});

test('restore and session:moved-in draw an exited payload row as the exited row', async () => {
  const payload = { name: 'cx', type: 'codex', cwd: '/w/c', exited: true, exitedAt: 5, exitCode: 0, exitSignal: null };
  const h = mkRenderer({ api: { restoreSessions: async () => [payload], getSidebarView: async () => ({ ok: false }) } });
  await h.restore();
  assert.strictEqual(h.rows.length, 1);
  assert.strictEqual(exitedLabelOf(h.rows[0]), 'exited (code 0) — click to resume');
  assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'mountRestoredSession'), []);
  const m = mkRenderer();
  m.env.movedInHandler({ ...payload, exitCode: 2 });
  assert.strictEqual(exitedLabelOf(m.rows[0]), 'exited (code 2) — click to resume');
});

test('✕ on a restored exited ticket-seat row warns that its worktree is removed unless it has uncommitted work', async () => {
  const payload = { name: 'cx', type: 'codex', cwd: '/w/c', exited: true, exitedAt: 5, exitCode: 0, exitSignal: null, worktreePath: '/wt/cx' };
  const h = mkRenderer({ api: { restoreSessions: async () => [payload], getSidebarView: async () => ({ ok: false }), forgetSession: async () => true } });
  await h.restore();
  assert.strictEqual(h.rows.length, 1, 'ENTER: the exited row is drawn');
  await h.rows[0].closeBtn.listeners.click({ stopPropagation() {} });
  assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'confirm'), [['confirm',
    'Forget session "cx"? It isn\'t running — this removes the saved entry. Its worktree /wt/cx is also removed from disk, unless it has uncommitted work (then nothing is removed).']]);
});

test('the forget confirm of a row with no known worktree still says a ticket seat\'s worktree goes', () => {
  const { forgetConfirmText } = require('../renderer/lib/format');
  assert.strictEqual(forgetConfirmText('Forget session "a"?', { name: 'a' }),
    'Forget session "a"? It isn\'t running — this removes the saved entry. If it is a ticket seat, its worktree is also removed from disk, unless it has uncommitted work (then nothing is removed).');
});

test('a reattach for a woken seat replaces its archived row with one live row', () => {
  const h = mkRenderer();
  const archived = h.env.document.createElement('div');
  archived.className = 'session-item archived';
  archived.dataset = { name: 'asst', type: 'claude', cwd: '/w' };
  h.rows.push(archived);
  h.env.sidebarMeta.set('asst', { createdAt: 1 });
  h.reattach({ name: 'asst', type: 'claude', cwd: '/w', backend: null, noWire: false, io: 'stream', background: true });
  assert.deepStrictEqual(h.rows, []);
  assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'addSessionToSidebar').map((c) => c.slice(1, 4)), [['asst', 'claude', '/w']]);
  assert.deepStrictEqual(h.calls.find((c) => c[0] === 'switchToNewSession'), ['switchToNewSession', 'asst', { agentInitiated: true }]);
});

function stashedRespawn(h) {
  const row = h.liveRow('s', { type: 'claude', cwd: '/w', fixFor: 'box1', ticket: 't4' });
  row.querySelector = (sel) => (sel === '.session-name' ? { textContent: 'Lab' } : null);
  h.env.exitHandler('s', 0, { expected: true, signal: 15, agentType: 'claude' });
  assert.deepStrictEqual(h.rows, [], 'ENTER: the expected exit removed the row');
  return () => h.reattach({ name: 's', type: 'claude', cwd: '/w', backend: null, noWire: false, io: 'pty', background: false });
}

test('a reattach after an expected exit rebuilds the row with the label, fix chip and ticket dot it had', () => {
  const h = mkRenderer();
  const reattach = stashedRespawn(h);
  reattach();
  assert.deepStrictEqual(h.calls.find((c) => c[0] === 'addSessionToSidebar'), ['addSessionToSidebar', 's', 'claude', '/w', 'Lab', null, null, false, null, 'box1']);
  assert.deepStrictEqual(h.calls.find((c) => c[0] === 'applyTicketBadge'), ['applyTicketBadge', 's', 't4']);
  assert.strictEqual(h.env.respawnSnapshots.has('s'), false, 'the snapshot is used once');
});

test('a respawn snapshot older than 60 s is not used', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const h = mkRenderer();
  const reattach = stashedRespawn(h);
  t.mock.timers.tick(60001);
  reattach();
  assert.deepStrictEqual(h.calls.find((c) => c[0] === 'addSessionToSidebar'), ['addSessionToSidebar', 's', 'claude', '/w', null, null, null, false, null, null]);
});

for (const row of [
  { what: 'an expected exit drops it and draws no failed row', expected: true, failedRows: 0 },
  { what: 'an unexpected exit draws its failed row', expected: false, failedRows: 1 },
]) {
  test(`a movingFailed entry: ${row.what}`, () => {
    const h = mkRenderer();
    h.liveRow('s', { type: 'claude', cwd: '/w' });
    h.env.movingFailed.set('s', { name: 's', type: 'claude', cwd: '/w', error: 'old process did not exit in time' });
    h.env.exitHandler('s', 0, { expected: row.expected, signal: 15, agentType: 'claude' });
    assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'removeSession'), [['removeSession', 's']], 'ENTER: the exit was handled');
    assert.strictEqual(h.calls.filter((c) => c[0] === 'addFailedSessionToSidebar').length, row.failedRows);
    assert.strictEqual(h.env.movingFailed.has('s'), false);
  });
}

const expectedExit = (h, name) => h.env.exitHandler(name, 0, { expected: true, signal: 15, agentType: 'claude' });
const callsOf = (h, what) => h.calls.filter((c) => c[0] === what);

test('A: an Edit Session restart whose respawn fails after the expected exit leaves one failed row', async () => {
  const h = mkRenderer({ api: { setSessionArgs: async () => { expectedExit(h, 's'); return { ok: false, error: 'Directory does not exist: /w' }; } } });
  const snap = { name: 's', type: 'claude', cwd: '/w', team: 'T' };
  h.liveRow('s', { type: 'claude', cwd: '/w', team: 'T' });
  const res = await h.out.setArgsOrFailRow('s', snap, true, [[], true]);
  assert.strictEqual(res.ok, false, 'ENTER: the save failed');
  assert.deepStrictEqual(callsOf(h, 'addFailedSessionToSidebar').map((c) => [c[1].name, c[1].type, c[1].cwd, c[1].team, c[1].error]),
    [['s', 'claude', '/w', 'T', 'Directory does not exist: /w']]);
});

test('A: an Edit Session restart that times out stashes the failed row for the late expected exit', async () => {
  const h = mkRenderer({ api: { setSessionArgs: async () => ({ ok: false, error: 'old process did not exit in time' }) } });
  h.liveRow('s', { type: 'claude', cwd: '/w' });
  await h.out.setArgsOrFailRow('s', { name: 's', type: 'claude', cwd: '/w' }, true, [[], true]);
  assert.strictEqual(callsOf(h, 'addFailedSessionToSidebar').length, 0, 'ENTER: nothing drawn while the seat is live');
  expectedExit(h, 's');
  assert.deepStrictEqual(callsOf(h, 'addFailedSessionToSidebar').map((c) => c[1].error), ['old process did not exit in time']);
});

test('B: a restart reply {ok:false} while the seat is live, then the expected exit, leaves one failed row', async () => {
  const h = mkRenderer({ api: { restartSession: async () => ({ ok: false, error: 'old process did not exit in time' }) } });
  h.liveRow('s', { type: 'codex', cwd: '/w/c' });
  await h.out.restartOrFailRow('s');
  assert.strictEqual(callsOf(h, 'addFailedSessionToSidebar').length, 0, 'ENTER: nothing drawn while the seat is live');
  assert.strictEqual(callsOf(h, 'showToast').length, 1, 'the failure still toasts');
  expectedExit(h, 's');
  assert.deepStrictEqual(callsOf(h, 'addFailedSessionToSidebar').map((c) => [c[1].name, c[1].type, c[1].cwd]), [['s', 'codex', '/w/c']]);
  assert.strictEqual(h.env.restartFailed.has('s'), false);
});

test('C: a respawnFailed context action after the expected exit draws one failed row, and a second does not double it', () => {
  const h = mkRenderer();
  h.liveRow('s', { type: 'claude', cwd: '/w', team: 'T' });
  expectedExit(h, 's');
  h.out.respawnFailed({ name: 's', type: 'claude', cwd: '/w', error: 'account dir x does not exist' });
  assert.deepStrictEqual(callsOf(h, 'addFailedSessionToSidebar').map((c) => [c[1].name, c[1].team, c[1].error]), [['s', 'T', 'account dir x does not exist']]);
  h.out.respawnFailed({ name: 's', type: 'claude', cwd: '/w', error: 'account dir x does not exist' });
  assert.strictEqual(callsOf(h, 'addFailedSessionToSidebar').length, 1);
});

test('C: a respawnFailed context action while the seat is live draws the failed row at its expected exit', () => {
  const h = mkRenderer();
  h.liveRow('s', { type: 'claude', cwd: '/w' });
  h.out.respawnFailed({ name: 's', type: 'claude', cwd: '/w', error: 'old process did not exit in time' });
  assert.strictEqual(callsOf(h, 'addFailedSessionToSidebar').length, 0, 'ENTER: nothing drawn while the seat is live');
  expectedExit(h, 's');
  assert.deepStrictEqual(callsOf(h, 'addFailedSessionToSidebar').map((c) => c[1].error), ['old process did not exit in time']);
});

test('D: a Delete Session kept by a timed-out exit leaves one archived row with the ✕ at its expected exit', async () => {
  const h = mkRenderer({ api: { confirmKill: async () => true, killSession: async () => ({ ok: false, error: 'process still running after 8s; worktree kept', live: true, worktreeRemoved: false, path: '/wt/s' }) } });
  h.liveRow('s', { type: 'claude', cwd: '/wt/s', ticket: 't9' });
  await h.out.deleteSessionRow('s');
  assert.strictEqual(callsOf(h, 'addArchivedSessionToSidebar').length, 0, 'ENTER: nothing drawn while the seat is live');
  expectedExit(h, 's');
  assert.deepStrictEqual(callsOf(h, 'addArchivedSessionToSidebar').map((c) => [c[1].name, c[1].type, c[1].cwd, c[1].ticket]), [['s', 'claude', '/wt/s', 't9']]);
});

test('D: a Delete Session whose tree removal failed after the exit draws one archived row', async () => {
  const h = mkRenderer({ api: { confirmKill: async () => true, killSession: async () => { expectedExit(h, 's'); return { ok: true, worktreeRemoved: false, error: 'locked', live: true, path: '/wt/s' }; } } });
  h.liveRow('s', { type: 'claude', cwd: '/wt/s' });
  await h.out.deleteSessionRow('s');
  assert.deepStrictEqual(callsOf(h, 'addArchivedSessionToSidebar').map((c) => c[1].name), ['s']);
  assert.strictEqual(callsOf(h, 'showToast').length, 1, 'the failure still toasts');
});

test('a Delete Session that removed the tree leaves no row', async () => {
  const h = mkRenderer({ api: { confirmKill: async () => true, killSession: async () => { expectedExit(h, 's'); return { ok: true, worktreeRemoved: true, live: true }; } } });
  h.liveRow('s', { type: 'claude', cwd: '/wt/s' });
  await h.out.deleteSessionRow('s');
  assert.ok(callsOf(h, 'removeSession').length >= 1, 'ENTER: the exit was handled');
  assert.deepStrictEqual([callsOf(h, 'addArchivedSessionToSidebar'), callsOf(h, 'addFailedSessionToSidebar'), h.rows], [[], [], []]);
});

test('C: a context reload whose create throws sends respawnFailed to the seat\'s workspace window', async () => {
  const { m } = mkProbe();
  const sent = [];
  m.windows.set('ws', { isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } });
  m.create = async () => { throw new Error('Directory does not exist: /gone'); };
  const entry = { name: 'rl', type: 'claude', cwd: '/gone', workspaceId: 'ws' };
  assert.strictEqual(m._coldRespawn('rl', entry, {}, '', 'reload'), true, 'ENTER: the reload was scheduled');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(sent, [['session:context-action', { action: 'respawnFailed', name: 'rl', error: 'Directory does not exist: /gone', type: 'claude', cwd: '/gone' }]]);
  persistence.remove('rl');
});

test('an in-place model switch refused while live stashes nothing: the next unexpected exit draws the exited row', async () => {
  const h = mkRenderer({ api: { setSessionArgs: async () => ({ ok: false, error: "Model 'claude-nope-1' not found", inPlace: true }) } });
  h.liveRow('s', { type: 'claude', cwd: '/w' });
  await h.out.setArgsOrFailRow('s', { name: 's', type: 'claude', cwd: '/w' }, true, [[], true]);
  h.env.exitHandler('s', 1, { expected: false, signal: null, agentType: 'claude' });
  assert.strictEqual(exitedLabelOf(h.rows[0]), 'exited (code 1) — click to resume');
  assert.strictEqual(callsOf(h, 'addFailedSessionToSidebar').length, 0);
});

test('a restartFailed stash older than its TTL is ignored at the exit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const h = mkRenderer({ api: { restartSession: async () => ({ ok: false, error: 'Session not found in persistence' }) } });
  h.liveRow('s', { type: 'claude', cwd: '/w' });
  await h.out.restartOrFailRow('s');
  assert.strictEqual(h.env.restartFailed.has('s'), true, 'ENTER: the refusal stashed');
  t.mock.timers.tick(30001);
  h.env.exitHandler('s', 1, { expected: false, signal: null, agentType: 'claude' });
  assert.strictEqual(callsOf(h, 'addFailedSessionToSidebar').length, 0);
  assert.strictEqual(exitedLabelOf(h.rows[0]), 'exited (code 1) — click to resume');
});
