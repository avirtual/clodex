'use strict';

// voice-popover-latch.test.js — the consecutive-failure latch in
// `renderer/popovers/voice-popover.js`'s core subscriber (t520).
//
// The module header says "DOM-bound, so no unit tests per the R1 rule". That is
// about the PAINTERS, which write innerHTML and read getBoundingClientRect. The
// subscriber is not: it is a gate over a key string, and the three states it has
// to distinguish (no throw / transient throw / permanent throw) are reachable
// with the injected `renderProxyBar` as the only moving part. So the stub below
// answers exactly the handful of DOM calls `initVoicePopover` makes on the way
// to installing that subscriber, and nothing else.
//
// What the states are, one line each, because each has its own reason:
//   no throw        — the gate must still suppress no-change emits. That is the
//                     t517 r1 regression, and a COUNT is how t517 proved it.
//   transient throw — must still self-heal on the next identical emit. Latching
//                     on the first failure reintroduces t519 nit 3.
//   permanent throw — must stop repainting after the SECOND failure, or every
//                     emit rebuilds #proxy-actions.

const { test } = require('node:test');
const assert = require('node:assert');

const { initVoicePopover } = require('../renderer/popovers/voice-popover');

// A snapshot as the core really emits one. Only the two fields the subscriber's
// key is built from matter; `pending` is spelled out because it is the field a
// real pick moves, and a fixture that omitted it would make every "real state
// change" case below indistinguishable from a no-change one.
function snap({ pending = null, mode = 'tap' } = {}) {
  return { pending, mode };
}

// The two elements `initVoicePopover` resolves by id, plus the close button. The
// popover starts HIDDEN, so `renderRows()` is gated off and `renderProxyBar` is
// the only painter the subscriber reaches — which is what makes the repaint
// count below a count of one thing.
function fakeEl(classes = []) {
  const set = new Set(classes);
  return {
    classList: { contains: (c) => set.has(c), add: (c) => set.add(c), remove: (c) => set.delete(c) },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    addEventListener() {},
  };
}

// Installs the globals, builds the popover, and returns the knobs a test drives.
// `paint` is the injected renderProxyBar: tests replace it to throw.
function harness({ paint } = {}) {
  const prevDoc = global.document;
  const prevWin = global.window;

  const pop = fakeEl(['hidden']);
  const body = fakeEl();
  const ids = { 'voice-popover': pop, 'voice-popover-body': body, 'voice-popover-close': fakeEl() };
  global.document = {
    getElementById: (id) => {
      // THROWS rather than returning null for an unknown id: `initVoicePopover`
      // returns a set of no-op stubs when `pop`/`body` are missing, so a fixture
      // that quietly answered null would install NO subscriber at all and leave
      // every repaint-count assertion below reading 0 out of an inert object.
      if (!(id in ids)) throw new Error(`fakeDocument: unhandled id ${id}`);
      return ids[id];
    },
    // `renderRows()` builds its note through lib/format's `esc`, which escapes by
    // round-tripping through a detached div. Without this the row painter throws
    // on the ESCAPER rather than on what a test told it to throw on — a green
    // "it threw" assertion over the wrong throw.
    createElement: () => ({ textContent: '', get innerHTML() { return String(this.textContent); } }),
    addEventListener() {},
  };
  global.window = { innerWidth: 1200, innerHeight: 800 };

  let paints = 0;
  const renderProxyBar = () => { paints++; if (paint) paint(paints); };

  let subscriber = null;
  const core = {
    subscribe(fn) { subscriber = fn; return () => {}; },
    snapshot: () => snap(),
    isMode: (m) => ['off', 'tap', 'hold'].includes(m),
    choose() {},
  };

  let api;
  try {
    api = initVoicePopover({ core, renderProxyBar });

    // ENTER: the subscriber must actually have been installed. Every assertion
    // below counts what `emit()` causes, and with no subscriber every count is 0 —
    // which is TRUE of "the latch suppressed it" too, so the whole file would go
    // green over a harness that wired nothing.
    assert.strictEqual(typeof subscriber, 'function', 'the harness must have reached core.subscribe');
  } catch (e) {
    // Restore on the THROW path ONLY: `harness()` does not return here, so no
    // caller ever binds `h` and no `finally` runs `restore()` — without this the
    // fake globals leak into whatever runs next in the file. The success path
    // must NOT restore: every test drives the popover through these globals.
    global.document = prevDoc; global.window = prevWin;
    throw e;
  }

  return {
    api, pop, body,
    paintCount: () => paints,
    // Delivers one emit the way the core does, and reports whether it threw —
    // an escaping throw is what reaches voice-control.js's per-listener guard
    // and produces exactly one console.error, so counting these counts the log.
    emit(s) {
      try { subscriber(s); return null; } catch (e) { return e; }
    },
    restore() { global.document = prevDoc; global.window = prevWin; },
  };
}

test('no throw: the gate still suppresses no-change emits, and the repaint count is unchanged', () => {
  const h = harness();
  try {
    const s = snap();
    for (let i = 0; i < 60; i++) h.emit(s);
    assert.strictEqual(h.paintCount(), 1, '60 identical emits must prime the bar exactly once');

    for (let i = 0; i < 30; i++) h.emit(snap());
    assert.strictEqual(h.paintCount(), 1, 'a fresh object with identical FIELDS is still a no-change emit');

    h.emit(snap({ pending: 'hold' }));
    assert.strictEqual(h.paintCount(), 2, 'a real transition must repaint');
    h.emit(snap({ pending: 'hold', mode: 'hold' }));
    assert.strictEqual(h.paintCount(), 3, 'and so must the next one');
    for (let i = 0; i < 30; i++) h.emit(snap({ pending: 'hold', mode: 'hold' }));
    assert.strictEqual(h.paintCount(), 3, 'settling back to no-change re-suppresses');
  } finally { h.restore(); }
});

test('transient throw: the next identical emit retries, and the paint that works latches', () => {
  // Throws on the FIRST paint only. This is t519's self-heal and the reason the
  // latch may not fire on the first failure.
  const h = harness({ paint: (n) => { if (n === 1) throw new Error('painter blipped'); } });
  try {
    const s = snap();
    assert.ok(h.emit(s) instanceof Error, 'the first failure must still reach the core guard');
    assert.strictEqual(h.paintCount(), 1);

    assert.strictEqual(h.emit(s), null, 'the identical emit must RETRY rather than be gated away');
    assert.strictEqual(h.paintCount(), 2, 'and that retry is the self-heal');

    for (let i = 0; i < 30; i++) h.emit(s);
    assert.strictEqual(h.paintCount(), 2, 'having healed, identical emits are suppressed again');
  } finally { h.restore(); }
});

test('permanent throw: repainting stops after the second failure', () => {
  const h = harness({ paint: () => { throw new Error('painter is permanently broken'); } });
  try {
    const s = snap();
    assert.ok(h.emit(s) instanceof Error, 'failure 1 escapes');
    assert.ok(h.emit(s) instanceof Error, 'failure 2 escapes');
    assert.strictEqual(h.paintCount(), 2, 'two attempts on the same key, never a third');

    for (let i = 0; i < 60; i++) h.emit(s);
    assert.strictEqual(h.paintCount(), 2,
      '60 further identical emits must not rebuild the bar');
  } finally { h.restore(); }
});

test('permanent throw: the console diagnostic is bounded, not silenced', () => {
  const h = harness({ paint: () => { throw new Error('painter is permanently broken'); } });
  try {
    const s = snap();
    // Each escaping throw is one console.error at voice-control.js's per-listener
    // guard. Bounded is the requirement; silent is not — that guard's own comment
    // says swallowing it trades a visible bug for a surface that stops updating.
    let escaped = 0;
    for (let i = 0; i < 60; i++) if (h.emit(s)) escaped++;
    assert.strictEqual(escaped, 2,
      'a permanent throw must not log once per emit for the life of the window');

    // A REAL state change is still allowed through, and still reports. This is
    // the recovery path: the latch suppresses only IDENTICAL emits, so it can
    // never wedge the surface shut against a change it has not painted yet.
    assert.ok(h.emit(snap({ pending: 'hold' })) instanceof Error,
      'a changed key must still attempt a paint on a latched, still-broken painter');
    assert.strictEqual(h.paintCount(), 3);

    // ENTER: and it re-latches on that new key rather than repainting per emit.
    // ONE attempt, not two: `failedOnce` is still set from the previous key's
    // streak, so a painter already known to be broken latches immediately on each
    // new key. The free retry is spent per FAILURE STREAK, not per key — which is
    // what keeps a permanently broken painter at O(number of real state changes)
    // instead of twice that, while a painter that heals resets the streak on its
    // first successful paint and gets its retry back.
    let escapedAfter = 0;
    for (let i = 0; i < 60; i++) if (h.emit(snap({ pending: 'hold' }))) escapedAfter++;
    assert.strictEqual(escapedAfter, 0, 'identical emits after the new key are gated away entirely');
    assert.strictEqual(h.paintCount(), 3, 'the changed key cost exactly one attempt, and no more');
  } finally { h.restore(); }
});

test('a throw from renderRows latches the same way, so an OPEN popover cannot flood either', () => {
  // The open popover reaches `renderRows()` before `renderProxyBar()`, and that
  // painter writes innerHTML into the live picker. It is inside the same try, so
  // it must latch identically — asserted rather than assumed, because it is a
  // DIFFERENT painter on a different line and the gate reads the same either way.
  const h = harness();
  try {
    h.pop.classList.remove('hidden');
    let rows = 0;
    Object.defineProperty(h.body, 'innerHTML', {
      set() { rows++; throw new Error('renderRows exploded'); },
      get() { return ''; },
    });
    const s = snap();
    assert.ok(h.emit(s) instanceof Error, 'failure 1 escapes');
    assert.ok(h.emit(s) instanceof Error, 'failure 2 escapes');
    for (let i = 0; i < 60; i++) h.emit(s);
    assert.strictEqual(rows, 2, 'the row painter is attempted twice and then gated off');
    assert.strictEqual(h.paintCount(), 0, 'and the bar painter is never reached past the earlier throw');
  } finally { h.restore(); }
});
