'use strict';
// session-forget-ipc.test.js — the `session:forget` handler (the failed-tab
// "forget" button) and the spawner-hint row it must drop on the way out (t158).
//
// Forget is a RECORD-DROPPER: after it runs, the seat's proxy route id is
// unknowable, and the hint table has no TTL — so a row not cleared here is
// permanent. The handler runs on a dead/failed entry with no live session, which
// is why the clear reads `spawnerHintSet` back off the record rather than off a
// session object like kill() does.
//
// Driven through the REAL SessionManager.clearHintForRecord, not a stub: a fake
// manager would pin that the handler calls something, which is the half of this
// that cannot break silently. The half that can is the record derivation.

const { test } = require('node:test');
const assert = require('node:assert');
const { registerIpcHandlers } = require('../ipc-handlers');
const { createSessionManager } = require('../session-manager');
const { resolveProxyBase } = require('../statusline');

function fixture(entries = []) {
  const hints = [];
  const order = [];
  const store = [...entries];
  const persistence = {
    list: () => store,
    get: (n) => store.find((e) => e.name === n) || null,
    remove: (n) => {
      order.push('remove');
      const i = store.findIndex((e) => e.name === n);
      if (i >= 0) store.splice(i, 1);
    },
  };
  const SessionManager = createSessionManager({
    getPersistence: () => persistence,
    getUiSettings: () => ({ get: () => ({ proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7811' }) }),
    resolveProxyBase,
    ProxyClient: {
      spawnerHint: (base, agent, opts) => {
        hints.push({ base, agent, opts });
        order.push('hint');
        return Promise.resolve({});
      },
    },
    log: { info() {}, warn() {}, error() {} },
  });
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    manager: new SessionManager(),
    persistence,
    log: { info() {}, error() {} },
  });
  return { forget: (name) => handlers.get('session:forget')(null, name), hints, order, persistence };
}

test('session:forget clears the seat\'s hint row BEFORE dropping the record that names the route', () => {
  const { forget, hints, order, persistence } = fixture([
    { name: 'seat', proxy: null, proxyAgent: 'clodex-seat-rt', spawnerHintSet: true },
  ]);
  assert.strictEqual(forget('seat'), true);
  assert.deepStrictEqual(hints, [{
    base: 'http://127.0.0.1:7811', agent: 'clodex-seat-rt', opts: { clear: true },
  }]);
  // Ordering is load-bearing, not incidental: the record IS the source of the
  // route id, so a clear after the remove would read null and post nothing.
  assert.deepStrictEqual(order, ['hint', 'remove']);
  assert.strictEqual(persistence.get('seat'), null, 'and the entry is still forgotten');
});

// t152's rule — "clear only what this seat set" — has to hold here too. Inferring
// the clear from the record alone would wipe an override an operator set
// out-of-band through /_hint, which is documented pre-launch arm config.
test('session:forget posts NOTHING for a seat that never set an override', () => {
  const { forget, hints, order } = fixture([
    { name: 'seat', proxy: null, proxyAgent: 'clodex-seat-rt' },
  ]);
  forget('seat');
  assert.deepStrictEqual(hints, []);
  assert.deepStrictEqual(order, ['remove'], 'the forget itself is unaffected');
});

test('session:forget survives a record that is absent, unrouted, or route-less', () => {
  for (const [label, entry] of [
    ['no record at all (double-forget)', null],
    ['never routed (proxy:false) — a null base addresses nothing', { name: 'seat', proxy: false, proxyAgent: 'clodex-seat-rt', spawnerHintSet: true }],
    ['no proxyAgent (a bash seat mints none)', { name: 'seat', proxy: null, spawnerHintSet: true }],
  ]) {
    const { forget, hints } = fixture(entry ? [entry] : []);
    assert.strictEqual(forget('seat'), true, `${label} → the handler still succeeds`);
    assert.deepStrictEqual(hints, [], `${label} → and posts nothing`);
  }
});

test('a hint failure never fails the forget (sync throw and rejected promise both)', async () => {
  for (const [label, spawnerHint] of [
    ['sync throw', () => { throw new Error('proxy exploded'); }],
    ['rejected promise', () => Promise.reject(new Error('timeout'))],
  ]) {
    const hints = [];
    const store = [{ name: 'seat', proxy: null, proxyAgent: 'clodex-seat-rt', spawnerHintSet: true }];
    const persistence = {
      list: () => store,
      get: (n) => store.find((e) => e.name === n) || null,
      remove: (n) => { const i = store.findIndex((e) => e.name === n); if (i >= 0) store.splice(i, 1); },
    };
    const SessionManager = createSessionManager({
      getPersistence: () => persistence,
      getUiSettings: () => ({ get: () => ({ proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7811' }) }),
      resolveProxyBase,
      ProxyClient: { spawnerHint },
      log: { info() {}, warn: (_s, m) => hints.push(m), error() {} },
    });
    const handlers = new Map();
    registerIpcHandlers({
      handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn),
      manager: new SessionManager(), persistence, log: { info() {}, error() {} },
    });
    assert.strictEqual(handlers.get('session:forget')(null, 'seat'), true,
      `${label} → the forget still succeeds`);
    assert.strictEqual(persistence.get('seat'), null, `${label} → the record is still dropped`);
  }
  // An uncaught rejection would not fail an assertion above — it would kill the
  // test PROCESS on the next tick. Give it that tick.
  await new Promise((r) => setImmediate(r));
});
