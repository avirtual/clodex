'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const pendingStore = require('../pending-store');
const crypto = require('node:crypto');
const { mkTmpRoot } = require('./lib/tmp-roots');

const IO_ARG = 24;

function boot() {
  const root = mkTmpRoot('clx-sop-');
  const PENDING_DIR = path.join(root, 'pending');
  const store = new Map();
  const sends = new Map();
  const lines = new Map();
  const closes = new Map();
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
      closes.set(who, opts.onClose);
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
    intentEnabledForSeat: require('../intent-registry').intentEnabledForSeat,
    parkDelivery: pendingStore.parkDelivery,
    drainPending: pendingStore.drainPending,
    countPending: pendingStore.countPending,
    peekPending: pendingStore.peekPending,
    hasActivePending: pendingStore.hasActivePending,
    claimParkedByKey: pendingStore.claimParkedByKey,
    claimParkedById: pendingStore.claimParkedById,
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
  const spawn = async (name, io) => {
    pending = name;
    const args = [name, 'claude', root, [], null, 'ws'];
    args[IO_ARG] = io;
    await m.create(...args);
    return m.sessions.get(name);
  };
  return {
    m, root, PENDING_DIR, logs, sends, persistence,
    close: (n, code = 1) => closes.get(n)(code, null),
    setPending: (n) => { pending = n; },
    spawn,
    emit: (n, obj) => lines.get(n)(obj),
    parked: (n) => {
      let files = [];
      try { files = fs.readdirSync(path.join(PENDING_DIR, n)).filter((f) => f.endsWith('.json') && !f.endsWith('.passive.json')).sort(); } catch { return []; }
      return files.map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(PENDING_DIR, n, f), 'utf8')) }));
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

async function busySeat(app, name) {
  const s = await app.spawn(name, 'stream');
  assert.strictEqual(s.io, 'stream', 'ENTER: the seat spawned with stream io');
  assert.strictEqual(typeof s.createdAt, 'number', 'ENTER: the seat has a createdAt');
  s.streamBusy = true;
  s.activityState = 'thinking';
  return s;
}

const key = (sender, body) => crypto.createHash('sha256').update(`${sender}\n${body}`).digest('hex').slice(0, 16);

test('_parkStreamOutbox: a dm queued on a busy stream seat is parked with its key and born when the stream dies', async () => {
  const app = boot();
  try {
    const s = await busySeat(app, 'sx');
    app.m._deliverMessage('sx', 'lead', 'queued-body-4410', 'dm', '', null, 'key-4410');
    assert.strictEqual(s.outbox.length, 1, 'ENTER: the dm waits in the outbox');
    app.close('sx');
    assert.strictEqual(app.m.sessions.has('sx'), false, 'ENTER: the seat is gone');
    const files = app.parked('sx');
    assert.strictEqual(files.length, 1);
    assert.match(files[0].text, /queued-body-4410/);
    assert.strictEqual(files[0].key, 'key-4410');
    assert.strictEqual(files[0].born, s.createdAt);
  } finally { app.stop(); }
});

test('the park lands before _cleanup drops the seat, so an exit wait sees the file', async () => {
  const app = boot();
  try {
    await busySeat(app, 'sx');
    app.m._deliverMessage('sx', 'lead', 'order-body-5521', 'dm', '', null, 'key-5521');
    const seen = [];
    const real = app.m._cleanup.bind(app.m);
    app.m._cleanup = (n) => { seen.push(app.parked(n).map((f) => f.key)); return real(n); };
    app.close('sx');
    assert.deepStrictEqual(seen, [['key-5521']]);
  } finally { app.stop(); }
});

test('a resend to a busy stream seat that then dies leaves the same id parked', async () => {
  const app = boot();
  try {
    const s = await busySeat(app, 'sx');
    pendingStore.parkDelivery(app.PENDING_DIR, 'sx', '[agent:from lead] resend-body-6631', '1000.000000001', 'abcde', false, s.createdAt, 'key-6631');
    app.persistence.upsert({ name: 'lead', intents: ['resend'] });
    await app.m._handleIntent('lead', { type: 'resend', id: 'abcde' });
    assert.deepStrictEqual(app.parked('sx'), [], 'ENTER: the resend claimed the parked file');
    assert.strictEqual(s.outbox.length, 1, 'ENTER: _streamEnqueue queued the resend behind the busy turn');
    app.close('sx');
    const files = app.parked('sx');
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].id, 'abcde');
    assert.match(files[0].file, /\.abcde\.json$/);
    assert.strictEqual(files[0].key, 'key-6631');
    assert.match(files[0].text, /resend-body-6631/);
  } finally { app.stop(); }
});

test('an urgent dm that superseded a parked copy is parked once under the same key when the stream dies', async () => {
  const app = boot();
  try {
    const s = await busySeat(app, 'sx');
    const body = 'urgent-body-7742';
    pendingStore.parkDelivery(app.PENDING_DIR, 'sx', `[agent:from lead] ${body}`, '1000.000000002', 'fghij', false, s.createdAt, key('lead', body));
    const r = app.m._gatedDeliver('sx', 'lead', body, true);
    assert.ok(r.superseded && r.superseded.claimed === 1, 'ENTER: the urgent dm claimed the parked copy');
    assert.strictEqual(s.outbox.length, 1, 'ENTER: the urgent dm waits in the outbox');
    app.close('sx');
    const files = app.parked('sx');
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].key, key('lead', body));
    assert.match(files[0].text, /urgent-body-7742/);
  } finally { app.stop(); }
});

test('a deleted stream seat parks nothing and logs the drop', async () => {
  const app = boot();
  try {
    await busySeat(app, 'sx');
    app.m._deliverMessage('sx', 'lead', 'deleted-body-8853', 'dm', '', null, 'key-8853');
    app.m._markDropHeld('sx');
    app.close('sx');
    assert.deepStrictEqual(app.parked('sx'), []);
    assert.ok(app.logs.some((l) => l.level === 'info' && l.msg === 'dropped 1 queued outbox item(s) for sx: seat deleted'));
  } finally { app.stop(); }
});

test('an operator outbox item is not parked and its drop is logged', async () => {
  const app = boot();
  try {
    const s = await busySeat(app, 'sx');
    app.m._deliverMessage('sx', 'user', 'operator-body-9964', 'dm');
    assert.strictEqual(s.outbox[0].origin, 'operator', 'ENTER: the item is an operator item');
    app.close('sx');
    assert.deepStrictEqual(app.parked('sx'), []);
    assert.ok(app.logs.some((l) => l.level === 'info' && l.msg === 'dropped 1 operator outbox item(s) for sx: seat exited code=1'));
  } finally { app.stop(); }
});

test('an unproduced producer item is parked by its fallback text and its claim never runs', async () => {
  const app = boot();
  try {
    const s = await busySeat(app, 'sx');
    let ran = 0;
    app.m._injectText(s, '', { produce: () => { ran++; return 'produced-1075'; }, fallback: () => 'fallback-body-1075', parkKey: 'key-1075' });
    app.m._injectText(s, '', { produce: () => { ran++; return 'produced-1076'; } });
    assert.strictEqual(s.outbox.length, 2, 'ENTER: both producers wait in the outbox');
    app.close('sx');
    assert.strictEqual(ran, 0);
    const files = app.parked('sx');
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].text, 'fallback-body-1075');
    assert.strictEqual(files[0].key, 'key-1075');
    assert.ok(app.logs.some((l) => l.level === 'info' && l.msg === 'dropped an unproduced outbox item for sx: no fallback'));
  } finally { app.stop(); }
});

test('a queued slash command is dropped with a log line, not re-parked', async () => {
  const app = boot();
  try {
    const s = await busySeat(app, 'sx');
    app.m._injectText(s, '/compact', { bypassHold: true });
    assert.strictEqual(s.outbox.length, 1, 'ENTER: the slash command waits in the outbox');
    app.close('sx');
    assert.deepStrictEqual(app.parked('sx'), []);
    assert.ok(app.logs.some((l) => l.level === 'warn' && l.msg === 'dropped a queued slash command for sx instead of re-parking it'));
  } finally { app.stop(); }
});

test('a re-parked dm tells its caller parked, never injected, and logs its dropped images', async () => {
  const app = boot();
  try {
    const s = await busySeat(app, 'sx');
    const heard = [];
    app.m._deliverMessage('sx', 'lead', 'divert-body-2186', 'dm', '', (...a) => heard.push(a), 'key-2186', [{ data: 'AAAA', mediaType: 'image/png' }]);
    assert.strictEqual(s.outbox.length, 1, 'ENTER: the dm waits in the outbox');
    app.close('sx');
    assert.strictEqual(app.parked('sx').length, 1);
    assert.deepStrictEqual(heard, [['parked', 'dead']]);
    assert.ok(app.logs.some((l) => l.level === 'warn' && /^re-parked a queued outbox item for sx \(seat exited code=1, \d+ chars, 1 image\(s\) dropped\)$/.test(l.msg)));
  } finally { app.stop(); }
});
