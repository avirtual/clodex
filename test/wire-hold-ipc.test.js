// Run: node --test
// Covers the `wire:hold` IPC handler — the ONLY place the operator's keep-warm
// choice becomes persisted state, and the only place the two mutually exclusive
// intents (`holdUntil` for a timed hold, `keepWarmAlways` for a perpetual one)
// are written. Every arm is a PAIR of writes: set the one, clear the other. A
// seat carrying both is the state the design forbids, and it is reachable only
// through a half-written pair here.
//
// The keeper is REAL, not a stub. The handler branches on the shape of arm()'s
// return (`j.armed && (j.always || j.until)`), so a stub returning a hand-made
// object would pin my idea of that shape rather than the shape — and the whole
// perpetual path exists precisely because `until` is null there.
const { test } = require('node:test');
const assert = require('node:assert');
const { registerIpcHandlers } = require('../ipc-handlers');
const { HoldKeeper } = require('../wire/hold');
const { WarmthStore } = require('../wire/warmth');

const SID = '4a59af49-cc52-44b7-8b02-7f4196a4b486';
const NAME = 'clodex';

function makeObj() {
  return {
    model: 'claude-opus-4-8',
    stream: true,
    max_tokens: 32000,
    system: [{ type: 'text', text: 'You are a test.' }],
    tools: [{ name: 'Bash' }],
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
  };
}

// `warm` false leaves the prefix absent, which is the cold-gate case: arm()
// declines and the handler must then persist NOTHING.
function rig({ warm = true, seen = true } = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const warmth = new WarmthStore({ now });
  const keeper = new HoldKeeper({ warmth, now, request: async () => { throw new Error('no pings in this test'); } });
  const obj = makeObj();
  keeper.noteRequest(SID, obj, {}, 'http://up/v1/messages');
  if (warm) warmth.record(obj, { cache_creation_input_tokens: 100, cache_read_input_tokens: 0 }, SID);

  const calls = [];
  const handlers = new Map();
  registerIpcHandlers({
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    manager: {
      _holdKeeper: keeper,
      _wireTelemetry: { payload: () => (seen ? { sessionId: SID } : null) },
    },
    persistence: {
      setHoldUntil: (name, v) => calls.push(['setHoldUntil', name, v]),
      setKeepWarmAlways: (name, v) => calls.push(['setKeepWarmAlways', name, v]),
    },
    log: { info: () => {}, warn: () => {} },
  });
  const fn = handlers.get('wire:hold');
  assert.ok(fn, 'ENTER: the wire:hold handler registered — every call below is vacuous otherwise');
  // The renderer's argument order, spelled once: (event, name, hours, force, always).
  return { calls, keeper, clock,
    hold: (hours, always) => fn(null, NAME, hours, false, !!always) };
}

test('wire:hold arming perpetually sets the seat flag and clears any deadline', () => {
  const { hold, calls, keeper } = rig();

  const r = hold(0, true);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.armed, true);
  // hours=0 with the flag is a perpetual arm, NOT the 'off' spelling — the
  // handler's `(always || hours > 0)` is what keeps those two apart.
  assert.strictEqual(keeper.holds()[SID].always, true);
  assert.strictEqual(keeper.holds()[SID].until, null);
  assert.deepStrictEqual(calls, [
    ['setKeepWarmAlways', NAME, true],
    ['setHoldUntil', NAME, null],
  ]);
});

test('wire:hold arming a duration sets the deadline and clears the seat flag', () => {
  const { hold, calls, clock } = rig();

  const r = hold(4, false);
  assert.strictEqual(r.armed, true);
  assert.deepStrictEqual(calls, [
    ['setHoldUntil', NAME, (clock.t + 4 * 3600) * 1000],
    ['setKeepWarmAlways', NAME, false],
  ]);
});

test('wire:hold explicit off clears both intents', () => {
  const { hold, calls } = rig();

  hold(0, false);
  assert.deepStrictEqual(calls, [
    ['setHoldUntil', NAME, null],
    ['setKeepWarmAlways', NAME, false],
  ]);
});

// The regression the mutual-exclusion clearing exists for: an operator who
// picks Always and then changes their mind to 4h. If the timed arm did not
// clear the flag, the seat would honour 4h until the next app restart and then
// silently re-arm itself perpetually, forever.
test('wire:hold always -> 4h withdraws the perpetual flag, not just the keeper hold', () => {
  const { hold, calls, keeper, clock } = rig();

  hold(0, true);
  assert.strictEqual(keeper.holds()[SID].always, true);
  calls.length = 0;

  const r = hold(4, false);
  assert.strictEqual(r.armed, true);
  assert.strictEqual(keeper.holds()[SID].always, false, 'the in-memory hold flipped');
  assert.deepStrictEqual(calls, [
    ['setHoldUntil', NAME, (clock.t + 4 * 3600) * 1000],
    ['setKeepWarmAlways', NAME, false],
  ], 'and so did the persisted intent');

  // ...and back, so neither direction is the only one wired.
  calls.length = 0;
  hold(0, true);
  assert.deepStrictEqual(calls, [
    ['setKeepWarmAlways', NAME, true],
    ['setHoldUntil', NAME, null],
  ]);
});

// Both no-write paths. Persisting an intent the keeper refused would leave the
// UI claiming a hold that does not exist, and — for the perpetual flag — would
// survive the restart and re-arm off a state the operator never achieved.
test('wire:hold persists nothing when the arm is declined or the wire has no session', () => {
  const cold = rig({ warm: false });
  const r = cold.hold(0, true);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.armed, false);
  assert.strictEqual(r.skipped, 'absent', 'ENTER: the cold gate is what declined it');
  assert.deepStrictEqual(cold.calls, []);
  // Same for a declined DURATION arm: the `else if` that clears on 'off' must
  // not catch a failed 4h arm.
  assert.strictEqual(cold.hold(4, false).armed, false);
  assert.deepStrictEqual(cold.calls, []);

  const unseen = rig({ seen: false });
  const r2 = unseen.hold(0, true);
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /has not seen a turn/);
  assert.deepStrictEqual(unseen.calls, []);
});
