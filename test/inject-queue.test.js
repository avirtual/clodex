'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { InjectQueue, shouldDeferInject, isInjectInFlight, canFireCompact } = require('../inject-queue');

// --- isInjectInFlight: compact dup-drop truth table --------------------------
// The dup-drop guard fires when a self-compact is already in flight (LATCH set,
// guard armed, OR continuation stashed). Extracted pure so it has a test even
// though the SessionManager it lives on can't be required under plain node.
test('isInjectInFlight: in flight iff pending, guard, or continuation set', () => {
  assert.strictEqual(isInjectInFlight({ pending: null, guard: false, continuation: null }), false);
  assert.strictEqual(isInjectInFlight({ pending: { cmd: '/compact' }, guard: false, continuation: null }), true);
  assert.strictEqual(isInjectInFlight({ pending: null, guard: true, continuation: null }), true);
  assert.strictEqual(isInjectInFlight({ pending: null, guard: false, continuation: 'do X' }), true);
  assert.strictEqual(isInjectInFlight({ pending: null, guard: true, continuation: 'do X' }), true);
  // Empty-string continuation is not "stashed" — only a real body counts.
  assert.strictEqual(isInjectInFlight({ pending: null, guard: false, continuation: '' }), false);
  // Fields absent entirely (back-compat) → not in flight.
  assert.strictEqual(isInjectInFlight({}), false);
});

// --- canFireCompact: latch fire gate -----------------------------------------
// A latched self-compact may fire only when the latch is set AND both inject
// queues are empty (CLI parked at prompt, nothing about to wake it). Pure so the
// gate is testable off the SessionManager.
test('canFireCompact: fires iff pending latch and both queues empty', () => {
  const p = { cmd: '/compact', continuation: 'go' };
  assert.strictEqual(canFireCompact({ pending: p, holdQueueLen: 0, ptyQueueLen: 0 }), true);
  // No latch -> never fires.
  assert.strictEqual(canFireCompact({ pending: null, holdQueueLen: 0, ptyQueueLen: 0 }), false);
  // Either queue non-empty -> wait (a queued inject is about to wake the CLI).
  assert.strictEqual(canFireCompact({ pending: p, holdQueueLen: 1, ptyQueueLen: 0 }), false);
  assert.strictEqual(canFireCompact({ pending: p, holdQueueLen: 0, ptyQueueLen: 2 }), false);
  assert.strictEqual(canFireCompact({ pending: p, holdQueueLen: 3, ptyQueueLen: 4 }), false);
  // Missing lengths default to 0 (fresh session, queues never built).
  assert.strictEqual(canFireCompact({ pending: p }), true);
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
    ctrlUSettleMs: 0,               // skip the real Ctrl-U gap in tests
    lastHumanInputAt: () => 0,
    isDead: () => false,
  });
  // Fire both back-to-back (synchronously), as two deliveries racing would.
  const a = q.enqueue('AAA');
  const b = q.enqueue('BBB');
  await Promise.all([a, b]);
  // Exactly: unit A (Ctrl-U, AAA, Enter) fully before unit B — no B bytes
  // between. Ctrl-U is its own write now (split from the text; see CTRLU_SETTLE).
  assert.deepStrictEqual(writes, ['\x15', 'AAA', '\r', '\x15', 'BBB', '\r']);
});

test('InjectQueue: newlines become carriage returns; length tracks drain', async () => {
  const writes = [];
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0,
    ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
  });
  const p = q.enqueue('line1\nline2');
  assert.strictEqual(q.length, 1);   // enqueued, not yet drained
  await p;
  assert.strictEqual(q.length, 0);
  assert.deepStrictEqual(writes, ['\x15', 'line1\rline2', '\r']);
});

test('InjectQueue: a dead session mid-drain skips the Enter (no write into a closed fd)', async () => {
  const writes = [];
  let dead = false;
  let sleeps = 0;
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 5,
    quietMs: 0, maxWaitMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => dead,
    // Two sleeps now: the Ctrl-U gap then the text settle. Flip dead during the
    // SECOND (text settle) — i.e. after Ctrl-U and text, before the Enter.
    sleep: () => { if (++sleeps === 2) dead = true; return Promise.resolve(); },
  });
  await q.enqueue('X');
  // Ctrl-U + text went out; the Enter is suppressed once the PTY died.
  assert.deepStrictEqual(writes, ['\x15', 'X']);
});

test('InjectQueue: a session that dies during the Ctrl-U gap writes neither text nor Enter', async () => {
  const writes = [];
  let dead = false;
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 5,
    quietMs: 0, maxWaitMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => dead,
    // Flip dead during the FIRST sleep (the Ctrl-U gap): the split opened a new
    // death window between the clear-line key and the text. Only the \x15 is out.
    sleep: () => { dead = true; return Promise.resolve(); },
  });
  await q.enqueue('X');
  assert.deepStrictEqual(writes, ['\x15']);
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
    ctrlUSettleMs: 0,
    lastHumanInputAt: () => lastHuman,
    isDead: () => false,
    now: () => clock,
    // Deterministic sleep: advance the virtual clock instead of real waiting.
    sleep: (ms) => { clock += ms; return Promise.resolve(); },
  });
  const p = q.enqueue('hi');
  // The drain loop advances `clock` via sleep until now-lastHuman >= quietMs.
  await p;
  assert.deepStrictEqual(writes, ['\x15', 'hi', '\r']);
  // Clock advanced past the quiet window before the first write.
  assert.ok(clock - lastHuman >= 50, `expected quiet elapsed, clock=${clock}`);
});

// --- InjectQueue: park-at-fire-time divert seam ------------------------------
// The divert is re-checked right before the write (after the quiet-gate). A
// draft that OPENS during the wait is caught here even though the enqueue-time
// park decision couldn't see it. A claimed item writes NOTHING — no Ctrl-U, no
// text, no Enter — so it can't splice the draft.
test('InjectQueue: a divert that claims the item skips the write entirely', async () => {
  const writes = [];
  const diverted = [];
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
  });
  await q.enqueue('parked', { divert: (t) => { diverted.push(t); return true; } });
  assert.deepStrictEqual(diverted, ['parked']);  // divert saw the text
  assert.deepStrictEqual(writes, []);            // ...and nothing was written
});

test('InjectQueue: a divert that declines lets the item write as normal', async () => {
  const writes = [];
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
  });
  await q.enqueue('kept', { divert: () => false });
  assert.deepStrictEqual(writes, ['\x15', 'kept', '\r']);
});

test('InjectQueue: no divert (absent opts) writes as normal — unchanged path', async () => {
  const writes = [];
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
  });
  await q.enqueue('plain');
  assert.deepStrictEqual(writes, ['\x15', 'plain', '\r']);
});

test('InjectQueue: a throwing divert falls through to a normal write (never drops)', async () => {
  const writes = [];
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
  });
  await q.enqueue('safe', { divert: () => { throw new Error('boom'); } });
  assert.deepStrictEqual(writes, ['\x15', 'safe', '\r']);
});

test('InjectQueue: divert only claims its own item, not later ones', async () => {
  const writes = [];
  let open = true;                                // draft open for the first item only
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
  });
  const divert = (t) => open;                     // claims while open
  const a = q.enqueue('first', { divert });
  const b = q.enqueue('second', { divert: (t) => { open = false; return false; } });
  await Promise.all([a, b]);
  // First parked (no bytes); second wrote normally.
  assert.deepStrictEqual(writes, ['\x15', 'second', '\r']);
});
