// Run: node --test
// t137 — which memory units are LIVE in an agent's context, folded over the
// four transitions Clodex already observes.
//
// THE FAILURE ASYMMETRY THIS FILE EXISTS TO PIN: a false ABSENT costs a few
// hundred redundant hint tokens; a false FULL silently suppresses a hint the
// model needed, with no signal anything was withheld. So every case below that
// could be satisfied by "report loaded" asserts the state EXACTLY, and the
// title-tier cases assert `!== 'full'` explicitly — a tracker that collapsed
// the three states into a boolean would pass a bare "is it known" check.
//
// The fold is driven through the REAL transitions — a real create(), the real
// onSessionId/onCompactSummary callbacks create() hands the watcher, and the
// real recall intent arm — never by calling the tracker's methods directly.
// Four consecutive mutation escapes in this repo were fixtures that could not
// reach the branch they guarded; a reducer called by hand is that shape by
// construction.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { digestTiers, composeDigest, createMemoryStore, DIGEST_BUDGET,
  RECENT_BODY_CAP } = require('../memory-store');
const { createMemoryLoad } = require('../memory-load');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');

// --- the composer's tiering ----------------------------------------------

test('digestTiers: the tiers describe the bytes actually served, all three populated', () => {
  const now = Date.parse('2026-07-31T00:00:00Z');
  // The index units carry OVER-CAP bodies on purpose: a short unit now rides in
  // full on recency alone, so a fixture of short unpinned units cannot produce a
  // title tier at all, and this test needs all three tiers populated.
  const long = 'x'.repeat(RECENT_BODY_CAP + 1);
  const units = [
    { id: 'mem-1-p', scope: '', learned_at: '2026-07-01T00:00:00Z', operatorPinned: true, body: 'PINNED BODY' },
    { id: 'mem-2-a', scope: '', learned_at: '2026-07-02T00:00:00Z', pinned: false, body: `index a\n${long}` },
    { id: 'mem-3-b', scope: '', learned_at: '2026-07-03T00:00:00Z', pinned: false, body: `index b\n${long}` },
  ];
  // Budget sized so the pin's body fits, one index line fits, and the second
  // does not: without the squeeze every unit lands in a served tier and the
  // absent branch is never reached.
  const wide = digestTiers(units, { now });
  assert.deepStrictEqual(wide.full, ['mem-1-p']);
  assert.deepStrictEqual(wide.title.sort(), ['mem-2-a', 'mem-3-b']);
  assert.deepStrictEqual(wide.absent, [], 'nothing is withheld at the real budget');

  // 344 measured, not guessed: below ~336 BOTH index lines are withheld (which
  // would leave the title tier empty and prove nothing about the split), and at
  // 356 both fit. This is the band that straddles the three tiers.
  const tight = digestTiers(units, { now, budget: 344 });
  assert.deepStrictEqual(tight.full, ['mem-1-p'], 'the pin still fits in half of 360');
  assert.deepStrictEqual(tight.title, ['mem-3-b'], 'the newest index line fits');
  assert.deepStrictEqual(tight.absent, ['mem-2-a'],
    'the tight budget must actually withhold one unit or this case proves nothing');
  // The claim under test is that a tier describes the BYTES, not the intent:
  // an id reported absent must not appear in the digest anywhere.
  for (const id of tight.absent) {
    assert.ok(!tight.text.includes(id), `${id} is reported absent but its text is in the digest`);
  }
  for (const id of tight.title) {
    assert.ok(tight.text.includes(`- ${id}`), `${id} is reported title but has no index line`);
    assert.ok(!tight.text.includes(`## ${id}`), `${id} is reported title but its BODY rode`);
  }
  assert.ok(tight.text.includes('## mem-1-p'), 'the full-tier unit must have its body in the text');
});

test('digestTiers: an empty store reports no text and no ids, and composeDigest still returns null', () => {
  // composeDigest's string-or-null shape is load-bearing (session-manager's
  // digestNonEmpty, cli-hooks' `digest ? ... : ''`), so the sibling must not
  // have changed it into an object.
  assert.deepStrictEqual(digestTiers([]), { text: null, full: [], title: [], absent: [] });
  assert.strictEqual(composeDigest([]), null,
    'composeDigest must still return NULL for an empty store — session-manager branches on it for '
    + 'digestNonEmpty and cli-hooks on `digest ? ... : \'\'`, so returning the tiers OBJECT here marks '
    + 'every empty store as digested and appends "[object Object]" to the hook context');
  assert.strictEqual(composeDigest(null), null, 'and for a null unit list');
  const d = composeDigest([{ id: 'mem-1-a', scope: '', learned_at: '2026-07-01T00:00:00Z', pinned: false, body: 'x' }]);
  assert.strictEqual(typeof d, 'string', 'a non-empty store must still yield a STRING, not a tiers object');
});

test('digestTiers: a pin demoted to an index line is TITLE, not FULL', () => {
  const big = 'x'.repeat(DIGEST_BUDGET);
  const units = [
    { id: 'mem-1-fat', scope: '', learned_at: '2026-07-01T00:00:00Z', pinned: true, body: big },
    { id: 'mem-2-thin', scope: '', learned_at: '2026-07-02T00:00:00Z', pinned: true, body: 'thin' },
  ];
  const t = digestTiers(units, { now: Date.parse('2026-07-31T00:00:00Z') });
  assert.deepStrictEqual(t.full, ['mem-2-thin'], 'the thin pin fits and rides in full');
  assert.deepStrictEqual(t.title, ['mem-1-fat'],
    'a pin whose body did not fit is a TITLE unit — the model knows it exists and cannot read it, '
    + 'which makes it a hint CANDIDATE; reporting it full is the suppressing error');
});

// --- the fold, through real transitions -----------------------------------

// A real create() with the claude arm's seams stubbed. Everything the tracker
// touches (the memory store, the watcher callbacks, the recall intent) is the
// product's own code; the stubs stand only between create()'s entry and the
// session landing in the map.
function mkManager({ units = [], extraDeps = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-memload-'));
  const memRoot = path.join(root, 'library', 'memory');
  const store = createMemoryStore(memRoot);
  const ids = [];
  for (const u of units) {
    const { id } = store.remember('a', { text: u.text, pinned: !!u.pinned });
    if (u.operatorPinned) store.setOperatorPinned('a', id, true);
    ids.push(id);
  }

  const logDir = path.join(root, 'library', 'memory-loadlog');
  const memoryLoad = createMemoryLoad({ logDir });
  const persisted = new Map();
  // The watcher's callbacks are how /clear and compaction reach the fold, and
  // create() builds them as closures over the session — capturing the real ones
  // is the only way to fire them without hand-writing the transition.
  const watchers = [];

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
    memoryStore: store,
    memoryLoad,
    composeDigest, digestTiers,   // the real composer — a fake would test the fake
    isDigested: () => false,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { static async isSocketLive() { return false; } start() {} stop() {} },
    JsonlWatcher: class {
      constructor(name, onText, onSessionId, onActivity, onCompactSummary) {
        watchers.push({ name, onSessionId, onCompactSummary });
      }
      start() {} stop() {}
    },
    pty: { spawn: () => ({ onData() {}, onExit() {}, pid: 999 }) },
    os,
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    setupClaudeHook: () => path.join(root, 'settings.json'),
    setupCodexHook: () => {},
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkillPlugin: () => {},
    writeClaudeDigestFile: () => true,
    buildIpcPrompt: () => '',
    bakePrompt: () => '',   // written to disk by create(); null throws in writeFileSync
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
    buildAgentsArg: () => [],
    effectiveInjectedSkills: () => [],
    unresolvedSubagentRefs: () => [],
    // Real pure leaves rather than stubs: create() runs them on the way to the
    // session map, and a stub here would only be modelling the path this
    // fixture needs to actually traverse.
    unionEnabled: require('../scope-util').unionEnabled,
    intentEnabled: require('../intent-catalog').intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fencedLines: require('../intent-scanner').fencedLines,
    // The real queue: the recall arm delivers THROUGH it, and the delivery is
    // what the recall record is a claim about. A stub would let the record
    // survive a delivery path that never ran.
    //
    // Every wait driven to 0 — NOT cosmetic. The boot-readiness gate polls
    // until `_bootReadySeen` latches, and that only happens on a real mode-2004
    // byte from a real CLI. With the production caps (INJECT_BOOT_MAXWAIT=20s,
    // undefined here → Infinity) the poll loop keeps the event loop alive
    // forever: this file printed 11/11 green and then HUNG, which inside the
    // full suite is indistinguishable from a deadlock.
    INJECT_BOOT_MAXWAIT: 0,
    INJECT_QUIET_MAXWAIT: 0,
    INJECT_QUIET_MS: 0,
    SHORT_TEXT_DELAY: 0,
    LONG_TEXT_DELAY: 0,
    LONG_TEXT_THRESHOLD: 1e9,
    COMPACT_CONTINUATION_DELAY: 0,
    INJECT_HOLD_TIMEOUT: 0,
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
    ...extraDeps,
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  // A real create() leaves an fs.watch handle and timers behind; without this
  // the file reports green and then HANGS, which inside the full suite is
  // indistinguishable from a deadlock.
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
    clearTimeout(s._injectFlushRetry);
    clearTimeout(s._compactValveTimer);
  };
  return { m, root, logDir, store, ids, watchers, stop, memoryLoad };
}

async function spawned(h, name, resumeId = null) {
  try {
    await h.m.create(name, 'claude', os.tmpdir(), [], resumeId, 'ws');
  } catch (e) {
    assert.fail(`create() did not reach the session map: ${e && e.message}`);
  }
  assert.ok(h.m.sessions.get(name), 'ENTER: create() must have put a session in the map');
  return h.m.sessions.get(name);
}

test('load: a fresh spawn records the digest — pinned body FULL, index line TITLE', async () => {
  // The plain unit's body must exceed RECENT_BODY_CAP or it now rides in full on
  // recency alone — a short unpinned unit can no longer produce a TITLE tier,
  // which is the state this test exists to pin.
  const h = mkManager({ units: [
    { text: 'a pinned claim', operatorPinned: true },
    { text: `an unpinned claim\n${'x'.repeat(RECENT_BODY_CAP + 1)}` },
  ] });
  const [pin, plain] = h.ids;
  try {
    await spawned(h, 'a');
    assert.strictEqual(h.m.memoryLoadState('a', pin), 'full',
      'the pinned unit\'s BODY rode the digest, so it is in context');
    // The case the whole three-state design exists for.
    assert.strictEqual(h.m.memoryLoadState('a', plain), 'title',
      'an index-line unit must report TITLE');
    assert.notStrictEqual(h.m.memoryLoadState('a', plain), 'full',
      'a title-only unit must NEVER report loaded: the model knows it exists and cannot read it, so '
      + 'suppressing its hint withholds exactly the unit most worth sending');
    assert.strictEqual(h.m.memoryLoadState('a', 'mem-0-nosuch'), 'absent',
      'a unit that never rode is absent');
  } finally { h.stop('a'); }
});

test('load: a RESUMED spawn records nothing — the hook cats no digest for source=resume', async () => {
  const h = mkManager({ units: [{ text: 'a pinned claim', operatorPinned: true }] });
  const [pin] = h.ids;
  try {
    await spawned(h, 'a', 'prior-conversation-id');
    assert.strictEqual(h.m.memoryLoadState('a', pin), 'absent',
      'the generated SessionStart script cats the digest only for source=startup|clear|compact, so a resumed '
      + 'session receives none — recording the bake would claim FULL for units the model never saw, on the '
      + 'most common spawn path there is');
  } finally { h.stop('a'); }
});

test('load: compaction empties the live set, fired from the watcher callback create() built', async () => {
  const h = mkManager({ units: [
    { text: 'a pinned claim', operatorPinned: true },
    { text: `an unpinned claim\n${'x'.repeat(RECENT_BODY_CAP + 1)}` },
  ] });
  const [pin, plain] = h.ids;
  try {
    await spawned(h, 'a');
    assert.strictEqual(h.m.memoryLoadState('a', pin), 'full', 'ENTER: something must be loaded to lose');

    const w = h.watchers.find(x => x.name === 'a');
    assert.ok(w && w.onCompactSummary, 'ENTER: create() must have handed the watcher a compact callback');
    w.onCompactSummary();

    assert.strictEqual(h.m.memoryLoadState('a', pin), 'absent',
      'compaction resets to EMPTY — no attempt to model what the summarizer kept, because "possibly evicted" '
      + 'must resolve to not-loaded for a dedup consumer');
    assert.strictEqual(h.m.memoryLoadState('a', plain), 'absent', 'the title tier is dropped too');
    assert.deepStrictEqual(h.m.memoryLiveSet('a').full, []);
    assert.deepStrictEqual(h.m.memoryLiveSet('a').title, []);
  } finally { h.stop('a'); }
});

test('load: a NEW session id resets, the SAME id does not', async () => {
  const h = mkManager({ units: [{ text: 'a pinned claim', operatorPinned: true }] });
  const [pin] = h.ids;
  try {
    await spawned(h, 'a');
    const w = h.watchers.find(x => x.name === 'a');
    assert.ok(w && w.onSessionId, 'ENTER: create() must have handed the watcher a session-id callback');

    // First id: the transcript symlink resolving for the first time, NOT a
    // /clear. A reset here would wipe the digest recorded microseconds earlier
    // in the same create() — the transition fires on every spawn.
    w.onSessionId('conv-1');
    assert.strictEqual(h.m.memoryLoadState('a', pin), 'full',
      'the first observed id is an adoption, not a change: resetting here would discard the digest this very '
      + 'spawn just delivered');
    w.onSessionId('conv-1');
    assert.strictEqual(h.m.memoryLoadState('a', pin), 'full', 'a repeat of the same id is not a transition');

    w.onSessionId('conv-2');
    assert.strictEqual(h.m.memoryLoadState('a', pin), 'absent',
      '/clear mints a new conversation id and the context is gone with it');
    assert.strictEqual(h.m.memoryLiveSet('a').sessionId, 'conv-2');
  } finally { h.stop('a'); }
});

test('load: a recall reports FULL and appends to the persisted log', async () => {
  // Over the cap for the same reason: it must ENTER as an index line, or the
  // title -> full transition this test measures has no starting point.
  const h = mkManager({ units: [{ text: `the recalled claim\n${'x'.repeat(RECENT_BODY_CAP + 1)}` }] });
  const [plain] = h.ids;
  try {
    const s = await spawned(h, 'a');
    assert.strictEqual(h.m.memoryLoadState('a', plain), 'title', 'ENTER: it starts as an index line');
    s.sessionId = 'conv-9';

    // The real intent arm, not the tracker: this is the highest-signal event in
    // the scheme and it was previously unlogged, so a test that called
    // noteRecall directly would not notice the wiring going missing.
    h.m._handleMemoryIntent(s, 'recall', plain);

    assert.strictEqual(h.m.memoryLoadState('a', plain), 'full',
      'a recall delivers the BODY into the transcript, which is what loaded means');

    const log = h.m.memoryRecallLog('a');
    assert.strictEqual(log.length, 1, `exactly one entry expected; got ${JSON.stringify(log)}`);
    assert.strictEqual(log[0].id, plain);
    assert.strictEqual(log[0].sessionId, 'conv-9',
      'the entry must carry the conversation it happened in — an evidence base with no session is not one');
    assert.ok(!Number.isNaN(Date.parse(log[0].at)), `at must be a parseable timestamp; got ${log[0].at}`);
  } finally { h.stop('a'); }
});

test('load: a recall that matches nothing records nothing', async () => {
  const h = mkManager({ units: [{ text: 'the only claim' }] });
  try {
    const s = await spawned(h, 'a');
    h.m._handleMemoryIntent(s, 'recall', 'no-such-thing-anywhere');
    assert.deepStrictEqual(h.m.memoryRecallLog('a'), [],
      'a failed recall delivered no body, so logging one would both corrupt the evidence base and suppress '
      + 'a hint for a unit the model has never seen');
  } finally { h.stop('a'); }
});

test('load: the recall log survives a store round-trip', async () => {
  // Over the cap for the same reason: it must ENTER as an index line, or the
  // title -> full transition this test measures has no starting point.
  const h = mkManager({ units: [{ text: `the recalled claim\n${'x'.repeat(RECENT_BODY_CAP + 1)}` }] });
  const [plain] = h.ids;
  try {
    const s = await spawned(h, 'a');
    s.sessionId = 'conv-9';
    h.m._handleMemoryIntent(s, 'recall', plain);
  } finally { h.stop('a'); }

  // A SECOND tracker over the same directory — the log is the evidence base for
  // evidence-driven archival, which reads it in a later process than the one
  // that wrote it. In-memory-only would pass every assertion above.
  const reopened = createMemoryLoad({ logDir: h.logDir });
  const log = reopened.recallLog('a');
  assert.strictEqual(log.length, 1, `the log must be on disk, not just in memory; got ${JSON.stringify(log)}`);
  assert.strictEqual(log[0].id, plain);
  assert.strictEqual(log[0].sessionId, 'conv-9');
  // The live set is deliberately NOT persisted: a restarted session has no
  // context to dedup against, so a surviving live set is a false FULL.
  assert.strictEqual(reopened.stateOf('a', plain), 'absent',
    'the live set must die with the process — a restarted session holds none of that context');
});

test('load: a tracker with no log directory still tracks, and reports an empty log', () => {
  // The null-object seam session-manager falls back to when deps carry no
  // tracker. It must not throw inside a turn handler, and it must not claim a
  // log it does not have.
  const t = createMemoryLoad();
  t.noteRecall('a', 'mem-1-x');
  assert.strictEqual(t.stateOf('a', 'mem-1-x'), 'full',
    'the live set is in-memory either way — losing the log must not also lose the tracking');
  assert.deepStrictEqual(t.recallLog('a'), [],
    'and it must report an EMPTY log rather than throwing on the missing directory');
});
