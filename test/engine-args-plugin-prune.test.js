'use strict';
// engine-args-plugin-prune.test.js — t654 MUST-FIX 1: narrowing a seat's plugin
// list must SURVIVE the restart the same save performs.
//
// applySessionArgs prunes first (setIntents/setPluginGrants drop the unticked
// plugin's verbs and grant tokens) and only then restarts. Every value the
// restart arm carries was read into `beforeKill` BEFORE that prune, so each of
// its three writes can put the dropped data straight back:
//
//   - `_preserveAcrossRestart` re-seeds the record, and `pluginGrants` is in
//     ALWAYS_PRESERVE — carried whether or not the caller names it.
//   - `create()` is handed the intents allowlist, and create()'s own upsert is
//     what makes a gate survive kill()+recreate.
//   - the failure arm spreads the pre-kill entry back over the record.
//
// So the assertions here read the STORE after the call returns, not the
// arguments create() received: the bug is a later write undoing an earlier one,
// which a call-arg test passes over by construction. The one call-arg assertion
// below is marked as such and exists because create() is stubbed, so its
// intents param has no other observable effect.
//
// createEngine constructs electron-free against a temp userData and starts
// background timers with no host to stop them, so we force-exit in `after` once
// assertions flush — node --test isolates each file in its own subprocess.

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createEngine } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');
const registry = require('../intent-registry');

function mkEngine() {
  const tmp = mkTmpRoot('clx-eng-prune-');
  return createEngine({
    userDataPath: tmp,
    seams: { registryDir: path.join(tmp, 'clodex-home') },
    log: { info() {}, warn() {}, error() {} },
  });
}

function mkRow(verb) {
  return { verb, parse: (l) => (l === `[agent:${verb}]` ? { probe: verb } : null) };
}

// The registry's plugin table is module-level, so a leaked row changes what
// every later test in this process parses.
function withRows(fn) {
  registry.registerIntent(mkRow('keptverb'), 'kept');
  registry.registerIntent(mkRow('goneverb'), 'gone');
  try { return fn(); } finally { registry._resetPluginRows(); }
}

test('narrowing plugins + restart: the pruned grants survive _preserveAcrossRestart', async () => withRows(async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert({
    name: 'a', type: 'claude', cwd: '/tmp',
    plugins: ['kept', 'gone'],
    intents: ['dm', 'keptverb', 'goneverb'],
    pluginGrants: ['kept:turns', 'gone:turns', 'gone:thinking'],
  });
  const captured = [];
  eng.manager.create = async (...args) => { captured.push(args); return { name: args[0], backend: null }; };

  const res = await eng.applySessionArgs('a', { extraArgs: [], restart: true, plugins: ['kept'] }, 'default');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.restarted, true,
    'ENTER: the restart must have happened — a save that did not respawn never reaches the arm under test and every assertion below reads the pre-restart store');
  assert.strictEqual(captured.length, 1, 'create was called once');

  const after1 = eng.stores.persistence.get('a');
  assert.deepStrictEqual(after1.plugins, ['kept'], 'the narrowed list is what persisted');
  assert.deepStrictEqual(after1.pluginGrants, ['kept:turns'],
    'and the dropped plugin\'s grant tokens stayed dropped — ALWAYS_PRESERVE must not carry the pre-prune value back');
  assert.deepStrictEqual(after1.intents, ['dm', 'keptverb'],
    'the dropped plugin\'s verb stayed out of the persisted allowlist');
  // Call-arg, and the only observation available: create() is stubbed here, so
  // the allowlist it is handed has no other effect. The store assertions above
  // are what catch a later write undoing this one.
  assert.deepStrictEqual(captured[0][17], ['dm', 'keptverb'],
    'create() is spawned with the PRUNED allowlist, not the pre-prune one it would bake into the prompt and re-persist');
  assert.deepStrictEqual(captured[0][21], ['kept'], 'and with the narrowed plugin list');
}));

test('narrowing plugins to NONE + restart: every plugin grant goes and none returns', async () => withRows(async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert({
    name: 'b', type: 'claude', cwd: '/tmp',
    plugins: ['kept', 'gone'],
    intents: ['dm', 'keptverb', 'goneverb'],
    pluginGrants: ['kept:turns', 'gone:turns'],
  });
  eng.manager.create = async (...args) => ({ name: args[0], backend: null });

  const res = await eng.applySessionArgs('b', { extraArgs: [], restart: true, plugins: [] }, 'default');
  assert.strictEqual(res.restarted, true, 'ENTER: the restart happened');

  const entry = eng.stores.persistence.get('b');
  assert.deepStrictEqual(entry.plugins, [], '[] is a real value — the seat that has no plugins');
  assert.ok(!('pluginGrants' in entry),
    'an empty grants list is stored as ABSENCE (setPluginGrants deletes the key), so the seed must not re-add it');
  assert.deepStrictEqual(entry.intents, ['dm'], 'only the core verb is left');
}));

test('narrowing plugins + a restart that FAILS: the failure arm writes the pruned values, not the pre-kill ones', async () => withRows(async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert({
    name: 'c', type: 'claude', cwd: '/tmp',
    plugins: ['kept', 'gone'],
    intents: ['dm', 'keptverb', 'goneverb'],
    pluginGrants: ['kept:turns', 'gone:thinking'],
  });
  eng.manager.create = async () => { throw new Error('spawn refused'); };

  const res = await eng.applySessionArgs('c', { extraArgs: [], restart: true, plugins: ['kept'] }, 'default');
  assert.strictEqual(res.ok, false, 'ENTER: create threw, so the catch arm is the one that wrote the record');
  assert.match(res.error, /spawn refused/);

  const entry = eng.stores.persistence.get('c');
  assert.deepStrictEqual(entry.intents, ['dm', 'keptverb'],
    'the spread must carry the pruned allowlist — the record is what the next workspace open respawns from');
  assert.deepStrictEqual(entry.pluginGrants, ['kept:turns'],
    'and the pruned grants, or a failed restart silently restores a revoked capability');
}));

test('a restart that does NOT touch plugins leaves the persisted gate and grants byte-identical', async () => withRows(async () => {
  const eng = mkEngine();
  const before = {
    name: 'd', type: 'claude', cwd: '/tmp',
    plugins: ['kept', 'gone'],
    intents: ['dm', 'keptverb', 'goneverb'],
    pluginGrants: ['kept:turns', 'gone:thinking'],
  };
  eng.stores.persistence.upsert({ ...before });
  const captured = [];
  eng.manager.create = async (...args) => { captured.push(args); return { name: args[0], backend: null }; };

  const res = await eng.applySessionArgs('d', { extraArgs: ['--x'] , restart: true }, 'default');
  assert.strictEqual(res.restarted, true, 'ENTER: the restart happened');
  const entry = eng.stores.persistence.get('d');
  assert.deepStrictEqual(entry.plugins, ['kept', 'gone'], 'an omitted plugins key is untouched, not a clear');
  assert.deepStrictEqual(entry.intents, ['dm', 'keptverb', 'goneverb'], 'and prunes nothing');
  assert.deepStrictEqual(entry.pluginGrants, ['kept:turns', 'gone:thinking']);
  assert.deepStrictEqual(captured[0][17], ['dm', 'keptverb', 'goneverb'],
    'and create() is spawned with the same allowlist it had');
}));

after(() => { setImmediate(() => process.exit(0)); });
