'use strict';
// clodex-home-app-root.test.js — t118's decision: REGISTRY_DIR is the app's
// root, and the team layer must follow it. CLODEX_HOME stays a seam for the
// STANDALONE script (scripts/clodex-team.js, pinned by clodex-team.test.js),
// never app configuration.
//
// The fixture is the whole point. `createTeamManifest({ fs })` fell back to
// defaultClodexHome(), i.e. the env var, so with CLODEX_HOME set the teams
// resolved to one tree while memory, messages, pending, peer-outbox, run/ and
// skill-plugins resolved to another. A test asserting the two AGREE while the
// variable is unset passes whatever the code does — they agree then regardless.
// So every case below sets CLODEX_HOME to a tree that is not REGISTRY_DIR and
// asserts the app ignores it.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createEngine } = require('../engine');

// The app's root, derived exactly as engine.js:133 / main.js / headless-main.js
// derive it: bare homedir, no env var in the expression.
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

test('the in-app team layer follows REGISTRY_DIR, not CLODEX_HOME', async () => {
  await withDecoyHome(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-eng-home-'));
    try {
      const eng = createEngine({ userDataPath: tmp, seams: {}, log: { info() {}, warn() {}, error() {} } });
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

// createEngine starts background timers that keep the loop alive.
after(() => { setImmediate(() => process.exit(0)); });
