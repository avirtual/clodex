'use strict';
// instance-label.test.js — CLODEX_LABEL, the third of the three env vars that
// let two Clodexes share one box (with CLODEX_HOME and CLODEX_DATA_DIR).
//
// Without it both instances self-label as the hostname, so the hello `host`
// field a peer displays and the `@origin` half of a relayed sender tag read the
// same for both. Addressing is unaffected either way — a dm target resolves
// against the SENDER's own peer labels — so what is at stake is legibility.
//
// Two layers, because either alone is a pin that cannot fail for the right
// reason. resolveSelfLabel's four cases are the policy; the engine case is the
// wiring — SELF_LABEL is not on createEngine's return, it reaches the wire as
// the RemoteServer's `hostLabel`, so that is where a const still hard-coding
// os.hostname() shows up.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { createEngine, resolveSelfLabel } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

function mkLog() {
  const warns = [];
  return { warns, info() {}, error() {}, warn(tag, msg) { warns.push(`${tag} ${msg}`); } };
}

// ── the policy, as a pure function ───────────────────────────────────────────

test('unset CLODEX_LABEL: the hostname, minus a .local suffix', () => {
  const log = mkLog();
  assert.strictEqual(resolveSelfLabel({}, 'box-a.local', log), 'box-a');
  assert.strictEqual(resolveSelfLabel({}, 'box-a', log), 'box-a');
  assert.deepStrictEqual(log.warns, [], 'the default path is not a complaint');
});

test('CLODEX_LABEL=box-b: that, so a second instance on one box is legible', () => {
  const log = mkLog();
  assert.strictEqual(resolveSelfLabel({ CLODEX_LABEL: 'box-b' }, 'shared.local', log), 'box-b');
  assert.strictEqual(resolveSelfLabel({ CLODEX_LABEL: '  box-b  ' }, 'shared.local', log), 'box-b',
    'trimmed: a trailing space in an export block is not part of the name');
  assert.deepStrictEqual(log.warns, []);
});

test('whitespace-only: falls through to the hostname, silently', () => {
  const log = mkLog();
  assert.strictEqual(resolveSelfLabel({ CLODEX_LABEL: '   ' }, 'shared.local', log), 'shared');
  assert.strictEqual(resolveSelfLabel({ CLODEX_LABEL: '' }, 'shared.local', log), 'shared');
  assert.deepStrictEqual(log.warns, [], 'an unset-shaped value is not a mistake worth a warn');
});

test('a value the outbox guard rejects: the hostname, plus one warn naming it', () => {
  // The label becomes an `@origin` suffix AND a path segment under the outbox
  // root, so it must clear the same validOrigin gate a wire-supplied origin
  // does. Each of these passes some looser check and fails that one.
  for (const bad of ['a/b', '..', '.', '../evil', 'has space', 'x'.repeat(65)]) {
    const log = mkLog();
    assert.strictEqual(resolveSelfLabel({ CLODEX_LABEL: bad }, 'shared.local', log), 'shared',
      `${JSON.stringify(bad)} must not reach the wire`);
    assert.strictEqual(log.warns.length, 1, `one warn for ${JSON.stringify(bad)}`);
    assert.match(log.warns[0], /CLODEX_LABEL/);
    assert.ok(log.warns[0].includes(bad.trim()), 'the warn names the rejected value');
    assert.ok(log.warns[0].includes('shared'), 'and the label actually used');
  }
});

// ── the wiring: the const the whole peer wire reads ──────────────────────────

// SELF_LABEL is not on createEngine's return object, so drive the real path:
// stand an engine up, patch RemoteServer to capture its construction options,
// and read `hostLabel` — the field the hello puts on the wire. Patching means
// no socket is ever bound. CLODEX_REMOTE_ENABLE=1 is the documented
// headless-container switch that brings the wire up with no settings write.
function engineHostLabel(label) {
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  const hadEnable = process.env.CLODEX_REMOTE_ENABLE;
  const hadLabel = process.env.CLODEX_LABEL;
  const tmp = mkTmpRoot('clx-label-');
  let opts = null;
  remoteMod.RemoteServer = function (o) {
    opts = o;
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() {}, setWtermCallbacks() {} };
  };
  process.env.CLODEX_REMOTE_ENABLE = '1';
  if (label === undefined) delete process.env.CLODEX_LABEL;
  else process.env.CLODEX_LABEL = label;
  const log = mkLog();
  try {
    const engine = createEngine({
      userDataPath: tmp,
      // registryDir or the engine seeds the operator's live ~/.clodex.
      seams: { registryDir: path.join(tmp, 'clodex-home') },
      log,
    });
    engine.syncRemoteServer();
  } finally {
    remoteMod.RemoteServer = orig;
    if (hadEnable === undefined) delete process.env.CLODEX_REMOTE_ENABLE;
    else process.env.CLODEX_REMOTE_ENABLE = hadEnable;
    if (hadLabel === undefined) delete process.env.CLODEX_LABEL;
    else process.env.CLODEX_LABEL = hadLabel;
  }
  assert.ok(opts, 'the peer wire was constructed');
  return { hostLabel: opts.hostLabel, warns: log.warns };
}

test('the engine const reads the env: CLODEX_LABEL reaches the wire as hostLabel', () => {
  const hostname = os.hostname().replace(/\.local$/, '');
  assert.strictEqual(engineHostLabel(undefined).hostLabel, hostname,
    'unset → the hostname, exactly as before this variable existed');
  assert.strictEqual(engineHostLabel('box-b').hostLabel, 'box-b');
  assert.strictEqual(engineHostLabel('  ').hostLabel, hostname);
  const bad = engineHostLabel('a/b');
  assert.strictEqual(bad.hostLabel, hostname);
  assert.strictEqual(bad.warns.filter((w) => w.includes('CLODEX_LABEL')).length, 1);
});

// createEngine's background timers keep the loop alive; exit once results flush.
after(() => { setImmediate(() => process.exit(0)); });
