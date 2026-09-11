'use strict';
// accounts-session.test.js — t811, the two session-manager seams the accounts
// registry reaches:
//
//  1. `session:list` gains an `account` label per row. It is read off the
//     PERSISTED entry's env, never the live process's, because the persisted
//     entry is the respawn recipe — the row is a claim about which account the
//     seat comes back on.
//  2. `create()` REFUSES to spawn when the merged env names a CLAUDE_CONFIG_DIR
//     that does not exist. That is the load-bearing half: without it the CLI
//     mints an empty config in the missing path and the seat loops on
//     onboarding forever, with nothing in any log to say why. So the assertion
//     is not merely that create() rejects — it is that `pty.spawn` was NEVER
//     CALLED, which is the difference between a refusal and a wedged tab.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

// --- 1. the `account` column on a list() row ---------------------------------

// Seats land in the live map directly: create() is the spawn path and this is
// about list()'s projection.
function mkRows(seats, { entries = {}, accounts } = {}) {
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: (n) => entries[n] || null }),
    getAccounts: accounts === undefined ? undefined : () => accounts,
    notifyOS: () => {},
    log: { info() {}, warn() {}, error() {}, debug() {} },
    fs,
    countPending: () => 0,
    resolveTeam: () => null,
    findProjectRoot: () => null,
  });
  const m = new SessionManager();
  for (const s of seats) {
    m.sessions.set(s.name, {
      type: 'claude', agentType: 'claude', cwd: '/proj', pty: { pid: 1 },
      activityState: 'idle', ...s,
    });
  }
  return Object.fromEntries(m.list().map((r) => [r.name, r]));
}

// One registry for the row tests: `/minted/sub-2` is registered, `~/.claude` is
// the default, and anything else falls back to its basename.
const registry = {
  labelFor: (dir) => {
    if (dir === '/home/u/.claude') return 'default';
    if (dir === '/minted/sub-2') return 'sub-2';
    return path.basename(dir);
  },
};

test('list(): a row whose persisted env names a REGISTERED dir carries that label', () => {
  const rows = mkRows([{ name: 'fable-seat' }], {
    entries: { 'fable-seat': { env: { CLAUDE_CONFIG_DIR: '/minted/sub-2' } } },
    accounts: registry,
  });
  assert.strictEqual(rows['fable-seat'].account, 'sub-2');
});

test('list(): a row with no env at all reads `default`', () => {
  const rows = mkRows([{ name: 'plain' }], { entries: { plain: {} }, accounts: registry });
  assert.strictEqual(rows.plain.account, 'default');
  // And a persisted entry that exists but carries other env vars — the absence
  // that matters is CLAUDE_CONFIG_DIR's, not the env map's.
  const withOther = mkRows([{ name: 'plain' }], {
    entries: { plain: { env: { MY_KEY: 'x' } } }, accounts: registry,
  });
  assert.strictEqual(withOther.plain.account, 'default');
});

test('list(): an env pointing at claudeHome itself reads `default`, not a basename', () => {
  const rows = mkRows([{ name: 'seat' }], {
    entries: { seat: { env: { CLAUDE_CONFIG_DIR: '/home/u/.claude' } } },
    accounts: registry,
  });
  assert.strictEqual(rows.seat.account, 'default');
});

test('list(): an UNREGISTERED dir shows its basename so a hand-typed one stays legible', () => {
  const rows = mkRows([{ name: 'seat' }], {
    entries: { seat: { env: { CLAUDE_CONFIG_DIR: '/Users/u/sub-9' } } },
    accounts: registry,
  });
  assert.strictEqual(rows.seat.account, 'sub-9', 'not mislabelled `default`');
});

test('list(): every row carries an account — a bash seat and an absent entry included', () => {
  const rows = mkRows(
    [{ name: 'a-shell', type: 'bash', agentType: null }, { name: 'ghost' }],
    { entries: {}, accounts: registry },
  );
  // `account` must be PRESENT on every row, not merely correct on the rows that
  // have one: a renderer reading `row.account` on a chip would print undefined.
  assert.strictEqual(rows['a-shell'].account, 'default');
  assert.strictEqual(rows.ghost.account, 'default');
});

test('list(): a host with no accounts store answers `default`, and a throwing one does too', () => {
  const none = mkRows([{ name: 'seat' }], {
    entries: { seat: { env: { CLAUDE_CONFIG_DIR: '/minted/sub-2' } } },
    accounts: undefined,
  });
  assert.strictEqual(none.seat.account, 'default', 'an absent store contributes nothing, it does not throw');

  const broken = mkRows([{ name: 'seat' }], {
    entries: { seat: { env: { CLAUDE_CONFIG_DIR: '/minted/sub-2' } } },
    accounts: { labelFor: () => { throw new Error('registry unreadable'); } },
  });
  assert.strictEqual(broken.seat.account, 'default', 'list() is a render path — best-effort, never a throw');
  // ENTER: the same seat DOES read sub-2 against a working store, so the two
  // defaults above are the fallbacks and not a projection that never works.
  const ok = mkRows([{ name: 'seat' }], {
    entries: { seat: { env: { CLAUDE_CONFIG_DIR: '/minted/sub-2' } } }, accounts: registry,
  });
  assert.strictEqual(ok.seat.account, 'sub-2');
});

// --- 2. create() refuses a missing account dir -------------------------------

function mkManager() {
  const root = mkTmpRoot('clx-accounts-create-');
  const userData = mkTmpRoot('clx-accounts-ud-');
  const store = new Map();
  const persistence = {
    list: () => [...store.values()],
    get: (n) => store.get(n) || null,
    upsert: (e) => store.set(e.name, { ...(store.get(e.name) || {}), ...e }),
    remove: (n) => store.delete(n),
    setSessionId: () => {}, setStripLevel: () => {}, setLabel: () => {},
  };
  const spawns = [];
  let mgr = null;
  const fakePty = {
    spawn: (_cmd, _args, opts) => {
      const rec = { env: opts.env };
      spawns.push(rec);
      return { onData() {}, onExit() {}, pid: 999, kill() { if (mgr) mgr.sessions.delete(rec.name); } };
    },
  };
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: root,
    fs, path, pathFor, runDirFor,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => persistence,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => userData,
    resolveProxyBase: () => null,
    lastTranscriptWrite: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { start() {} stop() {} },
    JsonlWatcher: class { start() {} stop() {} },
    pty: fakePty,
    os,
    stripLevelOf: () => 0,
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const m = new SessionManager();
  mgr = m;
  m._sendToSession = () => {};
  m._broadcast = () => {};
  // A real create() leaves watchers and timers behind; an fs.watch handle would
  // keep the loop alive and turn a green file into a hang.
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
  };
  return { m, root, persistence, spawns, stop };
}

// `bash` by default because that is the only type this fixture can carry all
// the way to a spawn — a claude seat reaches the proxy-registration path, which
// wants deps this manager is not given. The guard under test is claude-only
// (t812), so the tests that assert a THROW pass `'claude'` explicitly; they
// reject before any of that wiring runs.
const create = (m, name, sessionEnv, type = 'bash') => m.create(
  name, type, os.tmpdir(), [], null, 'ws', null, false, null,
  [], [], [], [], [], null, [], [], null, sessionEnv,
);

test('create(): a CLAUDE_CONFIG_DIR that does not exist throws BEFORE any spawn', async () => {
  const { m, spawns, stop } = mkManager();
  const missing = path.join(os.tmpdir(), 'clx-no-such-account-dir-t811');
  assert.strictEqual(fs.existsSync(missing), false, 'ENTER: the path really is absent');

  await assert.rejects(
    () => create(m, 'doomed', { CLAUDE_CONFIG_DIR: missing }, 'claude'),
    new RegExp(`^Error: account dir ${missing} does not exist$`),
  );
  // THE assertion. A throw after the spawn would leave a live CLI looping on
  // onboarding against the missing dir, which is the failure being prevented.
  assert.strictEqual(spawns.length, 0, 'nothing was spawned');
  assert.strictEqual(m.sessions.has('doomed'), false, 'and no session record survives');
  stop('doomed');
});

test('create(): a CLAUDE_CONFIG_DIR that EXISTS spawns, and the var reaches the PTY env', async () => {
  const { m, root, spawns, stop } = mkManager();
  const real = path.join(root, 'accounts', 'sub-2');
  fs.mkdirSync(real, { recursive: true });
  try {
    await create(m, 'fine', { CLAUDE_CONFIG_DIR: real });
    assert.strictEqual(spawns.length, 1, 'the guard passes a dir that is there');
    assert.strictEqual(spawns[0].env.CLAUDE_CONFIG_DIR, real, 'and the account rides into the PTY env');
  } finally { stop('fine'); }
});

test('create(): a CLAUDE_CONFIG_DIR that is a FILE is refused too', async () => {
  // The check is isDirectory(), not existsSync: a regular file at that path is
  // exactly as unusable as an absent one, and existsSync would wave it through.
  const { m, root, spawns, stop } = mkManager();
  const notADir = path.join(root, 'a-file');
  fs.writeFileSync(notADir, 'not a config dir');
  await assert.rejects(() => create(m, 'doomed', { CLAUDE_CONFIG_DIR: notADir }, 'claude'), /account dir .* does not exist/);
  assert.strictEqual(spawns.length, 0);
  stop('doomed');
});

test('create(): the guard reads the MERGED env, so a GLOBAL scope var is checked too', async () => {
  // The var can arrive from any scope, not just this call's session env — a
  // guard that only looked at the sessionEnv argument would miss the operator
  // who set CLAUDE_CONFIG_DIR globally in Preferences.
  const root = mkTmpRoot('clx-accounts-global-');
  const userData = mkTmpRoot('clx-accounts-global-ud-');
  const spawns = [];
  const missing = path.join(os.tmpdir(), 'clx-no-such-global-dir-t811');
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: root,
    fs, path, pathFor, runDirFor,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => ({ list: () => [], get: () => null, upsert: () => {}, remove: () => {}, setSessionId: () => {}, setStripLevel: () => {}, setLabel: () => {} }),
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getEnvScopes: () => ({ all: () => ({ global: { CLAUDE_CONFIG_DIR: { value: missing, secret: false } }, workspaces: {} }) }),
    getUserDataPath: () => userData,
    resolveProxyBase: () => null,
    lastTranscriptWrite: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { start() {} stop() {} },
    JsonlWatcher: class { start() {} stop() {} },
    pty: { spawn: () => { spawns.push(1); return { onData() {}, onExit() {}, pid: 9, kill() {} }; } },
    os,
    stripLevelOf: () => 0,
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  await assert.rejects(() => create(m, 'doomed', null, 'claude'), /account dir .* does not exist/);
  assert.strictEqual(spawns.length, 0, 'a globally-scoped bad dir is caught too');
});

test('create(): no CLAUDE_CONFIG_DIR anywhere spawns exactly as before', async () => {
  // The guard must be inert for the overwhelming majority of seats, which are on
  // the default account and set no such var at all.
  const { m, spawns, stop } = mkManager();
  try {
    await create(m, 'plain', null);
    assert.strictEqual(spawns.length, 1);
    assert.strictEqual('CLAUDE_CONFIG_DIR' in spawns[0].env, false, 'the default account is the ABSENCE of the var');
  } finally { stop('plain'); }
});

test('create(): a BASH seat on a missing account dir SPAWNS — that is how /login mints it', () => {
  // t812. The guard is claude-only: Preferences ▸ Accounts ▸ Log in opens a bash
  // seat carrying the account's CLAUDE_CONFIG_DIR and writes `claude /login`
  // into it, and for a registered-but-never-logged-in account that dir may not
  // exist yet. Refusing the bash spawn would make an unminted dir unfixable from
  // the UI — the one path that creates it is the one path the guard blocked.
  const { m, spawns, stop } = mkManager();
  const missing = path.join(os.tmpdir(), 'clx-no-such-account-dir-t812');
  assert.strictEqual(fs.existsSync(missing), false, 'ENTER: the path really is absent');
  return create(m, 'login-sub-2', { CLAUDE_CONFIG_DIR: missing }, 'bash').then(() => {
    assert.strictEqual(spawns.length, 1, 'the shell opened');
    assert.strictEqual(spawns[0].env.CLAUDE_CONFIG_DIR, missing, 'and it carries the account it is there to log in');
    stop('login-sub-2');
  });
});
