'use strict';

// voice-core.test.js — the voice-mode STATE MACHINE (t510), the half of
// renderer/voice-control.js that `test/voice-settings.test.js` does not reach:
// that file pins the read and the write of settings.json, this one pins what the
// core does with them once `pending` and a debounce get involved.
//
// WHY THIS EXISTS AT ALL: t509 took five review rounds and every round after the
// first found the same defect class in a different REACHABLE STATE, with the
// suite green each time. The states, not the lines, are what went unexercised.
//
// NO jsdom, and none is needed: t517 extracted `createVoiceCore`, which never
// touches `document`. Its whole environment is two stubs below. What that
// leaves untested is deliberate: everything `document`-bound lives in
// `createVoiceControl`.

const { test } = require('node:test');
const assert = require('node:assert');

const { createVoiceCore } = require('../renderer/voice-control');

const POLL_MS = 15000;            // must match voice-control.js
const CHOICE_DEBOUNCE_MS = 250;   // must match voice-control.js

// A settings read as the main side really returns it. `ok` is load-bearing:
// `refresh` gates on `r && r.ok`, so a fixture missing it leaves `state` null
// and every downstream assertion reads around the gap.
function fileSays(effective, extra = {}) {
  return { ok: true, source: 'voice', mode: effective, enabled: true, legacy: null, effective, ...extra };
}

// Installs the two globals the core closes over, builds it, and records every
// emitted snapshot. Returns the knobs a test drives plus `emits`.
function harness({ voice = null, write } = {}) {
  const calls = { getVoiceMode: 0, setVoiceMode: [], focusListeners: 0 };
  const toasts = [];
  const state = { voice, write: write || (async () => ({ ok: true })) };

  const prevWindow = global.window;

  const focusHandlers = [];
  global.window = {
    // The callback is CAPTURED, not counted and dropped. Counting alone is what
    // let the `holds > 0` guard inside it go unexercised while a test named for
    // that guard stayed green.
    addEventListener(ev, cb) { if (ev === 'focus') { calls.focusListeners++; focusHandlers.push(cb); } },
    api: {
      async getVoiceMode() { calls.getVoiceMode++; return state.voice; },
      async setVoiceMode(mode) { calls.setVoiceMode.push(mode); return state.write(mode); },
    },
  };

  const core = createVoiceCore({ showToast: (m) => toasts.push(m) });

  const emits = [];
  core.subscribe((snap) => emits.push(snap));

  return {
    core, emits, calls, toasts, state,
    // Fires the window `focus` event the way the browser does.
    focus() { for (const fn of focusHandlers) fn(); },
    last: () => emits[emits.length - 1],
    restore() { global.window = prevWindow; },
  };
}

// Lets every already-queued promise job run. setImmediate is NOT among the
// mocked timer apis, so this still drains under mock.timers.
const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// The reachable states. Each asserts the WHOLE snapshot: the four fields are
// the entire contract between the core and both surfaces, and a partial match
// is how an unwired dep arrives as `undefined` unnoticed.
// ---------------------------------------------------------------------------

test('fresh: constructed but never refreshed — no file read yet, so no mode is claimed', () => {
  const h = harness({});
  try {
    assert.deepStrictEqual(h.core.snapshot(), {
      state: null, pending: null, mode: null, force: false,
    });
  } finally { h.restore(); }
});

test('steady: a read of the file with nothing pending publishes the file\'s mode', async () => {
  const h = harness({ voice: fileSays('tap') });
  try {
    await h.core.refresh();
    assert.deepStrictEqual(h.last(), {
      state: fileSays('tap'), pending: null, mode: 'tap', force: false,
    });
  } finally { h.restore(); }
});

test('steady with an unreadable file: state survives the failed read and an emit still happens', async () => {
  const h = harness({ voice: fileSays('tap') });
  try {
    await h.core.refresh();
    h.state.voice = { ok: false, error: 'nope' };
    const before = h.emits.length;
    await h.core.refresh();
    assert.strictEqual(h.emits.length, before + 1, 'a failed read must still repaint the surfaces');
    assert.deepStrictEqual(h.last(), {
      state: fileSays('tap'), pending: null, mode: 'tap', force: false,
    });
  } finally { h.restore(); }
});

test('pending: the pick is published as pending and overrides the file\'s mode', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ voice: fileSays('tap') });
  try {
    await h.core.refresh();
    assert.strictEqual(h.core.choose('hold'), true);
    assert.deepStrictEqual(h.last(), {
      state: fileSays('tap'), pending: 'hold', mode: 'hold', force: false,
    });
    // Nothing is written yet — the debounce owns that.
    assert.deepStrictEqual(h.calls.setVoiceMode, []);
  } finally { h.restore(); }
});

// THE POINT OF THE SWAP, and the case most likely to regress silently. The
// setting is box-wide and the file is writable with nothing open, so a picker
// keyed to a live seat refused a write that was always possible.
test('a mode can be set with NO session to inject into', async () => {
  const h = harness({ voice: fileSays('tap') });
  try {
    await h.core.refresh();
    assert.strictEqual(h.core.choose('hold'), true, 'the pick must be accepted');
    assert.strictEqual(h.last().pending, 'hold', 'and shown as pending');
    // Real timers: the debounce is the only thing between the pick and the
    // write, and this asserts the write actually GOES OUT rather than that
    // `choose` returned true.
    await new Promise((r) => setTimeout(r, CHOICE_DEBOUNCE_MS + 20));
    assert.deepStrictEqual(h.calls.setVoiceMode, ['hold'], 'the write went out');
  } finally { h.restore(); }
});

test('operator picks "Not set": nothing is written, but the repaint is FORCED', async () => {
  const h = harness({ voice: fileSays('tap') });
  try {
    await h.core.refresh();
    assert.strictEqual(h.core.choose(''), false, '"Not set" is a reading, not a mode');
    // `force` is the field that matters here: it is what lets the surface repaint
    // out of a selection the core refused, even while the picker holds focus.
    // Without it the row keeps showing "Not set" beneath a line saying the value
    // came from the file — the r2 defect, in the shape reachable from the picker.
    assert.deepStrictEqual(h.last(), {
      state: fileSays('tap'), pending: null, mode: 'tap', force: true,
    });
  } finally { h.restore(); }
});

test('the debounce coalesces to the FINAL pick, and the successful write re-reads at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  // The file starts at `tap` and the pick is `off`, so the read-back below
  // observes a file that genuinely CHANGED. Starting them equal would make the
  // retire unfailable while reading like it had been earned.
  const h = harness({ voice: fileSays('tap') });
  try {
    await h.core.refresh();
    h.core.choose('tap');
    h.core.choose('hold');
    h.core.choose('off');
    assert.deepStrictEqual(h.calls.setVoiceMode, [], 'nothing may be written before the debounce elapses');
    // The intermediate picks are the reason the debounce survives the swap: each
    // one would otherwise be an atomic rewrite of the operator's global settings
    // file, and a keyboard-driven <select> fires `change` per option passed over.
    h.state.voice = fileSays('off');    // the write has landed
    t.mock.timers.tick(CHOICE_DEBOUNCE_MS);
    await flush();
    assert.deepStrictEqual(h.calls.setVoiceMode, ['off'], 'exactly one write, of the FINAL value');
    assert.strictEqual(h.last().pending, null, 'the write re-reads immediately and that read retires the affordance');
  } finally { h.restore(); }
});

test('write failed: the pick is dropped, the operator is told, and the repaint is forced', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ voice: fileSays('tap'),
    write: async () => ({ ok: false, error: 'settings.json has a syntax error' }),
  });
  try {
    await h.core.refresh();
    h.core.choose('hold');
    t.mock.timers.tick(CHOICE_DEBOUNCE_MS);
    await flush();
    assert.deepStrictEqual(h.last(), {
      state: fileSays('tap'), pending: null, mode: 'tap', force: true,
    }, 'the row must fall back to the file, forced past a focused picker');
    assert.deepStrictEqual(h.toasts, ['Setting voice to hold failed: settings.json has a syntax error']);

    // And it re-reads NOTHING. The success path re-reads to retire the
    // affordance; the failure path has nothing to retire — it already dropped
    // `pending` and toasted — so a read here would re-enter the state machine
    // over a pick the operator has been told did not happen. The only thing
    // preventing it is `sendMode`'s early `return` on the failure arm, one line
    // an edit could fall through without changing anything else a test names.
    const beforeReadback = h.calls.getVoiceMode;
    await flush();
    assert.strictEqual(h.calls.getVoiceMode, beforeReadback,
      'a failed write must not run the success path read-back');
    assert.strictEqual(h.last().pending, null, 'and the affordance stays dropped');
  } finally { h.restore(); }
});

test('the write threw: treated as a failure, not as a silently-successful write', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ voice: fileSays('tap'),
    write: async () => { throw new Error('socket closed'); },
  });
  try {
    await h.core.refresh();
    h.core.choose('hold');
    t.mock.timers.tick(CHOICE_DEBOUNCE_MS);
    await flush();
    assert.strictEqual(h.last().pending, null);
    assert.deepStrictEqual(h.toasts, ['Setting voice to hold failed: socket closed']);
  } finally { h.restore(); }
});

test('a SLOW failed write may not wipe the pick a later choice already owns', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let release;
  const h = harness({ voice: fileSays('off'),
    write: () => new Promise((r) => { release = r; }),
  });
  try {
    await h.core.refresh();
    h.core.choose('hold');
    t.mock.timers.tick(CHOICE_DEBOUNCE_MS);
    await flush();                      // the first write is now in flight
    h.core.choose('tap');               // operator moved on while it hung
    release({ ok: false, error: 'too late' });
    await flush();
    assert.strictEqual(h.last().pending, 'tap', 'the live pick must survive the stale failure');
    assert.deepStrictEqual(h.toasts, [], 'and no toast for a mode already moved on from');
  } finally { h.restore(); }
});

test('the pending affordance stands until a read AGREES — a differing read is not a rejection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ voice: fileSays('tap') });
  try {
    await h.core.refresh();
    h.core.choose('hold');
    await h.core.refresh();             // a read that raced the write
    assert.deepStrictEqual(h.last(), {
      state: fileSays('tap'), pending: 'hold', mode: 'hold', force: false,
    }, 'the write has not landed yet, which is not a refusal');

    h.state.voice = fileSays('hold');   // the file caught up
    await h.core.refresh();
    assert.deepStrictEqual(h.last(), {
      state: fileSays('hold'), pending: null, mode: 'hold', force: false,
    }, 'an equal read retires the affordance');
  } finally { h.restore(); }
});

test('an external /voice typed in a terminal wins: the file is the source, not what we wrote', async () => {
  const h = harness({ voice: fileSays('tap') });
  try {
    await h.core.refresh();
    h.state.voice = fileSays('off');
    await h.core.refresh();
    assert.strictEqual(h.last().mode, 'off');
  } finally { h.restore(); }
});

// --- lifecycle: the modal opens and closes over a bar that never does --------

test('start/stop is REFCOUNTED: closing Preferences must not stop the poll under the bar', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ voice: fileSays('tap') });
  try {
    h.core.start();                       // the bar mounts
    await flush();
    h.core.start();                       // Preferences opens on top of it
    await flush();
    assert.strictEqual(h.calls.getVoiceMode, 2, 'but every hold gets a fresh read');

    h.core.stop();                        // the dialog closes
    const before = h.calls.getVoiceMode;
    t.mock.timers.tick(POLL_MS);
    await flush();
    assert.strictEqual(h.calls.getVoiceMode, before + 1, 'the poll still runs for the bar');

    h.core.stop();                        // the window goes away
    const after = h.calls.getVoiceMode;
    t.mock.timers.tick(POLL_MS * 3);
    await flush();
    assert.strictEqual(h.calls.getVoiceMode, after, 'the last release stops the poll');
  } finally { h.restore(); }
});

test('an unbalanced stop cannot drive the refcount negative and wedge a later start', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ voice: fileSays('tap') });
  try {
    h.core.stop();
    h.core.stop();
    h.core.start();
    await flush();
    const before = h.calls.getVoiceMode;
    t.mock.timers.tick(POLL_MS);
    await flush();
    assert.strictEqual(h.calls.getVoiceMode, before + 1);
    h.core.stop();
  } finally { h.restore(); }
});

// Mock timers like every other `core.start()` in this file: the hold arms a real
// setInterval(refresh, POLL_MS) otherwise, and an assertion failing before
// `stop()` would leave it running past `restore()`. `refresh` swallows the
// resulting `window.api` throw, so the run would HANG on a live event loop
// instead of going red — on the very mutation this test exists to catch.
test('the focus listener only reads while a surface is holding the core open', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ voice: fileSays('tap') });
  try {
    assert.strictEqual(h.calls.focusListeners, 1, 'exactly one window focus listener per core');

    // The guard is `if (holds > 0) refresh()`, so the listener has to be CALLED
    // to exercise it. Asserting the registration count alone leaves the guard
    // deletable with this test still green under a name that claims to cover it.
    const beforeHold = h.calls.getVoiceMode;
    h.focus();
    await flush();
    assert.strictEqual(h.calls.getVoiceMode, beforeHold,
      'no surface is holding the core open, so a focus must not read the file');

    h.core.start();
    await flush();
    const holding = h.calls.getVoiceMode;
    h.focus();
    await flush();
    assert.strictEqual(h.calls.getVoiceMode, holding + 1,
      'while a surface holds it open, a focus re-reads the file');

    h.core.stop();
    const afterRelease = h.calls.getVoiceMode;
    h.focus();
    await flush();
    assert.strictEqual(h.calls.getVoiceMode, afterRelease,
      'the last release closes the core again: focus stops reading');
  } finally { h.restore(); }
});

test('one surface throwing while painting may not starve the other', async () => {
  const h = harness({ voice: fileSays('tap') });
  const errs = [];
  const realError = console.error;
  console.error = (...a) => errs.push(a);
  try {
    const seen = [];
    h.core.subscribe(() => { throw new Error('painter exploded'); });
    h.core.subscribe((snap) => seen.push(snap.mode));
    await h.core.refresh();
    await h.core.refresh();
    assert.deepStrictEqual(seen, ['tap', 'tap'], 'the surface after the thrower still paints, every time');
    assert.strictEqual(errs.length, 2, 'and the throw is surfaced rather than swallowed');
  } finally { console.error = realError; h.restore(); }
});

test('unsubscribe detaches a surface without disturbing the rest', async () => {
  const h = harness({ voice: fileSays('tap') });
  try {
    const seen = [];
    const off = h.core.subscribe((snap) => seen.push(snap.mode));
    await h.core.refresh();
    off();
    await h.core.refresh();
    assert.deepStrictEqual(seen, ['tap']);
    assert.strictEqual(h.emits.length, 2, 'the other subscriber kept receiving');
  } finally { h.restore(); }
});

// ------------------------------------------------------- the trigger binding
// `triggerBinding()` is the one hop where the settings:voiceMode payload shape
// can drift silently: the re-arm reads the push-to-talk key through it, and
// every failure mode of that feature looks like nothing happening. A renamed
// key on the main side would leave the re-arm permanently declining with no
// error anywhere, which is the shape of bug this whole ticket kept producing.

test('triggerBinding reports the push-to-talk chord the file read carried', async () => {
  const binding = { key: 'k', ctrl: false, alt: false, shift: false, meta: false, super: false };
  const h = harness({
    voice: fileSays('tap', { trigger: { file: '/x/keybindings.json', binding, custom: true } }),
  });
  try {
    await h.core.refresh();
    assert.deepStrictEqual(h.core.triggerBinding(), binding);
  } finally { h.restore(); }
});

test('triggerBinding is null before any read, and when the file binds no chord', async () => {
  // Before a refresh there is no payload at all — the re-arm must decline
  // rather than fall back to a space, which would type into a box whose owner
  // has no push-to-talk key bound.
  const fresh = harness({});
  try {
    assert.strictEqual(fresh.core.triggerBinding(), null);
  } finally { fresh.restore(); }

  // And the cleared-binding case the main-side read reports as `binding: null`.
  const cleared = harness({
    voice: fileSays('tap', { trigger: { file: '/x/keybindings.json', binding: null, custom: true } }),
  });
  try {
    await cleared.core.refresh();
    assert.strictEqual(cleared.core.triggerBinding(), null);
  } finally { cleared.restore(); }

  // A payload with no trigger key at all (an older main process) is the same
  // answer, and must not throw.
  const legacy = harness({ voice: fileSays('tap') });
  try {
    await legacy.core.refresh();
    assert.strictEqual(legacy.core.triggerBinding(), null);
  } finally { legacy.restore(); }
});
