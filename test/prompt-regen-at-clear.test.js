'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { createCliHooks } = require('../cli-hooks');
const { pathFor, runDirFor } = require('../clodex-paths');
const { bakePrompt, promptCacheDir, readCache, writeCache } = require('../ipc-prompt-cache');
const { mergeSessionEnv } = require('../env-scopes');
const { mkTmpRoot } = require('./lib/tmp-roots');

function mkManager(root) {
  const persisted = new Map();
  const spawns = [];
  let mgr = null;
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: root,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    fs, path, os,
    pathFor, runDirFor,
    buildIpcPrompt: require('../ipc-prompt').buildIpcPrompt,
    mergeClaudeSystemPrompt: require('../argv-merge').mergeClaudeSystemPrompt,
    readAppendBodies: () => [],
    resolveSystemPromptFile: () => null,
    pluginGrammarLines: () => [],
    bakePrompt, promptCacheDir, readCache,
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => ({
      list: () => [...persisted.values()],
      get: (n) => persisted.get(n) || null,
      upsert: (e) => persisted.set(e.name, { ...(persisted.get(e.name) || {}), ...e }),
      remove: (n) => persisted.delete(n),
      setSessionId: () => {},
      setStripLevel: () => {},
      setLabel: () => {},
      markDigested: () => {},
    }),
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getAgentLibrary: () => ({ list: () => [], get: () => null }),
    getPromptLibrary: () => ({ list: () => [], get: () => null }),
    getPluginHooks: () => null,
    getPeerManager: () => null,
    getRemindScheduler: () => null,
    getNotifications: () => null,
    getTemplates: () => ({ list: () => [] }),
    getUserDataPath: () => root,
    resolveProxyBase: () => null,
    resolveProxyAgentId: ({ name }) => `clodex-${name}-test`,
    normalizeProxyBase: (v) => v,
    lastTranscriptWrite: () => null,
    memoryStore: { list: () => [], get: () => null },
    memoryLoad: require('../memory-load').createMemoryLoad({}),
    composeDigest: () => null,
    digestTiers: require('../memory-store').digestTiers,
    isDigested: () => true,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { static async isSocketLive() { return false; } start() {} stop() {} },
    JsonlWatcher: class { start() {} stop() {} },
    pty: {
      spawn: (_cmd, args) => {
        const rec = { args: [...args] };
        spawns.push(rec);
        return { onData() {}, onExit() {}, pid: 999, write: () => {}, kill() { if (mgr) mgr.sessions.delete(rec.name); } };
      },
    },
    notifyOS: () => {},
    stripLevelOf: () => 0,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    setupClaudeHook: (name) => createCliHooks({
      REGISTRY_DIR: root,
      memoryStore: { list: () => [] },
      getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
      nodeInterp: process.execPath,
    }).setupClaudeHook(name),
    setupCodexHook: () => {},
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkills: () => {}, cleanupAgentPlugin: () => {},
    writeClaudeDigestFile: () => true,
    teeBlindBackend: () => null,
    readEffectiveClaudeEnv: () => ({}),
    mergeSessionEnv,
    resolveTeam: () => null,
    strictMcpReason: () => null,
    scrubInheritedClaudeMarkers: (e) => e,
    writeAgentPlugin: () => null, effectiveInjectedAgents: () => [],
    effectiveInjectedSkills: () => [],
    unresolvedSubagentRefs: () => [],
    deliverSkills: () => null, skillDeliveryProviders: () => ['claude', 'codex'],
    whichBin: () => null,
    codexStatusLineArg: () => [],
    mergeCodexInstructions: (a) => ({ cleaned: [...a], append: null }),
    randBase36: () => 'abc123',
    spillToFile: () => null,
    enqueueOutbox: () => {},
    drainPending: () => [],
    countPending: () => 0,
    peekPending: () => [],
    hasActivePending: () => false,
    isAlive: () => false,
    scheduleTrayRefresh: () => {},
    refreshAppMenu: () => {},
    refreshTrayMenu: () => {},
    findProjectRoot: () => null,
    execBodyCap: () => 4096,
    unionEnabled: require('../scope-util').unionEnabled,
    intentEnabled: require('../intent-catalog').intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    intentEnabledForSeat: require('../intent-registry').intentEnabledForSeat,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fencedLines: require('../intent-scanner').fencedLines,
    isHumanPtyInput: require('../proxy-util').isHumanPtyInput,
    draftChunkSignal: require('../proxy-util').draftChunkSignal,
    InjectQueue: require('../inject-queue').InjectQueue,
    isInjectInFlight: require('../inject-queue').isInjectInFlight,
    canFireCompact: require('../inject-queue').canFireCompact,
    INJECT_BOOT_MAXWAIT: 0, INJECT_QUIET_MAXWAIT: 0, INJECT_QUIET_MS: 0,
    SHORT_TEXT_DELAY: 0, LONG_TEXT_DELAY: 0, LONG_TEXT_THRESHOLD: 1e9,
    COMPACT_CONTINUATION_DELAY: 0, INJECT_HOLD_TIMEOUT: 0, COMPACT_INFLIGHT_TIMEOUT: 300000,
  });
  const m = new SessionManager();
  mgr = m;
  const typed = [];
  const handoffs = [];
  const refreshes = [];
  const shadow = [];
  const msgs = [];
  m._sendToSession = () => {};
  m._broadcast = (ch, row) => { if (ch === 'ipc-message') msgs.push(row.body); };
  m._injectText = (_s, text) => { typed.push(text); };
  m._injectReloadHandoff = (_s, handoff) => { handoffs.push(handoff); };
  m.refreshPrompt = (...a) => { refreshes.push(a); return false; };
  m._shadowLog = (rec) => { shadow.push(rec); };
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
    clearTimeout(s._injectFlushRetry);
    clearTimeout(s._compactValveTimer);
    clearTimeout(s._postClearValveTimer);
  };
  return { m, spawns, typed, handoffs, refreshes, shadow, msgs, stop, persisted };
}

async function spawn(h, name) {
  await h.m.create(name, 'claude', os.tmpdir(), [], null, 'ws',
    null, false, null, [], [], [], [], [], null, [], [], null, null);
  h.spawns[h.spawns.length - 1].name = name;
  const s = h.m.sessions.get(name);
  assert.ok(s, 'ENTER: create() must have put a session in the map');
  assert.ok(s.promptRecipe, 'ENTER: create() captured a prompt recipe');
  return s;
}

function bakedBytes(root, name) {
  return fs.readFileSync(pathFor(root, name, 'appendPrompt'), 'utf8');
}

async function settle(h, count) {
  for (let i = 0; i < 300 && h.spawns.length < count; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
}

function moveTruth(h) {
  h.m._teamBlockFor = () => ({ teamBlock: 'NEW TEAM BLOCK', teamName: 't', resolvedTeam: null, missingPrompt: null });
}

test('clear with a pending delta on a claude seat: kill+create with no --resume, the body rides the reload handoff, refreshPrompt never fires', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'rx';
  const h = mkManager(root);
  try {
    const s = await spawn(h, name);
    const born = bakedBytes(root, name);
    moveTruth(h);
    assert.strictEqual(h.m._promptDeltaPending(name), true, 'ENTER: the moved team block is a pending delta');

    h.m._handleContextIntent(s, 'clear', 'pick up at step 3');
    await settle(h, 2);

    assert.strictEqual(h.spawns.length, 2, 'the clear respawned the CLI');
    assert.ok(!h.spawns[1].args.includes('--resume'), `a fresh bake, not a resume: ${h.spawns[1].args.join(' ')}`);
    assert.ok(!h.typed.includes('/clear'), 'no /clear typed on this path');
    assert.deepStrictEqual(h.handoffs, ['pick up at step 3']);
    assert.strictEqual(h.refreshes.length, 0, 'refreshPrompt(clear) belongs to the typed /clear edge, which this path never produces');
    assert.ok(h.shadow.some((r) => r.type === 'prompt-regen-at-clear' && r.agent === name && r.bytes > 0),
      `shadow row present: ${JSON.stringify(h.shadow)}`);
    assert.ok(h.msgs.includes('context clear → cold respawn (prompt regenerated)'));
    const fresh = bakedBytes(root, name);
    assert.notStrictEqual(fresh, born);
    assert.ok(fresh.includes('NEW TEAM BLOCK'), 'the fresh process boots on the regenerated prompt');
    assert.strictEqual(readCache(root, name, 'session'), fresh, 'bakePrompt(reuse=false) re-baselined session.md');
    assert.strictEqual(readCache(root, name, 'notified'), fresh);
    assert.strictEqual(readCache(root, name, 'delta'), null, 'and nothing is left staged');
    assert.strictEqual(readCache(root, name, 'next'), null);
    assert.strictEqual(h.m._promptDeltaPending(name), false, 'the seat now runs the current prompt');
  } finally { h.stop(name); }
});

test('clear without a pending delta: /clear typed, no kill, no create', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'rx';
  const h = mkManager(root);
  try {
    const s = await spawn(h, name);
    assert.strictEqual(h.m._promptDeltaPending(name), false, 'ENTER: nothing moved');

    h.m._handleContextIntent(s, 'clear', 'pick up at step 3');
    await settle(h, 1);

    assert.strictEqual(h.spawns.length, 1, 'no respawn');
    assert.strictEqual(h.m.sessions.get(name), s, 'the live session is untouched');
    assert.deepStrictEqual(h.typed, ['/clear']);
    assert.strictEqual(s._postClearContinuation, 'pick up at step 3', 'the body waits on the sessionId edge as before');
    assert.deepStrictEqual(h.handoffs, []);
    assert.ok(!h.shadow.some((r) => r.type === 'prompt-regen-at-clear'));
  } finally { h.stop(name); }
});

test('a staged delta.md alone (undelivered) counts as pending', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'rx';
  const h = mkManager(root);
  try {
    await spawn(h, name);
    assert.strictEqual(h.m._promptDeltaPending(name), false, 'ENTER');
    writeCache(root, name, 'delta', 'staged and not yet drained');
    assert.strictEqual(h.m._promptDeltaPending(name), true);
  } finally { h.stop(name); }
});

test('body-less clear with a pending delta: respawn, no handoff injected, no /clear typed', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'rx';
  const h = mkManager(root);
  try {
    const s = await spawn(h, name);
    moveTruth(h);

    h.m._handleContextIntent(s, 'clear', '');
    await settle(h, 2);

    assert.strictEqual(h.spawns.length, 2, 'the clear respawned the CLI');
    assert.ok(!h.spawns[1].args.includes('--resume'));
    assert.deepStrictEqual(h.handoffs, [], 'no body, no first turn: the seat boots idle');
    assert.deepStrictEqual(h.typed, []);
    assert.strictEqual(h.refreshes.length, 0);
  } finally { h.stop(name); }
});

test('codex seat with anything pending: /clear typed, never a respawn', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'cx';
  const h = mkManager(root);
  const s = { name, type: 'codex', agentType: 'codex', promptRecipe: { intents: null, extraArgs: [] }, _dead: false };
  h.m.sessions.set(name, s);
  h.persisted.set(name, { name, type: 'codex', cwd: os.tmpdir() });
  writeCache(root, name, 'delta', 'staged');
  writeCache(root, name, 'session', 'old');
  assert.strictEqual(h.m._promptDeltaPending(name), false, 'ENTER: the predicate is claude-only');

  h.m._handleContextIntent(s, 'clear', 'carry on');
  await settle(h, 0);

  assert.strictEqual(h.spawns.length, 0);
  assert.deepStrictEqual(h.typed, ['/clear']);
  assert.strictEqual(s._postClearContinuation, 'carry on');
  clearTimeout(s._postClearValveTimer);
});

test('a claude seat with no captured recipe or no cache is never pending', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'rx';
  const h = mkManager(root);
  try {
    const s = await spawn(h, name);
    moveTruth(h);
    assert.strictEqual(h.m._promptDeltaPending(name), true, 'ENTER');
    const recipe = s.promptRecipe;
    s.promptRecipe = null;
    assert.strictEqual(h.m._promptDeltaPending(name), false, 'no recipe: the second recipe is exactly what refreshPrompt refuses to build');
    s.promptRecipe = recipe;
    fs.unlinkSync(path.join(promptCacheDir(root, name), 'session.md'));
    assert.strictEqual(h.m._promptDeltaPending(name), false, 'no session.md: nothing recorded to compare against');
  } finally { h.stop(name); }
});

test('reload still goes through the same respawn and injects its handoff', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'rx';
  const h = mkManager(root);
  try {
    const s = await spawn(h, name);
    h.m._handleContextIntent(s, 'reload', 'briefing');
    await settle(h, 2);
    assert.strictEqual(h.spawns.length, 2);
    assert.ok(!h.spawns[1].args.includes('--resume'));
    assert.deepStrictEqual(h.handoffs, ['briefing']);
    assert.ok(h.msgs.includes('context reload → fresh restart'));
  } finally { h.stop(name); }
});

after(() => { setImmediate(() => process.exit(0)); });
