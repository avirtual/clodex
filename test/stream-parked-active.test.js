'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const pendingStore = require('../pending-store');
const { reviewBeginLine } = require('../ticket-review-scope');
const { mkTmpRoot } = require('./lib/tmp-roots');

const IO_ARG = 24;

function boot() {
  const root = mkTmpRoot('clx-spa-');
  const PENDING_DIR = path.join(root, 'pending');
  const store = new Map();
  const sends = new Map();
  const lines = new Map();
  const logs = [];
  let pending = null;
  const persistence = {
    list: () => [...store.values()],
    get: (n) => store.get(n) || null,
    upsert: (e) => store.set(e.name, { ...(store.get(e.name) || {}), ...e }),
    remove: (n) => store.delete(n),
    setSessionId: () => {}, setStripLevel: () => {}, setLabel: () => {},
    setArchived: () => {}, setRosterSent: () => {}, setAutoCompact: () => {},
  };
  const rec = (level) => (scope, msg) => logs.push({ level, scope, msg: String(msg) });
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: root,
    fs, path, pathFor, runDirFor, os,
    PENDING_DIR,
    MSG_DIR: path.join(root, 'messages'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => persistence,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => root,
    getTemplates: () => ({ list: () => [] }),
    resolveProxyBase: () => null,
    resolveProxyAgentId: () => null,
    normalizeProxyBase: (v) => v,
    randBase36: (n) => 'x'.repeat(n),
    lastTranscriptWrite: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { start() {} stop() {} },
    JsonlWatcher: class { start() {} stop() {} },
    pty: { spawn: () => ({ onData() {}, onExit() {}, pid: 999, kill() {}, write() {}, resize() {} }) },
    spawnStreamSeat: (opts) => {
      const who = pending;
      sends.set(who, []);
      lines.set(who, opts.onLine);
      return {
        pid: 7001, startedAt: 1, startTime: 1, stderrTail: '',
        send: (obj) => { sends.get(who).push(obj); return Promise.resolve(); },
        close() {}, kill() {},
      };
    },
    notifyOS: () => {},
    log: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
    resolveTeam: () => ({ name: 'crew', lead: 'lead', root, roles: { reviewer: {} } }),
    findProjectRoot: () => null,
    setupClaudeHook: () => path.join(root, 'settings.json'),
    setupCodexHook: (name) => fs.mkdirSync(runDirFor(root, name), { recursive: true }),
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkills: () => {}, cleanupAgentPlugin: () => {},
    writeClaudeDigestFile: () => false,
    buildIpcPrompt: () => '',
    bakePrompt: () => '',
    teeBlindBackend: () => null,
    readEffectiveClaudeEnv: () => ({}),
    mergeSessionEnv: () => ({ ...process.env }),
    strictMcpReason: () => null,
    scrubInheritedClaudeMarkers: (e) => e,
    resolveSystemPromptFile: () => null,
    withoutPrivilegedIntentsFor: (x) => x,
    mergeClaudeSystemPrompt: require('../argv-merge').mergeClaudeSystemPrompt,
    readAppendBodies: () => [], pluginGrammarLines: () => [],
    getAgentLibrary: () => ({ list: () => [] }),
    getPromptLibrary: () => ({ raw: () => null }),
    writeAgentPlugin: () => null, effectiveInjectedAgents: () => [], effectiveInjectedSkills: () => [],
    unresolvedSubagentRefs: () => [], deliverSkills: () => null, skillDeliveryProviders: () => ['claude', 'codex'],
    unionEnabled: require('../scope-util').unionEnabled,
    intentEnabled: require('../intent-catalog').intentEnabled,
    parkDelivery: pendingStore.parkDelivery,
    drainPending: pendingStore.drainPending,
    countPending: pendingStore.countPending,
    peekPending: pendingStore.peekPending,
    hasActivePending: pendingStore.hasActivePending,
    claimParkedByKey: pendingStore.claimParkedByKey,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    shouldHoldDm: require('../proxy-util').shouldHoldDm,
    peerStatusLabel: require('../proxy-util').peerStatusLabel,
    InjectQueue: require('../inject-queue').InjectQueue,
    whichBin: () => null,
    codexStatusLineArg: () => [],
    mergeCodexInstructions: (a) => ({ cleaned: [...a], merged: '' }),
    spillToFile: () => null,
    isAlive: () => false,
    scheduleTrayRefresh: () => {}, refreshAppMenu: () => {}, refreshTrayMenu: () => {},
    INJECT_BOOT_MAXWAIT: 30, INJECT_QUIET_MAXWAIT: 0, INJECT_QUIET_MS: 0,
    SHORT_TEXT_DELAY: 0, LONG_TEXT_DELAY: 0, LONG_TEXT_THRESHOLD: 1e9,
    INJECT_HOLD_TIMEOUT: 60_000,
    DEFAULT_WORKSPACE_ID: 'default',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
  });

  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  m._applyTemplatePersistence = () => {};
  m._gatedDeliver = (target, sender, body, urgent, tag, onWrite) => {
    if (typeof onWrite === 'function') onWrite();
    return { queued: true };
  };
  const enqueued = [];
  const realEnqueue = m._streamEnqueue.bind(m);
  m._streamEnqueue = (s, item, ...rest) => {
    enqueued.push({ seat: s.name, text: item.text, produce: rest[1] || null });
    return realEnqueue(s, item, ...rest);
  };
  const streamSeats = new Set();
  const realCreate = m.create.bind(m);
  m.create = (...a) => {
    if (streamSeats.has(a[0])) a[IO_ARG] = 'stream';
    return realCreate(...a);
  };
  const spawn = async (name, io) => {
    pending = name;
    const args = [name, 'claude', root, [], null, 'ws'];
    args[IO_ARG] = io;
    await realCreate(...args);
    return m.sessions.get(name);
  };
  return {
    m, root, PENDING_DIR, enqueued, logs, sends, streamSeats,
    setPending: (n) => { pending = n; },
    spawn,
    emit: (n, obj) => lines.get(n)(obj),
    parkedFiles: (n) => {
      try { return fs.readdirSync(path.join(PENDING_DIR, n)).filter((f) => f.endsWith('.json') && !f.endsWith('.passive.json')); } catch { return []; }
    },
    stop: () => {
      for (const s of m.sessions.values()) {
        try { if (s.sentinel) s.sentinel.stop(); } catch {}
        try { if (s.watcher) s.watcher.stop(); } catch {}
        try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
        s._dead = true;
        for (const k of ['_bootDrainTimer', '_injectHoldTimer', '_bootSettleTimer', '_parkCapTimer', '_replayFallbackTimer',
          '_parkedDrainFallbackTimer', '_reviewStartTimer', '_streamInitTimer', '_streamHoldTimer', '_resultHold']) clearTimeout(s[k]);
      }
    },
  };
}

async function settled(app, name, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (app.m.sessions.has(name)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('_deliverParkedActive on a stream claude seat is one stream enqueue: no park file, no fallback timer', async () => {
  const app = boot();
  try {
    const s = await app.spawn('sx', 'stream');
    assert.strictEqual(s.io, 'stream', 'ENTER: the seat spawned with stream io');
    assert.strictEqual(s.agentType, 'claude', 'ENTER: and is a claude seat');
    app.enqueued.length = 0;
    app.m._deliverParkedActive('sx', 'lead', 'start-line-body-7781', 'dm');
    const mine = app.enqueued.filter((e) => e.seat === 'sx');
    assert.strictEqual(mine.length, 1);
    assert.match(mine[0].text, /start-line-body-7781/);
    assert.deepStrictEqual(app.parkedFiles('sx'), []);
    assert.ok(!s._parkedDrainFallbackTimer);
    assert.ok(app.logs.some((l) => l.level === 'debug' && l.msg === 'parked-active → stream enqueue for sx'));
  } finally { app.stop(); }
});

test('_deliverParkedActive on a pty claude seat still parks and arms the fallback', async () => {
  const app = boot();
  try {
    const s = await app.spawn('px', 'pty');
    assert.strictEqual(s.io, 'pty', 'ENTER: the seat spawned with pty io');
    const before = app.parkedFiles('px').length;
    app.m._deliverParkedActive('px', 'lead', 'pty-body-1203', 'dm');
    assert.strictEqual(app.parkedFiles('px').length, before + 1);
    assert.ok(s._parkedDrainFallbackTimer);
    assert.deepStrictEqual(app.enqueued.filter((e) => e.seat === 'px'), []);
  } finally { app.stop(); }
});

test('team-review onto a stream reviewer enqueues the begin line, and the re-nudge enqueues too', async () => {
  const app = boot();
  try {
    await app.spawn('lead', 'pty');
    const lead = app.m.sessions.get('lead');
    app.streamSeats.add('crew-reviewer-1');
    app.setPending('crew-reviewer-1');
    app.m._handleTeamReview(lead, 'diff at /tmp/x.diff against abc123');
    await settled(app, 'crew-reviewer-1');
    const s = app.m.sessions.get('crew-reviewer-1');
    assert.ok(s, 'ENTER: the reviewer spawned');
    assert.strictEqual(s.io, 'stream', 'ENTER: as a stream seat');
    const prefix = reviewBeginLine('claude').slice(0, 32);
    const begins = app.enqueued.filter((e) => e.seat === 'crew-reviewer-1' && e.text.includes(prefix));
    assert.strictEqual(begins.length, 1);
    assert.deepStrictEqual(app.parkedFiles('crew-reviewer-1'), []);
    assert.ok(!s._parkedDrainFallbackTimer);

    app.enqueued.length = 0;
    s.activityState = 'idle';
    app.m._checkReviewStarted(s, 'lead');
    assert.ok(s._reviewNudgeRetried, 'ENTER: the first window took the re-nudge branch');
    const renudge = app.enqueued.filter((e) => e.seat === 'crew-reviewer-1' && /ignore this if you have already started/.test(e.text));
    assert.strictEqual(renudge.length, 1);
    assert.deepStrictEqual(app.parkedFiles('crew-reviewer-1'), []);
  } finally { app.stop(); }
});

test('_drainPendingAtStreamInit: stream init drains files parked before it through the stream outbox, in seq order', async () => {
  const app = boot();
  try {
    const s = await app.spawn('sd', 'stream');
    pendingStore.parkDelivery(app.PENDING_DIR, 'sd', 'first-parked-4410', 1, null, false, app.m._bornFor('sd'));
    pendingStore.parkDelivery(app.PENDING_DIR, 'sd', 'second-parked-4411', 2, null, false, app.m._bornFor('sd'));
    assert.strictEqual(app.parkedFiles('sd').length, 2, 'ENTER: two active files are parked');
    app.enqueued.length = 0;
    app.emit('sd', { type: 'system', subtype: 'init', session_id: 'sess-sd' });
    assert.strictEqual(app.enqueued.filter((e) => e.seat === 'sd' && e.produce).length, 1);
    s.streamBusy = false;
    app.m._streamTurnEnd(s);
    const text = JSON.stringify(app.sends.get('sd'));
    const a = text.indexOf('first-parked-4410');
    const b = text.indexOf('second-parked-4411');
    assert.ok(a >= 0 && b > a, `both bodies delivered in order: ${text.slice(0, 400)}`);
    assert.deepStrictEqual(app.parkedFiles('sd'), []);
  } finally { app.stop(); }
});

test('_armParkedDrainFallback and _drainPendingAtBootReady are no-ops on a stream seat', async () => {
  const app = boot();
  try {
    const s = await app.spawn('sf', 'stream');
    pendingStore.parkDelivery(app.PENDING_DIR, 'sf', 'parked-9001', 1, null, false, app.m._bornFor('sf'));
    const before = app.logs.length;
    app.m._armParkedDrainFallback(s, 'whatever.json', 30, Date.now() + 90);
    assert.ok(!s._parkedDrainFallbackTimer);
    assert.strictEqual(s._parkedDrainFallbackFiles, undefined);
    app.m._drainPendingAtBootReady(s);
    assert.strictEqual(s._injectPtyQueue, undefined);
    assert.strictEqual(app.parkedFiles('sf').length, 1);
    assert.deepStrictEqual(app.logs.slice(before), []);
  } finally { app.stop(); }
});
