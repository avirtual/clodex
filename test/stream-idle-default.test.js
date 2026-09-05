'use strict';
// Run: node --test test/stream-idle-default.test.js
// t286/t676 — CLAUDE_STREAM_IDLE_TIMEOUT_MS reaches a seat as a SHIPPED DEFAULT
// (resources/env-defaults.json), seeded into the global env scope at initStores.
//
// t676 moved it off session-manager.js's baked BASE_ENV_DEFAULTS, which sat in
// the merge BASE below process.env and was invisible in the GUI. Two consequences
// are behaviour changes rather than refactors, and both are pinned below because
// nothing else would catch them:
//
//   it now sits ABOVE process.env, not below. As a global-scope entry it beats
//   an inherited value. Production cannot tell the difference — claude-env.js's
//   scrub deletes every inherited CLAUDE_* key before a seat spawns — but the
//   ordering is real and is asserted rather than left to be rediscovered.
//
//   the degrade path no longer carries it. When the scope store is unreachable
//   create() falls back to `{ ...process.env }`, and the value lived in that
//   store. A seat spawned through the degrade path gets the CLI's own 5-minute
//   threshold instead of 30 minutes. That is the cost of making the value
//   operator-editable, and it is pinned so it stays a decision.
//
// The value is only half the claim; WHERE it applies is the other half. Moved to
// the app-owned block after the merge (TERM, CLODEX_HOME, …) it would WIN over
// an operator's own workspace/session value. That direction is pinned too.
//
// These drive a REAL create() through a fake pty and read the env the process
// would actually have been spawned with. A regex over session-manager.js would
// pin what the file SAYS and stay green through exactly the move described
// above, since the line would still be there.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const { initStores } = require('../stores');
const { loadEnvDefaults } = require('../env-defaults');
const { mkTmpRoot } = require('./lib/tmp-roots');

const KEY = 'CLAUDE_STREAM_IDLE_TIMEOUT_MS';
const FLOOR = '1800000'; // the CLI clamps to [1, 1800000]; nothing higher is expressible

// A second key carried through the same merge. Its presence in the assertions
// is what distinguishes "the scope chain ran and produced this" from "the base
// happened to contain the one key under test". Deliberately a name create()
// does not read: a sibling that is also a live functional key (CLODEX_SPAWNER_HINT
// branches at session-manager.js's spawner-hint block) would couple these
// assertions to that feature's future.
const SIBLING = 'CLODEX_IDLE_SIBLING';

function mkManager(scopes, { breakScopes = false } = {}) {
  const root = mkTmpRoot('clx-idle-');
  const userData = mkTmpRoot('clx-idle-ud-'); // no env-override.env inside
  const spawns = [];
  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    fs, path, pathFor, runDirFor,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => ({
      list: () => [], get: () => null, upsert: () => {}, remove: () => {},
      setSessionId: () => {}, setStripLevel: () => {}, setLabel: () => {},
    }),
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getEnvScopes: breakScopes
      ? () => { throw new Error('scope store down'); }
      : () => ({ all: () => scopes }),
    getUserDataPath: () => userData,
    resolveProxyBase: () => null,
    lastTranscriptWrite: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { start() {} stop() {} },
    JsonlWatcher: class { start() {} stop() {} },
    pty: {
      spawn: (_cmd, _args, opts) => {
        spawns.push({ env: opts.env });
        return { onData() {}, onExit() {}, pid: 999, kill() {} };
      },
    },
    os,
    stripLevelOf: () => 0,
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
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
  return { m, spawns, stop };
}

// The app scrubs every inherited CLAUDE_* key out of process.env at startup
// (claude-env.js, main.js / headless-main.js) before any seat spawns, so a
// value in the runner's own environment is a state production never reaches.
// Left in place it would sit in the merge base and silently replace the floor,
// failing this file on one developer's machine and passing on every other.
async function spawnEnv(name, { global = {}, workspaces = {} } = {}, sessionEnv = null, opts = {}) {
  const had = Object.prototype.hasOwnProperty.call(process.env, KEY);
  const prev = process.env[KEY];
  if (opts.processEnvValue === undefined) delete process.env[KEY];
  else process.env[KEY] = opts.processEnvValue;
  const { m, spawns, stop } = mkManager({ global, workspaces }, opts);
  try {
    await m.create(name, 'bash', os.tmpdir(), [], null, 'ws', null, false, null,
      [], [], [], [], [], null, [], [], null, sessionEnv);
    // Every pre-spawn exit on this path throws (cwd stat, hook setup) and would
    // fail the await above, so this is not closing a silent-undefined hole: it
    // names the state instead of letting a future zero-spawn or double-spawn
    // path surface as a TypeError on spawns[0].env.
    assert.strictEqual(spawns.length, 1, 'ENTER: create() must have reached pty.spawn');
    return spawns[0].env;
  } finally {
    stop(name);
    if (had) process.env[KEY] = prev; else delete process.env[KEY];
  }
}

const pick = (env) => ({ [KEY]: env[KEY], [SIBLING]: env[SIBLING] });

test('the shipped file carries the floor, which is the CLI\'s highest expressible value', () => {
  // The value's new home. Against the REAL resources file, so emptying it or
  // typing a different number fails here rather than only on a live seat.
  const shipped = loadEnvDefaults(path.join(__dirname, '..', 'resources', 'env-defaults.json'));
  assert.strictEqual(shipped[KEY] && shipped[KEY].value, FLOOR,
    'the CLI takes max(env||0, 300000) clamped to [1, 1800000], so this only ever raises the stall '
    + 'threshold and 1800000 is the ceiling');
});

test('end to end: a real seeded profile spawns a seat carrying the floor', async () => {
  // The load-bearing case, and the only one that exercises the whole path the
  // operator actually gets: the real resources file → stores.js's seeder → the
  // env-scopes store → create()'s merge → the spawned PTY. Every other case here
  // hand-feeds the scope, so all of them would stay green with the seeder deleted.
  const userData = mkTmpRoot('clx-idle-seed-ud-');
  const registryDir = mkTmpRoot('clx-idle-seed-reg-');
  const stores = initStores(userData, {
    log: { info() {}, warn() {}, error() {} },
    registryDir,
    resourcesDir: path.join(registryDir, '__no_seed__'),
    skillsResourcesDir: path.join(registryDir, '__no_seed_skills__'),
  });
  // ENTER: the seeder ran against the real shipped file. Without this the spawn
  // assertion below would hold vacuously if seeding had produced nothing and the
  // key had arrived from somewhere else.
  assert.deepStrictEqual(stores.envScopes.getScope('global')[KEY], { value: FLOOR, secret: false });

  const env = await spawnEnv('i-e2e', stores.envScopes.all());
  assert.strictEqual(env[KEY], FLOOR, 'the seeded value must reach the spawned process');
});

test('the default is inert for a seat type that ignores it, but still present', async () => {
  // A global scope entry, so it crosses for every seat type. Pinned so a later
  // narrowing to claude-only is a deliberate edit here rather than a silent
  // behaviour change.
  const env = await spawnEnv('i2', { global: { [KEY]: FLOOR } });
  assert.strictEqual(env[KEY], FLOOR, 'bash seats carry it too — an unused env var on a bash PTY is inert');
});

// The direction that matters. An operator's INNER scope must beat the seeded
// global one; a move to the post-merge app-owned block breaks both at once.
for (const [scope, mk] of [
  ['workspace', (v) => [{ global: { [KEY]: FLOOR, [SIBLING]: 'off' }, workspaces: { ws: { [KEY]: v } } }, null]],
  ['session', (v) => [{ global: { [KEY]: FLOOR, [SIBLING]: 'off' } }, { [KEY]: v }]],
]) {
  test(`an operator's ${scope} scope beats the seeded default`, async () => {
    const [scopes, sessionEnv] = mk('600000');
    const env = await spawnEnv(`i-${scope}`, scopes, sessionEnv);
    assert.deepStrictEqual(pick(env), { [KEY]: '600000', [SIBLING]: 'off' },
      `a ${scope}-scope value must survive to the PTY — the default is an ordinary global entry, not an `
      + 'app-owned key applied after the merge, and clobbering an explicitly configured value is a worse '
      + 'bug than the stall this fixes');
  });
}

test('editing the global entry is how the operator changes the value, and it takes', async () => {
  // The GUI writes exactly this. It replaces the seeded value rather than
  // layering over it, which is what makes the Env page's editing real.
  const env = await spawnEnv('i-edit', { global: { [KEY]: '600000', [SIBLING]: 'off' } });
  assert.deepStrictEqual(pick(env), { [KEY]: '600000', [SIBLING]: 'off' });
});

test('deleting the global entry leaves the key absent — nothing bakes it back in', async () => {
  // The half that fails if a future change re-adds a BASE_ENV_DEFAULTS-style
  // bake "as a safety net": the operator's deletion would silently stop working
  // while the Env page kept showing the row gone.
  const env = await spawnEnv('i-deleted', { global: { [SIBLING]: 'off' } });
  assert.deepStrictEqual(pick(env), { [KEY]: undefined, [SIBLING]: 'off' });
});

test('as a global entry the default now sits ABOVE process.env', async () => {
  // A deliberate consequence of t676's move, not an accident. Production cannot
  // observe it (claude-env.js's scrub guarantees process.env carries no CLAUDE_*
  // key by the time a seat spawns), so only this pins the ordering.
  const env = await spawnEnv('i7', { global: { [KEY]: FLOOR } }, null, { processEnvValue: '999' });
  assert.strictEqual(env[KEY], FLOOR,
    'a global scope entry beats process.env — the seeded default is no longer under it');
});

test('the degrade path does NOT carry the default — the cost of making it editable', async () => {
  // create() degrades to `mergedEnv = { ...baseEnv }` when the scope store is
  // unreachable (getUserDataPath() before whenReady, a corrupt store), and the
  // value lives in that store now. Such a seat gets the CLI's own 5-minute
  // threshold. Stated rather than discovered: restoring a baked fallback would
  // reintroduce a value the operator cannot delete.
  const env = await spawnEnv('i8', { global: { [KEY]: FLOOR } }, null, { breakScopes: true });
  assert.strictEqual(env[KEY], undefined, 'the degrade path spawns without the default');
  assert.strictEqual(env.PATH, process.env.PATH,
    'ENTER: the fallback produced a real inherited env, not an empty object');
});

test('the full chain still orders correctly with the default seeded into global', async () => {
  // Three scopes disagreeing at once: the innermost must win. A change that
  // merged the global scope in at the wrong depth could still pass a
  // single-scope case by accident.
  const env = await spawnEnv('i6',
    { global: { [KEY]: FLOOR, [SIBLING]: 'g' }, workspaces: { ws: { [KEY]: '500000' } } },
    { [KEY]: '600000' });
  assert.deepStrictEqual(pick(env), { [KEY]: '600000', [SIBLING]: 'g' },
    'session > workspace > global, and the global-only sibling key still crosses');
});

after(() => { setImmediate(() => process.exit(0)); });
