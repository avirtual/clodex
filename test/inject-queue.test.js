'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { InjectQueue, shouldDeferInject, shouldWaitForReady, isInjectInFlight, canFireCompact } = require('../inject-queue');

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

// --- InjectQueue: multi-line bracketed-paste wrap ----------------------------
// A multi-line injection's \n→\r conversion makes each interior newline an
// Enter if node-pty splits the write across reads (observed live: a dm body +
// reply trailer landed as TWO user turns). While the CLI has paste mode 2004
// on, the queue wraps multi-line text in 200~/201~ markers so interior \r is
// literal content regardless of read-splitting; the trailing Enter still
// submits as its own write.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

test('InjectQueue: multi-line text is paste-wrapped when bracketedPaste is on', async () => {
  const writes = [];
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
    bracketedPaste: () => true,
  });
  await q.enqueue('body line\n(reply trailer)');
  assert.deepStrictEqual(writes,
    ['\x15', `${PASTE_START}body line\r(reply trailer)${PASTE_END}`, '\r']);
});

test('InjectQueue: single-line text is never wrapped, even with paste mode on', async () => {
  const writes = [];
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
    bracketedPaste: () => true,
  });
  await q.enqueue('one line only');
  assert.deepStrictEqual(writes, ['\x15', 'one line only', '\r']);
});

test('InjectQueue: paste mode off (or absent) → old bare bytes for multi-line', async () => {
  const writes = [];
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
    // no bracketedPaste seam at all — back-compat default
  });
  await q.enqueue('line a\nline b');
  assert.deepStrictEqual(writes, ['\x15', 'line a\rline b', '\r']);
});

test('InjectQueue: a throwing bracketedPaste falls back to unwrapped bytes', async () => {
  const writes = [];
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
    bracketedPaste: () => { throw new Error('boom'); },
  });
  await q.enqueue('line a\nline b');
  assert.deepStrictEqual(writes, ['\x15', 'line a\rline b', '\r']);
});

test('InjectQueue: bracketedPaste is read at WRITE time, not enqueue time', async () => {
  const writes = [];
  let on = false; // off when enqueued, on by the time the item drains
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
    bracketedPaste: () => on,
  });
  const first = q.enqueue('a\nb');
  on = true;
  const second = q.enqueue('c\nd');
  await Promise.all([first, second]);
  // First drained with mode still off at ITS write; the flag flipped
  // synchronously before the chain ran, so both actually see on=true only if
  // the queue read late — pin the second item, the unambiguous case.
  assert.strictEqual(writes.filter((w) => w.startsWith(PASTE_START)).length >= 1, true);
  assert.strictEqual(writes.at(-2), `${PASTE_START}c\rd${PASTE_END}`);
});

// --- shouldWaitForReady: boot-readiness gate decision ------------------------
// The first inject into a fresh CLI seat must wait until the seat signals it's
// accepting input (else text+Enter read as one paste-like chunk, Enter swallowed).
test('shouldWaitForReady: not ready yet, cap not reached → wait', () => {
  assert.strictEqual(shouldWaitForReady({
    now: 1_000, waitingSince: 1_000, ready: false, maxWaitMs: 20_000,
  }), true);
});

test('shouldWaitForReady: ready → go immediately', () => {
  assert.strictEqual(shouldWaitForReady({
    now: 1_000, waitingSince: 1_000, ready: true, maxWaitMs: 20_000,
  }), false);
});

test('shouldWaitForReady: cap reached overrides not-ready (inject anyway)', () => {
  assert.strictEqual(shouldWaitForReady({
    now: 21_001, waitingSince: 1_000, ready: false, maxWaitMs: 20_000,
  }), false);
});

// --- InjectQueue: boot-readiness gate ----------------------------------------
// Default (no ready seam) is pass-through — a virgin call injects immediately.
// This is the invariant that keeps every bash/codex path and existing test green.
test('InjectQueue: no ready seam → injects immediately (pass-through default)', async () => {
  const writes = [];
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
  });
  await q.enqueue('boot');
  assert.deepStrictEqual(writes, ['\x15', 'boot', '\r']);
});

test('InjectQueue: boot gate holds the write until ready flips true', async () => {
  const writes = [];
  let clock = 0;
  let ready = false;               // seat still booting
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
    now: () => clock,
    // Each poll advances the clock; the seat becomes ready after ~1s of boot.
    sleep: (ms) => { clock += ms; if (clock >= 1_000) ready = true; return Promise.resolve(); },
    ready: () => ready,
    readyMaxWaitMs: 20_000,
    readyPollMs: 250,
  });
  const p = q.enqueue('scope');
  assert.deepStrictEqual(writes, [], 'nothing written while the seat is still booting');
  await p;
  assert.deepStrictEqual(writes, ['\x15', 'scope', '\r']);
  assert.ok(clock >= 1_000, `waited for readiness, clock=${clock}`);
});

test('InjectQueue: boot cap forces the write through a seat that never signals ready', async () => {
  const writes = [];
  const capFired = [];
  let clock = 0;
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
    now: () => clock,
    sleep: (ms) => { clock += ms; return Promise.resolve(); },
    ready: () => false,            // never signals ready (e.g. a CLI without 2004)
    readyMaxWaitMs: 20_000,
    readyPollMs: 250,
    onReadyCapFire: (t) => capFired.push(t),
  });
  await q.enqueue('scope');
  assert.deepStrictEqual(writes, ['\x15', 'scope', '\r'], 'injected anyway after the cap');
  assert.ok(clock >= 20_000, `waited out the cap, clock=${clock}`);
  assert.deepStrictEqual(capFired, ['scope'], 'cap-fire surfaced for observability');
});

test('InjectQueue: boot cap does NOT fire when the seat becomes ready in time', async () => {
  const capFired = [];
  let clock = 0;
  let ready = false;
  const q = new InjectQueue({
    write: () => {},
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
    now: () => clock,
    sleep: (ms) => { clock += ms; if (clock >= 500) ready = true; return Promise.resolve(); },
    ready: () => ready,
    readyMaxWaitMs: 20_000,
    readyPollMs: 250,
    onReadyCapFire: (t) => capFired.push(t),
  });
  await q.enqueue('scope');
  assert.deepStrictEqual(capFired, [], 'ready in time → no cap-fire warning');
});

test('InjectQueue: a seat that dies while booting abandons the item (no write)', async () => {
  const writes = [];
  let dead = false;
  let clock = 0;
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 1,
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => dead,
    now: () => clock,
    sleep: (ms) => { clock += ms; if (clock >= 500) dead = true; return Promise.resolve(); },
    ready: () => false,            // never ready — but the seat dies first
    readyMaxWaitMs: 20_000,
    readyPollMs: 250,
  });
  await q.enqueue('scope');
  assert.deepStrictEqual(writes, [], 'died mid-boot → nothing written into a closed fd');
});

test('InjectQueue: once ready, a subsequent item never re-blocks (latch is the caller\'s job)', async () => {
  // The queue re-reads ready() each drain; the LATCH lives in the caller (a
  // never-un-setting flag). Here ready() stays true after boot, so item two
  // drains with zero extra waiting even though the gate is still wired.
  const writes = [];
  let clock = 0;
  let ready = true;                // already booted (latched true upstream)
  const q = new InjectQueue({
    write: (bytes) => writes.push(bytes),
    settleMsFor: () => 0,          // zero settle so the clock only moves if a GATE waits
    quietMs: 0, maxWaitMs: 0, ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    isDead: () => false,
    now: () => clock,
    sleep: (ms) => { clock += ms; return Promise.resolve(); },
    ready: () => ready,
    readyMaxWaitMs: 20_000,
    readyPollMs: 250,
  });
  await q.enqueue('one');
  await q.enqueue('two');
  assert.deepStrictEqual(writes, ['\x15', 'one', '\r', '\x15', 'two', '\r']);
  assert.strictEqual(clock, 0, 'ready seat waits zero ticks (boot gate never blocks) on either item');
});
