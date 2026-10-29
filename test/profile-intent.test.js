'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');

const { createSessionManager } = require('../session-manager');
const { createMemoryStore } = require('../memory-store');
const { intentEnabled } = require('../intent-catalog');
const registry = require('../intent-registry');
const scanner = require('../intent-scanner');
const { mkTmpRoot } = require('./lib/tmp-roots');

function mkFixture({ intents = null, cls = 'assistant', agentType = 'claude' } = {}) {
  const home = mkTmpRoot('clodex-t2079-');
  const memoryStore = createMemoryStore(pathReal.join(home, 'memory'));
  const entry = { name: 'p1', class: cls, intents };
  const persistence = {
    list: () => [entry], get: (n) => (n === 'p1' ? entry : null), upsert: () => {}, remove: () => {},
    markDigested: () => {}, setArchived: () => {}, setStripLevel: () => {}, setAutoCompact: () => {},
  };
  const rebaked = [];
  const deps = {
    knownSkillNames: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => [] }),
    getRemindScheduler: () => null,
    getNotifications: () => null,
    memoryStore,
    writeClaudeDigestFile: (n) => { rebaked.push(n); return false; },
    intentEnabled,
    withoutPrivilegedIntentsFor: registry.withoutPrivilegedIntentsFor,
    fencedLines: scanner.fencedLines,
    parseIntent: scanner.parseIntent,
    looksLikeIntent: scanner.looksLikeIntent,
    bodyModeFor: registry.bodyModeFor,
    intentEnabledFor: registry.intentEnabledFor,
    intentEnabledForSeat: registry.intentEnabledForSeat,
    pluginRowFor: registry.pluginRowFor,
    validIntentNames: registry.validIntentNames,
    fs: fsReal,
    path: pathReal,
    pathFor: require('../clodex-paths').pathFor,
    runDirFor: require('../clodex-paths').runDirFor,
    os: osReal,
    ensureDir: require('../fs-util').ensureDir,
    gitWorktree: require('../git-worktree'),
    childProcess: require('node:child_process'),
    countPending: require('../pending-store').countPending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    termAvailableFor: require('../drawer-avail').termAvailableFor,
    REGISTRY_DIR: home,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    resolveTeam: () => null,
    findProjectRoot: () => null,
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  const injected = [];
  const acks = [];
  m._injectText = (s, text) => injected.push(text);
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._memoryAck = (s, text) => acks.push(text);
  m._deliverMessage = () => 'delivered';
  m.recordMisfire = () => {};
  const session = { name: 'p1', type: agentType, agentType, cwd: home, pty: { pid: 1 }, activityState: 'idle' };
  m.sessions.set('p1', session);
  return {
    m, session, injected, acks, rebaked, memoryStore,
    run: (turn) => {
      const list = m._extractIntents(turn);
      assert.strictEqual(list.length, 1, 'ENTER: the turn parsed to exactly one intent');
      return m._handleIntent('p1', list[0]);
    },
    cleanup: () => { try { fsReal.rmSync(home, { recursive: true, force: true }); } catch {} },
  };
}

function seed(f) {
  const r = f.memoryStore.profileSet('p1', { game: { level: 3 }, notes: { mood: 'calm' } }, { merge: false });
  assert.ok(r.ok, 'ENTER: the seed profile was written');
  return r;
}

test('set writes the note to disk at once and moves updatedAt', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 29, 12, 0, 0) });
  const f = mkFixture();
  try {
    seed(f);
    t.mock.timers.tick(5000);
    await f.run('[agent:profile set plan] rush the north');
    const view = f.memoryStore.profileGet('p1');
    assert.deepStrictEqual(view.profile, { game: { level: 3 }, notes: { mood: 'calm', plan: 'rush the north' } });
    assert.strictEqual(view.updatedAt, '2026-10-29T12:00:05.000Z');
    assert.deepStrictEqual(f.acks, [`[agent:profile] notes.plan set (${view.bytes} bytes)`]);
    assert.deepStrictEqual(f.injected, []);
    assert.deepStrictEqual(f.rebaked, ['p1']);
  } finally { f.cleanup(); }
});

test('set with a greedy multi-line body stores a YAML list', async () => {
  const f = mkFixture();
  try {
    seed(f);
    await f.run('[agent:profile set openings]\n- e4\n- d4\n[agent:end]');
    assert.deepStrictEqual(f.memoryStore.profileGet('p1').profile.notes.openings, ['e4', 'd4']);
  } finally { f.cleanup(); }
});

test('drop removes the key and acks', async () => {
  const f = mkFixture();
  try {
    seed(f);
    f.m._handleProfileIntent(f.session, { sub: 'drop', key: 'mood', body: '' });
    assert.deepStrictEqual(f.memoryStore.profileGet('p1').profile, { game: { level: 3 }, notes: {} });
    assert.deepStrictEqual(f.acks, ['[agent:profile] notes.mood dropped']);
  } finally { f.cleanup(); }
});

test('set on a seat with no profile is refused and writes nothing', async () => {
  const f = mkFixture();
  try {
    await f.run('[agent:profile set plan] x');
    assert.deepStrictEqual(f.injected, ['[agent:profile] no profile for this seat (the operator or the game creates it over the API)']);
    assert.strictEqual(f.memoryStore.profileGet('p1').profile, null);
    assert.deepStrictEqual(f.acks, []);
  } finally { f.cleanup(); }
});

for (const [label, opts] of [['a Claude non-assistant', { cls: 'agent' }], ['a Codex assistant', { agentType: 'codex' }]]) {
  test(`${label} is refused before any store call and writes nothing`, async () => {
    const f = mkFixture(opts);
    try {
      seed(f);
      const calls = [];
      for (const k of ['profileGet', 'profileSet']) {
        const real = f.memoryStore[k];
        f.memoryStore[k] = (...a) => { calls.push(k); return real(...a); };
      }
      f.m._handleProfileIntent(f.session, { sub: 'set', key: 'plan', body: 'x' });
      f.m._handleProfileIntent(f.session, { sub: 'drop', key: 'mood', body: '' });
      assert.deepStrictEqual(f.injected, ['[agent:profile] not available for this seat', '[agent:profile] not available for this seat']);
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(f.acks, []);
      assert.deepStrictEqual(f.rebaked, []);
    } finally { f.cleanup(); }
  });
}

test('the store cap refusal passes through verbatim', async () => {
  const f = mkFixture();
  try {
    seed(f);
    await f.run(`[agent:profile set big] ${'x'.repeat(5000)}`);
    assert.strictEqual(f.injected.length, 1);
    assert.match(f.injected[0], /^\[agent:profile\] profile exceeds 4096 bytes \(\d+\)$/);
    assert.strictEqual(f.memoryStore.profileGet('p1').profile.notes.big, undefined);
  } finally { f.cleanup(); }
});

test('unknown verb, bad key and a bad value bounce', async () => {
  const f = mkFixture();
  try {
    seed(f);
    await f.run('[agent:profile frob mood]');
    await f.run('[agent:profile set Mood] x');
    await f.run('[agent:profile set plan]\nfoo\nbar\n[agent:end]');
    assert.deepStrictEqual(f.injected, [
      '[agent:profile] unknown verb "frob" (use set|drop)',
      '[agent:profile] bad key "Mood" (lowercase a-z, 0-9, _ or -)',
      '[agent:profile] line 1: expected key: value',
    ]);
    assert.deepStrictEqual(f.memoryStore.profileGet('p1').profile.notes, { mood: 'calm' });
  } finally { f.cleanup(); }
});

test('an allowlist with profile but not memory can set, and cannot remember', async () => {
  const f = mkFixture({ intents: ['dm', 'profile'] });
  try {
    seed(f);
    await f.run('[agent:profile set plan] hold');
    assert.strictEqual(f.memoryStore.profileGet('p1').profile.notes.plan, 'hold');
    await f.run('[agent:memory remember] a fact');
    assert.strictEqual(f.injected.length, 1);
    assert.match(f.injected[0], /^\[agent:memory\] the memory intent is disabled for this session/);
    assert.deepStrictEqual(f.memoryStore.list('p1'), []);
  } finally { f.cleanup(); }
});

test('an allowlist with memory but not profile is refused profile', async () => {
  const f = mkFixture({ intents: ['dm', 'memory'] });
  try {
    seed(f);
    await f.run('[agent:profile set plan] hold');
    assert.strictEqual(f.injected.length, 1);
    assert.match(f.injected[0], /^\[agent:profile\] the profile intent is disabled for this session/);
    assert.strictEqual(f.memoryStore.profileGet('p1').profile.notes.plan, undefined);
  } finally { f.cleanup(); }
});
