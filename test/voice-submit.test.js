'use strict';

// voice-submit.test.js — the hands-free submit matcher (renderer/lib/voice-submit.js)
// and the watcher over it (renderer/voice-submit-watcher.js), t566.
//
// No jsdom and none is needed: neither module touches `document`. The watcher's
// whole environment is the fake terminal below, and the four functions it is
// handed. What that leaves untested is the Preferences markup and the
// createTerminal wiring, both DOM-bound, per the R1 rule.
//
// THE INTERLOCK IS THE POINT. This feature writes Enter into a live session, and
// the one state where that is destructive is a permission dialog, where Enter
// ANSWERS it. Those tests assert on what reached the pty, not on a return value:
// a guard can be deleted and leave every predicate still returning the right
// thing while the write happens anyway.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_SUBMIT_PHRASE, normalizePhrase, composerTail, matchTrigger,
  shouldFire, readVoiceSubmitSettings,
} = require('../renderer/lib/voice-submit');
const { createVoiceSubmitWatcher } = require('../renderer/voice-submit-watcher');

const ENTER_SETTLE_MS = 30; // must match voice-submit-watcher.js

// ---------------------------------------------------------------- normalization

test('the phrase is matched case-insensitively and through dictation punctuation', () => {
  // Each row carries its erase count and its survivor as LITERALS: computing
  // either with the code's own rule (length - index) would assert only that the
  // code agrees with itself, and could not express the trailing-space rows,
  // which are the ones that differ.
  //
  // The erase spans the phrase, any punctuation dictation added, the whitespace
  // after it, AND the space before it — so what survives has no dangling space.
  const cases = [
    ['finish the report over and out', 13, 'finish the report'],
    ['finish the report Over and out', 13, 'finish the report'],
    ['finish the report OVER AND OUT', 13, 'finish the report'],
    ['finish the report over and out.', 14, 'finish the report'],
    ['finish the report over and out!!', 15, 'finish the report'],
    ['finish the report over and out. ', 15, 'finish the report'],
    ['finish the report Over and out?  ', 16, 'finish the report'],
    ['over and out', 12, ''],
  ];
  for (const [content, erase, survives] of cases) {
    const hit = matchTrigger(content, DEFAULT_SUBMIT_PHRASE);
    assert.ok(hit, `no match: ${JSON.stringify(content)}`);
    assert.strictEqual(hit.erase, erase, `erase for ${JSON.stringify(content)}`);
    assert.strictEqual(content.slice(0, content.length - hit.erase), survives,
      `survivor for ${JSON.stringify(content)}`);
  }
});

test('a configured phrase carrying case and punctuation still matches plain speech', () => {
  const hit = matchTrigger('all done, Roger That.', 'Roger, that!');
  assert.ok(hit);
  assert.strictEqual(hit.erase, 12);
});

test('the phrase matches on word boundaries, never as a substring', () => {
  // Each of these CONTAINS the phrase's characters; none is the operator saying
  // it. A bare indexOf/endsWith accepts the first two.
  for (const content of [
    'the handover and out',        // no left boundary
    'over and outside',            // no right boundary
    'over and out is the phrase',  // not at the end
    'and out',                     // partial
    'over out and',                // wrong order
  ]) {
    assert.strictEqual(matchTrigger(content, DEFAULT_SUBMIT_PHRASE), null, content);
  }
  // …and the boundary is whitespace, not "any non-letter": a phrase glued to the
  // previous word by punctuation is still the operator ending an utterance.
  assert.ok(matchTrigger('done -- over and out', DEFAULT_SUBMIT_PHRASE));
});

test('an empty or punctuation-only phrase yields no matcher at all', () => {
  // The failure this pins: '' compiled into the regex matches the end of EVERY
  // composer, so a blanked phrase would submit on every quiet window.
  for (const phrase of ['', '   ', '...', null, undefined, 42]) {
    assert.strictEqual(normalizePhrase(phrase), '', `normalize ${JSON.stringify(phrase)}`);
    assert.strictEqual(matchTrigger('anything at all', phrase), null, `match ${JSON.stringify(phrase)}`);
  }
});

test('settings resolve strictly, and a blank phrase falls back to the default', () => {
  assert.deepStrictEqual(readVoiceSubmitSettings({ voiceSubmit: true, voiceSubmitPhrase: 'Wrap It Up.' }),
    { enabled: true, phrase: 'wrap it up' });
  // undefined is what an omission from the settings:get whitelist arrives as,
  // and it must read as OFF rather than as truthy-by-absence.
  assert.deepStrictEqual(readVoiceSubmitSettings({}),
    { enabled: false, phrase: DEFAULT_SUBMIT_PHRASE });
  assert.deepStrictEqual(readVoiceSubmitSettings({ voiceSubmit: 'yes', voiceSubmitPhrase: '  ' }),
    { enabled: false, phrase: DEFAULT_SUBMIT_PHRASE });
  assert.deepStrictEqual(readVoiceSubmitSettings(null),
    { enabled: false, phrase: DEFAULT_SUBMIT_PHRASE });
});

test('the composer is identified by its prompt, and other rows are not composers', () => {
  assert.strictEqual(composerTail('> finish the report over and out'), 'finish the report over and out');
  assert.strictEqual(composerTail('│ > over and out'), 'over and out');
  // Transcript text is not a composer no matter what it ends with — this is what
  // keeps the agent's own output from submitting on the operator's behalf.
  assert.strictEqual(composerTail('  I will say over and out'), null);
  assert.strictEqual(composerTail('>no space after the prompt'), null);
  assert.strictEqual(composerTail(''), null);
  assert.strictEqual(composerTail(null), null);
});

// ------------------------------------------------------------- activation gate

test('the gate needs the setting AND tap mode, and hold is excluded', () => {
  const ON = { enabled: true, voiceMode: 'tap', attention: null };
  assert.strictEqual(shouldFire(ON), true);

  // Each row flips exactly ONE field of the firing case, so a row that fails
  // names the condition that stopped it rather than an unrelated one.
  const blocked = [
    ['setting off', { ...ON, enabled: false }],
    ['setting absent', { ...ON, enabled: undefined }],
    ['setting truthy but not true', { ...ON, enabled: 'yes' }],
    // The CLI's own autoSubmit sends on release here; a second Enter would
    // submit whatever came after.
    ['hold mode', { ...ON, voiceMode: 'hold' }],
    ['voice off', { ...ON, voiceMode: 'off' }],
    ['mode unreadable', { ...ON, voiceMode: null }],
    ['permission dialog', { ...ON, attention: 'permission' }],
  ];
  for (const [label, arg] of blocked) {
    assert.strictEqual(shouldFire(arg), false, label);
  }
  assert.strictEqual(shouldFire(), false);

  // The other two attention kinds are NOT dialogs and must not block: gating on
  // "any attention" would make the feature dead for a badged session.
  for (const attention of ['idle', 'other']) {
    assert.strictEqual(shouldFire({ ...ON, attention }), true, attention);
  }
});

// ------------------------------------------------------------------ the watcher

// A fake xterm buffer holding ONE cursor row. `type` is the normal/alternate
// distinction; `translateToString(_, 0, cursorX)` is the truncate-at-cursor read
// the watcher makes, and this stub honours the cursorX argument rather than
// ignoring it — a stub that returned the whole row would hide a watcher that
// forgot to truncate.
function fakeTerminal({ row = '', type = 'normal' } = {}) {
  const listeners = [];
  const state = { row, type };
  return {
    _state: state,
    buffer: {
      get active() {
        return {
          type: state.type,
          baseY: 0,
          cursorY: 0,
          get cursorX() { return state.row.length; },
          getLine: (y) => (y === 0 ? {
            translateToString: (_trim, start, end) => state.row.slice(start ?? 0, end ?? state.row.length),
          } : null),
        };
      },
    },
    onWriteParsed(fn) { listeners.push(fn); return { dispose() {} }; },
    // Set the composer and fire the write event, as a real terminal would.
    write(text) { state.row = text; for (const fn of listeners) fn(); },
  };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// The quiet window and the enter-settle gap are real setTimeouts and the tests
// wait out real time rather than faking a clock — which is only affordable
// because the watcher takes `quietMs` as a seam. `env` is mutable so a test can
// change the world DURING a window, which is what the fire-time re-check tests
// need. `done()` waits out both stages of a fire.
const TEST_QUIET_MS = 5;
function fastHarness({
  row = '', type = 'normal',
  config = { enabled: true, phrase: DEFAULT_SUBMIT_PHRASE },
  voiceMode = 'tap', attention = null,
} = {}) {
  const writes = [];
  const term = fakeTerminal({ row, type });
  const env = { config, voiceMode, attention };
  const watcher = createVoiceSubmitWatcher(term, {
    getConfig: () => env.config,
    getVoiceMode: () => env.voiceMode,
    getAttention: () => env.attention,
    write: (d) => writes.push(d),
    quietMs: TEST_QUIET_MS,
  });
  return { term, watcher, writes, env, done: () => settle(TEST_QUIET_MS + ENTER_SETTLE_MS + 25) };
}

test('a matching composer submits after the quiet window: backspaces then Enter', async () => {
  const h = fastHarness();
  h.term.write('> finish the report over and out');
  await h.done();
  // Two writes, in this order. One chunk carrying both would be read as a paste
  // and leave the \r in the buffer as a literal.
  assert.strictEqual(h.writes.length, 2, `writes: ${JSON.stringify(h.writes)}`);
  assert.strictEqual(h.writes[0], '\x7f'.repeat(13));
  assert.strictEqual(h.writes[1], '\r');
  assert.strictEqual(h.watcher.fireCount(), 1);
  h.watcher.dispose();
});

test('NOTHING is written while the session shows a permission dialog', async () => {
  const h = fastHarness({ attention: 'permission' });
  h.term.write('> approve it over and out');
  await h.done();
  // Not "no Enter" — no bytes AT ALL. A backspace burst into an open dialog is
  // its own damage, and asserting only on the '\r' would pass with the erase
  // still going out.
  assert.deepStrictEqual(h.writes, []);
  assert.strictEqual(h.watcher.fireCount(), 0);
  h.watcher.dispose();
});

test('the interlock is checked at FIRE time, not when the phrase arrives', async () => {
  // The dialog opens DURING the quiet window — the exact race the re-check
  // exists for. A gate evaluated when the match was seen would fire into it.
  const h = fastHarness();
  h.term.write('> approve it over and out');
  h.env.attention = 'permission';
  await h.done();
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('a phrase spoken during a dialog does not fire once the dialog clears', async () => {
  const h = fastHarness({ attention: 'permission' });
  h.term.write('> approve it over and out');
  await h.done();
  assert.deepStrictEqual(h.writes, []);

  // The dialog clears and the terminal repaints, with the composer unchanged.
  // By now the speech is stale and the dialog has moved the session on; a queued
  // fire would submit it into whatever is there instead.
  h.env.attention = null;
  h.term.write('> approve it over and out');
  await h.done();
  assert.deepStrictEqual(h.writes, [], 'a blocked match must not re-fire after the block lifts');
  h.watcher.dispose();
});

test('the interlock holds when the attention read THROWS', async () => {
  // An unreachable sidebar row must DECLINE, not sail past the guard on the
  // undefined a swallowed throw would leave behind.
  const writes = [];
  const term = fakeTerminal();
  const watcher = createVoiceSubmitWatcher(term, {
    getConfig: () => ({ enabled: true, phrase: DEFAULT_SUBMIT_PHRASE }),
    getVoiceMode: () => 'tap',
    getAttention: () => { throw new Error('row gone'); },
    write: (d) => writes.push(d),
    quietMs: TEST_QUIET_MS,
  });
  term.write('> approve it over and out');
  await settle(TEST_QUIET_MS + ENTER_SETTLE_MS + 25);
  assert.deepStrictEqual(writes, []);
  watcher.dispose();
});

test('hold mode and a disabled setting write nothing', async () => {
  for (const [label, patch] of [
    ['hold', { voiceMode: 'hold' }],
    ['voice off', { voiceMode: 'off' }],
    ['feature off', { config: null }],
  ]) {
    const h = fastHarness(patch);
    h.term.write('> finish the report over and out');
    await h.done();
    assert.deepStrictEqual(h.writes, [], label);
    h.watcher.dispose();
  }
});

test('one fire per match, re-armed only by a non-matching composer', async () => {
  const h = fastHarness();
  h.term.write('> finish the report over and out');
  await h.done();
  assert.strictEqual(h.watcher.fireCount(), 1);

  // A repaint of the same composer — the CLI redraws its live tail constantly.
  h.term.write('> finish the report over and out');
  await h.done();
  assert.strictEqual(h.watcher.fireCount(), 1, 'a repaint must not re-submit');

  // Composer clears (the submit landed), then a fresh utterance.
  h.term.write('> ');
  await h.done();
  h.term.write('> and another thing over and out');
  await h.done();
  assert.strictEqual(h.watcher.fireCount(), 2);
  h.watcher.dispose();
});

test('a full-screen program on the alternate buffer never matches', async () => {
  const h = fastHarness({ type: 'alternate' });
  h.term.write('> finish the report over and out');
  await h.done();
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('the quiet window restarts on every write, so a mid-utterance match waits', async () => {
  const h = fastHarness();
  // Streamed transcription: the phrase lands, then MORE speech arrives before
  // the window expires. Firing on the first segment would submit half of it.
  h.term.write('> over and out');
  h.term.write('> over and out of the office tomorrow');
  await h.done();
  assert.deepStrictEqual(h.writes, [], 'the utterance kept going — nothing should have been sent');
  h.watcher.dispose();
});

test('dispose stops a fire already in flight', async () => {
  const h = fastHarness();
  h.term.write('> finish the report over and out');
  await settle(12);            // past the quiet window, inside the enter gap
  h.watcher.dispose();
  await settle(ENTER_SETTLE_MS + 25);
  // The erase may already have gone out; the Enter must not follow a disposed
  // terminal, where it would land in whatever session took its place.
  assert.ok(!h.writes.includes('\r'), `writes: ${JSON.stringify(h.writes)}`);
});
