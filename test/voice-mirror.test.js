'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createVoiceMirror, draftFromRows, engineObserved } = require('../renderer/voice-mirror');
const { applyDraft, attachTriggerSubmit, createPtyVoiceDraft } = require('../renderer/lib/composer-voice');

const HEAD = '❯ ';

function fakeTerminal(screen) {
  const subs = [];
  const t = {
    rows: 30,
    screen,
    buffer: {
      active: {
        type: 'normal',
        baseY: 0,
        get cursorY() { return t.screen.length - 1; },
        get cursorX() { return t.screen[t.screen.length - 1].length; },
        getLine: (y) => (y < t.screen.length ? { translateToString: () => t.screen[y] } : undefined),
      },
    },
    onWriteParsed(cb) { subs.push(cb); return { dispose() { subs.splice(subs.indexOf(cb), 1); } }; },
    paint(rows) { t.screen = rows; for (const cb of [...subs]) cb(); },
  };
  return t;
}

test('draftFromRows joins a wrapped composer and drops the interim cursor block', () => {
  assert.equal(draftFromRows([`${HEAD}hello there`, '  from a long draft █']), 'hello there from a long draft');
  assert.equal(draftFromRows([`${HEAD}`]), '');
  assert.equal(draftFromRows(['some agent output']), null);
  assert.equal(draftFromRows(null), null);
});

test('the mirror reports each change of the engine input row only while armed', () => {
  const t = fakeTerminal(['old output', `${HEAD}`]);
  const drafts = [];
  const mirror = createVoiceMirror(t, { onDraft: (d) => drafts.push(d) });
  t.paint(['old output', `${HEAD}Banana █`]);
  assert.deepEqual(drafts, [], 'unarmed: nothing mirrored');
  t.paint(['old output', `${HEAD}`]);
  mirror.arm();
  t.paint(['old output', `${HEAD}Banana █`]);
  t.paint(['old output', `${HEAD}Banana █`]);
  t.paint(['old output', `${HEAD}Banana split for the recorder.`]);
  t.paint(['old output', `${HEAD}`]);
  assert.deepEqual(drafts, ['Banana', 'Banana split for the recorder.'], 'one call per change, an emptied row is not a draft');
  mirror.dispose();
  t.paint(['old output', `${HEAD}later`]);
  assert.equal(drafts.length, 2);
});

test('the mirror reports only what was spoken after it armed', () => {
  const t = fakeTerminal([`${HEAD}left over`]);
  const drafts = [];
  const mirror = createVoiceMirror(t, { onDraft: (d) => drafts.push(d) });
  mirror.arm();
  t.paint([`${HEAD}left over new words`]);
  assert.deepEqual(drafts, ['new words']);
});

test('applyDraft replaces only the mirrored span and keeps the operator typing around it', () => {
  let st = applyDraft('Note:', null, 'hello');
  assert.deepEqual(st.value, 'Note: hello');
  st = applyDraft(st.value, st.span, 'hello world');
  assert.equal(st.value, 'Note: hello world');
  const typed = `${st.value} (edited)`;
  st = applyDraft(typed, st.span, 'hello world again');
  assert.equal(st.value, 'Note: hello world again (edited)');
  const shifted = `Re: ${st.value}`;
  st = applyDraft(shifted, st.span, 'hello final');
  assert.equal(st.value, 'Re: Note: hello final (edited)');
  const gone = applyDraft('cleared', st.span, 'next');
  assert.equal(gone.value, 'cleared next');
});

function fakeTextarea(value = '') {
  const listeners = new Map();
  return {
    value,
    addEventListener(ev, cb) { listeners.set(ev, cb); },
    removeEventListener(ev) { listeners.delete(ev); },
    type(v) { this.value = v; const cb = listeners.get('input'); if (cb) cb(); },
  };
}

test('the trigger phrase strips, marks the origin and sends once per draft', () => {
  const ta = fakeTextarea();
  const log = [];
  const cfg = { enabled: true, phrase: 'over and out' };
  attachTriggerSubmit(ta, {
    getConfig: () => cfg,
    markOrigin: () => log.push('mark'),
    send: () => log.push(`send:${ta.value}`),
    holdsFire: () => true,
  });
  ta.type('ship it');
  assert.deepEqual(log, []);
  ta.type('ship it over and out.');
  assert.deepEqual(log, ['mark', 'send:ship it']);
  ta.value = 'ship it over and out.';
  ta.type('ship it over and out.');
  assert.deepEqual(log, ['mark', 'send:ship it'], 'the same draft never fires twice');
  ta.type('again over and out');
  assert.deepEqual(log, ['mark', 'send:ship it', 'mark', 'send:again'], 'a changed draft re-arms');
  ta.type('over and out');
  assert.equal(log.length, 4, 'a bare phrase with nothing to send marks nothing');
  cfg.enabled = false;
  ta.type('late over and out');
  assert.equal(log.length, 4, 'disabled in Preferences: never fires');
});

test('Chromium receiver: the default timers arm the quiet window when setTimeout rejects a foreign this', () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const calls = [];
  const traces = [];
  globalThis.setTimeout = function (fn, ms) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    calls.push(ms);
    return calls.length;
  };
  globalThis.clearTimeout = function () {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
  };
  try {
    const ta = fakeTextarea();
    const sub = attachTriggerSubmit(ta, {
      getConfig: () => ({ enabled: true, phrase: 'enter' }),
      markOrigin: () => {},
      send: () => {},
      quietMs: 1200,
      trace: (l) => traces.push(l),
    });
    assert.doesNotThrow(() => sub.draft('hello enter'));
    assert.doesNotThrow(() => sub.draft('hello enter.'));
    assert.deepEqual(calls, [1200, 1200]);
    assert.deepEqual(traces, []);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

test('a timer that throws is traced as timer failed and rethrown', () => {
  const ta = fakeTextarea();
  const traces = [];
  const sub = attachTriggerSubmit(ta, {
    getConfig: () => ({ enabled: true, phrase: 'enter' }),
    markOrigin: () => {},
    send: () => {},
    quietMs: 1200,
    timers: { set: () => { throw new TypeError('Illegal invocation'); }, clear: () => {} },
    trace: (l) => traces.push(l),
  });
  assert.throws(() => sub.draft('hello'), /Illegal invocation/);
  assert.deepEqual(traces, ['timer failed: Illegal invocation']);
});

test('typed trigger word outside a dictation is ordinary text; while recording it sends', () => {
  const ta = fakeTextarea();
  const sent = [];
  let recording = false;
  attachTriggerSubmit(ta, {
    getConfig: () => ({ enabled: true, phrase: 'enter' }),
    markOrigin: () => {},
    send: () => sent.push(ta.value),
    holdsFire: () => recording,
  });
  ta.type('please press enter');
  assert.deepEqual(sent, []);
  assert.equal(ta.value, 'please press enter');
  recording = true;
  ta.type('please press enter');
  assert.deepEqual(sent, ['please press']);
});

test('after released() completes a dictation, a typed trigger word no longer sends', async () => {
  const ta = fakeTextarea();
  const clock = fakeClock();
  const sent = [];
  let recording = true;
  const sub = attachTriggerSubmit(ta, {
    getConfig: () => ({ enabled: true, phrase: 'enter' }),
    markOrigin: () => {},
    send: () => { sent.push(ta.value); ta.value = ''; },
    holdsFire: () => recording,
    onVoiceStop: () => { recording = false; return Promise.resolve(true); },
    quietMs: 1200,
    timers: clock.timers,
  });
  sub.draft('Hello world enter.');
  clock.advance(1200);
  await Promise.resolve();
  sub.released();
  assert.deepEqual(sent, ['Hello world']);
  ta.type('x enter');
  assert.deepEqual(sent, ['Hello world']);
  assert.equal(ta.value, 'x enter');
});

test('after released() ends a dictation the quiet window never stopped, a typed trigger word no longer sends', () => {
  const ta = fakeTextarea();
  const clock = fakeClock();
  const sent = [];
  const sub = attachTriggerSubmit(ta, {
    getConfig: () => ({ enabled: true, phrase: 'enter' }),
    markOrigin: () => {},
    send: () => { sent.push(ta.value); ta.value = ''; },
    holdsFire: () => false,
    quietMs: 1200,
    timers: clock.timers,
  });
  sub.draft('hello world');
  clock.advance(1200);
  sub.released();
  ta.type('hello world press enter');
  assert.deepEqual(sent, []);
  assert.equal(ta.value, 'hello world press enter');
});

test('a timer whose clear throws is traced as timer failed and rethrown', () => {
  const ta = fakeTextarea();
  const traces = [];
  const sub = attachTriggerSubmit(ta, {
    getConfig: () => ({ enabled: true, phrase: 'enter' }),
    markOrigin: () => {},
    send: () => {},
    quietMs: 1200,
    timers: { set: () => 1, clear: () => { throw new TypeError('Illegal invocation'); } },
    trace: (l) => traces.push(l),
  });
  sub.draft('hello');
  assert.throws(() => sub.draft('hello there'), /Illegal invocation/);
  assert.deepEqual(traces, ['timer failed: Illegal invocation']);
});

test('a mirrored utterance sends once: the trigger waits out the repaint, then stops and disarms', () => {
  const t = fakeTerminal([`${HEAD}`]);
  const ta = fakeTextarea();
  const pending = [];
  const timers = { set: (fn) => { pending.push(fn); return pending.length; }, clear: (id) => { pending[id - 1] = null; } };
  const flush = () => { for (let i = 0; i < pending.length; i++) { const fn = pending[i]; pending[i] = null; if (fn) fn(); } };
  const sent = [];
  let fired = 0;
  let mirror = null;
  const sub = attachTriggerSubmit(ta, {
    getConfig: () => ({ enabled: true, phrase: 'over and out' }),
    markOrigin: () => {},
    send: () => { sent.push(ta.value); ta.value = ''; sub.resetSpan(); },
    onVoiceFire: () => { fired++; mirror.disarm(); },
    quietMs: 1200,
    timers,
  });
  mirror = createVoiceMirror(t, { onDraft: (d) => sub.draft(d) });
  mirror.arm();
  t.paint([`${HEAD}ship it over and out █`]);
  t.paint([`${HEAD}Ship it, over and out.`]);
  flush();
  t.paint([`${HEAD}Ship it, over and out. more`]);
  flush();
  assert.deepEqual(sent, ['Ship it,']);
  assert.equal(fired, 1);
  assert.equal(mirror.isArmed(), false);
  assert.equal(ta.value, '');
});

test('a released mirror disarms once the engine clears its input row', () => {
  const t = fakeTerminal([`${HEAD}`]);
  const drafts = [];
  const mirror = createVoiceMirror(t, { onDraft: (d) => drafts.push(d) });
  mirror.arm();
  t.paint([`${HEAD}hello █`]);
  mirror.release();
  t.paint([`${HEAD}Hello there.`]);
  t.paint([`${HEAD}`]);
  t.paint([`${HEAD}stray`]);
  assert.deepEqual(drafts, ['hello', 'Hello there.']);
  assert.equal(mirror.isArmed(), false);
});

test('tap mode: a phrase in the interim paint stops the recorder and sends the final sentence once', () => {
  const t = fakeTerminal([`${HEAD}`]);
  const ta = fakeTextarea();
  const pending = [];
  const timers = { set: (fn) => { pending.push(fn); return pending.length; }, clear: (id) => { pending[id - 1] = null; } };
  const flush = () => { for (let i = 0; i < pending.length; i++) { const fn = pending[i]; pending[i] = null; if (fn) fn(); } };
  const sent = [];
  let recording = true;
  let stops = 0;
  let mirror = null;
  const sub = attachTriggerSubmit(ta, {
    getConfig: () => ({ enabled: true, phrase: 'over and out' }),
    markOrigin: () => {},
    send: () => { sent.push(ta.value); ta.value = ''; sub.resetSpan(); },
    onVoiceFire: () => mirror.disarm(),
    holdsFire: () => recording,
    onVoiceStop: () => { stops++; recording = false; mirror.release(); },
    quietMs: 1200,
    timers,
  });
  mirror = createVoiceMirror(t, { onDraft: (d) => sub.draft(d), onRelease: () => sub.released() });
  mirror.arm();
  t.paint([`${HEAD}ship it over and out █`]);
  flush();
  assert.deepEqual(sent, [], 'the interim paint never sends');
  assert.equal(stops, 1);
  t.paint([`${HEAD}Ship it now, over and out.`]);
  t.paint([`${HEAD}`]);
  flush();
  assert.deepEqual(sent, ['Ship it now,']);
  assert.equal(stops, 1);
  assert.equal(mirror.isArmed(), false);
});

function fakeClock() {
  let now = 0;
  let seq = 0;
  const due = new Map();
  return {
    timers: {
      set: (fn, ms) => { seq++; due.set(seq, { at: now + ms, fn }); return seq; },
      clear: (id) => { due.delete(id); },
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of due) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    pending: () => due.size,
  };
}

const METER = ['▅', '▆', '▇', '█', '▆', '▅', '▄', '▃', '▄', '▅', '▆', '▇'];

function meterFor(t, clock, text, ms) {
  for (let i = 0; i * 50 < ms; i++) {
    t.paint([`${HEAD}${text}${METER[i % METER.length]}`]);
    clock.advance(50);
  }
}

function streamSeat({ recording, onStop }) {
  const t = fakeTerminal([`${HEAD}`]);
  const ta = fakeTextarea();
  const clock = fakeClock();
  const seat = { t, ta, clock, sent: [], stops: 0, recording, mirror: null };
  const sub = attachTriggerSubmit(ta, {
    getConfig: () => ({ enabled: true, phrase: 'enter' }),
    markOrigin: () => {},
    send: () => { seat.sent.push(ta.value); ta.value = ''; sub.resetSpan(); },
    onVoiceFire: () => seat.mirror.disarm(),
    holdsFire: () => seat.recording,
    onVoiceStop: () => { seat.stops++; return onStop(seat); },
    quietMs: 1200,
    releaseMs: 2500,
    timers: clock.timers,
  });
  seat.sub = sub;
  seat.mirror = createVoiceMirror(t, { onDraft: (d) => sub.draft(d), onRelease: () => sub.released() });
  seat.mirror.arm();
  return seat;
}

test('draftFromRows drops the level meter the CLI animates in the cursor cell', () => {
  for (const g of '▁▂▃▄▅▆▇█') assert.equal(draftFromRows([`${HEAD}Hello world enter.${g}`]), 'Hello world enter.');
});

test('tap mode, probe rows: the meter ticking past "enter" does not starve the quiet window; ENTER sends once, phrase stripped', () => {
  const s = streamSeat({ recording: true, onStop: (seat) => { seat.recording = false; seat.mirror.release(); } });
  s.t.paint([`${HEAD}Hello█`]);
  s.t.paint([`${HEAD}Hello world▂`]);
  meterFor(s.t, s.clock, 'Hello world enter.', 3000);
  assert.equal(s.stops, 1, 'the quiet window elapsed while the meter still ticked');
  s.t.paint([`${HEAD}Hello world enter.`]);
  s.t.paint([`${HEAD}Hello world, enter.`]);
  s.t.paint([`${HEAD}`]);
  s.clock.advance(5000);
  assert.deepEqual(s.sent, ['Hello world,']);
  assert.equal(s.ta.value, '');
});

test('hold mode, probe rows: the meter ticking past "enter" while held does not starve the quiet window; ENTER sends once, phrase stripped', () => {
  const s = streamSeat({ recording: false, onStop: () => {} });
  s.t.paint([`${HEAD}Hello█`]);
  s.t.paint([`${HEAD}Hello world▄`]);
  meterFor(s.t, s.clock, 'Hello world enter.', 3000);
  assert.deepEqual(s.sent, ['Hello world']);
  meterFor(s.t, s.clock, 'Hello world enter.', 3000);
  s.t.paint([`${HEAD}Hello, world, enter.`]);
  s.clock.advance(5000);
  assert.deepEqual(s.sent, ['Hello world']);
  assert.equal(s.stops, 0);
});

test('tap mode: a failed stop clears the latch and the next quiet window retries it', async () => {
  let fail = true;
  const s = streamSeat({
    recording: true,
    onStop: (seat) => {
      if (fail) { seat.recording = false; return Promise.resolve(false); }
      seat.recording = false;
      seat.mirror.release();
      return Promise.resolve(true);
    },
  });
  s.t.paint([`${HEAD}Hello world enter.`]);
  s.clock.advance(1200);
  assert.equal(s.stops, 1);
  await Promise.resolve();
  fail = false;
  s.clock.advance(1200);
  assert.equal(s.stops, 1);
  assert.deepEqual(s.sent, ['Hello world']);
});

function tapStopped() {
  return streamSeat({
    recording: true,
    onStop: (seat) => { seat.recording = false; seat.mirror.release(); return Promise.resolve(true); },
  });
}

test('tap mode: the stop tap landed but the engine row never clears; the release deadline sends the sentence', async () => {
  const s = tapStopped();
  s.t.paint([`${HEAD}Hello world enter.`]);
  s.clock.advance(1200);
  await Promise.resolve();
  assert.equal(s.stops, 1);
  assert.deepEqual(s.sent, []);
  s.clock.advance(2500);
  assert.deepEqual(s.sent, ['Hello world']);
  assert.equal(s.stops, 1);
  assert.equal(s.mirror.isArmed(), false);
});

test('tap mode: the engine row clears before the release deadline; it sends on the clear and the deadline sends nothing', async () => {
  const s = tapStopped();
  s.t.paint([`${HEAD}Hello world enter.`]);
  s.clock.advance(1200);
  await Promise.resolve();
  s.clock.advance(400);
  s.t.paint([`${HEAD}`]);
  assert.deepEqual(s.sent, ['Hello world']);
  assert.equal(s.clock.pending(), 0, 'the clear cancelled the release deadline');
  s.clock.advance(5000);
  assert.equal(s.sent.length, 1);
  assert.equal(s.mirror.isArmed(), false);
});

test('tap mode: a keystroke while the release is owed sends once and cancels the deadline', async () => {
  const s = tapStopped();
  s.t.paint([`${HEAD}Hello world enter.`]);
  s.clock.advance(1200);
  await Promise.resolve();
  s.clock.advance(800);
  s.ta.type('Hello world enter. ');
  assert.equal(s.sent.length, 1);
  assert.equal(s.clock.pending(), 0, 'the keystroke cancelled the release deadline');
  s.clock.advance(5000);
  s.t.paint([`${HEAD}`]);
  assert.equal(s.sent.length, 1);
});

test('tap mode: the same sentence dictated twice sends twice', async () => {
  const s = tapStopped();
  for (let i = 0; i < 2; i++) {
    if (i) { s.recording = true; s.sub.resetSpan(); s.mirror.arm(); }
    s.t.paint([`${HEAD}Hello world enter.`]);
    s.clock.advance(1200);
    await Promise.resolve();
    s.t.paint([`${HEAD}`]);
  }
  assert.deepEqual(s.sent, ['Hello world', 'Hello world']);
});

test('tap mode: two refused stops send the sentence anyway, phrase stripped', async () => {
  const s = streamSeat({ recording: true, onStop: () => Promise.resolve(false) });
  s.t.paint([`${HEAD}Hello world enter.`]);
  s.clock.advance(1200);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(s.sent, []);
  s.clock.advance(1200);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(s.stops, 2);
  assert.deepEqual(s.sent, ['Hello world']);
  s.clock.advance(10000);
  assert.equal(s.stops, 2);
});

test('the mirror drops a leftover baseline once the engine row clears, so a repeated sentence still mirrors', () => {
  const t = fakeTerminal([`${HEAD}Hello world enter.`]);
  const drafts = [];
  const mirror = createVoiceMirror(t, { onDraft: (d) => drafts.push(d) });
  mirror.arm();
  t.paint([`${HEAD}`]);
  t.paint([`${HEAD}Hello█`]);
  t.paint([`${HEAD}Hello world enter.▂`]);
  assert.deepEqual(drafts, ['Hello', 'Hello world enter.']);
});

test('engineObserved reads the recorder and processing indicators off the whole engine screen', () => {
  assert.equal(engineObserved(null), null);
  const lit = fakeTerminal([`${HEAD}`, '\u23fa REC  space to stop']);
  assert.deepEqual(engineObserved({ terminal: lit }), { recording: true, processing: false, text: false });
  assert.deepEqual(engineObserved({ terminal: fakeTerminal([`${HEAD}`, 'Voice: processing\u2026']) }), { recording: false, processing: true, text: false });
  assert.deepEqual(engineObserved({ terminal: fakeTerminal([`${HEAD}`]) }), { recording: false, processing: false, text: false });
});

test('engineObserved reports text when the engine input row still holds the previous dictation', () => {
  assert.deepEqual(engineObserved({ terminal: fakeTerminal([`${HEAD}test enter`]) }), { recording: false, processing: false, text: true });
});

test('seatVoiceRecord passes the engine view it already had, read before the view is created', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const body = src.slice(src.indexOf('async function seatVoiceRecord('), src.indexOf('function seatVoiceFired('));
  const read = body.indexOf('const observed = engineObserved(voiceEngineView);');
  assert.ok(read !== -1);
  assert.ok(read < body.indexOf('voiceEngine()'));
  assert.match(body, /window\.api\.voiceRecord\(name, action, observed\)/);
});

function ptyFixture(phrase = 'over and out', { failWrites = 0 } = {}) {
  const t = fakeTerminal([`${HEAD}`]);
  const pending = [];
  const timers = { set: (fn) => { pending.push(fn); return pending.length; }, clear: (id) => { pending[id - 1] = null; } };
  const flush = () => { for (let i = 0; i < pending.length; i++) { const fn = pending[i]; pending[i] = null; if (fn) fn(); } };
  const writes = [];
  const traces = [];
  let origins = 0;
  let fails = failWrites;
  const sink = createPtyVoiceDraft({
    getConfig: () => ({ enabled: true, phrase }),
    write: (d) => { if (fails > 0) { fails--; throw new Error('pty gone'); } writes.push(d); },
    markOrigin: () => { origins++; },
    quietMs: 1200,
    timers,
    trace: (line) => traces.push(line),
  });
  const mirror = createVoiceMirror(t, { onDraft: (d) => sink.draft(d), onRelease: () => sink.released() });
  return { t, sink, mirror, writes, traces, flush, origins: () => origins };
}

test('a pty seat: each draft types into the row as he speaks, a correction backspaces only the changed tail', () => {
  const f = ptyFixture('enter');
  f.sink.draft('Okay.');
  f.sink.draft('Okay. so');
  f.sink.draft('Okay. So there');
  assert.deepStrictEqual(f.writes, ['Okay.', ' so', '\x7f\x7fSo there']);
  assert.ok(f.traces.includes('pty row sync -2 +"So there"'), f.traces.join('\n'));
  assert.equal(f.origins(), 0);
});

test('a pty seat: the release after a trigger word backspaces the phrase, then Enter alone, no paste', () => {
  const f = ptyFixture('enter');
  f.sink.draft('Okay. So there was a problem. Enter.');
  f.writes.length = 0;
  f.sink.released();
  assert.deepStrictEqual(f.writes, ['\x7f\x7f\x7f\x7f\x7f\x7f\x7f', '\r']);
  assert.equal(f.origins(), 1);
  assert.equal(f.sink.pending(), '');
});

test('a pty seat: the quiet window after a trigger word sends the synced row once', () => {
  const f = ptyFixture();
  f.mirror.arm();
  f.t.paint([`${HEAD}ship it over and out`]);
  f.flush();
  assert.deepStrictEqual(f.writes, ['ship it over and out', '\x7f'.repeat(13), '\r']);
  f.mirror.release();
  f.t.paint([`${HEAD}`]);
  assert.equal(f.writes.length, 3, 'the release after a fire sends nothing more');
});

test('a pty seat: a release with no trigger word leaves the typed text in the row, unsent', () => {
  const f = ptyFixture();
  f.mirror.arm();
  f.t.paint([`${HEAD}first line`]);
  f.t.paint([`${HEAD}First line. Second line.`]);
  f.mirror.release();
  f.t.paint([`${HEAD}`]);
  assert.deepStrictEqual(f.writes, ['first line', '\x7f'.repeat(10) + 'First line. Second line.']);
  assert.equal(f.origins(), 0);
  f.sink.resetSpan();
  f.sink.draft('more');
  assert.deepStrictEqual(f.writes.slice(2), ['more'], 'the next dictation appends without erasing the row');
});

test('a pty seat: a release with nothing synced still writes the bracketed text, then Enter', () => {
  const f = ptyFixture('over and out', { failWrites: 1 });
  assert.throws(() => f.sink.draft('First line. Second line.'), /pty gone/);
  assert.deepStrictEqual(f.writes, []);
  f.sink.released();
  assert.deepStrictEqual(f.writes, ['\x1b[200~First line. Second line.\x1b[201~', '\r']);
  assert.equal(f.origins(), 1);
});

test('a pty seat: a keystroke during the dictation freezes the row, later drafts and the send write nothing', () => {
  const f = ptyFixture('enter');
  f.sink.draft('Okay.');
  f.sink.userTyped();
  f.sink.userTyped();
  f.sink.draft('Okay. So there');
  f.sink.draft('Okay. So there. Enter.');
  f.sink.released();
  f.flush();
  assert.deepStrictEqual(f.writes, ['Okay.']);
  assert.equal(f.origins(), 0);
  assert.equal(f.traces.filter((l) => l === 'pty row frozen by keystroke').length, 1);
  f.sink.resetSpan();
  f.sink.draft('again');
  assert.deepStrictEqual(f.writes, ['Okay.', 'again']);
});

test('a pty seat: a non-BMP character in a correction is one backspace', () => {
  const f = ptyFixture();
  f.sink.draft('go \u{1F600}');
  f.sink.draft('go \u{1F44D}');
  assert.deepStrictEqual(f.writes, ['go \u{1F600}', '\x7f\u{1F44D}']);
});

test('a pty seat: an empty dictation writes nothing', () => {
  const f = ptyFixture();
  f.sink.released();
  assert.deepEqual(f.writes, []);
});

test('a pty seat: a dictation of only the trigger word erases it and sends nothing', () => {
  const f = ptyFixture();
  f.sink.draft('over and out');
  f.sink.released();
  assert.deepStrictEqual(f.writes, ['over and out', '\x7f'.repeat(12)]);
  assert.equal(f.origins(), 0);
});

test('a pty seat: a release before the quiet window strips the trigger phrase from the row before Enter', () => {
  const f = ptyFixture();
  f.mirror.arm();
  f.t.paint([`${HEAD}ship it over and out`]);
  f.mirror.release();
  f.t.paint([`${HEAD}`]);
  assert.deepStrictEqual(f.writes, ['ship it over and out', '\x7f'.repeat(13), '\r']);
});

test('a pty seat: a keystroke after the stop but before the release still freezes the row', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('ptyVoice.userTyped()'));
  assert.ok(line);
  assert.match(line, /voiceRecordingSeat === name \|\| \(voiceArmedSeat === name && voiceEngineView && voiceEngineView\.mirror\.isArmed\(\)\)/);
  assert.match(line, /isHumanPtyInput\(data\)/);
});
