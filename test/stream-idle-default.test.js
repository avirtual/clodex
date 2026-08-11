'use strict';
// Run: node --test test/stream-idle-default.test.js
// t286 — CLAUDE_STREAM_IDLE_TIMEOUT_MS is baked as a FLOOR under the env-scope
// chain (session-manager.js BASE_ENV_DEFAULTS).
//
// The value is only half the claim; WHERE it is applied is the other half. Fed
// into the merge's `base` it loses to every scope, which is the point. Moved to
// the app-owned block after the merge (TERM, CLODEX_HOME, …) it would WIN, and
// an operator who deliberately set a different value in a global/workspace/
// session scope would silently get ours instead. Both directions are pinned
// below; the override direction is the one that catches that move.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-idle-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-idle-ud-')); // no env-override.env inside
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

test('with no scopes set, a seat spawns with the floor baked in', async () => {
  const env = await spawnEnv('i1', {}, { [SIBLING]: 'off' });
  assert.deepStrictEqual(pick(env), { [KEY]: FLOOR, [SIBLING]: 'off' },
    'the floor must reach the spawned process, and the sibling scope key alongside it — a partial match on '
    + 'the floor alone would also hold if the merge had collapsed to the raw base');
});

test('the default is inert for a seat type that ignores it, but still present', async () => {
  // Applied to the merge base, which is built before agentType is computed, so
  // every seat carries it. Pinned so a later narrowing to claude-only is a
  // deliberate edit here rather than a silent behaviour change.
  const env = await spawnEnv('i2');
  assert.strictEqual(env[KEY], FLOOR, 'bash seats carry it too — an unused env var on a bash PTY is inert');
});

// The direction that matters. Each scope in the canonical chain
// (process.env < global < workspace < session) must beat the baked default; a
// move to the post-merge app-owned block breaks all three at once.
for (const [scope, mk] of [
  ['global', (v) => [{ global: { [KEY]: v, [SIBLING]: 'off' } }, null]],
  ['workspace', (v) => [{ workspaces: { ws: { [KEY]: v, [SIBLING]: 'off' } } }, null]],
  ['session', (v) => [{}, { [KEY]: v, [SIBLING]: 'off' }]],
]) {
  test(`an operator's ${scope} scope beats the baked default`, async () => {
    const [scopes, sessionEnv] = mk('600000');
    const env = await spawnEnv(`i-${scope}`, scopes, sessionEnv);
    assert.deepStrictEqual(pick(env), { [KEY]: '600000', [SIBLING]: 'off' },
      `a ${scope}-scope value must survive to the PTY — the default is a floor under the chain, not an `
      + 'app-owned key applied after the merge, and clobbering an explicitly configured value is a worse '
      + 'bug than the stall this fixes');
  });
}

test('the default sits BELOW process.env, not above it', async () => {
  // The spread order in create() is `{ ...DEFAULTS, ...process.env }`. Production
  // can never observe the difference — claude-env.js's scrub guarantees
  // process.env carries no CLAUDE_* key by the time a seat spawns — so without
  // this test an inversion to `{ ...process.env, ...DEFAULTS }` is a free edit,
  // and it would silently promote every baked default above the bottom link of
  // the canonical chain.
  const env = await spawnEnv('i7', {}, null, { processEnvValue: '999' });
  assert.strictEqual(env[KEY], '999',
    'process.env is the bottom of the chain and must still beat the baked default');
});

test('the floor survives the env-scope store throwing', async () => {
  // create() degrades to `mergedEnv = { ...baseEnv }` when the scope store is
  // unreachable (getUserDataPath() before whenReady, a corrupt store). Reverting
  // that fallback to `{ ...process.env }` is invisible to every other test here,
  // and a seat spawned through the degrade path would silently lose the floor.
  const env = await spawnEnv('i8', {}, null, { breakScopes: true });
  assert.strictEqual(env[KEY], FLOOR, 'the degrade path must still carry the floor');
  assert.strictEqual(env.PATH, process.env.PATH,
    'ENTER: the fallback produced a real inherited env, not an empty object');
});

test('the full chain still orders correctly with the default underneath', async () => {
  // Three scopes disagreeing at once: the default must lose to all of them and
  // the innermost must win. A fix that merged the default in at the wrong depth
  // could still pass a single-scope case by accident.
  const env = await spawnEnv('i6',
    { global: { [KEY]: '400000', [SIBLING]: 'g' }, workspaces: { ws: { [KEY]: '500000' } } },
    { [KEY]: '600000' });
  assert.deepStrictEqual(pick(env), { [KEY]: '600000', [SIBLING]: 'g' },
    'session > workspace > global > baked default, and the global-only sibling key still crosses');
});

after(() => { setImmediate(() => process.exit(0)); });
