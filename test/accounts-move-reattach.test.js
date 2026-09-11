'use strict';
// Run: node --test test/accounts-move-reattach.test.js
//
// t812 r1 MUST-FIX. `accounts:move-by-model` restarts every matching seat, and a
// restart kills the PTY — which fires `session-exit` in the renderer, which
// REMOVES the sidebar row. Every other main-side restart pushes a `reattach`
// context-action afterwards so the row and terminal come back; the move sweep
// did not, so a successful move made each moved seat DISAPPEAR from the sidebar
// until the next app start. The seats were alive and on the new account the
// whole time, which is exactly why nothing else caught it.
//
// The pin is on the ACTION PUSH, per moved seat and only for moved seats: a
// skipped seat was never killed, so pushing reattach for it would rebuild a row
// that is already there.

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createEngine } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

function mkEngine() {
  const tmp = mkTmpRoot('clx-move-reattach-');
  return createEngine({
    userDataPath: tmp,
    seams: { registryDir: path.join(tmp, 'clodex-home') },
    log: { info() {}, warn() {}, error() {} },
  });
}

// Three seats, the sweep's own scenario: two on fable (one idle, one mid-turn)
// and one on opus. Only the idle fable seat may move.
function seed(eng) {
  const { persistence } = eng.stores;
  for (const [name, args] of [
    ['fable-idle', ['--model', 'fable']],
    ['fable-busy', ['--model', 'fable']],
    ['opus-idle', ['--model', 'claude-opus-5']],
  ]) {
    persistence.upsert({ name, type: 'claude', cwd: '/tmp', extraArgs: args });
    eng.manager.sessions.set(name, {
      name, type: 'claude', agentType: 'claude', cwd: '/tmp',
      // kill() must DROP the seat from the live map: the restart path awaits
      // waitForSessionExit, which polls that map for 8s and then throws. A fake
      // PTY whose kill does nothing turns every subject here into a timeout.
      pty: { pid: 1, kill() { eng.manager.sessions.delete(name); } },
      backend: null, noWire: false,
      activityState: name === 'fable-busy' ? 'thinking' : 'idle',
    });
  }
}

// The REAL applySessionArgs runs — `moveAccountByModel` calls it through the
// engine's own closure, so replacing `eng.applySessionArgs` from outside would
// spy a function nothing calls and leave the real restart spawning PTYs. Only
// `manager.create` is stubbed, the idiom of test/engine-args-env.test.js: that
// is the single point the respawn goes through, so the rest of the restart path
// — including the `{ ok, restarted }` this wrapper keys on — stays real.
function spyCreate(eng, { fail = false } = {}) {
  const created = [];
  eng.manager.create = async (...args) => {
    if (fail) throw new Error('respawn failed');
    created.push(args);
    const [name, type, cwd] = args;
    // The real create() RE-PERSISTS the record kill() dropped, and the wrapper
    // reads that record back for the reattach payload's type and cwd. A stub
    // that only faked the live seat would leave the payload typeless — which the
    // renderer treats as "rebuild nothing".
    eng.stores.persistence.upsert({ name, type, cwd, extraArgs: args[3] || [] });
    const seat = { name, type, cwd, backend: null, noWire: false, pty: { pid: 2, kill() {} } };
    eng.manager.sessions.set(name, seat);
    return seat;
  };
  return created;
}

function spySends(eng) {
  const sent = [];
  eng.manager._sendToSession = (name, channel, payload) => { sent.push({ name, channel, payload }); };
  return sent;
}

test('a moved seat gets a reattach context-action, so its sidebar row comes back', async () => {
  const eng = mkEngine();
  seed(eng);
  const created = spyCreate(eng);
  const sent = spySends(eng);
  eng.accounts.add({ label: 'sub-2', plan: 'max', configDir: '/tmp' });

  const res = await eng.moveAccountByModel('fable', 'sub-2');

  // ENTER: the move really did move exactly one seat. Without this the assertions
  // below are satisfied by a sweep that moved nothing at all.
  assert.deepStrictEqual(res.moved, ['fable-idle']);
  assert.deepStrictEqual(created.map((a) => a[0]), ['fable-idle'], 'one respawn, for that seat');

  const reattaches = sent.filter((s) => s.channel === 'session:context-action' && s.payload.action === 'reattach');
  assert.strictEqual(reattaches.length, 1, 'exactly one reattach — one per seat actually restarted');
  assert.strictEqual(reattaches[0].name, 'fable-idle', 'pushed to the seat that was killed');
  assert.strictEqual(reattaches[0].payload.name, 'fable-idle');
  assert.strictEqual(reattaches[0].payload.type, 'claude', 'the renderer rebuilds nothing without a type');
  assert.strictEqual(reattaches[0].payload.background, true,
    'agent-initiated: a bulk move must not steal focus onto the last seat it touched');
});

test('a SKIPPED seat gets no reattach — it was never killed', async () => {
  // fable-busy is mid-turn and opus-idle is on another model. Their rows are
  // untouched on screen, so a reattach for either would rebuild a live row.
  const eng = mkEngine();
  seed(eng);
  spyCreate(eng);
  const sent = spySends(eng);
  eng.accounts.add({ label: 'sub-2', plan: 'max', configDir: '/tmp' });

  const res = await eng.moveAccountByModel('fable', 'sub-2');
  assert.deepStrictEqual(res.skipped.map((s) => s.name).sort(), ['fable-busy', 'opus-idle']);
  const names = sent
    .filter((s) => s.channel === 'session:context-action' && s.payload.action === 'reattach')
    .map((s) => s.name);
  assert.deepStrictEqual(names, ['fable-idle'], 'only the moved seat');
});

test('a FAILED restart gets no reattach — there is no new seat to attach to', async () => {
  // applySessionArgs reports `{ ok:false }` when the respawn threw; the sweep puts
  // the seat in `skipped` with the error. Telling the renderer to rebuild a row
  // for a seat that did not come back would show a tab with a dead terminal.
  const eng = mkEngine();
  seed(eng);
  spyCreate(eng, { fail: true });
  const sent = spySends(eng);
  eng.accounts.add({ label: 'sub-2', plan: 'max', configDir: '/tmp' });

  const res = await eng.moveAccountByModel('fable', 'sub-2');
  assert.deepStrictEqual(res.moved, []);
  assert.ok(
    res.skipped.some((s) => s.name === 'fable-idle' && /^respawn failed —/.test(s.reason)),
    `expected a respawn-failed skip, got ${JSON.stringify(res.skipped)}`,
  );
  assert.deepStrictEqual(sent.filter((s) => s.channel === 'session:context-action'), [], 'nothing pushed');
});

after(() => { setImmediate(() => process.exit(0)); });
