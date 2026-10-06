'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createCliHooks } = require('../cli-hooks');
const { pathFor, runDirFor } = require('../clodex-paths');
const { composeSubagentBrief } = require('../intent-socket');
const registry = require('../intent-registry');
const grammar = require('../plugins/browser-pane/grammar');
const subagent = require('../plugins/browser-pane/subagent');
const { TOOL } = require('../plugins/browser-pane/mcp-tool');
const { mkTmpRoot } = require('./lib/tmp-roots');

const B4 = "This seat's browser pane is the `browser` MCP tool (verb, service, bracket, body). Refusals come back as text; a refused call will not succeed on retry — return and let the seat's main agent decide.";
const TAIL = "Refusals come back as text; a refused call will not succeed on retry — return and let the seat's main agent decide.";
const SEAT = { intents: ['browser'], plugins: ['browser-pane'] };

function withBrowserVerb(fn) {
  registry.registerIntent({ verb: 'browser', parse: grammar.parseLine, handler: () => {}, tools: [TOOL], subagent }, 'browser-pane', { shipped: true });
  return Promise.resolve().then(fn).finally(() => registry._resetPluginRows());
}

function hooksAt(root) {
  return createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
}

test('writeMcpCatalog: { v, rev, tools, briefs } at the mcpCatalog path, mode 0600, 16-hex rev', () => {
  const root = mkTmpRoot('clx-mcpcat-');
  const r = hooksAt(root).writeMcpCatalog('seat1', { tools: [], briefs: ['A.'] });
  const p = pathFor(root, 'seat1', 'mcpCatalog');
  assert.strictEqual(r.path, p);
  assert.strictEqual(r.changed, true);
  assert.match(r.rev, /^[0-9a-f]{16}$/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { v: 1, rev: r.rev, tools: [], briefs: ['A.'] });
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600);
});

test('writeMcpCatalog: identical content is not rewritten; different content is, with a new rev', () => {
  const root = mkTmpRoot('clx-mcpcat-');
  const h = hooksAt(root);
  const p = pathFor(root, 'seat1', 'mcpCatalog');
  const a = h.writeMcpCatalog('seat1', { tools: [], briefs: ['A.'] });
  const before = fs.statSync(p);
  const b = h.writeMcpCatalog('seat1', { tools: [], briefs: ['A.'] });
  const after = fs.statSync(p);
  assert.strictEqual(b.changed, false);
  assert.strictEqual(b.rev, a.rev);
  assert.strictEqual(after.ino, before.ino);
  assert.strictEqual(after.mtimeMs, before.mtimeMs);
  const c = h.writeMcpCatalog('seat1', { tools: [], briefs: ['B.'] });
  assert.strictEqual(c.changed, true);
  assert.notStrictEqual(c.rev, a.rev);
  assert.notStrictEqual(fs.statSync(p).ino, before.ino);
});

test('writeMcpCatalog: the written inputSchema round-trips the plugin TOOL schema', () => withBrowserVerb(() => {
  const root = mkTmpRoot('clx-mcpcat-');
  const h = hooksAt(root);
  const cat = registry.subagentCatalogFor(SEAT);
  assert.strictEqual(cat.tools[0].inputSchema, TOOL.inputSchema, 'ENTER: the registry hands out the plugin object');
  h.writeMcpCatalog('seat1', cat);
  const back = h.readMcpCatalog('seat1');
  assert.deepStrictEqual(back.tools[0].inputSchema, TOOL.inputSchema);
  assert.deepStrictEqual(back.briefs, [subagent.brief]);
  assert.notStrictEqual(back.tools[0].inputSchema, TOOL.inputSchema);
}));

test('writeMcpCatalog: the write leaves no temp file in the run dir', () => {
  const root = mkTmpRoot('clx-mcpcat-');
  hooksAt(root).writeMcpCatalog('seat1', { tools: [], briefs: ['A.'] });
  const dir = runDirFor(root, 'seat1');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f !== path.basename(pathFor(root, 'seat1', 'mcpCatalog'))), []);
});

test('readMcpCatalog: missing or torn file reads as the empty catalog', () => {
  const root = mkTmpRoot('clx-mcpcat-');
  const h = hooksAt(root);
  assert.deepStrictEqual(h.readMcpCatalog('seat1'), { tools: [], briefs: [] });
  h.writeMcpCatalog('seat1', { tools: [], briefs: ['A.'] });
  fs.writeFileSync(pathFor(root, 'seat1', 'mcpCatalog'), '{"v":1,"re');
  assert.deepStrictEqual(h.readMcpCatalog('seat1'), { tools: [], briefs: [] });
});

test('composeSubagentBrief: rows', () => {
  assert.strictEqual(composeSubagentBrief([]), '');
  assert.strictEqual(composeSubagentBrief([undefined]), '');
  assert.strictEqual(composeSubagentBrief(undefined), '');
  assert.strictEqual(composeSubagentBrief([subagent.brief]), B4);
  assert.strictEqual(composeSubagentBrief(['A.', 'B.']), 'A. B. ' + TAIL);
});

test('intent-socket.js names no plugin: no browser literal in the source', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'intent-socket.js'), 'utf8');
  assert.ok(!/browser/.test(src));
});

function mkManager() {
  const root = mkTmpRoot('clx-mcpcat-');
  const store = new Map();
  const persistence = {
    list: () => [...store.values()],
    get: (n) => store.get(n) || null,
    upsert: (e) => store.set(e.name, { ...(store.get(e.name) || {}), ...e }),
    remove: (n) => store.delete(n),
    setSessionId: () => {},
    setIntents: (n, intents) => {
      const e = store.get(n);
      if (!e) return;
      if (Array.isArray(intents)) e.intents = [...intents];
      else delete e.intents;
    },
  };
  const hooks = hooksAt(root);
  const catalogs = [];
  const { createSessionManager } = require('../session-manager');
  const { intentEnabled } = require('../intent-catalog');
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: root,
    fs, path, pathFor, runDirFor,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => persistence,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    resolveProxyBase: () => null,
    normalizeProxyBase: (v) => v,
    resolveProxyAgentId: () => null,
    lastTranscriptWrite: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { start() {} stop() {} },
    JsonlWatcher: class { start() {} stop() {} },
    pty: { spawn: () => ({ onData() {}, onExit() {}, pid: 999 }) },
    os,
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    WIRE_SHADOW: false,
    WIRE_INTENTS_LIVE: true,
    setupClaudeHook: hooks.setupClaudeHook,
    writeMcpConfig: () => {},
    writeMcpCatalog: (n, c) => {
      const r = hooks.writeMcpCatalog(n, c);
      catalogs.push({ name: n, catalog: JSON.parse(JSON.stringify(c)), changed: r.changed });
      return r;
    },
    setupCodexHook: () => {},
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkills: () => {}, cleanupAgentPlugin: () => {},
    buildIpcPrompt: () => '', writeClaudeDigestFile: () => false,
    teeBlindBackend: () => null,
    readEffectiveClaudeEnv: () => ({}),
    mergeSessionEnv: () => ({ ...process.env }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => root,
    resolveTeam: () => null,
    strictMcpReason: () => null,
    scrubInheritedClaudeMarkers: (e) => e,
    resolveSystemPromptFile: () => null,
    mergeClaudeSystemPrompt: (a) => ({ cleaned: [...a], append: null }),
    readAppendBodies: () => [],
    pluginGrammarLines: () => [],
    intentEnabled,
    getAgentLibrary: () => ({ list: () => [] }),
    unionEnabled: () => [],
    writeAgentPlugin: () => null, effectiveInjectedAgents: () => [],
    deliverSkills: () => null, skillDeliveryProviders: () => ['claude', 'codex'],
    effectiveInjectedSkills: () => [],
    unresolvedSubagentRefs: () => [],
    bakePrompt: () => '',
    nextIncarnation: () => 1,
    memLoad: { noteDigest: () => {}, noteSession: () => {} },
    tiersOf: () => ({}),
    arm: { onContextReset: () => {} },
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
  };
  return { m, persistence, catalogs, stop };
}

function spawn(m, name, { extraArgs = [], intents = null, plugins = null } = {}) {
  return m.create(name, 'claude', os.tmpdir(), extraArgs, null, 'ws', null, false, null,
    [], [], [], [], [], null, [], [], intents, null, true, true, plugins);
}

const BROWSER_CATALOG = () => ({ tools: [{ name: TOOL.name, description: TOOL.description, inputSchema: TOOL.inputSchema }], briefs: [subagent.brief] });

test('spawn: a seat granted browser writes the browser catalog from the create() arguments', () => withBrowserVerb(async () => {
  const { m, catalogs, stop } = mkManager();
  await spawn(m, 'cat1', { intents: ['browser'], plugins: ['browser-pane'] });
  stop('cat1');
  assert.deepStrictEqual(catalogs, [{ name: 'cat1', catalog: JSON.parse(JSON.stringify(BROWSER_CATALOG())), changed: true }]);
}));

test('spawn: a seat with no intents list still writes, and writes the empty catalog', () => withBrowserVerb(async () => {
  const { m, catalogs, stop } = mkManager();
  await spawn(m, 'cat2', { intents: null, plugins: ['browser-pane'] });
  stop('cat2');
  assert.deepStrictEqual(catalogs.map((c) => [c.name, c.catalog]), [['cat2', { tools: [], briefs: [] }]]);
}));

test('spawn: a seat whose args carry --mcp-config still writes its catalog', () => withBrowserVerb(async () => {
  const { m, catalogs, stop } = mkManager();
  await spawn(m, 'cat3', { extraArgs: ['--mcp-config', '/tmp/x.json'], intents: ['browser'], plugins: ['browser-pane'] });
  stop('cat3');
  assert.strictEqual(catalogs.length, 1);
  assert.strictEqual(catalogs[0].catalog.tools.length, 1);
}));

test('refreshSeatCatalog: 0 → 1 → 0 through setIntents, an identical refresh does not rewrite', () => withBrowserVerb(async () => {
  const { m, persistence, catalogs, stop } = mkManager();
  await spawn(m, 'cat4', { intents: [], plugins: ['browser-pane'] });
  stop('cat4');
  catalogs.length = 0;
  persistence.setIntents('cat4', []);
  m.refreshSeatCatalog('cat4');
  persistence.setIntents('cat4', ['browser']);
  m.refreshSeatCatalog('cat4');
  persistence.setIntents('cat4', []);
  m.refreshSeatCatalog('cat4');
  assert.deepStrictEqual(catalogs.map((c) => c.catalog.tools.length), [0, 1, 0]);
  assert.deepStrictEqual(catalogs.map((c) => c.changed), [false, true, true]);
  const again = m.refreshSeatCatalog('cat4');
  assert.strictEqual(again.changed, false);
  assert.strictEqual(m.refreshSeatCatalog('nosuch'), null);
}));

test('ipc: setIntents, setPlugins and setPluginGrants each refresh the seat catalog once', () => {
  const { registerIpcHandlers } = require('../ipc-handlers');
  const handlers = new Map();
  const store = { s1: { name: 's1', type: 'claude' } };
  const refreshed = [];
  const persistence = {
    get: (n) => store[n] || null,
    setIntents: () => {}, setPlugins: () => {}, setPluginGrants: () => {},
  };
  const stub = () => () => {};
  const deps = new Proxy({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    persistence,
    manager: { sessions: new Map(), refreshSeatCatalog: (n) => refreshed.push(n) },
    log: { info() {}, error() {} },
  }, { get(t, p) { return p in t ? t[p] : stub(); } });
  registerIpcHandlers(deps);
  for (const [ch, arg] of [['session:setIntents', ['browser']], ['session:setPlugins', ['browser-pane']], ['session:setPluginGrants', []]]) {
    refreshed.length = 0;
    assert.deepStrictEqual(handlers.get(ch)(null, 's1', arg), { ok: true }, ch);
    assert.deepStrictEqual(refreshed, ['s1'], ch);
  }
});

test('plugin host: activate and deactivate tell the manager to refresh every seat catalog', () => {
  const { createPluginHostEngine } = require('../plugin-host-engine');
  const { HOST_API_VERSION } = require('../plugin-api');
  const dir = mkTmpRoot('clx-mcpcat-');
  let calls = 0;
  const engine = createPluginHostEngine({
    manager: {
      sessions: new Map(),
      list: () => [], listForWorkspace: () => [],
      _broadcast: () => {}, _sendToSession: () => {}, windowForWorkspace: () => null,
      _injectText: () => {},
      refreshAllSeatCatalogs: () => { calls += 1; },
    },
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    log: { info: () => {}, error: () => {} },
    userDataPath: dir,
    fs, path,
    gitWorktree: {},
    telemetrySnapshot: () => null,
    getLoader: () => null,
  });
  try {
    engine.register('cat-plug', { activate() {} }, { hostApi: HOST_API_VERSION }, { shipped: true });
    assert.strictEqual(calls, 1);
    engine.deactivate('cat-plug');
    assert.strictEqual(calls, 2);
  } finally {
    registry._resetPluginRows();
  }
});

test('refreshSeatCatalog: a persisted claude seat that is not live is not written', () => withBrowserVerb(async () => {
  const { m, persistence, catalogs } = mkManager();
  persistence.upsert({ name: 'gone', type: 'claude', intents: ['browser'], plugins: ['browser-pane'] });
  assert.strictEqual(m.refreshSeatCatalog('gone'), null);
  assert.deepStrictEqual(catalogs, []);
}));

test('engine applySessionArgs without restart refreshes the seat catalog after the grant writes', async () => {
  const { createEngine } = require('../engine');
  const tmp = mkTmpRoot('clx-mcpcat-');
  const eng = createEngine({
    userDataPath: tmp,
    seams: { noSeed: true, registryDir: path.join(tmp, 'clodex-home') },
    log: { info() {}, warn() {}, error() {} },
  });
  eng.stores.persistence.upsert({ name: 'c', type: 'claude', cwd: '/tmp', workspaceId: 'default', intents: ['browser'] });
  const seen = [];
  eng.manager.refreshSeatCatalog = (n) => { seen.push([n, eng.stores.persistence.get(n).intents]); return null; };
  const res = await eng.applySessionArgs('c', { intents: [], restart: false }, 'default');
  assert.deepStrictEqual(res, { ok: true, restarted: false });
  assert.deepStrictEqual(seen, [['c', []]]);
});
