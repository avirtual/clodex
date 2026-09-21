'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionManager } = require('../../session-manager');
const { createCliHooks } = require('../../cli-hooks');
const { pathFor, runDirFor } = require('../../clodex-paths');
const { bakePrompt, promptCacheDir, readCache, ipcDelta } = require('../../ipc-prompt-cache');
const { mergeSessionEnv } = require('../../env-scopes');

function mkManager(root, overrides = {}) {
  const persisted = new Map();
  const spawns = [];
  const watchers = [];
  let sids = 0;
  let mgr = null;
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: root,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    fs, path, os,
    pathFor, runDirFor,
    buildIpcPrompt: require('../../ipc-prompt').buildIpcPrompt,
    mergeClaudeSystemPrompt: require('../../argv-merge').mergeClaudeSystemPrompt,
    readAppendBodies: () => [],
    resolveSystemPromptFile: () => null,
    pluginGrammarLines: () => [],
    bakePrompt, promptCacheDir, readCache,
    ipcDelta: overrides.ipcDelta || ipcDelta,
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => ({
      list: () => [...persisted.values()],
      get: (n) => persisted.get(n) || null,
      upsert: (e) => persisted.set(e.name, { ...(persisted.get(e.name) || {}), ...e }),
      remove: (n) => persisted.delete(n),
      setSessionId: (n, sid) => { const e = persisted.get(n); if (e) e.sessionId = sid; },
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
    memoryLoad: require('../../memory-load').createMemoryLoad({}),
    composeDigest: () => null,
    digestTiers: require('../../memory-store').digestTiers,
    isDigested: () => true,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { static async isSocketLive() { return false; } start() {} stop() {} },
    JsonlWatcher: class {
      constructor(name, _onText, onSessionId, _onActivity, onCompact) {
        this.name = name; this.onSessionId = onSessionId; this.onCompact = onCompact;
        const args = spawns.length ? spawns[spawns.length - 1].args : [];
        const at = args.indexOf('--resume');
        this.sid = at >= 0 ? args[at + 1] : `sid-${++sids}`;
        watchers.push(this);
      }
      start() { this.onSessionId(this.sid); }
      stop() {}
    },
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
    unionEnabled: require('../../scope-util').unionEnabled,
    intentEnabled: require('../../intent-catalog').intentEnabled,
    withoutPrivilegedIntentsFor: require('../../intent-registry').withoutPrivilegedIntentsFor,
    bodyModeFor: require('../../intent-registry').bodyModeFor,
    intentEnabledFor: require('../../intent-registry').intentEnabledFor,
    intentEnabledForSeat: require('../../intent-registry').intentEnabledForSeat,
    pluginRowFor: require('../../intent-registry').pluginRowFor,
    validIntentNames: require('../../intent-registry').validIntentNames,
    fencedLines: require('../../intent-scanner').fencedLines,
    isHumanPtyInput: require('../../proxy-util').isHumanPtyInput,
    draftChunkSignal: require('../../proxy-util').draftChunkSignal,
    InjectQueue: require('../../inject-queue').InjectQueue,
    isInjectInFlight: require('../../inject-queue').isInjectInFlight,
    canFireCompact: require('../../inject-queue').canFireCompact,
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
  return { m, spawns, watchers, typed, handoffs, refreshes, shadow, msgs, stop, persisted };
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


module.exports = { mkManager, spawn, bakedBytes, settle, moveTruth };
