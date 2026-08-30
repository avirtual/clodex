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

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_SUBMIT_PHRASE, normalizePhrase, findSubmit, matchTrigger,
  foldConfusables, shouldFire, readVoiceSubmitSettings,
} = require('../renderer/lib/voice-submit');
const {
  createVoiceSubmitWatcher, readComposition, commitComposition,
} = require('../renderer/voice-submit-watcher');

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
    { enabled: true, composition: false, phrase: 'wrap it up' });
  // undefined is what an omission from the settings:get whitelist arrives as,
  // and it must read as OFF rather than as truthy-by-absence.
  assert.deepStrictEqual(readVoiceSubmitSettings({}),
    { enabled: false, composition: false, phrase: DEFAULT_SUBMIT_PHRASE });
  assert.deepStrictEqual(readVoiceSubmitSettings({ voiceSubmit: 'yes', voiceSubmitPhrase: '  ' }),
    { enabled: false, composition: false, phrase: DEFAULT_SUBMIT_PHRASE });
  assert.deepStrictEqual(readVoiceSubmitSettings(null),
    { enabled: false, composition: false, phrase: DEFAULT_SUBMIT_PHRASE });
});

test('the composition read is ANDed with the master switch, never standing alone', () => {
  // The riskier half must not be reachable with the feature itself off — a
  // stale `voiceSubmitComposition: true` in a settings file predates the
  // operator unticking the box above it, and a bare `=== true` read would arm
  // the poll over a feature he believes is disarmed.
  const cases = [
    [{ voiceSubmit: true, voiceSubmitComposition: true }, true, true],
    [{ voiceSubmit: true, voiceSubmitComposition: false }, true, false],
    [{ voiceSubmit: true }, true, false],
    [{ voiceSubmit: false, voiceSubmitComposition: true }, false, false],
    [{ voiceSubmitComposition: true }, false, false],
    [{ voiceSubmit: true, voiceSubmitComposition: 'yes' }, true, false],
  ];
  for (const [raw, enabled, composition] of cases) {
    assert.deepStrictEqual(readVoiceSubmitSettings(raw),
      { enabled, composition, phrase: DEFAULT_SUBMIT_PHRASE }, JSON.stringify(raw));
  }
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
// Every watcher built below, disposed after each test WHETHER OR NOT it passed.
// EVERY watcher holds the composition poll's setInterval, buffer-half ones
// included, so this has to sit above BOTH harnesses: an assertion that fails
// jumps over the dispose() at the end of its test, and the surviving interval
// hangs the whole suite on a timeout instead of naming the failure. Covering
// only the composition harness leaves every buffer-half failure unreportable.
// Belt to the per-test dispose calls, not a replacement for them.
const live = [];
function track(watcher) { live.push(watcher); return watcher; }
afterEach(() => { while (live.length) live.pop().dispose(); });

const TEST_QUIET_MS = 5;
function fastHarness({
  rows = [''], type = 'normal',
  config = { enabled: true, phrase: DEFAULT_SUBMIT_PHRASE },
  attention = null,
} = {}) {
  const writes = [];
  const term = fakeTerminal({ rows: rows.map((r) => (typeof r === 'string' ? { text: r } : r)), type });
  const env = { config, attention };
  const watcher = track(createVoiceSubmitWatcher(term, {
    getConfig: () => env.config,
    getAttention: () => env.attention,
    write: (d) => writes.push(d),
    quietMs: TEST_QUIET_MS,
  }));
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

// ------------------------------------------------------- the composition half
//
// The state these cover: the operator has dictated, macOS is holding the words
// UNCOMMITTED, and the terminal buffer is EMPTY. Captured live — the overlay and
// the helper textarea both carried the phrase for seconds while the buffer rows
// stayed empty.
//
// So the fixture drives the watcher through the same two seams the DOM does:
// text appears in the composition reader while NOTHING is written to the
// terminal. Do not "simplify" one of these by writing the phrase into the buffer
// instead — that models a state the real DOM never produces, and every
// assertion downstream of it would pass over a feature that cannot work.

// A harness whose composition reader is a plain mutable string. `commits`
// records what the commit boundary was asked to do; `echo` is what the real
// commit causes — the composed text reaching the pty as an ordinary write —
// and it is deliberately NOT automatic, so a test says when it happens.
function compositionHarness({
  config = { enabled: true, composition: true, phrase: DEFAULT_SUBMIT_PHRASE },
  attention = null, composed = null, commitTakes = true, now, type = 'normal',
} = {}) {
  const writes = [];
  const commits = [];
  const term = fakeTerminal({ type });
  const env = { config, attention, composed };
  const watcher = track(createVoiceSubmitWatcher(term, {
    getConfig: () => env.config,
    getAttention: () => env.attention,
    write: (d) => writes.push(d),
    quietMs: TEST_QUIET_MS,
    pollMs: 1,
    readComposition: () => env.composed,
    commitComposition: () => { commits.push(env.composed); return commitTakes; },
    ...(now ? { now } : {}),
  }));
  return {
    term, watcher, writes, commits, env,
    // Long enough for the composed text to go stale AND be polled over.
    settled: () => settle(TEST_QUIET_MS + 30),
    done: () => settle(TEST_QUIET_MS + ENTER_SETTLE_MS + 25),
  };
}

test('a composition ending in the phrase is COMMITTED, and nothing else is sent', async () => {
  const h = compositionHarness({ composed: ' finish the report over and out' });
  await h.settled();
  assert.deepStrictEqual(h.commits, [' finish the report over and out']);
  // This half commits and stops. The erase and the Enter belong to the buffer
  // half, which runs after the commit echoes — sending them here too would
  // submit the draft twice and backspace over a composer that is not there yet.
  assert.deepStrictEqual(h.writes, [], `writes: ${JSON.stringify(h.writes)}`);
  assert.strictEqual(h.watcher.commitCount(), 1);
  assert.strictEqual(h.watcher.fireCount(), 0);
  h.watcher.dispose();
});

test('the two halves compose: the commit echoes as a write, and THAT submits', async () => {
  // The point of the design, asserted end to end. The composition half turns an
  // invisible composition into an ordinary write; the shipped buffer path takes
  // it from there, unchanged and through all its own gates.
  const h = compositionHarness({ composed: ' finish the report over and out' });
  await h.settled();
  assert.strictEqual(h.commits.length, 1, 'the composition should have committed');
  assert.deepStrictEqual(h.writes, [], 'nothing may be sent before the echo');

  // What the commit causes: the text reaches the pty and the CLI repaints its
  // composer with it. The composition is over, so the reader goes quiet.
  h.env.composed = null;
  h.term.write('❯ finish the report over and out');
  await h.done();
  assert.deepStrictEqual(h.writes, ['\x7f'.repeat(13), '\r']);
  assert.strictEqual(h.watcher.fireCount(), 1);
  h.watcher.dispose();
});

test('a composition still being transcribed is NOT committed', async () => {
  // The hazard this feature is built around: acting on words the operator has
  // not finalised. The phrase must be the END of a settled utterance, not a
  // string that happened to pass through mid-stream.
  const h = compositionHarness({ composed: ' over and out' });
  await settle(3);
  h.env.composed = ' over and out of the office tomorrow';
  await h.settled();
  assert.deepStrictEqual(h.commits, [], 'the utterance kept going — nothing should have committed');
  h.watcher.dispose();
});

test('NOTHING is committed while the session shows a permission dialog', async () => {
  const h = compositionHarness({ attention: 'permission', composed: ' approve it over and out' });
  await h.settled();
  assert.deepStrictEqual(h.commits, []);
  assert.deepStrictEqual(h.writes, []);
  assert.strictEqual(h.watcher.commitCount(), 0);
  h.watcher.dispose();
});

test('the composition interlock holds when the attention read THROWS', async () => {
  const writes = [];
  const commits = [];
  const term = fakeTerminal();
  const watcher = track(createVoiceSubmitWatcher(term, {
    getConfig: () => ({ enabled: true, composition: true, phrase: DEFAULT_SUBMIT_PHRASE }),
    getAttention: () => { throw new Error('row gone'); },
    write: (d) => writes.push(d),
    quietMs: TEST_QUIET_MS,
    pollMs: 1,
    readComposition: () => ' approve it over and out',
    commitComposition: () => { commits.push(1); return true; },
  }));
  await settle(TEST_QUIET_MS + 30);
  assert.deepStrictEqual(commits, []);
  assert.deepStrictEqual(writes, []);
  watcher.dispose();
});

test('a composition blocked by a dialog does not commit once the dialog clears', async () => {
  const h = compositionHarness({ attention: 'permission', composed: ' approve it over and out' });
  await h.settled();
  assert.deepStrictEqual(h.commits, []);
  // The dialog clears with the same words still pending. By now the speech is
  // stale and the dialog has moved the session on.
  h.env.attention = null;
  await h.settled();
  assert.deepStrictEqual(h.commits, [], 'a blocked composition must not commit after the block lifts');
  h.watcher.dispose();
});

test('an already-committed composition is not committed twice', async () => {
  // The commit is not instantaneous and the poll keeps running. Without the
  // latch every interval would re-dispatch into the same pending text.
  const h = compositionHarness({ composed: ' finish the report over and out' });
  await h.settled();
  await h.settled();
  assert.strictEqual(h.commits.length, 1, `commits: ${JSON.stringify(h.commits)}`);
  h.watcher.dispose();
});

test('the composition half stays asleep unless ITS setting is on', async () => {
  for (const [label, config] of [
    ['feature off', null],
    ['submit on, composition off', { enabled: true, composition: false, phrase: DEFAULT_SUBMIT_PHRASE }],
    ['composition absent', { enabled: true, phrase: DEFAULT_SUBMIT_PHRASE }],
    ['composition on but submit off', { enabled: false, composition: true, phrase: DEFAULT_SUBMIT_PHRASE }],
  ]) {
    const h = compositionHarness({ config, composed: ' finish the report over and out' });
    await h.settled();
    assert.deepStrictEqual(h.commits, [], label);
    assert.deepStrictEqual(h.writes, [], label);
    h.watcher.dispose();
  }
});

test('a composition that does not end with the phrase is left alone', async () => {
  for (const composed of [
    ' finish the report',
    ' over and out of the office',      // the right-hand boundary
    ' handover and out',                // the left-hand boundary
    '   ',
  ]) {
    const h = compositionHarness({ composed });
    await h.settled();
    assert.deepStrictEqual(h.commits, [], JSON.stringify(composed));
    h.watcher.dispose();
  }
});

test('re-arming over an unchanged composition does not commit words spoken before it', async () => {
  // Turning the setting on while a composition is already sitting there must
  // not submit it: those words predate the arm, exactly as the buffer half's
  // latch handles the same case on its side.
  //
  // The clock is DRIVEN, not slept on: the window is measured with the injected
  // `now`, so holding it still proves the poll declines because too little time
  // has passed rather than because the assertion ran before the next tick — a
  // race a real 2ms sleep against a 1ms poll would decide by luck.
  const clock = { t: 1000 };
  const h = compositionHarness({
    config: { enabled: true, composition: false, phrase: DEFAULT_SUBMIT_PHRASE },
    composed: ' finish the report over and out',
    now: () => clock.t,
  });
  await h.settled();
  assert.deepStrictEqual(h.commits, []);

  h.env.config = { enabled: true, composition: true, phrase: DEFAULT_SUBMIT_PHRASE };
  // Many polls run, but the clock has not advanced past the window, so the text
  // is never old enough to act on however often it is observed.
  await h.settled();
  assert.deepStrictEqual(h.commits, [], 'must not commit until the window has passed SINCE the arm');

  clock.t += TEST_QUIET_MS + 1;
  await h.settled();
  assert.deepStrictEqual(h.commits, [' finish the report over and out']);
  h.watcher.dispose();
});

test('a composition over a full-screen program is never committed', async () => {
  // The alt-screen decline has to be asked on the COMPOSITION path in its own
  // right: that path never reads the buffer, so a check living inside the buffer
  // read declines nothing here. A composition over vim or a pager is not a draft
  // for this feature to submit, whatever words it holds.
  const h = compositionHarness({ type: 'alternate', composed: ' finish the report over and out' });
  await h.settled();
  assert.deepStrictEqual(h.commits, []);
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('leaving the alternate buffer restarts the window, it does not resume it', async () => {
  // The decline FORGETS rather than merely returning, and this is what that
  // buys. Words observed BEFORE a full-screen program starts must not become
  // committable just because the program was up long enough for the window to
  // elapse — the time passed with the composer hidden, not settling.
  //
  // The clock is driven so the elapsed time is the only variable: a bare
  // `return` here leaves pendingAt at its pre-alt-screen value, and the first
  // poll after the program exits sees a stale timestamp already older than the
  // window and commits on the spot.
  const clock = { t: 1000 };
  const h = compositionHarness({
    composed: ' finish the report over and out', now: () => clock.t,
  });
  // Observed on the normal buffer, but not yet old enough to act on.
  await h.settled();
  assert.deepStrictEqual(h.commits, [], 'not settled yet');

  // A full-screen program takes over and stays up past a full window.
  h.term._state.type = 'alternate';
  await h.settled();
  clock.t += TEST_QUIET_MS + 1;
  await h.settled();
  assert.deepStrictEqual(h.commits, [], 'nothing may commit while the program is up');

  // It exits with the same words still pending. They are NOT stale-committable:
  // the window starts again from here.
  h.term._state.type = 'normal';
  await h.settled();
  assert.deepStrictEqual(h.commits, [],
    'the window must restart on return, not resume from before the program');

  // And it does still fire once they have genuinely settled since the return.
  clock.t += TEST_QUIET_MS + 1;
  await h.settled();
  assert.deepStrictEqual(h.commits, [' finish the report over and out']);
  h.watcher.dispose();
});

test('dispose stops the composition poll AND releases its timer', async () => {
  // Two assertions because the first one alone cannot see the bug. The poll
  // callback returns early on `disposed`, so dropping the clearInterval leaves
  // behaviour identical and only leaks the handle — verified by mutation: with
  // the clearInterval removed, the commits check below still passed. A leaked
  // interval per terminal outlives every session the operator closes.
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timers();
  const h = compositionHarness({ composed: ' finish the report over and out' });
  assert.ok(timers() > before, 'the poll should be running while the watcher is live');
  h.watcher.dispose();
  assert.strictEqual(timers(), before, 'dispose must release the poll timer, not just flag it');
  await h.settled();
  assert.deepStrictEqual(h.commits, []);
});

test('a commit that does not take is RECORDED, and not retried', async () => {
  // The report on this ticket claimed a guard here, so the code must have one.
  // A boundary returning false means the composition is still pending: that is
  // counted, and deliberately NOT retried — the latch stands, because retrying
  // would spray a Meta keydown at the terminal on every poll for as long as the
  // words sit there, and the only failure that produces it is xterm no longer
  // finalizing on that key, which a retry cannot fix.
  const h = compositionHarness({
    composed: ' finish the report over and out', commitTakes: false,
  });
  await h.settled();
  assert.strictEqual(h.watcher.commitCount(), 1);
  assert.strictEqual(h.watcher.commitFailureCount(), 1, 'a failed commit must be visible');
  await h.settled();
  assert.strictEqual(h.commits.length, 1, 'must not retry the dispatch');
  assert.deepStrictEqual(h.writes, [], 'and must never fall back to writing Enter itself');
  h.watcher.dispose();
});

test('a commit boundary that THROWS does not take the watcher down', async () => {
  const term = fakeTerminal();
  const watcher = track(createVoiceSubmitWatcher(term, {
    getConfig: () => ({ enabled: true, composition: true, phrase: DEFAULT_SUBMIT_PHRASE }),
    getAttention: () => null,
    write: () => {},
    quietMs: TEST_QUIET_MS,
    pollMs: 1,
    readComposition: () => ' finish the report over and out',
    commitComposition: () => { throw new Error('xterm moved'); },
  }));
  await settle(TEST_QUIET_MS + 30);
  // The throw is swallowed and the poll survives it. An unhandled throw inside
  // a setInterval callback kills nothing visible, which is why this asserts the
  // watcher is still counting rather than that no error escaped.
  assert.strictEqual(watcher.commitCount(), 1);
  assert.strictEqual(watcher.commitFailureCount(), 1, 'a throw is a failed commit, not a silent one');
  watcher.dispose();
});

// ------------------------------------------------- the two swappable boundaries
//
// readComposition and commitComposition are the only two places that touch
// xterm's internals, and both rest on structure xterm could move. They are
// pinned against fakes shaped like the real DOM rather than against a browser:
// what is being asserted is the CONTRACT each promises its caller, which is what
// the half above is written against.

function fakeElement(nodes) {
  return { querySelector: (sel) => nodes[sel] || null };
}

test('readComposition returns the pending text, and null for every not-composing shape', () => {
  const text = ' this is a dictation test over and out';
  assert.strictEqual(
    readComposition({ element: fakeElement({ '.composition-view.active': { textContent: text } }) }),
    text);

  // `.active` is the composing flag: compositionstart adds it, the finalize
  // removes it. A view without it is last utterance's leftovers — Bogdan's
  // capture shows exactly that, the node holding its text with the class gone.
  for (const [label, term] of [
    ['not composing', { element: fakeElement({}) }],
    ['empty overlay', { element: fakeElement({ '.composition-view.active': { textContent: '' } }) }],
    ['blank overlay', { element: fakeElement({ '.composition-view.active': { textContent: '   ' } }) }],
    ['no textContent', { element: fakeElement({ '.composition-view.active': {} }) }],
    ['no element yet', {}],
    ['element without query', { element: {} }],
    ['no terminal', null],
  ]) {
    assert.strictEqual(readComposition(term), null, label);
  }
});

test('readComposition asks THIS terminal, never the document', () => {
  // There is one `.composition-view` per terminal and Bogdan's capture found
  // six. A document-wide query would return another session's overlay as
  // readily as this one's, and this watcher would submit into the wrong seat.
  let asked = null;
  const term = {
    element: {
      querySelector(sel) { asked = sel; return { textContent: 'mine over and out' }; },
    },
  };
  assert.strictEqual(readComposition(term), 'mine over and out');
  assert.strictEqual(asked, '.composition-view.active',
    'the selector must be scoped to the terminal element, not run against document');
});

test('commitComposition dispatches a finalizing keydown AT the textarea', () => {
  const OriginalKeyboardEvent = globalThis.KeyboardEvent;
  // Node has no KeyboardEvent. The stub records the init, which is the whole
  // load-bearing part: xterm's CompositionHelper decides purely off keyCode.
  globalThis.KeyboardEvent = class {
    constructor(type, init) { Object.assign(this, { type }, init); }
  };
  try {
    const events = [];
    let composing = true;
    const term = {
      textarea: { dispatchEvent: (ev) => { events.push(ev); composing = false; return true; } },
      element: {
        querySelector: () => (composing ? { textContent: 'over and out' } : null),
      },
    };
    assert.strictEqual(commitComposition(term), true);
    assert.strictEqual(events.length, 1);
    const ev = events[0];
    assert.strictEqual(ev.type, 'keydown');
    // Meta and nothing else. CompositionHelper.keydown exempts 229/16/17/18 and
    // finalizes on anything else, so Shift, Ctrl or Alt here would not commit at
    // all; a printable key would commit AND type itself into the draft. Meta
    // finalizes and produces no byte.
    assert.strictEqual(ev.key, 'Meta');
    assert.strictEqual(ev.keyCode, 91);
    assert.strictEqual(ev.metaKey, true);
    assert.notStrictEqual(ev.keyCode, 16, 'Shift is exempt from the finalize');
    assert.notStrictEqual(ev.keyCode, 17, 'Ctrl is exempt from the finalize');
    assert.notStrictEqual(ev.keyCode, 18, 'Alt is exempt from the finalize');
    assert.notStrictEqual(ev.keyCode, 229, 'the composition character is exempt from the finalize');
    // xterm listens on the textarea itself, so the event reaches it AT_TARGET.
    // Bubbling would additionally offer a Meta keydown to every shortcut
    // handler in the renderer, for nothing.
    assert.strictEqual(ev.bubbles, false);
  } finally {
    globalThis.KeyboardEvent = OriginalKeyboardEvent;
  }
});

test('commitComposition empties the textarea, and ONLY after the dispatch', () => {
  const OriginalKeyboardEvent = globalThis.KeyboardEvent;
  globalThis.KeyboardEvent = class { constructor(type, init) { Object.assign(this, { type }, init); } };
  try {
    // The ORDER is the fix, not the end state. _finalizeComposition(false) reads
    // the words out of `value` synchronously during dispatchEvent; clearing
    // BEFORE would hand it an empty string and send nothing at all. Clearing
    // after is what stops macOS's own compositionend — which reads the
    // open-ended substring(start) and is not deduped, since _dataAlreadySent is
    // only ever written on a path our keydown never takes — from dispatching the
    // same words a second time.
    const log = [];
    let composing = true;
    const ta = {
      _v: ' finish the report over and out',
      get value() { return this._v; },
      set value(v) { this._v = v; log.push(`set:${JSON.stringify(v)}`); },
      dispatchEvent() {
        // What xterm does inside the dispatch: read the pending words NOW.
        log.push(`dispatch:${JSON.stringify(ta._v)}`);
        composing = false;
        return true;
      },
    };
    const term = {
      textarea: ta,
      element: { querySelector: () => (composing ? { textContent: ta._v } : null) },
    };
    assert.strictEqual(commitComposition(term), true);
    assert.deepStrictEqual(log, [
      'dispatch:" finish the report over and out"',
      'set:""',
    ], 'the finalize must see the words, and the clear must follow it');
    assert.strictEqual(ta.value, '', 'the late compositionend must find nothing left to re-send');
  } finally {
    globalThis.KeyboardEvent = OriginalKeyboardEvent;
  }
});

test('the late compositionend finds nothing to re-send — the belt is unreachable', () => {
  // WHY THERE IS NO SECOND GUARD AGAINST A DOUBLE SUBMIT.
  //
  // macOS fires its own compositionend after our keydown has already finalized.
  // That takes CompositionHelper's waitForPropagation branch, and since
  // _isComposing is false by then it reads the OPEN-ENDED substring(start) form
  // and would dispatch the same words a second time. The field that exists to
  // dedup it (_dataAlreadySent, xterm issue #3191) is written only from
  // _handleAnyTextareaChanges, which a keydown-driven finalize never reaches, so
  // it stays '' and subtracts nothing.
  //
  // This replays that branch's ACTUAL arithmetic against the state our boundary
  // leaves behind. It is a model of xterm's logic, not of the DOM — the values
  // it runs on are the ones commitComposition really produces.
  const OriginalKeyboardEvent = globalThis.KeyboardEvent;
  globalThis.KeyboardEvent = class { constructor(type, init) { Object.assign(this, { type }, init); } };
  try {
    const words = ' finish the report over and out';
    let composing = true;
    const ta = {
      value: words,
      dispatchEvent() { composing = false; return true; },
    };
    commitComposition({
      textarea: ta,
      element: { querySelector: () => (composing ? { textContent: ta.value } : null) },
    });

    // compositionstart set start to the length BEFORE the utterance; nothing
    // was already sent, so the dedup offset is zero.
    const start = 0 + ''.length;
    const lateInput = ta.value.substring(start);
    assert.strictEqual(lateInput, '', 'the late finalize must read an empty string');
    // `if (input.length > 0)` is what then skips the dispatch entirely.
    assert.strictEqual(lateInput.length > 0, false,
      'a second dispatch would need a non-empty input; there is none');
  } finally {
    globalThis.KeyboardEvent = OriginalKeyboardEvent;
  }
});

test('commitComposition reports whether the composition actually went away', () => {
  const OriginalKeyboardEvent = globalThis.KeyboardEvent;
  globalThis.KeyboardEvent = class { constructor(type, init) { Object.assign(this, { type }, init); } };
  try {
    // A dispatch that leaves the composition pending is a FAILED commit: if
    // xterm ever stops finalizing on this key, the boundary must say so rather
    // than report success and leave the caller believing the words were sent.
    const stuck = {
      textarea: { dispatchEvent: () => true },
      element: { querySelector: () => ({ textContent: 'over and out' }) },
    };
    assert.strictEqual(commitComposition(stuck), false);
    // No textarea to dispatch at is the same answer, and must not throw.
    assert.strictEqual(commitComposition({ element: { querySelector: () => null } }), false);
    assert.strictEqual(commitComposition({}), false);
    assert.strictEqual(commitComposition(null), false);
  } finally {
    globalThis.KeyboardEvent = OriginalKeyboardEvent;
  }
});
