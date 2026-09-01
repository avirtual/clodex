'use strict';

// mic-handoff.test.js — a `select` must not leave a recorder live on the seat
// the microphone moved OFF.
//
// FIELD EVIDENCE, from the running app: he said the select phrase naming a seat
// in another window and the seat he left went on recording in the background
// through the CLI's own recorder. The broadcast made that seat stop ARMING —
// `isMicTarget` gates the turn-end re-arm — and nothing stopped the recorder
// that was already lit, so the room streamed upstream until the CLI's ~15s
// silence auto-finish.
//
// ASSERTED ON THE BYTES THAT REACHED THE PTY, never on the handoff's return
// value, and over a REAL watcher rather than a stub `tapOff`. A stub would pass
// with every one of the ensure-off gates deleted, and those gates are what stop
// this write from becoming the inverted failure — a byte on a DARK recorder
// arms a microphone nobody asked for.
//
// The fixture literals are duplicated from recorder-indicator.test.js on
// purpose, for the reason that file gives: a shared fixture lets one edit move
// both sides of every assertion at once.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const { createVoiceSubmitWatcher } = require('../renderer/voice-submit-watcher');
const { createMirrorLatch } = require('../renderer/lib/mirror-latch');
const { createMicHandoff } = require('../renderer/lib/mic-handoff');

// Measured off a live seat 2026-08-31 (CLI 2.1.251). Escapes, not the glyphs:
// the composer separator is a NON-BREAKING space, and an ASCII one here makes
// every empty-composer fixture read as a draft — the stop dead, the suite green.
const EMPTY_COMPOSER = '\u276f\u00a0';
const DRAFT_COMPOSER = '\u276f\u00a0half a sentence';
const REC_ROW = ' agents \u23fa\u0020REC \u00b7 tap to send';
const IDLE_ROW = ' agents \u00b7 tap to talk';

// Cursor on the LAST row unless a row carries `cursor: true`. The real footer
// paints the indicator BELOW the composer, so a composer row in a multi-row
// paint must say so or the composer read looks at the indicator instead.
function fakeTerminal({ rows, type = 'normal' }) {
  const state = { rows: rows.map((r) => (typeof r === 'string' ? { text: r } : r)), type };
  const cursorIndex = () => {
    const marked = state.rows.findIndex((r) => r && r.cursor);
    return marked === -1 ? state.rows.length - 1 : marked;
  };
  return {
    get rows() { return state.rows.length; },
    buffer: {
      get active() {
        return {
          type: state.type,
          baseY: 0,
          get cursorY() { return cursorIndex(); },
          get cursorX() {
            const r = state.rows[cursorIndex()];
            return typeof r.cursorX === 'number' ? r.cursorX : r.text.length;
          },
          getLine: (y) => {
            const r = state.rows[y];
            if (!r) return null;
            return {
              translateToString: (_t, start, end) =>
                r.text.slice(start ?? 0, end ?? r.text.length),
            };
          },
        };
      },
    },
    onWriteParsed() { return { dispose() {} }; },
  };
}

// Every watcher holds the composition poll's setInterval, so an assertion that
// throws jumps over its own dispose() and the surviving interval hangs the run
// on a timeout instead of naming the failure.
const live = [];
afterEach(() => { while (live.length) live.pop().dispose(); });

// The ENTER assertions below read `recorderReading()`, which is produced by the
// composition poll and starts at 'out' — asserting it before one poll has run
// would describe the watcher's initial value rather than the fixture's screen,
// which is precisely the trap of a state a test never actually reaches.
const tick = () => new Promise((res) => setTimeout(res, 12));

// One window holding named seats, each with a real watcher over its own fake
// screen, and the handoff wired over the same mirror renderer.js gives it.
function windowWith(seats, { initial = null } = {}) {
  const writes = new Map();
  const watchers = new Map();
  for (const [name, spec] of Object.entries(seats)) {
    const w = [];
    writes.set(name, w);
    const watcher = createVoiceSubmitWatcher(fakeTerminal(spec), {
      getConfig: () => ({ enabled: true, rearm: true, phrase: 'over and out' }),
      getAttention: () => spec.attention || null,
      getVoiceMode: () => spec.voiceMode || 'tap',
      getTriggerKey: () => (spec.trigger === undefined ? ' ' : spec.trigger),
      recorderScope: () => true,
      pollMs: 2,
      write: (d) => w.push(d),
    });
    live.push(watcher);
    watchers.set(name, watcher);
  }
  const mirror = createMirrorLatch(initial, {
    normalize: (name) => (typeof name === 'string' ? name : null),
  });
  // Every name the handoff asked about, in order. The byte assertions cannot
  // tell "the loser was looked up and declined" from "nothing was looked up at
  // all" — both write nothing — so the lookup itself has to be observable.
  const lookups = [];
  const onMicTarget = createMicHandoff({
    mirror,
    watcherFor: (name) => {
      lookups.push(name);
      return watchers.get(name) || null;
    },
  });
  return { mirror, onMicTarget, watchers, writes, lookups, bytes: (n) => writes.get(n) };
}

// THE TICKET. Everything else in this file is a way of failing to do it.
test('THE HANDOFF: a seat that loses the microphone while RECORDING is stopped', async () => {
  const h = windowWith({
    A: { rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW] },
    B: { rows: [{ text: EMPTY_COMPOSER, cursor: true }, IDLE_ROW] },
  }, { initial: 'A' });
  await tick();
  // ENTER: the state the name claims — A genuinely holds the microphone and its
  // recorder is genuinely lit. Without this the case below could pass because
  // nothing was recording, which is the fixture trap this subsystem specialises
  // in: a test that cannot reach its own state is green and asserts nothing.
  assert.strictEqual(h.mirror.read(), 'A', 'ENTER: A holds the microphone');
  assert.strictEqual(h.watchers.get('A').recorderReading(), 'lit',
    'ENTER: and its recorder is actually running');

  h.onMicTarget('B');

  assert.deepStrictEqual(h.bytes('A'), [' '],
    'the recorder he switched away from was stopped, not left streaming the room');
  assert.strictEqual(h.watchers.get('A').offTapCount(), 1);
  assert.deepStrictEqual(h.bytes('B'), [],
    'and the seat that GAINED the microphone was not written to — select arms it, this does not');
});

// The mirror still has to move, or every later re-arm on B declines and the
// seat he just selected is deaf. The stop is an addition to that update, never
// a replacement for it.
test('the mirror still tracks the new holder', () => {
  const h = windowWith({
    A: { rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW] },
    B: { rows: [{ text: EMPTY_COMPOSER, cursor: true }, IDLE_ROW] },
  }, { initial: 'A' });
  h.onMicTarget('B');
  assert.strictEqual(h.mirror.read(), 'B');
  assert.strictEqual(h.mirror.heard(), true, 'and the broadcast latched against a late pull');
});

// NOT VACUOUS, and this is the row that makes the whole file mean something: a
// stop that fired on every broadcast would pass the case above too. Repeats are
// the common traffic — main's guard is on the NAME, so a re-broadcast of an
// unchanged target is possible from any new writer — and a byte here lands on a
// LIT recorder and STOPS the dictation he is in the middle of.
test('a broadcast that does NOT move the microphone writes nothing', async () => {
  const h = windowWith({
    A: { rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW] },
  }, { initial: 'A' });
  await tick();
  assert.strictEqual(h.watchers.get('A').recorderReading(), 'lit',
    'ENTER: lit, so a stop that fired here would cut him off mid-sentence');
  h.onMicTarget('A');
  assert.deepStrictEqual(h.bytes('A'), [], 'he is still dictating into it');
});

// The polarity, and it is the ensure-off half's: writing to a DARK recorder
// ARMS a microphone on a seat he just navigated AWAY from — this ticket's own
// bug, re-created by its fix. Reached through the real watcher, so deleting
// tapOff's lit gate reds here.
test('THE POLARITY: a seat that loses the microphone while DARK is not written to', async () => {
  const h = windowWith({
    A: { rows: [{ text: EMPTY_COMPOSER, cursor: true }, IDLE_ROW] },
    B: { rows: [{ text: EMPTY_COMPOSER, cursor: true }, IDLE_ROW] },
  }, { initial: 'A' });
  await tick();
  assert.strictEqual(h.watchers.get('A').recorderReading(), 'off',
    'ENTER: dark, so only the polarity rule can decline');
  h.onMicTarget('B');
  assert.deepStrictEqual(h.bytes('A'), [],
    'a byte on a dark recorder arms the background seat — the failure inverted');
});

// THE RESIDUAL, and this case pins its PRICE rather than a safe outcome: the
// recorder is NOT stopped here and goes on streaming until the CLI's ~15s
// auto-finish. What the decline buys is only that the draft is not SENT — the
// key stops AND SUBMITS beside a lit indicator, so a half-written message would
// go to an agent as he switches away from it.
//
// Whether this is a corner or the MODAL path is an open question this suite
// cannot settle: if the CLI paints interim transcript into the composer while
// recording, the composer is non-empty exactly when a select arrives, and the
// stop declines in the case it was written for. See the ticket journal.
test('a LIT recorder over a draft keeps recording — the stop would SEND the draft', async () => {
  const h = windowWith({
    A: { rows: [{ text: DRAFT_COMPOSER, cursor: true }, REC_ROW] },
    B: { rows: [{ text: EMPTY_COMPOSER, cursor: true }, IDLE_ROW] },
  }, { initial: 'A' });
  await tick();
  // ENTER: lit, so the decline below is the COMPOSER rule and not an unlit
  // fixture. Without this the case passes on a screen where nothing was
  // recording, and it would then defend the residual against a future fix.
  assert.strictEqual(h.watchers.get('A').recorderReading(), 'lit',
    'ENTER: the recorder is genuinely running, so only the composer can decline');
  h.onMicTarget('B');
  assert.deepStrictEqual(h.bytes('A'), [],
    'not stopped — what is pinned is that his unsent draft was not SENT, not that this is safe');
});

// A seat in ANOTHER window resolves to no watcher here. Each window runs this
// handler over its own map and stops its own seats; the one that owns the
// loser is the one that can read its screen.
test('a loser this window does not hold is a silent no-op', () => {
  const h = windowWith({
    B: { rows: [{ text: EMPTY_COMPOSER, cursor: true }, IDLE_ROW] },
  }, { initial: 'elsewhere' });
  h.onMicTarget('B');
  assert.strictEqual(h.mirror.read(), 'B', 'the mirror still moved');
  assert.deepStrictEqual(h.bytes('B'), []);
  // The byte check alone would read identically if the handoff had looked up
  // nothing at all, so this pins WHICH name it asked about: the LOSER, never
  // the seat that just gained the microphone. Asserting the whole list is what
  // makes it a discrimination — a lookup of 'B' would fail here, and a stop
  // aimed at the new holder is the one wrong turn this path could take.
  assert.deepStrictEqual(h.lookups, ['elsewhere'],
    'the loser was the name resolved, and it is not one this window holds');
});

// The microphone RELEASED, not handed on — main broadcasts null. The loser is
// no less live for it, and 15s of room audio is 15s either way.
test('a release to null still stops the recorder it released', () => {
  const h = windowWith({
    A: { rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW] },
  }, { initial: 'A' });
  h.onMicTarget(null);
  assert.strictEqual(h.mirror.read(), null);
  assert.deepStrictEqual(h.bytes('A'), [' '], 'released is not a reason to keep recording');
});

// The FIRST broadcast a window hears has no prior holder, so there is nothing
// to stop. Distinct from the no-op case above: that one had a name that did not
// resolve, this one has no name at all.
test('the first broadcast into a fresh window stops nothing', () => {
  const h = windowWith({
    A: { rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW] },
  });
  assert.strictEqual(h.mirror.read(), null, 'ENTER: nothing held the microphone yet');
  h.onMicTarget('A');
  assert.deepStrictEqual(h.bytes('A'), []);
});

// ORDERING, and it is the one thing here that cannot be read off the source: the
// losing seat's re-arm timer can fire DURING the handoff, and it decides through
// `isMicTarget` on this same mirror. With the note after the stop it still reads
// its own name, re-arms, and re-lights the recorder just stopped — a live mic in
// the background window, arrived at through the fix.
test('the mirror is updated BEFORE the stop, so a re-arm racing it declines', () => {
  const seen = [];
  const mirror = createMirrorLatch('A', {
    normalize: (name) => (typeof name === 'string' ? name : null),
  });
  const onMicTarget = createMicHandoff({
    mirror,
    watcherFor: (name) => {
      // Sampled at the moment the stop resolves its watcher, which is the last
      // instant before the byte goes out.
      seen.push(mirror.read());
      return name ? { tapOff: () => true } : null;
    },
  });
  onMicTarget('B');
  assert.deepStrictEqual(seen, ['B'],
    'the loser had already stopped being the target by the time the stop ran');
});
