'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createVoiceMirror, draftFromRows } = require('../renderer/voice-mirror');
const { applyDraft, attachTriggerSubmit } = require('../renderer/lib/composer-voice');

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
