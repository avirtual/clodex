'use strict';
// clodex-home-app-root.test.js — the invariant t118 protected, kept while its
// ruling is reversed (t760): ONE root per instance. An INJECTED REGISTRY_DIR is
// the app's root and every subsystem must follow it, outranking CLODEX_HOME —
// which since t760 supplies the app's root only when nothing injected one.
//
// The fixture is the whole point. `createTeamManifest({ fs })` fell back to
// defaultClodexHome(), i.e. the env var, so with CLODEX_HOME set the teams
// resolved to one tree while memory, messages, pending, peer-outbox, run/ and
// skill-plugins resolved to another. A test asserting the two AGREE while the
// variable is unset passes whatever the code does — they agree then regardless.
// So every case below sets CLODEX_HOME to a tree that is not the injected
// REGISTRY_DIR and asserts the injected one still wins.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createEngine } = require('../engine');

// The operator's live tree, which no case here may resolve to.
const APP_ROOT = path.join(os.homedir(), '.clodex');

// A decoy CLODEX_HOME carrying a team the app must not see. The name is
// improbable enough that a hit could only have come from this tree.
function mkDecoyHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-decoy-home-'));
  const teamDir = path.join(home, 'teams', 'decoy-team-from-env');
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(path.join(teamDir, 'team.json'), JSON.stringify({
    name: 'decoy-team-from-env', root: '/tmp', lead: 'lead', roles: { lead: {} },
  }));
  return home;
}

// ASYNC, and every caller awaits it. Synchronous, the finally ran in the same
// tick as an async fn's first await — restoring CLODEX_HOME before the exec
// spawn's setImmediate ever snapshotted process.env, so case 2 compared the
// child's env against `undefined` and could not fail.
async function withDecoyHome(fn) {
  const prev = process.env.CLODEX_HOME;
  const home = mkDecoyHome();
  process.env.CLODEX_HOME = home;
  try {
    assert.notStrictEqual(home, APP_ROOT, 'the fixture must make the two trees DIFFER, or it asserts nothing');
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.CLODEX_HOME; else process.env.CLODEX_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('an injected REGISTRY_DIR outranks CLODEX_HOME for the in-app team layer', async () => {
  await withDecoyHome(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-eng-home-'));
    try {
      // An explicit registryDir, not the real home (t359): the discriminator here
      // is that a team planted in CLODEX_HOME stays invisible, and a root that is
      // neither the decoy nor the operator's live tree tests that just as sharply
      // without seeding ~/.clodex from whatever branch the suite runs in.
      const eng = createEngine({
        userDataPath: tmp,
        seams: { registryDir: path.join(tmp, 'clodex-home') },
        log: { info() {}, warn() {}, error() {} },
      });
      // listTeams is the front door's own reader, so this drives the real wiring
      // rather than re-deriving a path the product might not use.
      const names = eng.listTeams().map((t) => t.name || t);
      assert.ok(!names.includes('decoy-team-from-env'),
        `a team planted in CLODEX_HOME must be invisible to the app — got ${JSON.stringify(names)}`);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

test('the exec child is given CLODEX_HOME=REGISTRY_DIR rather than inheriting the app\'s', async () => {
  // Fixing the engine alone relocates the split one process over: the exec
  // child spawned with no `env` key inherits the app's environment, so a set
  // CLODEX_HOME would make scripts/clodex-team.js follow it while the app no
  // longer does. There is no --home flag; the env is the only channel.
  const { createSessionManager } = require('../session-manager');
  const { isFilenameToken, parseAndValidate } = require('../exec-schema');

  await withDecoyHome(async (decoy) => {
    const REGISTRY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-exec-home-'));
    try {
      const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
      fs.mkdirSync(execDir, { recursive: true });
      fs.writeFileSync(path.join(execDir, 'clodex-team.json'), JSON.stringify({
        argv: ['/usr/bin/env', 'node', '${CLODEX_BIN}/clodex-team.js'],
        timeoutMs: 5000, maxBytes: 4096, replyStderr: true,
        schema: {
          type: 'object', additionalProperties: false, required: ['action', 'agent'],
          properties: { action: { type: 'string', enum: ['roster'] }, agent: { type: 'string', maxLength: 64 } },
        },
      }));

      const spawned = [];
      const fakeChild = () => {
        const ee = new (require('node:events').EventEmitter)();
        ee.stdin = { write() {}, end() {} };
        ee.stderr = new (require('node:events').EventEmitter)();
        ee.kill = () => {};
        setImmediate(() => ee.emit('exit', 0, null));
        return ee;
      };
      // createSessionManager returns the CLASS; the manager is an instance of it.
      const SessionManager = createSessionManager({
        knownSkillNames: () => [],
        REGISTRY_DIR,
        isFilenameToken, parseAndValidate,
        os, fs, path,
        log: { warn() {}, info() {}, error() {} },
        getPersistence: () => ({ list: () => [], get: () => ({ execCommands: ['clodex-team'] }) }),
        childProcess: { spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return fakeChild(); } },
      });
      const m = new SessionManager();
      m._injectText = () => {};
      m._broadcast = () => {};
      const session = { name: 'a', agentType: 'claude', workspaceId: 'ws1', cwd: '/some/session/cwd' };

      m._handleExecIntent(session, 'clodex-team', JSON.stringify({ action: 'roster', agent: 'a' }));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      assert.strictEqual(spawned.length, 1, 'the command spawned once');
      const env = spawned[0].opts && spawned[0].opts.env;
      assert.ok(env, 'the spawn must set an env explicitly; inheriting is the bug');
      assert.strictEqual(env.CLODEX_HOME, REGISTRY_DIR,
        'the child is pointed at the app root, not at whatever the app inherited');
      assert.notStrictEqual(env.CLODEX_HOME, decoy,
        'the decoy in the app\'s own environment must not reach the child');
      // The rest of the environment still crosses — PATH is how `/usr/bin/env
      // node` resolves at all.
      assert.strictEqual(env.PATH, process.env.PATH, 'the env is extended, not replaced');

    } finally { fs.rmSync(REGISTRY_DIR, { recursive: true, force: true }); }
  });
});

// t760's other half: with nothing injected, CLODEX_HOME MOVES the root. Driven
// through writeComposeFile because sandbox.js resolves its registryDir from the
// same fallback and then bakes it into the compose file's bind sources — a real
// consumer, not a re-derivation. Every other dep is injected, so no docker, no
// settings store and no port probe is touched.
test('an un-injected registryDir follows CLODEX_HOME into the compose mounts', async () => {
  const { createSandbox } = require('../sandbox');
  await withDecoyHome(async (home) => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-sbx-ud-'));
    try {
      const box = createSandbox({
        getUserDataPath: () => userData,
        getUiSettings: () => ({ get: () => ({}), set: () => {} }),
        isPortInUse: async () => false,
        log: { info() {}, error() {} },
      });
      const gen = await box.writeComposeFile();
      const yaml = fs.readFileSync(gen.path, 'utf8');
      assert.ok(yaml.includes(`${path.join(home, 'library')}:`),
        `the library bind must come from CLODEX_HOME — got:\n${yaml}`);
      assert.ok(!yaml.includes(`${path.join(APP_ROOT, 'library')}:`),
        'the operator home must not appear once CLODEX_HOME is set');
      assert.ok(fs.existsSync(path.join(home, 'library')),
        'the mount sources are created under the override, not under the operator home');
    } finally { fs.rmSync(userData, { recursive: true, force: true }); }
  });
});

// main.js and headless-main.js cannot be required here — one needs electron, the
// other takes a pidfile and stands a live engine up at module scope. Their share
// of the flip is therefore pinned on the source: each must derive REGISTRY_DIR
// from the shared resolver, and hang LOG_FILE off that same const, so the log
// file, the host stamp and the engine agree by construction.
for (const host of ['main.js', 'headless-main.js']) {
  test(`${host} derives its registry root from defaultClodexHome()`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', host), 'utf8');
    assert.ok(/const REGISTRY_DIR = defaultClodexHome\(\);/.test(src),
      `${host} must resolve its root through the shared CLODEX_HOME-aware resolver`);
    assert.ok(/require\('\.\/clodex-paths'\)/.test(src),
      `${host} must import that resolver rather than re-implement it`);
    assert.ok(!/path\.join\(os\.homedir\(\), '\.clodex'\)/.test(src),
      `${host} must keep no hard-coded ~/.clodex, or the override splits the root`);
    assert.ok(/const LOG_FILE = path\.join\(REGISTRY_DIR, 'clodex\.log'\);/.test(src),
      `${host}'s log file must hang off REGISTRY_DIR so it moves with the root`);
  });
}

test('main.js moves userData to CLODEX_DATA_DIR before the single-instance lock', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const setPathAt = src.indexOf("app.setPath('userData'");
  const lockAt = src.indexOf('app.requestSingleInstanceLock()');
  assert.ok(setPathAt > -1, 'main.js must move userData when CLODEX_DATA_DIR is set');
  assert.ok(lockAt > -1, 'main.js must still take the single-instance lock');
  assert.ok(setPathAt < lockAt,
    'the setPath must precede the lock, or both instances lock the default userData dir');
  assert.ok(/CLODEX_DATA_DIR/.test(src.slice(Math.max(0, setPathAt - 200), setPathAt)),
    'the move must be gated on CLODEX_DATA_DIR, not taken unconditionally');
  assert.ok(/app\.setPath\('userData', path\.resolve\(process\.env\.CLODEX_DATA_DIR\)\)/.test(src),
    'the desktop host must resolve the override, not pass a relative string through');

  const headless = fs.readFileSync(path.join(__dirname, '..', 'headless-main.js'), 'utf8');
  assert.ok(/path\.resolve\(process\.env\.CLODEX_DATA_DIR\)/.test(headless),
    'the headless host must resolve it too, or the two hosts disagree on a relative value');
});

// createEngine starts background timers that keep the loop alive.
after(() => { setImmediate(() => process.exit(0)); });
