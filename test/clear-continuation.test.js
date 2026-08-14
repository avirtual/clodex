// Run: node --test
// `[agent:context clear] <body>` — the body is injected as turn-one in the FRESH
// conversation. Driven end-to-end through a real create(): the fire point is the
// sessionId-CHANGE edge inside create()'s onSessionId closure, so a test that
// called _firePostClearContinuation directly would stay green with that call
// deleted — which is the whole wiring. The fake JsonlWatcher captures the real
// closure; _injectText is captured (text AND options) because bypassHold is a
// behavioural difference between the /clear command and its continuation.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');

function mkManager(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-clearcont-'));
  const watchers = [];
  const injected = [];
  const broadcasts = [];
  const warns = [];
  const persisted = new Map();

  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    fs, path, pathFor, runDirFor,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => ({
      list: () => [...persisted.values()],
      get: (n) => persisted.get(n) || null,
      upsert: (e) => persisted.set(e.name, { ...(persisted.get(e.name) || {}), ...e }),
      remove: (n) => persisted.delete(n),
      setSessionId: () => {},
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
    getUserDataPath: () => os.tmpdir(),
    resolveProxyBase: () => null,
    resolveProxyAgentId: () => null,
    normalizeProxyBase: (v) => v,
    lastTranscriptWrite: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    digestTiers: () => ({ full: [], title: [] }),
    isDigested: () => true,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { static async isSocketLive() { return false; } start() {} stop() {} },
    JsonlWatcher: class {
      constructor(name, onText, onSessionId, onActivity, onCompactSummary) {
        watchers.push({ name, onSessionId, onCompactSummary });
      }
      start() {} stop() {}
    },
    pty: { spawn: () => ({ onData() {}, onExit() {}, pid: 999, write() {} }) },
    os,
    notifyOS: () => {},
    log: { info: () => {}, warn: (...a) => warns.push(a.join(' ')), error: () => {}, debug: () => {} },
    setupClaudeHook: () => path.join(root, 'settings.json'),
    setupCodexHook: () => {},
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkillPlugin: () => {}, cleanupAgentPlugin: () => {},
    writeClaudeDigestFile: () => true,
    buildIpcPrompt: () => '',
    bakePrompt: () => '',
    teeBlindBackend: () => null,
    readEffectiveClaudeEnv: () => ({}),
    mergeSessionEnv: () => ({ ...process.env }),
    resolveTeam: () => null,
    strictMcpReason: () => null,
    scrubInheritedClaudeMarkers: (e) => e,
    resolveSystemPromptFile: () => null,
    mergeClaudeSystemPrompt: (a) => ({ cleaned: [...a], append: null }),
    readAppendBodies: () => [],
    pluginGrammarLines: () => [],
    writeAgentPlugin: () => null, effectiveInjectedAgents: () => [],
    effectiveInjectedSkills: () => [],
    unresolvedSubagentRefs: () => [],
    // Real pure leaves: the body-capture mode for `context clear` is part of what
    // this ticket changed, so a stub would test the stub.
    unionEnabled: require('../scope-util').unionEnabled,
    intentEnabled: require('../intent-catalog').intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fencedLines: require('../intent-scanner').fencedLines,
    parseIntent: require('../intent-scanner').parseIntent,
    looksLikeIntent: require('../intent-scanner').looksLikeIntent,
    // Every wait driven to 0: the boot-readiness gate polls until a real
    // mode-2004 byte latches, which never arrives from a fake PTY, and the
    // production caps would keep the loop alive forever (file goes green, then
    // hangs — indistinguishable from a deadlock inside the full suite).
    INJECT_BOOT_MAXWAIT: 0,
    INJECT_QUIET_MAXWAIT: 0,
    INJECT_QUIET_MS: 0,
    SHORT_TEXT_DELAY: 0,
    LONG_TEXT_DELAY: 0,
    LONG_TEXT_THRESHOLD: 1e9,
    COMPACT_CONTINUATION_DELAY: 0,
    COMPACT_INFLIGHT_TIMEOUT: 60_000,
    INJECT_HOLD_TIMEOUT: 60_000,
    InjectQueue: require('../inject-queue').InjectQueue,
    isInjectInFlight: require('../inject-queue').isInjectInFlight,
    canFireCompact: require('../inject-queue').canFireCompact,
    writeSkillPlugin: () => {},
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
    ...overrides,
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = (ch, msg) => broadcasts.push(msg);
  m._injectText = (s, text, opts) => injected.push({ text, opts: opts || null });

  // create() leaves an fs.watch handle and timers behind; without this the file
  // reports green and then HANGS.
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
    clearTimeout(s._injectFlushRetry);
    clearTimeout(s._compactValveTimer);
    clearTimeout(s._postClearValveTimer);
    clearTimeout(s._injectHoldTimer);
  };
  return { m, root, watchers, injected, broadcasts, warns, stop };
}

async function spawned(h, name = 'a') {
  await h.m.create(name, 'claude', os.tmpdir(), [], null, 'ws');
  const s = h.m.sessions.get(name);
  assert.ok(s, 'ENTER: create() must have put a session in the map');
  const w = h.watchers.find((x) => x.name === name);
  assert.ok(w && w.onSessionId, 'ENTER: create() must have handed the watcher a session-id callback');
  return { s, w };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('clear continuation: fires on the sessionId CHANGE, not on the first id and not on a repeat', async () => {
  const h = mkManager();
  try {
    const { s, w } = await spawned(h);
    h.m._handleContextIntent(s, 'clear', 'pick up the thread: @/tmp/handoff.md');

    assert.deepStrictEqual(h.injected, [{ text: '/clear', opts: { bypassHold: true } }],
      'the /clear command still injects immediately, with bypassHold');
    assert.strictEqual(s._postClearContinuation, 'pick up the thread: @/tmp/handoff.md');
    assert.ok(s._postClearValveTimer, 'valve armed with the continuation');

    // First observed id is an ADOPTION (the watcher resolving the symlink for the
    // first time), not a clear. Firing here would inject the briefing into the
    // conversation the agent is still mid-turn in.
    w.onSessionId('conv-1');
    await tick();
    assert.strictEqual(h.injected.length, 1, 'the first id is not a change');
    w.onSessionId('conv-1');
    await tick();
    assert.strictEqual(h.injected.length, 1, 'a repeat of the same id is not a change');

    // /compact keeps the id, /clear mints a new one — this is the edge.
    w.onSessionId('conv-2');
    await tick();
    assert.deepStrictEqual(h.injected[1], { text: 'pick up the thread: @/tmp/handoff.md', opts: null },
      'the continuation rides the NORMAL inject path — bypassHold exists for the bare slash command, '
      + 'not for prose, and skipping the quiet gate would let it splice into a human draft');
    assert.strictEqual(h.injected.length, 2);
    assert.strictEqual(s._postClearContinuation, null, 'consumed, not left armed for the next clear');
    assert.strictEqual(s._postClearValveTimer, null, 'valve disarmed on fire');

    // And it is genuinely one-shot: a later clear (operator-driven, no body)
    // must not replay it.
    w.onSessionId('conv-3');
    await tick();
    assert.strictEqual(h.injected.length, 2, 'a second edge replays nothing');
  } finally { h.stop('a'); }
});

// Keep-warm's /clear handover hangs off this same callback, and the reason it
// has to be tested HERE rather than by calling the handover method directly is
// that the defect was never in the method — it was in which edge invoked it. The
// wire's turn.completed rotation guard compares s.sessionId against the turn's
// id, and the assignment in this callback has already made them equal by then,
// so on an ordinary clear that guard never fires. A test that calls the method
// itself cannot see that; driving the real watcher callback can.
test('clear continuation: a clear ends the OLD conversation keep-warm hold and reopens the re-arm gate', async () => {
  const h = mkManager();
  try {
    const { s, w } = await spawned(h);
    const ended = [];
    h.m._holdKeeper = {
      endSession: (sid) => { ended.push(sid); return { session: sid, holdDisarmed: true }; },
    };
    // The gate as _maybeRearmHold leaves it after the seat's first main-line
    // turn: latched true in every case, including "nothing persisted". Only a
    // clear reopens it, so if this edge misses, the new conversation is never
    // armed until the app restarts.
    s._holdRearmed = true;

    w.onSessionId('conv-1');
    await tick();
    assert.deepStrictEqual(ended, [], 'the first id is an adoption, not a clear — no hold to end');
    assert.strictEqual(s._holdRearmed, true, 'and an adoption must not reopen the gate');

    w.onSessionId('conv-2');
    await tick();
    assert.deepStrictEqual(ended, ['conv-1'],
      'the OLD id is what gets ended — the keeper is keyed on it, and nothing else '
      + 'ever disarms a perpetual hold, so ending the new one would strand the old forever');
    assert.strictEqual(s.sessionId, 'conv-2');
    assert.strictEqual(s._holdRearmed, false,
      'gate reopened, so the next main-line turn re-arms the new conversation');
  } finally { h.stop('a'); }
});

// The two handover sites in one test, which is the only place the interleaving
// is visible: onSessionId records what the seat left, the wire's backstop reads
// it. Neither seam alone can show that a turn still in flight from the cleared
// conversation does not undo the handover that just happened.
test('clear continuation: an in-flight turn from the cleared conversation cannot undo the handover', async () => {
  const h = mkManager();
  try {
    const { s, w } = await spawned(h);
    const ended = [];
    h.m._holdKeeper = { endSession: (sid) => { ended.push(sid); return { session: sid, holdDisarmed: true }; } };
    h.m._shadowLog = () => {};

    w.onSessionId('conv-1');
    await tick();
    w.onSessionId('conv-2');
    await tick();
    assert.deepStrictEqual(ended, ['conv-1'], 'ENTER: the handover ran at all');
    assert.strictEqual(s._holdRearmed, false, 'ENTER: and reopened the gate');

    // Now the wire's backstop, reached by a turn.completed carrying the id the
    // clear discarded. Without the guard this ends conv-2's hold — the one the
    // handover just installed — and walks s.sessionId backwards, leaving an idle
    // seat cold until the operator returns.
    h.m._onWireSessionRotated(s, 'a', 'conv-1');

    assert.deepStrictEqual(ended, ['conv-1'], 'no second endSession — conv-2 keeps the hold');
    assert.strictEqual(s.sessionId, 'conv-2', 'and the seat is still on the live conversation');
  } finally { h.stop('a'); }
});

test('clear continuation: a BODYLESS clear behaves exactly as it did before — nothing stored, nothing fired', async () => {
  const h = mkManager();
  try {
    const { s, w } = await spawned(h);
    h.m._handleContextIntent(s, 'clear', '');

    assert.deepStrictEqual(h.injected, [{ text: '/clear', opts: { bypassHold: true } }]);
    assert.strictEqual(s._postClearContinuation, undefined, 'no continuation state on a bare clear');
    assert.ok(!s._postClearValveTimer, 'no valve armed — nothing to expire');

    w.onSessionId('conv-1');
    w.onSessionId('conv-2');
    await tick();
    assert.strictEqual(h.injected.length, 1, 'the edge injects nothing when no body was passed');

    // Whitespace-only is bodyless too: `[agent:context clear] ` must not arm a
    // valve that later logs a dropped continuation nobody wrote.
    h.injected.length = 0;
    h.m._handleContextIntent(s, 'clear', '   \n  ');
    assert.strictEqual(s._postClearContinuation, undefined);
    assert.ok(!s._postClearValveTimer);
  } finally { h.stop('a'); }
});

test('clear continuation: the valve drops a stranded continuation and the edge then fires NOTHING', async () => {
  const h = mkManager({ COMPACT_INFLIGHT_TIMEOUT: 1 });
  try {
    const { s, w } = await spawned(h);
    h.m._handleContextIntent(s, 'clear', 'stale briefing');
    assert.ok(s._postClearValveTimer, 'ENTER: something must be armed to strand');

    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(s._postClearContinuation, null, 'valve dropped the stranded continuation');
    assert.ok(h.warns.some((x) => /clear a release valve fired/.test(x)),
      'a silent drop is the failure mode the log exists for');
    assert.ok(h.broadcasts.some((b) => /continuation dropped/.test(b.body)),
      'surfaced in the IPC log, not just the dev console');

    // The point of the valve: the NEXT id change may be an operator's manual
    // /clear minutes later, and a stale briefing landing in an unrelated
    // conversation is worse than a lost one.
    h.injected.length = 0;
    w.onSessionId('conv-1');
    w.onSessionId('conv-2');
    await tick();
    assert.deepStrictEqual(h.injected, [], 'the dropped continuation cannot fire on a later clear');
  } finally { h.stop('a'); }
});

test('clear continuation: a second clear while one is armed is DROPPED, first body intact', async () => {
  const h = mkManager();
  try {
    const { s, w } = await spawned(h);
    h.m._handleContextIntent(s, 'clear', 'first briefing');
    h.m._handleContextIntent(s, 'clear', 'second briefing');

    assert.deepStrictEqual(h.injected, [{ text: '/clear', opts: { bypassHold: true } }],
      'the second /clear is not injected at all');
    assert.strictEqual(s._postClearContinuation, 'first briefing',
      'the armed body survives — overwriting it would fire the second clear\'s briefing into the first clear\'s conversation');
    assert.ok(h.warns.some((x) => /clear a dropped — already in flight/.test(x)));
    assert.ok(h.broadcasts.some((b) => /clear → dropped \(already in flight\)/.test(b.body)));

    // A bodyless clear is dropped by the same gate: letting it through would
    // consume the armed briefing on a clear that never asked for one.
    h.m._handleContextIntent(s, 'clear', '');
    assert.strictEqual(h.injected.length, 1);
    assert.strictEqual(s._postClearContinuation, 'first briefing');

    w.onSessionId('conv-1');
    w.onSessionId('conv-2');
    await tick();
    assert.deepStrictEqual(h.injected[1], { text: 'first briefing', opts: null },
      'exactly one continuation, and it is the first');
    assert.strictEqual(h.injected.length, 2);
  } finally { h.stop('a'); }
});

test('clear continuation: a MULTI-LINE body is captured greedily by the real scanner', async () => {
  // bodyMode for `context clear` moved none -> greedy for this feature; at
  // 'none' the briefing would be silently truncated to whatever fit on the
  // intent line, which is the shape nobody writes a handoff in.
  const h = mkManager();
  try {
    const [intent, ...rest] = h.m._extractIntents(
      '[agent:context clear] line one\nline two\nline three\n[agent:end]\ntrailing prose');
    assert.strictEqual(intent.type, 'context');
    assert.strictEqual(intent.sub, 'clear');
    assert.strictEqual(intent.body, 'line one\nline two\nline three');
    assert.ok(rest.every((i) => i.type !== 'context'), 'the [agent:end] closes the body');
  } finally { h.stop('a'); }
});
