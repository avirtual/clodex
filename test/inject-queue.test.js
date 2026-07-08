'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { InjectQueue, shouldDeferInject, isInjectInFlight } = require('../inject-queue');

// --- isInjectInFlight: compact dup-drop truth table --------------------------
// The dup-drop guard fires when a self-compact is already in flight (guard armed
// OR continuation stashed). Extracted pure so it has a test even though the
// SessionManager it lives on can't be required under plain node.
test('isInjectInFlight: in flight iff guard or continuation set', () => {
  assert.strictEqual(isInjectInFlight({ guard: false, continuation: null }), false);
  assert.strictEqual(isInjectInFlight({ guard: true, continuation: null }), true);
  assert.strictEqual(isInjectInFlight({ guard: false, continuation: 'do X' }), true);
  assert.strictEqual(isInjectInFlight({ guard: true, continuation: 'do X' }), true);
  // Empty-string continuation is not "stashed" — only a real body counts.
  assert.strictEqual(isInjectInFlight({ guard: false, continuation: '' }), false);
});

// --- shouldDeferInject: typing quiet-gate decision ---------------------------
test('shouldDeferInject: recent human input defers', () => {
  // keystroke 500ms ago, 2s quiet window, plenty of max-wait left → wait
  assert.strictEqual(shouldDeferInject({
    now: 10_000, lastHumanInputAt: 9_500, waitingSince: 9_800,
    quietMs: 2_000, maxWaitMs: 30_000,
  }), true);
});

test('shouldDeferInject: quiet window elapsed → go', () => {
  // last keystroke 3s ago, 2s window → quiet, inject now
  assert.strictEqual(shouldDeferInject({
    now: 10_000, lastHumanInputAt: 7_000, waitingSince: 9_000,
    quietMs: 2_000, maxWaitMs: 30_000,
  }), false);
});

test('shouldDeferInject: max-wait cap overrides an actively-typing draft', () => {
  // human typed 100ms ago (would normally defer) but this item has been waiting
  // 30s → cap reached, inject anyway (a walked-away draft can't starve forever)
  assert.strictEqual(shouldDeferInject({
    now: 40_000, lastHumanInputAt: 39_900, waitingSince: 10_000,
    quietMs: 2_000, maxWaitMs: 30_000,
  }), false);
});

test('shouldDeferInject: no human input ever → never defers', () => {
  assert.strictEqual(shouldDeferInject({
    now: 10_000, lastHumanInputAt: 0, waitingSince: 10_000,
    quietMs: 2_000, maxWaitMs: 30_000,
  }), false);
});

// --- InjectQueue: serialization (the anti-splice invariant) ------------------
// Two near-simultaneous injections must NOT interleave: each Ctrl-U→text→Enter
// is one atomic unit, and units drain in arrival order. This is the regression
// for the operator-message-spliced-mid-word bug.
test('InjectQueue: concurrent injections never interleave, preserve order', async () => {
  const writes = [];
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 5,          // tiny real settle — serialization holds regardless
    quietMs: 0,                     // no quiet-gate for this test
    maxWaitMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
  });
  // Fire both back-to-back (synchronously), as two deliveries racing would.
  const a = q.enqueue('AAA');
  const b = q.enqueue('BBB');
  await Promise.all([a, b]);
  // Exactly: unit A (Ctrl-U+AAA, Enter) fully before unit B — no B bytes between.
  assert.deepStrictEqual(writes, ['\x15AAA', '\r', '\x15BBB', '\r']);
});

test('InjectQueue: newlines become carriage returns; length tracks drain', async () => {
  const writes = [];
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
  });
  const p = q.enqueue('line1\nline2');
  assert.strictEqual(q.length, 1);   // enqueued, not yet drained
  await p;
  assert.strictEqual(q.length, 0);
  assert.deepStrictEqual(writes, ['\x15line1\rline2', '\r']);
});

test('InjectQueue: a dead session mid-drain skips the Enter (no write into a closed fd)', async () => {
  const writes = [];
  let dead = false;
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 5,
    quietMs: 0, maxWaitMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => dead,
    // The only sleep here is the settle (quietMs 0 → no quiet wait); flip the
    // session dead during it, i.e. after Ctrl-U+text but before the Enter.
    sleep: () => { dead = true; return Promise.resolve(); },
  });
  await q.enqueue('X');
  // Ctrl-U+text went out; the Enter is suppressed once the PTY died.
  assert.deepStrictEqual(writes, ['\x15X']);
});

test('InjectQueue: quiet-gate defers the write until typing stops', async () => {
  const writes = [];
  let clock = 1_000;
  let lastHuman = 1_000;            // "just typed"
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 50,
    maxWaitMs: 10_000,
    lastHumanInputAt: () => lastHuman,
    isDead: () => false,
    now: () => clock,
    // Deterministic sleep: advance the virtual clock instead of real waiting.
    sleep: (ms) => { clock += ms; return Promise.resolve(); },
  });
  const p = q.enqueue('hi');
  // The drain loop advances `clock` via sleep until now-lastHuman >= quietMs.
  await p;
  assert.deepStrictEqual(writes, ['\x15hi', '\r']);
  // Clock advanced past the quiet window before the first write.
  assert.ok(clock - lastHuman >= 50, `expected quiet elapsed, clock=${clock}`);
});
