'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createSessionManager } = require('../session-manager');
const { HoldKeeper } = require('../wire/hold');

function mkManager() {
  const logs = [];
  const SessionManager = createSessionManager({
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null, setHoldUntil: () => {} }),
    log: {
      info: (tag, msg) => logs.push(`${tag}: ${msg}`), warn: (tag, msg) => logs.push(`${tag}: ${msg}`),
      error: () => {}, debug: () => {},
    },
  });
  const m = new SessionManager();
  m._broadcast = () => {};
  const s = { name: 'seat', sessionId: 'sid-1', agentType: 'claude', _holdRearmed: true };
  m.sessions.set('seat', s);
  return { m, s, logs };
}

test('a 429 ping disarms the hold for that session and clears the re-arm latch', () => {
  const { m, s } = mkManager();
  const keeper = new HoldKeeper({ warmth: { query: () => ({ warm: true, found: true }) } });
  const events = [];
  keeper.on('hold', (ev) => { events.push(ev); m._onHoldLifecycle(ev); });
  m._holdKeeper = keeper;
  assert.strictEqual(keeper.arm('sid-1', 2).armed, true, 'ENTER: the hold is armed');
  keeper.emit('hold', { session: 'sid-1', event: 'ping', result: { ok: false, status_code: 429 }, pings: 1 });
  assert.deepStrictEqual(Object.keys(keeper.holds()), []);
  const disarmed = events.filter((e) => e.event === 'disarmed');
  assert.deepStrictEqual(disarmed.map((e) => e.session), ['sid-1']);
  assert.strictEqual(s._holdRearmed, false);
});

test('a 500 ping does not disarm', () => {
  const { m, s } = mkManager();
  const keeper = new HoldKeeper({ warmth: { query: () => ({ warm: true, found: true }) } });
  keeper.on('hold', (ev) => m._onHoldLifecycle(ev));
  m._holdKeeper = keeper;
  keeper.arm('sid-1', 2);
  keeper.emit('hold', { session: 'sid-1', event: 'ping', result: { ok: false, status_code: 500 }, pings: 1 });
  assert.deepStrictEqual(Object.keys(keeper.holds()), ['sid-1']);
  assert.strictEqual(s._holdRearmed, true);
});
