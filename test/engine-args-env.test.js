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
  // 21, because create() grew two positionals past env (mint, then t189's
  // noWire). The count is still asserted rather than only the index: env sits at
  // 18 and a signature that lost a LATER argument would leave 18 correct while
  // the tail silently defaults — which is how noWire would stop surviving a
  // restart with nothing else failing.
  assert.strictEqual(captured[0].length, 21, 'create got the full 21-positional signature');
  assert.deepStrictEqual(captured[0][18], { AWS_PROFILE: 'acct', DB: 'x' }, 'the persisted env is threaded as the 19th arg — not dropped');
  assert.strictEqual(captured[0][20], false,
    'and the 21st is noWire, resolved off the persisted entry — an args edit must not un-wire an ordinary seat');
});

// t189 — the arm that carries the claim. The `false` above is satisfied by a
// dropped argument (the parameter defaults false), so on its own it says nothing
// about whether the value is READ. This one can only pass if applySessionArgs
// actually reaches into the persisted entry: the Edit dialog does not surface
// wire-off, so `patch` never carries it and the record is the sole source.
// Without this, an args edit silently re-wires a wire-off seat — ANTHROPIC_BASE_URL
// comes back and the phone can no longer attach — while the save reports success.
test('args-edit restart on a WIRE-OFF seat threads noWire true (21st positional)', async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert({ name: 'w', type: 'claude', cwd: '/tmp', noWire: true });
  const captured = [];
  spyCreate(eng.manager, captured);
  const res = await eng.applySessionArgs('w', { extraArgs: ['--z'], restart: true }, 'default');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.restarted, true,
    'ENTER: the restart must have happened — a save that did not respawn calls create() zero times and the assertion below reads undefined');
  assert.strictEqual(captured.length, 1, 'create was called once');
  assert.strictEqual(captured[0][20], true,
    'the persisted wire-off flag survives an unrelated args edit — the patch never carries it, so this can only come from the record');
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

// T46b — the Edit dialog now OWNS session env: a patch.env EDITS the entry (persist +
// thread the NEW value, not beforeKill's), and the deny-list bites at the door.
test('args-edit CHANGES session env: new env is persisted and threaded (deny/invalid dropped)', async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert({ name: 'c', type: 'bash', cwd: '/tmp', env: { OLD: 'gone' } });
  const captured = [];
  spyCreate(eng.manager, captured);
  const res = await eng.applySessionArgs('c', {
    extraArgs: [], restart: true, env: { AWS_PROFILE: 'acct', CLODEX_REMOTE_TOKEN: 'x', '1bad': 'y' },
  }, 'default');
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(captured[0][18], { AWS_PROFILE: 'acct' },
    'the NEW env is threaded, the old is replaced, and the deny/invalid keys are dropped');
  assert.deepStrictEqual(eng.stores.persistence.get('c').env, { AWS_PROFILE: 'acct' },
    'the new env is persisted flat on the entry');
});

test('args-edit CLEARS session env: empty map → threads null AND drops entry.env (clear-to-null)', async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert({ name: 'd', type: 'bash', cwd: '/tmp', env: { AWS_PROFILE: 'acct' } });
  const captured = [];
  spyCreate(eng.manager, captured);
  const res = await eng.applySessionArgs('d', { extraArgs: [], restart: true, env: {} }, 'default');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(captured[0][18], null, 'a cleared env threads null (byte-identity holds)');
  assert.ok(!('env' in eng.stores.persistence.get('d')), 'entry.env is REMOVED, not left as {}');
});

test('args-edit with env omitted preserves the persisted env (no-restart save)', async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert({ name: 'e', type: 'bash', cwd: '/tmp', env: { AWS_PROFILE: 'acct' } });
  const res = await eng.applySessionArgs('e', { extraArgs: ['--z'] }, 'default'); // no restart, no env key
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.restarted, false);
  assert.deepStrictEqual(eng.stores.persistence.get('e').env, { AWS_PROFILE: 'acct' },
    'omitting env leaves the persisted env untouched');
});

// createEngine's background timers keep the loop alive; exit once results flush.
after(() => { setImmediate(() => process.exit(0)); });
