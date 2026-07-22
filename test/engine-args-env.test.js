'use strict';
// engine-args-env.test.js — MUST-FIX 1 (T46 review): the args-edit restart path
// (engine.applySessionArgs) must thread the session's persisted env into
// manager.create(). Omitting it made a SUCCESS restart respawn env-less AND
// create()'s own upsert erase env from sessions.json (so every later --resume was
// wrong too) — while the FAILURE path already preserved env via the ...beforeKill
// spread. This pins the arg reaching create(); create() persisting a threaded env
// flat on the entry is separately pinned in session-manager.test.js, so the two
// together give the full "restart keeps entry.env" guarantee.
//
// createEngine constructs electron-free against a temp userData. Its construction
// starts background timers that keep the event loop alive (no host to stop them),
// so we force-exit in an `after` hook once assertions flush — node --test isolates
// each file in its own subprocess, so this only exits THIS file's process.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('../engine');

function mkEngine() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-eng-env-'));
  return createEngine({ userDataPath: tmp, seams: {}, log: { info() {}, warn() {}, error() {} } });
}

// Replace manager.create with a recorder so no real PTY spawns — captures the full
// positional args (the 19th, index 18, is the T46 session env) and returns a
// minimal fake session.
function spyCreate(manager, captured) {
  manager.create = async (...args) => { captured.push(args); return { name: args[0], backend: null }; };
}

test('args-edit restart threads the persisted env into create() (19th positional)', async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert({ name: 'a', type: 'bash', cwd: '/tmp', env: { AWS_PROFILE: 'acct', DB: 'x' } });
  const captured = [];
  spyCreate(eng.manager, captured);
  const res = await eng.applySessionArgs('a', { extraArgs: ['--y'], restart: true }, 'default');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.restarted, true);
  assert.strictEqual(captured.length, 1, 'create was called once');
  assert.strictEqual(captured[0].length, 19, 'create got the full 19-positional signature');
  assert.deepStrictEqual(captured[0][18], { AWS_PROFILE: 'acct', DB: 'x' }, 'the persisted env is threaded as the 19th arg — not dropped');
});

test('args-edit restart with no persisted env threads null (no-scopes byte-identity holds)', async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert({ name: 'b', type: 'bash', cwd: '/tmp' });
  const captured = [];
  spyCreate(eng.manager, captured);
  const res = await eng.applySessionArgs('b', { extraArgs: [], restart: true }, 'default');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(captured[0][18], null, 'an env-less session threads null, not {}');
});

// createEngine's background timers keep the loop alive; exit once results flush.
after(() => { setImmediate(() => process.exit(0)); });
