'use strict';

// voice-submit.test.js — the hands-free submit matcher (renderer/lib/voice-submit.js)
// and the watcher over it (renderer/voice-submit-watcher.js).
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
  DEFAULT_SUBMIT_PHRASE, normalizePhrase, findSubmit, matchTrigger,
  foldConfusables, shouldFire, readVoiceSubmitSettings,
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

test('typographic quotes and dashes fold, so a dictated phrase meets a typed one', () => {
  // The shipped defect: the operator typed `that's it` with U+0027, dictation
  // emitted U+2019, EDGE_PUNCT strips only at word EDGES, and the apostrophe
  // INSIDE the word went into the regex as a literal. Hands-free submit could
  // never fire on that phrase.
  //
  // Both directions, because the field takes whatever is pasted into it. Each
  // row's erase is a LITERAL: the fold must not move the count, or the erase
  // strands the phrase's head or eats the words before it. The survivor is what
  // proves that — it is checked against the RAW content, which is what the
  // backspaces actually run over.
  const cases = [
    ['Testing. Testing. That\u2019s it.', "that's it", 11, 'Testing. Testing.'],
    ["Testing. Testing. That's it.", 'that\u2019s it', 11, 'Testing. Testing.'],
    ["Testing. Testing. That's it.", "that's it", 11, 'Testing. Testing.'],
    ['Testing. Testing. That\u2019s it.', 'that\u2019s it', 11, 'Testing. Testing.'],
    ['all set that\u2018s it', "that's it", 10, 'all set'],
    ['all set that\u02bcs it', "that's it", 10, 'all set'],
    ['draft done sign\u2013off now', 'sign-off now', 13, 'draft done'],
    ['draft done sign\u2014off now', 'sign-off now', 13, 'draft done'],
    ['draft done sign-off now', 'sign\u2014off now', 13, 'draft done'],
  ];
  for (const [content, phrase, erase, survives] of cases) {
    const hit = matchTrigger(content, phrase);
    assert.ok(hit, `no match: ${JSON.stringify(content)} / ${JSON.stringify(phrase)}`);
    assert.strictEqual(hit.erase, erase, `erase for ${JSON.stringify(content)}`);
    assert.strictEqual(content.slice(0, content.length - hit.erase), survives,
      `survivor for ${JSON.stringify(content)}`);
  }
});

test('every fold is one character for one, which is what keeps the erase honest', () => {
  // matchTrigger counts its erase against the RAW content but finds its index in
  // the FOLDED one. A substitution of any other length would shift every index
  // after it, so this is the invariant the erase counts above rest on — and it
  // is invisible from those rows, which would all still pass with a fold that
  // happened to be length-preserving only for the cases they happen to use.
  for (const ch of ['\u2019', '\u2018', '\u02bc', '\u2014', '\u2013']) {
    assert.strictEqual(foldConfusables(ch).length, 1, `fold width of ${JSON.stringify(ch)}`);
  }
  assert.strictEqual(foldConfusables('a\u2019b\u2014c').length, 'a\u2019b\u2014c'.length);
  // Left alone: folding these would change which phrases match, which is the
  // thing a broad normalization pass does that nobody asked for.
  assert.strictEqual(foldConfusables('caf\u00e9 \u201cquoted\u201d \u2026'), 'caf\u00e9 \u201cquoted\u201d \u2026');
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

// findSubmit now takes ONE string: the cursor row, already truncated at the
// cursor. The composer walk, the border model and the prompt check are gone —
// the match is anchored at the end of the row, so nothing has to LOCATE the
// draft first. The `\u2502 > ...` fixtures that used to live here pinned an
// invented screen shape no CLI emits, and are deleted rather than ported.

test('the live-captured composer row matches end to end', () => {
  // Copied from the watcher's own capture on 2026-08-30 (CLI 2.1.251): U+276F,
  // one space, no border. The erase must cover " over and out." and leave the
  // ornament and the draft's real words untouched — that survivor assertion is
  // what proves the backspaces cannot reach into the prompt the CLI drew.
  const row = '\u276f I enable debug over and out.';
  const hit = findSubmit(row, DEFAULT_SUBMIT_PHRASE);
  assert.ok(hit);
  assert.strictEqual(hit.erase, 14);
  assert.strictEqual(row.slice(0, row.length - hit.erase), '\u276f I enable debug');
});

test('the tail match does not depend on a prompt being there at all', () => {
  // The prompt character is no longer load-bearing, so all three of these are
  // the same match. If a future CLI changes the ornament again, none of this
  // moves — which is the whole reason the walk was deleted.
  const cases = [
    ['\u276f I enable debug over and out.', 14, '\u276f I enable debug'],
    ['> I enable debug over and out.', 14, '> I enable debug'],
    ['I enable debug over and out.', 14, 'I enable debug'],
  ];
  for (const [row, erase, survives] of cases) {
    const hit = findSubmit(row, DEFAULT_SUBMIT_PHRASE);
    assert.ok(hit, `no match: ${JSON.stringify(row)}`);
    assert.strictEqual(hit.erase, erase, `erase for ${JSON.stringify(row)}`);
    assert.strictEqual(row.slice(0, row.length - hit.erase), survives,
      `survivor for ${JSON.stringify(row)}`);
  }
});

test('a row with no match reports zero erase rather than declining', () => {
  // Distinct from null: the watcher RE-ARMS on this, and folding it into the
  // "cannot read this" answer would leave the latch stuck after every fire.
  assert.deepStrictEqual(findSubmit('\u276f still typing', DEFAULT_SUBMIT_PHRASE),
    { content: '\u276f still typing', erase: 0 });
  assert.deepStrictEqual(findSubmit('', DEFAULT_SUBMIT_PHRASE), { content: '', erase: 0 });
});

test('an unreadable row is null, which is the same answer as do-not-fire', () => {
  for (const bad of [null, undefined, 42, {}, ['\u276f over and out']]) {
    assert.strictEqual(findSubmit(bad, DEFAULT_SUBMIT_PHRASE), null, JSON.stringify(bad));
  }
});

// ------------------------------------------------------------- activation gate

test('the gate needs the setting, and the permission dialog is the only block', () => {
  const ON = { enabled: true, attention: null };
  assert.strictEqual(shouldFire(ON), true);

  // Each row flips exactly ONE field of the firing case, so a row that fails
  // names the condition that stopped it rather than an unrelated one.
  const blocked = [
    ['setting off', { ...ON, enabled: false }],
    ['setting absent', { ...ON, enabled: undefined }],
    ['setting truthy but not true', { ...ON, enabled: 'yes' }],
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

test('the gate is INDEPENDENT of the CLI voice mode, in every value it takes', () => {
  // The mode used to gate this, and the gate refused the case the feature is
  // most wanted in: macOS on-device dictation types into the composer while the
  // CLI's own mode reads `off`, and Codex has no `/voice` at all. Passing the
  // key must change nothing — including 'hold', where the CLI's autoSubmit
  // covers release-to-send but the phrase is still the operator's own intent.
  for (const voiceMode of ['off', 'hold', 'tap', null, undefined]) {
    assert.strictEqual(shouldFire({ enabled: true, attention: null, voiceMode }), true,
      `fires with voiceMode ${String(voiceMode)}`);
    assert.strictEqual(shouldFire({ enabled: true, attention: 'permission', voiceMode }), false,
      `interlock holds with voiceMode ${String(voiceMode)}`);
  }
});

// ------------------------------------------------------------------ the watcher

// A fake xterm buffer holding N screen rows, cursor on the LAST one. It keeps
// its multi-row shape although the watcher now reads only the cursor row: that
// is what lets a test place rows ABOVE the cursor and assert they are not read.
// `translateToString(_, 0, cursorX)` is the truncate-at-cursor read the watcher
// makes, and this stub honours the cursorX argument rather than ignoring it — a
// stub returning the whole row would hide a watcher that forgot to truncate.
function fakeTerminal({ rows = [''], type = 'normal' } = {}) {
  const listeners = [];
  const state = { rows: [...rows], type };
  const last = () => state.rows[state.rows.length - 1];
  return {
    _state: state,
    buffer: {
      get active() {
        return {
          type: state.type,
          baseY: 0,
          get cursorY() { return state.rows.length - 1; },
          // `cursorX` on a row puts the cursor MID-row, so a test can place text
          // to its right — the only shape that can catch a read that forgets to
          // truncate at the cursor.
          get cursorX() {
            const r = last();
            return typeof r.cursorX === 'number' ? r.cursorX : r.text.length;
          },
          getLine: (y) => {
            const r = state.rows[y];
            if (!r) return null;
            return {
              isWrapped: !!r.isWrapped,
              translateToString: (_trim, start, end) =>
                r.text.slice(start ?? 0, end ?? r.text.length),
            };
          },
        };
      },
    },
    onWriteParsed(fn) { listeners.push(fn); return { dispose() {} }; },
    // Repaint the composer and fire the write event, as a real terminal would.
    // Strings are the common one-row case; objects carry `isWrapped`.
    write(...next) {
      state.rows = next.flat().map((r) => (typeof r === 'string' ? { text: r } : r));
      for (const fn of listeners) fn();
    },
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
  rows = [''], type = 'normal',
  config = { enabled: true, phrase: DEFAULT_SUBMIT_PHRASE },
  attention = null,
} = {}) {
  const writes = [];
  const term = fakeTerminal({ rows: rows.map((r) => (typeof r === 'string' ? { text: r } : r)), type });
  const env = { config, attention };
  const watcher = createVoiceSubmitWatcher(term, {
    getConfig: () => env.config,
    getAttention: () => env.attention,
    write: (d) => writes.push(d),
    quietMs: TEST_QUIET_MS,
  });
  return { term, watcher, writes, env, done: () => settle(TEST_QUIET_MS + ENTER_SETTLE_MS + 25) };
}

test('a matching composer submits after the quiet window: backspaces then Enter', async () => {
  const h = fastHarness();
  h.term.write('❯ finish the report over and out');
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
  h.term.write('❯ approve it over and out');
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
  h.term.write('❯ approve it over and out');
  h.env.attention = 'permission';
  await h.done();
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('a phrase spoken during a dialog does not fire once the dialog clears', async () => {
  const h = fastHarness({ attention: 'permission' });
  h.term.write('❯ approve it over and out');
  await h.done();
  assert.deepStrictEqual(h.writes, []);

  // The dialog clears and the terminal repaints, with the composer unchanged.
  // By now the speech is stale and the dialog has moved the session on; a queued
  // fire would submit it into whatever is there instead.
  h.env.attention = null;
  h.term.write('❯ approve it over and out');
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
    getAttention: () => { throw new Error('row gone'); },
    write: (d) => writes.push(d),
    quietMs: TEST_QUIET_MS,
  });
  term.write('❯ approve it over and out');
  await settle(TEST_QUIET_MS + ENTER_SETTLE_MS + 25);
  assert.deepStrictEqual(writes, []);
  watcher.dispose();
});

test('a disabled setting writes nothing, whether it is off or absent', async () => {
  for (const [label, patch] of [
    ['feature off', { config: null }],
    ['enabled false', { config: { enabled: false, phrase: DEFAULT_SUBMIT_PHRASE } }],
    ['enabled absent', { config: { phrase: DEFAULT_SUBMIT_PHRASE } }],
  ]) {
    const h = fastHarness(patch);
    h.term.write('❯ finish the report over and out');
    await h.done();
    assert.deepStrictEqual(h.writes, [], label);
    h.watcher.dispose();
  }
});

test('the watcher submits for a draft the operator TYPED, with no voice mode anywhere', async () => {
  // The watcher is handed no mode reader at all — the plumbing is gone, not
  // merely defaulted — so this is the macOS-dictation and the typed case both:
  // the phrase reached the composer without the CLI's voice mode involved.
  const h = fastHarness();
  h.term.write('❯ finish the report over and out');
  await h.done();
  assert.strictEqual(h.writes.length, 2, `writes: ${JSON.stringify(h.writes)}`);
  assert.strictEqual(h.writes[0], '\x7f'.repeat(13));
  assert.strictEqual(h.writes[1], '\r');
  h.watcher.dispose();
});

test('one fire per match, re-armed only by a non-matching composer', async () => {
  const h = fastHarness();
  h.term.write('❯ finish the report over and out');
  await h.done();
  assert.strictEqual(h.watcher.fireCount(), 1);

  // A repaint of the same composer — the CLI redraws its live tail constantly.
  h.term.write('❯ finish the report over and out');
  await h.done();
  assert.strictEqual(h.watcher.fireCount(), 1, 'a repaint must not re-submit');

  // Composer clears (the submit landed), then a fresh utterance.
  h.term.write('❯ ');
  await h.done();
  h.term.write('❯ and another thing over and out');
  await h.done();
  assert.strictEqual(h.watcher.fireCount(), 2);
  h.watcher.dispose();
});

test('the read stops at the CURSOR, not the end of the row', async () => {
  // The operator moved the caret back into the draft and the phrase sits to the
  // RIGHT of it — leftover text from an earlier edit, not what they just said.
  // A read that takes the whole row fires on it and erases text the operator can
  // still see ahead of the caret.
  const h = fastHarness();
  h.term.write({ text: '\u276f finish the report over and out', cursorX: 17 });
  await h.done();
  assert.deepStrictEqual(h.writes, [], 'nothing may be written for text past the cursor');
  assert.strictEqual(h.watcher.fireCount(), 0);
  h.watcher.dispose();
});

test('a WRAPPED draft still fires, because the phrase is on the cursor row', async () => {
  // The case the deleted walk existed for, end to end through the real buffer
  // read. It needs no walk: the utterance ends with the phrase, so the phrase is
  // on the last visual row, which is the row the cursor is on. The rows above
  // are present precisely to show they are never read.
  const h = fastHarness();
  h.term.write(
    { text: '\u276f a long dictated thought that filled the whole row' },
    { text: 'and it kept going over and out', isWrapped: true },
  );
  await h.done();
  assert.strictEqual(h.writes.length, 2, `writes: ${JSON.stringify(h.writes)}`);
  assert.strictEqual(h.writes[0], '\x7f'.repeat(13));
  assert.strictEqual(h.writes[1], '\r');
  h.watcher.dispose();
});

test('a SECOND deliberate utterance of the phrase fires again', async () => {
  // A latch that were a bare boolean would make this dead: the composer still
  // ends with the phrase, so the latch would still hold for the rest of the
  // draft. Keyed on the content, a CHANGED draft re-arms.
  const h = fastHarness();
  h.term.write('❯ first thought over and out');
  await h.done();
  assert.strictEqual(h.watcher.fireCount(), 1);

  // The submit did not land (busy agent, say), the operator says it again, and
  // the phrase is appended to a draft that already ends with it.
  h.term.write('❯ first thought over and out over and out');
  await h.done();
  assert.strictEqual(h.watcher.fireCount(), 2, 'a repeated phrase must fire again');
  h.watcher.dispose();
});

test('a repaint of an already-answered composer still does not re-fire', async () => {
  // The other half of the content latch: re-arming on CHANGE must not re-arm on
  // an identical repaint, or the stale-speech case the latch exists for revives.
  const h = fastHarness({ attention: 'permission' });
  h.term.write('❯ approve it over and out');
  await h.done();
  assert.deepStrictEqual(h.writes, []);

  h.env.attention = null;
  for (let i = 0; i < 3; i += 1) {
    h.term.write('❯ approve it over and out');   // byte-identical repaints
    await h.done();
  }
  assert.deepStrictEqual(h.writes, [], 'an unchanged draft must stay answered');
  h.watcher.dispose();
});

test('a full-screen program on the alternate buffer never matches', async () => {
  const h = fastHarness({ type: 'alternate' });
  h.term.write('❯ finish the report over and out');
  await h.done();
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('the quiet window restarts on every write, so a mid-utterance match waits', async () => {
  const h = fastHarness();
  // Streamed transcription: the phrase lands, then MORE speech arrives before
  // the window expires. Firing on the first segment would submit half of it.
  h.term.write('❯ over and out');
  h.term.write('❯ over and out of the office tomorrow');
  await h.done();
  assert.deepStrictEqual(h.writes, [], 'the utterance kept going — nothing should have been sent');
  h.watcher.dispose();
});

test('dispose stops a fire already in flight', async () => {
  const h = fastHarness();
  h.term.write('❯ finish the report over and out');
  await settle(12);            // past the quiet window, inside the enter gap
  h.watcher.dispose();
  await settle(ENTER_SETTLE_MS + 25);
  // The erase may already have gone out; the Enter must not follow a disposed
  // terminal, where it would land in whatever session took its place.
  assert.ok(!h.writes.includes('\r'), `writes: ${JSON.stringify(h.writes)}`);
});
