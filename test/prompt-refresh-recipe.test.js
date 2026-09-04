'use strict';

// refreshPrompt() must produce the SAME BYTES create() would, and this file is
// the only place that runs its body.
//
// The bug this pins shipped and survived a 3530-green suite. refreshPrompt was a
// SECOND copy of create()'s prompt assembly, and it had already drifted two ways:
// it ignored CLODEX_DISABLE_IPC_PROMPT (shipped config — the reviewer seat
// template sets it) and dropped extraArgs. The reason nothing caught it is that
// the existing tests for the refresh stub the method to assert call ORDER, so its
// body never executed. Order tests are in test/hint-arm.test.js; BYTES are here.
//
// Divergence is not a transient wrong answer, it is permanent corruption:
// refreshPrompt bakes with reuse=false, which WRITES its result into session.md.
// If those bytes are not create()'s, every later spawn diffs recipe-against-
// recipe and stages a delta describing a change that never happened — a phantom
// the agent can never absorb, because nothing on either side is actually moving.
//
// Real deps throughout (real ipc-prompt, real argv-merge, real cache module, real
// generated hook). A fake in the assembly path here would test the fake, and a
// fake is precisely what a byte-equality claim cannot tolerate.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionManager } = require('../session-manager');
const { createCliHooks } = require('../cli-hooks');
const { pathFor, runDirFor } = require('../clodex-paths');
const { bakePrompt, promptCacheDir, readCache, cachePathFor } = require('../ipc-prompt-cache');
const { mergeSessionEnv } = require('../env-scopes');
const { mkTmpRoot } = require('./lib/tmp-roots');

function tmp() { return mkTmpRoot('clodex-refresh-'); }

// The prompt-assembly deps are REAL; only the world outside it (pty, transport,
// watcher, os notifications) is stubbed. That split is the point of the file.
function mkManager(root) {
  const persisted = new Map();
  const watchers = [];
  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    fs, path, os,
    pathFor, runDirFor,
    // --- the recipe, all real ---
    buildIpcPrompt: require('../ipc-prompt').buildIpcPrompt,
    mergeClaudeSystemPrompt: require('../argv-merge').mergeClaudeSystemPrompt,
    // The ASSEMBLY above is real; these two are inputs to it and live in
    // engine.js (prompt-library readers, not importable standalone). Stubbing an
    // input is safe — what a byte-equality claim cannot tolerate is a fake in the
    // assembly, and there is none. No test here passes appendPromptFiles or a
    // systemPromptFile, so both stubs return the empty case they would anyway.
    readAppendBodies: () => [],
    resolveSystemPromptFile: () => null,
    pluginGrammarLines: () => [],
    bakePrompt, promptCacheDir, readCache,
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    // --- the world ---
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
    JsonlWatcher: class {
      constructor(name, onText, onSessionId, onActivity, onCompactSummary) {
        watchers.push({ name, onSessionId, onCompactSummary });
      }
      start() {} stop() {}
    },
    pty: { spawn: () => ({ onData() {}, onExit() {}, pid: 999, write: () => {} }) },
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    // The REAL generated hook — its SessionStart script is half of the
    // clear/compact contract these tests exercise.
    setupClaudeHook: (name) => createCliHooks({
      REGISTRY_DIR: root,
      memoryStore: { list: () => [] },
      getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
      nodeInterp: process.execPath,
    }).setupClaudeHook(name),
    setupCodexHook: () => {},
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkillPlugin: () => {}, cleanupAgentPlugin: () => {},
    writeClaudeDigestFile: () => true,
    teeBlindBackend: () => null,
    readEffectiveClaudeEnv: () => ({}),
    // The REAL merge, so `env` rides in as SESSION env — the scope a spawn
    // template actually uses to set CLODEX_DISABLE_IPC_PROMPT. A stub that
    // ignored its arguments would make the flag invisible to create() and the
    // disable half of these tests would pass without ever exercising it.
    mergeSessionEnv,
    resolveTeam: () => null,
    strictMcpReason: () => null,
    scrubInheritedClaudeMarkers: (e) => e,
    writeAgentPlugin: () => null, effectiveInjectedAgents: () => [],
    effectiveInjectedSkills: () => [],
    unresolvedSubagentRefs: () => [],
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
    COMPACT_CONTINUATION_DELAY: 0, INJECT_HOLD_TIMEOUT: 0,
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.watcher) s.watcher.stop(); } catch {}
    // create() opens an fs.watch on run/<name>/ for the ctx-reminder. It is a
    // live libuv handle, so leaving it open does not fail a test — it hangs the
    // whole FILE after the last assertion passes.
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
    clearTimeout(s._injectFlushRetry);
    clearTimeout(s._compactValveTimer);
  };
  return { m, watchers, stop };
}

async function spawn(h, name, extraArgs = [], sessionEnv = null) {
  await h.m.create(name, 'claude', os.tmpdir(), extraArgs, null, 'ws',
    null, false, null, [], [], [], [], [], null, [], [], null, sessionEnv);
  assert.ok(h.m.sessions.get(name), 'ENTER: create() must have put a session in the map');
  return h.m.sessions.get(name);
}

// The bytes create() actually wrote — the ground truth every claim below compares
// against. Read from disk rather than recomputed, so a test cannot agree with a
// recomputation that is itself the drifted copy.
function bakedBytes(root, name) {
  return fs.readFileSync(pathFor(root, name, 'appendPrompt'), 'utf8');
}

// --- recipe equality: the refresh is a NO-OP when nothing changed ---

for (const [label, extraArgs, env] of [
  ['a plain seat', [], null],
  ['a seat with extraArgs --append-system-prompt', ['--append-system-prompt', 'EXTRA-SEAT-TEXT'], null],
  ['a seat with CLODEX_DISABLE_IPC_PROMPT=1', [], { CLODEX_DISABLE_IPC_PROMPT: '1' }],
  ['both at once', ['--append-system-prompt', 'EXTRA-SEAT-TEXT'], { CLODEX_DISABLE_IPC_PROMPT: '1' }],
]) {
  test(`recipe: refreshPrompt on ${label} with NOTHING changed is a no-op`, async () => {
    const root = tmp(), name = 'rx';
    const h = mkManager(root);
    try {
      await spawn(h, name, extraArgs, env);
      const born = bakedBytes(root, name);
      assert.strictEqual(readCache(root, name, 'session'), born,
        'ENTER: create() must have baked session.md to the same bytes it wrote to append-prompt.md');

      const changed = h.m.refreshPrompt(name, 'test');

      assert.strictEqual(changed, false,
        `refreshPrompt must return false for ${label}: it hit the "already current" guard, which is only reachable when its recipe reproduces create()'s bytes exactly. A true here means the two recipes disagree, and the disagreement is now written into session.md forever`);
      assert.strictEqual(bakedBytes(root, name), born, 'and the prompt file is untouched');
      assert.strictEqual(readCache(root, name, 'session'), born, 'and session.md is untouched');
      assert.ok(!fs.existsSync(cachePathFor(root, name, 'delta')),
        'and no phantom delta is staged — a diff describing recipe-vs-recipe is one the agent can never absorb');
    } finally { h.stop(name); }
  });
}

test('recipe: the disable flag and extraArgs are actually LOAD-BEARING in the compared bytes', async () => {
  // Guards the four no-op tests above from passing vacuously. If the flag and the
  // extra text made no difference to the baked bytes, "identical" would be true
  // for reasons that have nothing to do with the recipes agreeing.
  const a = tmp(), b = tmp(), c = tmp();
  const ha = mkManager(a), hb = mkManager(b), hc = mkManager(c);
  try {
    await spawn(ha, 'rx');
    await spawn(hb, 'rx', [], { CLODEX_DISABLE_IPC_PROMPT: '1' });
    await spawn(hc, 'rx', ['--append-system-prompt', 'EXTRA-SEAT-TEXT']);
    const plain = bakedBytes(a, 'rx');
    assert.ok(plain.includes('[agent:dm TARGET]'),
      'the plain seat carries the IPC protocol');
    assert.ok(!bakedBytes(b, 'rx').includes('[agent:dm TARGET]'),
      'CLODEX_DISABLE_IPC_PROMPT=1 removes it — so a refresh that ignored the flag would write a ~9KB protocol into a lean seat');
    assert.ok(bakedBytes(c, 'rx').includes('EXTRA-SEAT-TEXT'),
      'extraArgs text lands in the baked prompt — so a refresh that dropped extraArgs would delete it');
  } finally { ha.stop('rx'); hb.stop('rx'); hc.stop('rx'); }
});

test('recipe: a seat spawned before the capture existed refuses to refresh', async () => {
  // An app upgrade leaves live sessions that were created by the OLD build and
  // have no promptRecipe. Rebuilding one from the persistence entry is exactly
  // the second recipe this file exists to forbid, so the only safe answer is to
  // decline and let the next respawn capture one.
  const root = tmp(), name = 'rx';
  const h = mkManager(root);
  try {
    await spawn(h, name);
    const born = bakedBytes(root, name);
    h.m.sessions.get(name).promptRecipe = null;   // the pre-upgrade shape

    assert.strictEqual(h.m.refreshPrompt(name, 'test'), false,
      'no captured recipe must mean no refresh — guessing one is how the divergence gets written into session.md');
    assert.strictEqual(readCache(root, name, 'session'), born, 'and session.md keeps the frozen bytes');
  } finally { h.stop(name); }
});

// --- the refresh actually WORKS when truth moved ---

test('refresh: a changed team block re-bakes the prompt and advances both cache files', async () => {
  const root = tmp(), name = 'rx';
  const h = mkManager(root);
  try {
    await spawn(h, name);
    const born = bakedBytes(root, name);
    // Move truth the way a real change does — the team block is re-resolved on
    // every refresh precisely so a team.json edit lands at the next reset.
    h.m._teamBlockFor = () => ({ teamBlock: 'NEW TEAM BLOCK', teamName: 't', resolvedTeam: null });

    assert.strictEqual(h.m.refreshPrompt(name, 'clear'), true, 'a real change refreshes');

    const now = bakedBytes(root, name);
    assert.notStrictEqual(now, born, 'the prompt file carries the new truth');
    assert.ok(now.includes('NEW TEAM BLOCK'), 'specifically the changed bytes');
    assert.strictEqual(readCache(root, name, 'session'), now,
      'session.md must advance WITH the file, or the next spawn re-bakes the old bytes and stages a phantom delta');
    assert.strictEqual(readCache(root, name, 'notified'), now,
      'and notified.md with it, or the agent is handed a diff describing exactly what it is already reading');
  } finally { h.stop(name); }
});

// --- MF3: the hook and the refresh no longer race ---

function runSessionStart(root, name, source) {
  const transcript = path.join(root, 'fake-transcript.jsonl');
  fs.writeFileSync(transcript, '');
  const r = require('child_process').spawnSync('/bin/bash', [pathFor(root, name, 'hook')], {
    encoding: 'utf8',
    input: JSON.stringify({ transcript_path: transcript, source }),
  });
  assert.strictEqual(r.status, 0, `SessionStart hook exited ${r.status}: ${r.stderr}`);
}

// The two components observe the same context reset through different channels
// (the CLI's SessionStart hook vs the watcher's session-id / compact-summary
// callbacks) and there is no ordering between them. BOTH orders must leave the
// seat with a session.md that matches its prompt file — the old code did not:
// refresh-first early-returned at the no-op guard, then the hook's unlink landed,
// and the seat ran on with NO session.md until its next resume re-baked under a
// warm conversation.
for (const order of ['hook-first', 'refresh-first']) {
  for (const source of ['clear', 'compact']) {
    test(`MF3: ${order} at a ${source} leaves session.md consistent with the prompt file`, async () => {
      const root = tmp(), name = 'rx';
      const h = mkManager(root);
      try {
        await spawn(h, name);
        h.m._teamBlockFor = () => ({ teamBlock: 'NEW TEAM BLOCK', teamName: 't', resolvedTeam: null });

        if (order === 'hook-first') {
          runSessionStart(root, name, source);
          h.m.refreshPrompt(name, source);
        } else {
          h.m.refreshPrompt(name, source);
          runSessionStart(root, name, source);
        }

        const onDisk = bakedBytes(root, name);
        assert.ok(fs.existsSync(cachePathFor(root, name, 'session')),
          `${order}: the seat must never be left WITHOUT a session.md — that is a deferred, unbounded re-bake of a live conversation, which is the 111k-139k bust the freeze exists to prevent`);
        assert.strictEqual(readCache(root, name, 'session'), onDisk,
          `${order}: session.md must equal what the CLI is actually reading, or the next spawn stages a delta against bytes nobody has`);
        assert.ok(onDisk.includes('NEW TEAM BLOCK'),
          `${order}: and the refresh must have landed regardless of who won — the whole point of the reset edge is that the seat comes back on current truth`);
      } finally { h.stop(name); }
    });
  }
}
