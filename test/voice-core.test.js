'use strict';

// voice-core.test.js — the voice-mode STATE MACHINE (t510), the half of
// renderer/voice-control.js that `test/voice-settings.test.js` does not reach:
// that file pins the read of settings.json, this one pins what the core does
// with it once `pending`, `pendingTarget`, a debounce and a dying session get
// involved.
//
// WHY THIS EXISTS AT ALL: t509 took five review rounds and every round after the
// first found the same defect class in a different REACHABLE STATE, with the
// suite green each time. The states, not the lines, are what went unexercised.
//
// NO jsdom, and none is needed: t517 extracted `createVoiceCore`, which never
// touches `document`. Its whole environment is three stubs below. What that
// leaves untested is deliberate and listed at the bottom of this file.

const { test } = require('node:test');
const assert = require('node:assert');

const { createVoiceCore } = require('../renderer/voice-control');

const POLL_MS = 15000;          // must match voice-control.js
const CHOICE_DEBOUNCE_MS = 250; // must match voice-control.js

// A settings read as the main side really returns it. `ok` is load-bearing:
// `refresh` gates on `r && r.ok`, so a fixture missing it leaves `state` null
// and every downstream assertion reads around the gap.
function fileSays(effective, extra = {}) {
  return { ok: true, source: 'voice', mode: effective, enabled: true, legacy: null, effective, ...extra };
}

// A stand-in for one `.session-item` row. `dataset`/`classList` are exactly the
// two surfaces injectTarget() reads.
function row(name, { type = 'claude', peerUi, failed, classes = [] } = {}) {
  return {
    dataset: { name, type, ...(peerUi ? { peerUi } : {}), ...(failed ? { failed } : {}) },
    classList: { contains: (c) => classes.includes(c) },
    _type: type,
  };
}

// The fake #session-list. It answers ONLY the selector the core actually uses
// and THROWS on anything else — a reducer that silently returned [] for a
// changed selector would empty the row set and leave every "no target" and
// "pickJustDied" assertion below trivially true. This is the CLAUDE.md ▸ Tests
// "assert the interesting row survived the reduction" hazard, so the harness
// refuses to be the thing that drops it.
const CLAUDE_SELECTOR = '.session-item[data-type="claude"]';
function fakeSessionList(rows = []) {
  const claude = () => rows.filter((r) => r._type === 'claude');
  return {
    rows,
    set(next) { rows.length = 0; rows.push(...next); },
    querySelectorAll(sel) {
      if (sel !== CLAUDE_SELECTOR) throw new Error(`fakeSessionList: unhandled selector ${sel}`);
      return claude();
    },
    querySelector(sel) {
      if (sel !== CLAUDE_SELECTOR) throw new Error(`fakeSessionList: unhandled selector ${sel}`);
      return claude()[0] || null;
    },
  };
}

// Installs the three globals the core closes over, builds it, and records every
// emitted snapshot. Returns the knobs a test drives plus `emits`.
function harness({ rows = [], active = null, voice = null, inject } = {}) {
  const list = fakeSessionList(rows);
  const calls = { getVoiceMode: 0, injectPrompt: [], observe: 0, disconnect: 0, focusListeners: 0 };
  const toasts = [];
  const state = { active, voice, inject: inject || (async () => ({ ok: true })) };

  const prevWindow = global.window;
  const prevObserver = global.MutationObserver;

  let observer = null;
  global.MutationObserver = class {
    constructor(cb) { this.cb = cb; this.observing = false; observer = this; }
    observe() { calls.observe++; this.observing = true; }
    disconnect() { calls.disconnect++; this.observing = false; }
  };
  global.window = {
    addEventListener(ev) { if (ev === 'focus') calls.focusListeners++; },
    api: {
      async getVoiceMode() { calls.getVoiceMode++; return state.voice; },
      async injectPrompt(target, text) { calls.injectPrompt.push([target, text]); return state.inject(target, text); },
    },
  };

  const core = createVoiceCore({
    getActiveSession: () => state.active,
    sessionTypeOf: (name) => (list.rows.find((r) => r.dataset.name === name) || {})._type || null,
    sessionList: list,
    showToast: (m) => toasts.push(m),
  });

  const emits = [];
  core.subscribe((snap) => emits.push(snap));

  return {
    core, emits, calls, toasts, list, state,
    // Replaces the rows and delivers the change the way the real DOM does —
    // through the core's own MutationObserver, and only while it is observing.
    // Reaching for `repaint()` instead would test a path the app does not take
    // when a session dies with no focus change and no user action.
    mutate(next) {
      list.set(next);
      if (observer && observer.observing) observer.cb();
    },
    last: () => emits[emits.length - 1],
    restore() { global.window = prevWindow; global.MutationObserver = prevObserver; },
  };
}

// Lets every already-queued promise job run. setImmediate is NOT among the
// mocked timer apis, so this still drains under mock.timers.
const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// The reachable states. Each asserts the WHOLE snapshot: the seven fields are
// the entire contract between the core and both surfaces, and a partial match
// is how an unwired dep arrives as `undefined` unnoticed.
// ---------------------------------------------------------------------------

test('fresh: constructed but never refreshed — no file read yet, so no mode is claimed', () => {
  const h = harness({ rows: [row('a')], active: 'a' });
  try {
    assert.deepStrictEqual(h.core.snapshot(), {
      target: 'a', state: null, pending: null, mode: null,
      anyClaudeRow: true, pickJustDied: false, force: false,
    });
  } finally { h.restore(); }
});

test('fresh with no session rows at all: reachable, because Preferences opens with no Claude session', () => {
  const h = harness({ rows: [], active: null });
  try {
    assert.deepStrictEqual(h.core.snapshot(), {
      target: null, state: null, pending: null, mode: null,
      anyClaudeRow: false, pickJustDied: false, force: false,
    });
  } finally { h.restore(); }
});

test('steady: a read of the file with nothing pending publishes the file\'s mode', async () => {
  const h = harness({ rows: [row('a')], active: 'a', voice: fileSays('tap') });
  try {
    await h.core.refresh();
    assert.deepStrictEqual(h.last(), {
      target: 'a', state: fileSays('tap'), pending: null, mode: 'tap',
      anyClaudeRow: true, pickJustDied: false, force: false,
    });
  } finally { h.restore(); }
});

test('steady with an unreadable file: state survives the failed read and an emit still happens', async () => {
  const h = harness({ rows: [row('a')], active: 'a', voice: fileSays('tap') });
  try {
    await h.core.refresh();
    h.state.voice = { ok: false, error: 'nope' };
    const before = h.emits.length;
    await h.core.refresh();
    assert.strictEqual(h.emits.length, before + 1, 'a failed read must still repaint the surfaces');
    assert.deepStrictEqual(h.last(), {
      target: 'a', state: fileSays('tap'), pending: null, mode: 'tap',
      anyClaudeRow: true, pickJustDied: false, force: false,
    });
  } finally { h.restore(); }
});

test('pending + target alive: the pick is published as pending and overrides the file\'s mode', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ rows: [row('a')], active: 'a', voice: fileSays('tap') });
  try {
    await h.core.refresh();
    assert.strictEqual(h.core.choose('hold'), true);
    assert.deepStrictEqual(h.last(), {
      target: 'a', state: fileSays('tap'), pending: 'hold', mode: 'hold',
      anyClaudeRow: true, pickJustDied: false, force: false,
    });
    // Nothing is injected yet — the debounce owns that.
    assert.deepStrictEqual(h.calls.injectPrompt, []);
  } finally { h.restore(); }
});

test('pending + target dead: the pick dies with its session and is reported as pickJustDied ONCE', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ rows: [row('a')], active: 'a', voice: fileSays('tap') });
  try {
    await h.core.refresh();
    h.core.choose('hold');
    h.list.set([]);
    h.state.active = null;
    h.core.repaint();
    assert.deepStrictEqual(h.last(), {
      target: null, state: fileSays('tap'), pending: null, mode: 'tap',
      anyClaudeRow: false, pickJustDied: true, force: false,
    }, 'the dead pick must be dropped and the drop announced');
    // r2/r3, without a DOM: the surface is told the pick died exactly once, so a
    // repaint cannot keep re-announcing a death that already happened.
    h.core.repaint();
    assert.strictEqual(h.last().pickJustDied, false);
  } finally { h.restore(); }
});

test('a dead target never publishes a pending through the pure snapshot either', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ rows: [row('a')], active: 'a', voice: fileSays('tap') });
  try {
    await h.core.refresh();
    h.core.choose('hold');
    h.list.set([]);
    h.state.active = null;
    // snapshot() is the bar button's synchronous read. It must not paint a
    // pending belonging to a session that is gone — but it must ALSO not consume
    // the pickJustDied that emit() owes the other surface.
    assert.deepStrictEqual(h.core.snapshot(), {
      target: null, state: fileSays('tap'), pending: null, mode: 'tap',
      anyClaudeRow: false, pickJustDied: false, force: false,
    });
    h.core.repaint();
    assert.strictEqual(h.last().pickJustDied, true, 'snapshot() must not have eaten the drop');
  } finally { h.restore(); }
});

test('target switched to another live session: the pick does not follow the operator', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ rows: [row('a'), row('b')], active: 'a', voice: fileSays('tap') });
  try {
    await h.core.refresh();
    h.core.choose('hold');
    h.state.active = 'b';
    h.core.repaint();
    assert.deepStrictEqual(h.last(), {
      target: 'b', state: fileSays('tap'), pending: null, mode: 'tap',
      anyClaudeRow: true, pickJustDied: true, force: false,
    }, 'a pick queued into `a` must not be shown as pending against `b`');
  } finally { h.restore(); }
});

test('operator picks "Not set": a no-op injection-wise, but a FORCED repaint', async () => {
  const h = harness({ rows: [row('a')], active: 'a', voice: fileSays('tap') });
  try {
    await h.core.refresh();
    assert.strictEqual(h.core.choose(''), false, '"Not set" is a reading, not a mode');
    // `force` is the field that matters here: it is what lets the surface repaint
    // out of a selection the core refused, even while the picker holds focus.
    // Without it the row keeps showing "Not set" beneath a line saying the value
    // came from the file — the r2 defect, in the shape reachable from the picker.
    assert.deepStrictEqual(h.last(), {
      target: 'a', state: fileSays('tap'), pending: null, mode: 'tap',
      anyClaudeRow: true, pickJustDied: false, force: true,
    });
  } finally { h.restore(); }
});

test('picking a mode with no reachable target is refused and forces a repaint', async () => {
  const h = harness({ rows: [row('a', { classes: ['archived'] })], active: null, voice: fileSays('tap') });
  try {
    await h.core.refresh();
    assert.strictEqual(h.core.choose('hold'), false);
    assert.deepStrictEqual(h.last(), {
      target: null, state: fileSays('tap'), pending: null, mode: 'tap',
      anyClaudeRow: true, pickJustDied: false, force: true,
    }, 'an archived row is visible (anyClaudeRow) but is not a target');
  } finally { h.restore(); }
});

test('the debounce coalesces to the FINAL pick — one injection, not one per option passed over', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ rows: [row('a')], active: 'a', voice: fileSays('off') });
  try {
    await h.core.refresh();
    h.core.choose('tap');
    h.core.choose('hold');
    h.core.choose('off');
    assert.deepStrictEqual(h.calls.injectPrompt, [], 'nothing may go out before the debounce elapses');
    t.mock.timers.tick(CHOICE_DEBOUNCE_MS);
    await flush();
    assert.deepStrictEqual(h.calls.injectPrompt, [['a', '/voice off']]);
  } finally { h.restore(); }
});

test('injection failed: the pick is dropped, the operator is told, and the repaint is forced', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({
    rows: [row('a')], active: 'a', voice: fileSays('tap'),
    inject: async () => ({ ok: false, error: 'agent is wedged' }),
  });
  try {
    await h.core.refresh();
    h.core.choose('hold');
    t.mock.timers.tick(CHOICE_DEBOUNCE_MS);
    await flush();
    assert.deepStrictEqual(h.last(), {
      target: 'a', state: fileSays('tap'), pending: null, mode: 'tap',
      anyClaudeRow: true, pickJustDied: false, force: true,
    }, 'the row must fall back to the file, forced past a focused picker');
    assert.deepStrictEqual(h.toasts, ['Setting voice to hold failed: agent is wedged']);
  } finally { h.restore(); }
});

test('injection threw: treated as a failure, not as a silently-successful send', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({
    rows: [row('a')], active: 'a', voice: fileSays('tap'),
    inject: async () => { throw new Error('socket closed'); },
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

test('a SLOW failed injection may not wipe the pick a later choice already owns', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let release;
  const h = harness({
    rows: [row('a')], active: 'a', voice: fileSays('off'),
    inject: () => new Promise((r) => { release = r; }),
  });
  try {
    await h.core.refresh();
    h.core.choose('hold');
    t.mock.timers.tick(CHOICE_DEBOUNCE_MS);
    await flush();                      // first injection is now in flight
    h.core.choose('tap');               // operator moved on while it hung
    release({ ok: false, error: 'too late' });
    await flush();
    assert.strictEqual(h.last().pending, 'tap', 'the live pick must survive the stale failure');
    assert.deepStrictEqual(h.toasts, [], 'and no toast for a mode already moved on from');
  } finally { h.restore(); }
});

test('the target dies between the pick and the debounce: the row watch announces the drop, nothing is injected', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ rows: [row('a')], active: 'a', voice: fileSays('tap') });
  try {
    h.core.start();
    await flush();
    h.core.choose('hold');
    h.state.active = null;
    h.mutate([]);                       // the PTY exited: no focus change, no user action
    assert.deepStrictEqual(h.last(), {
      target: null, state: fileSays('tap'), pending: null, mode: 'tap',
      anyClaudeRow: false, pickJustDied: true, force: false,
    }, 'the watch is the only thing that can notice this, so it must announce the drop');

    t.mock.timers.tick(CHOICE_DEBOUNCE_MS);
    await flush();
    assert.deepStrictEqual(h.calls.injectPrompt, [], 'no session left to type into');
    // The debounced send finds no target and re-emits. `pickJustDied` is false
    // because the watch above already consumed the drop — the announcement is
    // owed once, and the surface must not be told a second time about a death it
    // has already painted.
    assert.deepStrictEqual(h.last(), {
      target: null, state: fileSays('tap'), pending: null, mode: 'tap',
      anyClaudeRow: false, pickJustDied: false, force: false,
    });
    h.core.stop();
  } finally { h.restore(); }
});

test('the pending affordance stands until a read AGREES — a differing read is not a rejection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ rows: [row('a')], active: 'a', voice: fileSays('tap') });
  try {
    await h.core.refresh();
    h.core.choose('hold');
    await h.core.refresh();             // the CLI has not run the command yet
    assert.deepStrictEqual(h.last(), {
      target: 'a', state: fileSays('tap'), pending: 'hold', mode: 'hold',
      anyClaudeRow: true, pickJustDied: false, force: false,
    }, 'the command is parked, not refused');

    h.state.voice = fileSays('hold');   // the file caught up
    await h.core.refresh();
    assert.deepStrictEqual(h.last(), {
      target: 'a', state: fileSays('hold'), pending: null, mode: 'hold',
      anyClaudeRow: true, pickJustDied: false, force: false,
    }, 'an equal read retires the affordance');
  } finally { h.restore(); }
});

test('an external /voice typed in a terminal wins: the file is the source, not what we injected', async () => {
  const h = harness({ rows: [row('a')], active: 'a', voice: fileSays('tap') });
  try {
    await h.core.refresh();
    h.state.voice = fileSays('off');
    await h.core.refresh();
    assert.strictEqual(h.last().mode, 'off');
  } finally { h.restore(); }
});

// --- target selection ------------------------------------------------------

test('injectTarget skips every row that has no local process to type into', async () => {
  const CASES = [
    { what: 'a peer row', rows: [row('p', { peerUi: '1' }), row('a')], expect: 'a' },
    { what: 'a failed row', rows: [row('f', { failed: '1' }), row('a')], expect: 'a' },
    { what: 'an archived row', rows: [row('z', { classes: ['archived'] }), row('a')], expect: 'a' },
    { what: 'a peer-item row', rows: [row('z', { classes: ['peer-item'] }), row('a')], expect: 'a' },
    { what: 'only unusable rows', rows: [row('p', { peerUi: '1' })], expect: null },
    { what: 'no rows', rows: [], expect: null },
  ];
  for (const c of CASES) {
    const h = harness({ rows: c.rows, active: null, voice: fileSays('tap') });
    try {
      await h.core.refresh();
      assert.strictEqual(h.last().target, c.expect, c.what);
      assert.strictEqual(h.last().anyClaudeRow, c.rows.length > 0, `${c.what}: the row is still VISIBLE`);
    } finally { h.restore(); }
  }
});

test('a non-Claude active tab falls back to the sidebar rather than injecting /voice into Codex', async () => {
  const h = harness({
    rows: [row('codexy', { type: 'codex' }), row('a')], active: 'codexy', voice: fileSays('tap'),
  });
  try {
    await h.core.refresh();
    assert.strictEqual(h.last().target, 'a');
  } finally { h.restore(); }
});

// --- lifecycle: the modal opens and closes over a bar that never does --------

test('start/stop is REFCOUNTED: closing Preferences must not stop the poll under the bar', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ rows: [row('a')], active: 'a', voice: fileSays('tap') });
  try {
    h.core.start();                       // the bar mounts
    await flush();
    assert.strictEqual(h.calls.observe, 1);
    h.core.start();                       // Preferences opens on top of it
    await flush();
    assert.strictEqual(h.calls.observe, 1, 'the second hold must not re-observe');
    assert.strictEqual(h.calls.getVoiceMode, 2, 'but every hold gets a fresh read');

    h.core.stop();                        // the dialog closes
    assert.strictEqual(h.calls.disconnect, 0);
    const before = h.calls.getVoiceMode;
    t.mock.timers.tick(POLL_MS);
    await flush();
    assert.strictEqual(h.calls.getVoiceMode, before + 1, 'the poll still runs for the bar');

    h.core.stop();                        // the window goes away
    assert.strictEqual(h.calls.disconnect, 1);
    const after = h.calls.getVoiceMode;
    t.mock.timers.tick(POLL_MS * 3);
    await flush();
    assert.strictEqual(h.calls.getVoiceMode, after, 'the last release stops the poll');
  } finally { h.restore(); }
});

test('an unbalanced stop cannot drive the refcount negative and wedge a later start', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ rows: [row('a')], active: 'a', voice: fileSays('tap') });
  try {
    h.core.stop();
    h.core.stop();
    h.core.start();
    await flush();
    assert.strictEqual(h.calls.observe, 1, 'the first real hold must still arm the watch');
    const before = h.calls.getVoiceMode;
    t.mock.timers.tick(POLL_MS);
    await flush();
    assert.strictEqual(h.calls.getVoiceMode, before + 1);
    h.core.stop();
  } finally { h.restore(); }
});

test('the focus listener only reads while a surface is holding the core open', () => {
  const h = harness({ rows: [row('a')], active: 'a', voice: fileSays('tap') });
  try {
    assert.strictEqual(h.calls.focusListeners, 1, 'exactly one window focus listener per core');
  } finally { h.restore(); }
});

test('one surface throwing while painting may not starve the other', async () => {
  const h = harness({ rows: [row('a')], active: 'a', voice: fileSays('tap') });
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
  const h = harness({ rows: [row('a')], active: 'a', voice: fileSays('tap') });
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
