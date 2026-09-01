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
  shouldRearm, composerIsEmpty, recorderBlocksRearm, recordingObserved, processingObserved,
  resolveTriggerKey,
} = require('../renderer/lib/voice-submit');
const {
  createVoiceSubmitWatcher, readComposition, commitComposition, CONSUMED_IDLE_MS,
  REARM_ABANDON_MS,
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
    { enabled: true, composition: false, rearm: false, phrase: 'wrap it up' });
  // undefined is what an omission from the settings:get whitelist arrives as,
  // and it must read as OFF rather than as truthy-by-absence.
  assert.deepStrictEqual(readVoiceSubmitSettings({}),
    { enabled: false, composition: false, rearm: false, phrase: DEFAULT_SUBMIT_PHRASE });
  assert.deepStrictEqual(readVoiceSubmitSettings({ voiceSubmit: 'yes', voiceSubmitPhrase: '  ' }),
    { enabled: false, composition: false, rearm: false, phrase: DEFAULT_SUBMIT_PHRASE });
  assert.deepStrictEqual(readVoiceSubmitSettings(null),
    { enabled: false, composition: false, rearm: false, phrase: DEFAULT_SUBMIT_PHRASE });
});

test('the composition read is ANDed with the master switch, never standing alone', () => {
  // The riskier half must not be reachable with the feature itself off — a
  // stale `voiceSubmitComposition: true` in a settings file predates the
  // operator unticking the box above it, and a bare `=== true` read would arm
  // the poll over a feature he believes is disarmed.
  // `rearm` is ANDed with the master switch for the same reason, so it rides
  // this table rather than a parallel one — the two secondary switches must
  // not drift apart in how they read a stale file.
  const cases = [
    [{ voiceSubmit: true, voiceSubmitComposition: true }, true, true, false],
    [{ voiceSubmit: true, voiceSubmitComposition: false }, true, false, false],
    [{ voiceSubmit: true }, true, false, false],
    [{ voiceSubmit: false, voiceSubmitComposition: true }, false, false, false],
    [{ voiceSubmitComposition: true }, false, false, false],
    [{ voiceSubmit: true, voiceSubmitComposition: 'yes' }, true, false, false],
    [{ voiceSubmit: true, voiceSubmitRearm: true }, true, false, true],
    [{ voiceSubmit: false, voiceSubmitRearm: true }, false, false, false],
    [{ voiceSubmitRearm: true }, false, false, false],
    [{ voiceSubmit: true, voiceSubmitRearm: 'yes' }, true, false, false],
    [{ voiceSubmit: true, voiceSubmitComposition: true, voiceSubmitRearm: true }, true, true, true],
  ];
  for (const [raw, enabled, composition, rearm] of cases) {
    assert.deepStrictEqual(readVoiceSubmitSettings(raw),
      { enabled, composition, rearm, phrase: DEFAULT_SUBMIT_PHRASE }, JSON.stringify(raw));
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

// A fake xterm buffer holding N screen rows, cursor on the LAST one unless a
// row carries `cursor: true`. It keeps
// its multi-row shape although the watcher now reads only the cursor row: that
// is what lets a test place rows ABOVE the cursor and assert they are not read.
// `translateToString(_, 0, cursorX)` is the truncate-at-cursor read the watcher
// makes, and this stub honours the cursorX argument rather than ignoring it — a
// stub returning the whole row would hide a watcher that forgot to truncate.
//
// `cursor: true` exists because the real footer paints the composer with rows
// BELOW it (box border, status line, the recording indicator). A stub that can
// only put the cursor last cannot express that layout at all, and the
// indicator scan reads exactly those rows.
function fakeTerminal({ rows = [''], type = 'normal' } = {}) {
  const listeners = [];
  const state = { rows: [...rows], type };
  const cursorIndex = () => {
    const marked = state.rows.findIndex((r) => r && r.cursor);
    return marked === -1 ? state.rows.length - 1 : marked;
  };
  const last = () => state.rows[cursorIndex()];
  return {
    _state: state,
    // The screen height, which is where the indicator scan stops. Equal to the
    // row count here: this stub has no scrollback, so baseY is 0 and every row
    // it holds is on screen.
    get rows() { return state.rows.length; },
    buffer: {
      get active() {
        return {
          type: state.type,
          baseY: 0,
          get cursorY() { return cursorIndex(); },
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
  // Overridden only by the starvation tests below, which have to place a
  // repaint INSIDE the window and a probe between two deadlines. At 5ms those
  // margins are shorter than the timer jitter they would be measuring.
  quietMs = TEST_QUIET_MS,
} = {}) {
  const writes = [];
  const term = fakeTerminal({ rows: rows.map((r) => (typeof r === 'string' ? { text: r } : r)), type });
  const env = { config, attention };
  const watcher = track(createVoiceSubmitWatcher(term, {
    getConfig: () => env.config,
    getAttention: () => env.attention,
    write: (d) => writes.push(d),
    quietMs,
  }));
  return { term, watcher, writes, env, done: () => settle(quietMs + ENTER_SETTLE_MS + 25) };
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
  const watcher = track(createVoiceSubmitWatcher(term, {
    getConfig: () => ({ enabled: true, phrase: DEFAULT_SUBMIT_PHRASE }),
    getAttention: () => { throw new Error('row gone'); },
    write: (d) => writes.push(d),
    quietMs: TEST_QUIET_MS,
  }));
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

// The animation starves the gate. Reported live: "it doesn't seem to be sending
// when tap is on" ... "i had to untap, for the text to get processed" -- the
// submit landed the moment recording STOPPED, which is the whole diagnosis.
// While the microphone is live the CLI paints an audio level meter on a 50ms
// tick, and a window restarted by every write can never elapse under it.
//
// The meter is the cursor GLYPH, not a row: the CLI passes it as the composer
// input's `cursorChar`, so it animates inside the cursor cell on the composer
// row itself. Both fixtures below therefore paint it on the cursor row, which
// is the shape a fix that only ignored OTHER rows would not survive.
//
// `cursorX` sits AT the meter glyph, not past it: that models the cursor cell
// the CLI paints into, and the read this gate makes ends there exclusively. A
// fixture that put the cursor past the glyph would be asserting against a
// screen the CLI never draws, and would make the erase counts below wrong.
//
// Each test asserts DURING the animation, not after it. Asserting only at the
// end cannot tell a starved window from a slow one -- the first draft of these
// passed against the shipped bug for exactly that reason, because the loop's
// own duration outlasted the window it was supposed to be holding open.

const METER = '\u2581\u2583\u2585\u2587';

test('a meter animating on the composer row does not hold the window open', async () => {
  // 20 frames at 8ms is 160ms over a 40ms window: four deadlines' worth, with
  // no gap between frames wide enough to fire in. Under the shipped code the
  // window restarts on every frame and NOTHING is ever written.
  //
  // The fire is asserted while frames are STILL ARRIVING, which is what makes
  // this a starvation measurement rather than a race with the loop's runtime.
  const h = fastHarness({ quietMs: 40 });
  const draft = '\u276f finish the report over and out';
  let firedDuring = 0;
  for (let i = 0; i < 20; i += 1) {
    h.term.write({ text: draft + METER[i % 4], cursorX: draft.length, cursor: true });
    await settle(8);
    if (i === 14) firedDuring = h.watcher.fireCount();
  }
  assert.strictEqual(firedDuring, 1,
    'the submit must fire WHILE the meter is still painting');
  await settle(ENTER_SETTLE_MS + 25);
  assert.deepStrictEqual(h.writes, ['\x7f'.repeat(13), '\r']);
  h.watcher.dispose();
});

test('speech arriving under a live meter RESTARTS the window', async () => {
  // The property the fix must not trade away, and the discriminator against a
  // fix that simply stopped restarting: more speech lands mid-window, and the
  // probe sits past the FIRST deadline but before the restarted one. A watcher
  // that ignored the change would already have submitted the partial draft.
  //
  // The meter animates throughout, so the restart cannot be coming from the
  // frames -- only the words can have caused it.
  const h = fastHarness({ quietMs: 120 });
  const half = '\u276f tell them over and out';
  h.term.write({ text: half + METER[0], cursorX: half.length, cursor: true });
  await settle(60);
  const full = '\u276f tell them over and out and i mean it over and out';
  for (let i = 0; i < 5; i += 1) {
    h.term.write({ text: full + METER[i % 4], cursorX: full.length, cursor: true });
    await settle(16);
  }
  assert.deepStrictEqual(h.writes, [],
    'the partial draft must NOT have been submitted at its own deadline');
  assert.strictEqual(h.watcher.fireCount(), 0, 'ENTER: nothing may have fired yet');

  // And it does fire once the speech stops, so the assertion above is a WAIT
  // rather than a permanent decline -- the failure a fix that never rescheduled
  // would also produce.
  for (let i = 0; i < 12; i += 1) {
    h.term.write({ text: full + METER[i % 4], cursorX: full.length, cursor: true });
    await settle(16);
  }
  await settle(ENTER_SETTLE_MS + 25);
  assert.strictEqual(h.watcher.fireCount(), 1, 'the settled draft must submit');
  // 13 = the phrase plus the space before it, erased from the FULL draft.
  assert.deepStrictEqual(h.writes, ['\x7f'.repeat(13), '\r']);
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
    // Both arguments, because WHAT WAS ALREADY SENT is the whole of this fix:
    // a harness recording only the text cannot tell the accumulation bug from
    // its repair — the shipped code committed twice too.
    //
    // A successful commit CLEARS THE READER, because the real boundary does:
    // _finalizeComposition removes `.active`, and commitComposition reports
    // success by observing `readComposition() === null`. So a null read after a
    // commit is guaranteed, not incidental — a fixture that leaves the overlay
    // active models a DOM state that cannot occur, and it hides every bug in
    // what the watcher does across that null. Each test re-arms `env.composed`
    // with the next sample, exactly as macOS refills the composition.
    commitComposition: (_t, composed, consumed) => {
      commits.push([composed, consumed]);
      if (commitTakes) env.composed = null;
      return commitTakes;
    },
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
  assert.deepStrictEqual(h.commits, [[' finish the report over and out', '']]);
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
  assert.deepStrictEqual(h.commits, [[' finish the report over and out', '']]);
  h.watcher.dispose();
});

test('the SECOND commit in one dictation session sends only the new words', async () => {
  // THE LIVE BUG, replayed from the operator's own transcript. macOS keeps its
  // own record of the whole dictation session, so after the first commit the
  // overlay does not empty — it comes back carrying utterance 1 IN FULL, first
  // trigger word and all, with utterance 2 appended. The tell in the real
  // capture is that surviving first `Roger`: our erase ran in the CLI composer,
  // and this text was re-sent from the OS, which that erase never touched.
  const u1 = ' Dictation test roger';
  const u2 = ' it sent it. The problem is that it appears to still keep the previous text on Dictation roger';
  const h = compositionHarness({
    config: { enabled: true, composition: true, phrase: 'roger' },
    composed: u1,
  });
  await h.settled();
  assert.deepStrictEqual(h.commits, [[u1, '']], 'the first utterance commits whole, nothing consumed before it');

  // THE NULL POLL, and the test is worthless without it. The commit removed
  // `.active`, so the overlay reads null until macOS refills it — seconds later,
  // across many polls. `consumed` has to SURVIVE that gap: it belongs to the
  // dictation session, not to the composition, and a prefix reset on the null
  // read is erased before the words it describes ever come back.
  assert.strictEqual(h.env.composed, null, 'ENTER: the commit cleared the overlay, as the real one does');
  await h.settled();
  await h.settled();

  h.env.composed = u1 + u2;
  await h.settled();
  assert.strictEqual(h.commits.length, 2, `the accumulation must commit again: ${JSON.stringify(h.commits)}`);
  // The assertion the shipped code failed: the boundary is told what was
  // already sent, so only the remainder goes out. Asserting the consumed prefix
  // rather than merely "committed twice" is the point — the old code committed
  // twice too, and sent the operator his own last sentence back.
  assert.deepStrictEqual(h.commits[1], [u1 + u2, u1]);
  assert.strictEqual(h.commits[1][0].slice(h.commits[1][1].length), u2,
    'ENTER: the remainder handed to the boundary is utterance 2 alone');
});

test('a REVISED accumulation sends nothing further, rather than re-sending', async () => {
  // Growth is ordinary but not guaranteed: dictation rewrites what it already
  // transcribed, so sample N+1 need not extend sample N. The offset is then
  // meaningless, and there is no safe slice to take. Dropping the words is
  // recoverable — the operator says them again; re-sending sentences he has
  // already submitted is not.
  const h = compositionHarness({
    config: { enabled: true, composition: true, phrase: 'roger' },
    composed: ' send the first draft roger',
  });
  await h.settled();
  assert.strictEqual(h.commits.length, 1);
  await h.settled();   // the null poll between utterances

  // Dictation revised "first" to "second" — the prefix no longer holds.
  h.env.composed = ' send the second draft roger and then some more roger';
  await h.settled();
  assert.strictEqual(h.commits.length, 1,
    `a revision must not commit: ${JSON.stringify(h.commits)}`);

  // And it STAYS dead for this composition: a later sample that happens to
  // extend the revision must not resume, because everything it carries was
  // already spoken past.
  h.env.composed = ' send the second draft roger and then some more roger still roger';
  await h.settled();
  assert.strictEqual(h.commits.length, 1, 'the desync must not heal itself mid-composition');
});

test('a desync survives the gap between utterances, and only IDLE clears it', async () => {
  // A desync must NOT be cleared by the overlay going quiet: that null is the
  // ordinary gap between two utterances of one dictation session, and the
  // accumulation it precedes still carries everything already spoken. Clearing
  // there would resume mid-session against a revised transcript, which is the
  // re-send this whole prefix exists to prevent.
  //
  // What DOES clear it is the idle expiry — long enough to be a different
  // sitting. The clock is driven, so this asserts the expiry rather than
  // sleeping out a real 90 seconds.
  const clock = { t: 1000 };
  const h = compositionHarness({
    config: { enabled: true, composition: true, phrase: 'roger' },
    composed: ' first thing roger',
    now: () => clock.t,
  });
  await h.settled();                  // first sighting stamps pendingAt
  clock.t += TEST_QUIET_MS + 1;       // then the window elapses
  await h.settled();
  assert.strictEqual(h.commits.length, 1);
  await h.settled();                  // the null poll after the commit

  h.env.composed = ' something else entirely roger';   // a revision: desync
  await h.settled();
  clock.t += TEST_QUIET_MS + 1;
  await h.settled();
  assert.strictEqual(h.commits.length, 1, 'the revision must not commit');

  // The overlay goes quiet and comes back WITHIN the session. Still dead.
  h.env.composed = null;
  await h.settled();
  h.env.composed = ' another try roger';
  await h.settled();
  clock.t += TEST_QUIET_MS + 1;
  await h.settled();
  assert.strictEqual(h.commits.length, 1,
    'a null read is an ordinary gap — it must not resurrect a desynced session');

  // Now the operator walks away. Past the expiry, the next composition is a
  // genuinely new sitting and the feature comes back.
  h.env.composed = null;
  clock.t += CONSUMED_IDLE_MS + 1;
  await h.settled();
  h.env.composed = ' a brand new utterance roger';
  await h.settled();
  clock.t += TEST_QUIET_MS + 1;
  await h.settled();
  assert.deepStrictEqual(h.commits[h.commits.length - 1], [' a brand new utterance roger', ''],
    'ENTER: past the expiry the session restarts with nothing consumed');
  assert.strictEqual(h.commits.length, 2);
});

test('the trigger is matched on the REMAINDER, not on the accumulation', async () => {
  // The already-sent utterance still ends in the phrase and is still sitting in
  // the accumulated text. Matching the whole sample would re-fire on those same
  // words every quiet window for the life of the composition.
  const first = ' the report is ready roger';
  const h = compositionHarness({
    config: { enabled: true, composition: true, phrase: 'roger' },
    composed: first,
  });
  await h.settled();
  assert.strictEqual(h.commits.length, 1);
  await h.settled();   // the null poll between utterances

  // THE DISTINGUISHING CASE, and it is the ordinary state rather than a corner:
  // macOS refills the overlay with exactly what was just consumed, and the next
  // word has not arrived yet. The remainder is EMPTY and declines; whole-text
  // matching sees an accumulation that ends in the phrase, re-fires, and
  // dispatches a commit that sends nothing while finalizing the live
  // composition out from under the operator. The `committed` latch cannot stand
  // in for this — the null poll above cleared it.
  h.env.composed = first;
  await h.settled();
  await h.settled();
  assert.strictEqual(h.commits.length, 1,
    `an empty remainder must decline: ${JSON.stringify(h.commits)}`);

  // Grows, and the accumulation still ENDS with the old phrase — but the new
  // words do not, so there is nothing to commit yet.
  h.env.composed = first + ' and here is more to say';
  await h.settled();
  assert.strictEqual(h.commits.length, 1,
    `the remainder does not end in the phrase: ${JSON.stringify(h.commits)}`);

  // ENTER: the two declines above are the remainder rule, not a dead watcher —
  // the same fixture commits the moment the NEW words end in the phrase.
  h.env.composed = first + ' and here is more to say roger';
  await h.settled();
  assert.deepStrictEqual(h.commits[1],
    [first + ' and here is more to say roger', first],
    'only the words after the consumed prefix are sent');
});

test('a commit blocked by a dialog buries its words instead of re-sending them', async () => {
  // The interlock refuses, and the accumulation keeps growing regardless. Those
  // words must be consumed anyway: the next sample carries them again, and
  // committing then would send speech from before the dialog into whatever the
  // dialog left behind.
  const blocked = ' approve it roger';
  const h = compositionHarness({
    config: { enabled: true, composition: true, phrase: 'roger' },
    attention: 'permission', composed: blocked,
  });
  await h.settled();
  assert.deepStrictEqual(h.commits, []);

  h.env.attention = null;
  await h.settled();   // the null poll between utterances
  h.env.composed = blocked + ' now say something new roger';
  await h.settled();
  assert.strictEqual(h.commits.length, 1, 'the new words may commit');
  assert.deepStrictEqual(h.commits[0], [blocked + ' now say something new roger', blocked],
    'ENTER: the blocked utterance is consumed, so only the words after it are sent');
});

test('un-ticking the setting FORGETS a composition already sitting there', async () => {
  // The config gate's forgetPending() had no pin that could fail if its body
  // were emptied: the existing re-arm test starts with composition:false, so
  // `pending` is never populated and a bare `return` passes it just as well.
  // This one populates the state FIRST, so the un-tick has something to clear.
  //
  // What it protects: without the reset, the words are still sitting in
  // `pending` with an old `pendingAt`, so the re-tick finds them instantly
  // "stable" and commits speech from before the feature was armed.
  const clock = { t: 1000 };
  const h = compositionHarness({
    config: { enabled: true, composition: true, phrase: 'roger' },
    composed: ' words spoken while it was on roger',
    now: () => clock.t,
  });
  // Populate `pending`/`pendingAt` — but do NOT let the window elapse, so
  // nothing has committed and the state under test is genuinely there.
  await h.settled();
  assert.deepStrictEqual(h.commits, [], 'the window has not passed; nothing may have committed');

  h.env.config = { enabled: true, composition: false, phrase: 'roger' };
  await h.settled();
  // The window elapses WHILE the setting is off. If the un-tick forgot nothing,
  // pendingAt still dates from the first poll and the text is now stale.
  clock.t += TEST_QUIET_MS + 1;
  await h.settled();

  h.env.config = { enabled: true, composition: true, phrase: 'roger' };
  await h.settled();
  assert.deepStrictEqual(h.commits, [],
    'the re-tick must restart the window, not inherit a timestamp from before the un-tick');

  // And it does commit once the window passes SINCE the re-tick, so the
  // assertion above is a real decline rather than a feature that is simply off.
  clock.t += TEST_QUIET_MS + 1;
  await h.settled();
  assert.deepStrictEqual(h.commits, [[' words spoken while it was on roger', '']],
    'ENTER: the feature is alive — the decline above was the reset, not a dead poll');
});

test('turning the setting off ends the DICTATION SESSION, not just the composition', async () => {
  // The consumed prefix survives an ordinary null read, so something has to end
  // it besides the idle expiry, and the un-tick is the operator saying stop.
  // Without this the prefix outlives its own feature: re-arming would subtract
  // words from an accumulation the operator has since restarted, silently
  // swallowing the first utterance of the new session.
  const clock = { t: 1000 };
  const h = compositionHarness({
    config: { enabled: true, composition: true, phrase: 'roger' },
    composed: ' the first utterance roger',
    now: () => clock.t,
  });
  await h.settled();
  clock.t += TEST_QUIET_MS + 1;
  await h.settled();
  assert.deepStrictEqual(h.commits, [[' the first utterance roger', '']]);

  // Off, then on again — well inside the idle window, so only the un-tick can
  // account for the reset.
  h.env.config = { enabled: true, composition: false, phrase: 'roger' };
  await h.settled();
  h.env.config = { enabled: true, composition: true, phrase: 'roger' };

  // The SAME words come back. Treated as a fresh session, they must commit
  // whole rather than being subtracted away to nothing.
  h.env.composed = ' the first utterance roger';
  await h.settled();
  clock.t += TEST_QUIET_MS + 1;
  await h.settled();
  assert.strictEqual(h.commits.length, 2, 'the re-armed session must commit again');
  assert.deepStrictEqual(h.commits[1], [' the first utterance roger', ''],
    'ENTER: nothing consumed — the un-tick ended the session the prefix belonged to');
});

test('a TAB SWITCH is an out-of-scope seat, not the end of the dictation session', async () => {
  // getConfig returns null for any seat that is not the active claude session,
  // so one click on another sidebar row produces it — and treating that as a
  // stop is t577's bug back again by a route the operator can reach with the
  // mouse: dictate into A, commit, click B, click back, keep talking. The OS
  // accumulation never went anywhere, so a cleared prefix means the next commit
  // resends the utterance already submitted.
  const h = compositionHarness({
    config: { enabled: true, composition: true, phrase: 'roger' },
    composed: ' the first utterance roger',
  });
  await h.settled();
  assert.deepStrictEqual(h.commits, [[' the first utterance roger', '']]);

  // Click away. The config goes null with the prefix held, and stays null over
  // several polls — the seat is not merely skipped for one tick.
  h.env.config = null;
  await h.settled();
  await h.settled();

  // Click back, well inside the idle window, and keep dictating into the same
  // macOS session: the overlay comes back carrying the first utterance IN FULL.
  h.env.config = { enabled: true, composition: true, phrase: 'roger' };
  h.env.composed = ' the first utterance roger and now the second one roger';
  await h.settled();
  assert.strictEqual(h.commits.length, 2, 'the second utterance must still commit');
  assert.deepStrictEqual(h.commits[1],
    [' the first utterance roger and now the second one roger', ' the first utterance roger'],
    'ENTER: the prefix survived the switch — only the new words are sent');
});

test('a seat switched away RESTARTS the window, it does not resume it', async () => {
  // The other half of the new `!cfg` arm: it forgets the PENDING text as well
  // as keeping the prefix, and a bare `return;` there passes every other pin —
  // the TAB SWITCH one cannot see it, because a commit nulls the overlay and
  // there is no pending text to inherit across the switch. The hazard is the
  // pager arm's, reached by a click instead: words observed but not yet stable,
  // the seat left for longer than a window, and the same words still sitting
  // there on return. An inherited `pendingAt` makes them instantly committable,
  // and the time passed with the seat not even on screen.
  const clock = { t: 1000 };
  const h = compositionHarness({
    config: { enabled: true, composition: true, phrase: 'roger' },
    composed: ' half a thought roger',
    now: () => clock.t,
  });
  // Observed under a live config, but not yet old enough to act on.
  await h.settled();
  assert.deepStrictEqual(h.commits, [], 'not settled yet');

  // The operator clicks another seat and stays there past a full window.
  h.env.config = null;
  await h.settled();
  clock.t += TEST_QUIET_MS + 1;
  await h.settled();
  assert.deepStrictEqual(h.commits, [], 'nothing may commit while the seat is out of scope');

  // Back, with the same words still in the overlay. NOT stale-committable: the
  // window starts again from the return.
  h.env.config = { enabled: true, composition: true, phrase: 'roger' };
  await h.settled();
  assert.deepStrictEqual(h.commits, [],
    'the window must restart on return, not resume from before the switch');

  // ENTER: and they do commit once genuinely settled SINCE the return, so the
  // decline above is the reset rather than a watcher that never woke up.
  clock.t += TEST_QUIET_MS + 1;
  await h.settled();
  assert.deepStrictEqual(h.commits, [[' half a thought roger', '']],
    'the same words commit once the window has passed since the return');
});

test('a LONG utterance keeps the session alive — the expiry measures silence, not time since the last submit', async () => {
  // THE FAILING PATH, and it is ordinary rather than a corner: commit the first
  // utterance, then dictate a second one for longer than the expiry with the
  // overlay ACTIVE throughout. That activity is positive evidence the dictation
  // session never ended, so the prefix must not age out — the operator has not
  // stopped talking, and the OS accumulation still holds utterance 1.
  //
  // Stamping only at commit time measures "time since we last submitted", which
  // this crosses while doing nothing wrong. The overlay is known to flap
  // mid-session, so the null read that follows is expected, not exceptional.
  const clock = { t: 1000 };
  const u1 = ' the first utterance roger';
  const h = compositionHarness({
    config: { enabled: true, composition: true, phrase: 'roger' },
    composed: u1,
    now: () => clock.t,
  });
  await h.settled();
  clock.t += TEST_QUIET_MS + 1;
  await h.settled();
  assert.deepStrictEqual(h.commits, [[u1, '']]);
  await h.settled();                       // the null read the commit produces

  // A second utterance arrives slowly, over well past the expiry. The overlay is
  // ACTIVE at every step and the text keeps GROWING, so this never reaches the
  // quiet-window return — which is exactly why the refresh cannot live below it.
  //
  // The clock advances AND the text grows together, so the composition is never
  // observed unchanged across an elapsed window. Every poll therefore returns at
  // the growth check or the quiet-window check, and the ONLY place a refresh can
  // fire is above them — which is what pins the placement rather than merely the
  // existence of the refresh. Letting a word go stale here would let a refresh
  // sitting below the quiet-window return pass this test too.
  let sofar = u1;
  const words = [' it', ' keeps', ' going', ' and', ' going'];
  for (const w of words) {
    clock.t += Math.floor(CONSUMED_IDLE_MS / 2);
    sofar += w;
    h.env.composed = sofar;
    await h.settled();
  }
  assert.ok(clock.t - 1000 > CONSUMED_IDLE_MS,
    'ENTER: the utterance really did outlast the expiry window');

  // Then the overlay flaps, as the operator's probe showed it does unprompted.
  h.env.composed = null;
  await h.settled();

  // And the utterance finishes. Utterance 1 must STILL be consumed.
  const u2 = sofar.slice(u1.length) + ' roger';
  h.env.composed = u1 + u2;
  await h.settled();
  clock.t += TEST_QUIET_MS + 1;
  await h.settled();
  assert.strictEqual(h.commits.length, 2, `should have committed again: ${JSON.stringify(h.commits)}`);
  assert.deepStrictEqual(h.commits[1], [u1 + u2, u1],
    'the prefix must have survived: a live overlay is the session saying it is still here');
  assert.notStrictEqual(h.commits[1][1], '',
    'ENTER: an empty prefix here is the resend — the whole accumulation would go out again');
});

test('a full-screen program does not end the dictation session', async () => {
  // A pager opening and closing leaves the OS accumulation fully intact, so
  // clearing the prefix here would resend every utterance already submitted.
  // The asymmetry that decides it: a surviving prefix at worst desyncs and goes
  // quiet, costing one utterance the operator can repeat; a cleared prefix
  // resends sentences already submitted, which cannot be undone.
  const clock = { t: 1000 };
  const u1 = ' the first utterance roger';
  const h = compositionHarness({
    config: { enabled: true, composition: true, phrase: 'roger' },
    composed: u1,
    now: () => clock.t,
  });
  await h.settled();
  clock.t += TEST_QUIET_MS + 1;
  await h.settled();
  assert.deepStrictEqual(h.commits, [[u1, '']]);

  // vim opens and closes, well inside the expiry.
  h.term._state.type = 'alternate';
  h.env.composed = u1 + ' invisible to this feature';
  await h.settled();
  assert.strictEqual(h.commits.length, 1, 'nothing may commit over a full-screen program');
  h.term._state.type = 'normal';

  const u2 = ' and now the second roger';
  h.env.composed = u1 + u2;
  await h.settled();
  clock.t += TEST_QUIET_MS + 1;
  await h.settled();
  assert.strictEqual(h.commits.length, 2, 'the feature must work again once the program exits');
  assert.deepStrictEqual(h.commits[1], [u1 + u2, u1],
    'ENTER: the prefix survived the pager — otherwise utterance 1 goes out a second time');
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
  assert.deepStrictEqual(h.commits, [[' finish the report over and out', '']]);
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

test('commitComposition shortens the textarea so the finalize sends only the remainder', () => {
  const OriginalKeyboardEvent = globalThis.KeyboardEvent;
  globalThis.KeyboardEvent = class { constructor(type, init) { Object.assign(this, { type }, init); } };
  try {
    // THE LEVER, run against xterm's ACTUAL arithmetic rather than described.
    // `start` is fixed at compositionstart and private, so it cannot be moved;
    // `end` is set by a setTimeout in compositionupdate and here points past the
    // shortened value, which is the case that has to work. substring CLAMPS, so
    // the send is the remainder rather than a fragment.
    const head = '❯ typed before ';                 // present at compositionstart
    const consumed = ' Dictation test roger';
    const fresh = ' it sent it. The problem is on Dictation roger';
    const composed = consumed + fresh;

    const start = head.length;
    let sent = null;
    const ta = {
      value: head + composed,
      dispatchEvent() {
        // What _finalizeComposition(false) does, inline, during the dispatch:
        // read value.substring(start, end) with end LEFT OVER from the full text.
        sent = this.value.substring(start, end);
        composing = false;
        return true;
      },
    };
    const end = ta.value.length;                     // stale: the pre-shortening length
    let composing = true;
    const term = {
      textarea: ta,
      element: { querySelector: () => (composing ? { textContent: composed } : null) },
    };

    assert.strictEqual(commitComposition(term, composed, consumed), true);
    assert.strictEqual(sent, fresh,
      'only the un-consumed remainder may reach the pty — this is the whole bug');
    assert.ok(!sent.includes('Dictation test'),
      'ENTER: the already-submitted utterance must not appear in the send');
    // And the clear still runs after, so the late compositionend re-dispatch
    // still finds nothing: shortening does not trade that guarantee away.
    assert.strictEqual(ta.value, '');
  } finally {
    globalThis.KeyboardEvent = OriginalKeyboardEvent;
  }
});

test('commitComposition with nothing consumed does not touch the value before dispatching', () => {
  const OriginalKeyboardEvent = globalThis.KeyboardEvent;
  globalThis.KeyboardEvent = class { constructor(type, init) { Object.assign(this, { type }, init); } };
  try {
    // The first commit of a composition, and every caller that passes no prefix.
    // A rewrite here would be a write for no gain, and `substring(start, end)`
    // already sends exactly the composition.
    const log = [];
    let composing = true;
    const words = ' finish the report over and out';
    const ta = {
      _v: words,
      get value() { return this._v; },
      set value(v) { this._v = v; log.push(`set:${JSON.stringify(v)}`); },
      dispatchEvent() { log.push(`dispatch:${JSON.stringify(ta._v)}`); composing = false; return true; },
    };
    const term = { textarea: ta, element: { querySelector: () => (composing ? { textContent: ta._v } : null) } };

    assert.strictEqual(commitComposition(term, words, ''), true);
    assert.deepStrictEqual(log, [`dispatch:${JSON.stringify(words)}`, 'set:""'],
      'no pre-dispatch write when there is no consumed prefix');
    // The no-argument call is the same case: every existing caller keeps working.
    log.length = 0; composing = true; ta._v = words;
    assert.strictEqual(commitComposition(term), true);
    assert.deepStrictEqual(log, [`dispatch:${JSON.stringify(words)}`, 'set:""']);
  } finally {
    globalThis.KeyboardEvent = OriginalKeyboardEvent;
  }
});

test('commitComposition still sends the remainder when the overlay carries a leading space the textarea does not', () => {
  const OriginalKeyboardEvent = globalThis.KeyboardEvent;
  globalThis.KeyboardEvent = class { constructor(type, init) { Object.assign(this, { type }, init); } };
  try {
    // Dictation prepends a space to the OVERLAY, which is where `composed` is
    // read from; the textarea need not carry it. A byte-exact suffix demand
    // refuses here — and because the prefix advances at the latch, that refusal
    // BURIES the utterance rather than retrying it. The remainder must come out
    // whole, with the offset taken from the form that actually matched.
    const consumed = ' Dictation test roger';
    const composed = consumed + ' it sent it roger';
    const value = composed.trimStart();          // no leading space in the textarea

    let sent = null;
    const start = 0;
    const ta = {
      value,
      dispatchEvent() { sent = this.value.substring(start, end); composing = false; return true; },
    };
    const end = value.length;                    // stale, pre-shortening
    let composing = true;
    const term = { textarea: ta, element: { querySelector: () => (composing ? { textContent: composed } : null) } };

    assert.strictEqual(commitComposition(term, composed, consumed), true,
      'a prepended overlay space must not cause a refusal');
    assert.strictEqual(sent, ' it sent it roger', 'the remainder must arrive whole');
    assert.ok(!sent.includes('Dictation test'),
      'ENTER: the already-sent utterance must still not be resent on the trimmed path');
  } finally {
    globalThis.KeyboardEvent = OriginalKeyboardEvent;
  }
});

test('commitComposition REFUSES when the textarea does not hold the composition it was told about', () => {
  const OriginalKeyboardEvent = globalThis.KeyboardEvent;
  globalThis.KeyboardEvent = class { constructor(type, init) { Object.assign(this, { type }, init); } };
  try {
    // Shortening rests on the head of `value` being the pre-composition text.
    // If the DOM does not agree with what the caller believes is pending, the
    // slice would move the words under a `start` that cannot move with them and
    // send a fragment cut at the wrong byte. Refusing costs one utterance; the
    // caller records it as a failed commit and does not retry.
    for (const [label, value, composed, consumed] of [
      ['value does not end with the composition', '❯ something else entirely', ' a roger b', ' a roger'],
      ['composition does not start with the consumed prefix', '❯ x a roger b', ' a roger b', ' NOT the prefix'],
      ['value is not a string', undefined, ' a roger b', ' a roger'],
    ]) {
      let dispatched = false;
      const ta = { value, dispatchEvent() { dispatched = true; return true; } };
      const term = { textarea: ta, element: { querySelector: () => ({ textContent: composed }) } };
      assert.strictEqual(commitComposition(term, composed, consumed), false, label);
      assert.strictEqual(dispatched, false, `${label}: nothing may be dispatched`);
      assert.strictEqual(ta.value, value, `${label}: the value is left alone`);
    }
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

// ------------------------------------------------------------------- re-arm
// The second half of the feature: writing ONE character into an empty composer
// on the thinking -> idle edge, because the CLI's tap recorder arms only from a
// keypress. Same hazard as the submit half and then some — under the old
// post-send trigger a permission dialog was an incidental collision, but the
// idle edge is exactly when a dialog appears, so the interlock is on the main
// path here. These assert on what reached the pty for that reason.

test('shouldRearm fires on the edge and only on the edge', () => {
  const base = {
    enabled: true, rearm: true, voiceMode: 'tap', attention: null,
  };
  assert.strictEqual(shouldRearm({ ...base, from: 'thinking', to: 'idle' }), true);
  // A LEVEL check would pass all of these, and each one is a character written
  // into a composer the operator may be typing in by hand.
  for (const [from, to] of [
    ['idle', 'idle'], ['thinking', 'thinking'], ['idle', 'thinking'],
    [null, 'idle'], ['compacting', 'idle'], ['thinking', 'compacting'],
  ]) {
    assert.strictEqual(shouldRearm({ ...base, from, to }), false,
      `${String(from)} -> ${String(to)} must not re-arm`);
  }
});

test('shouldRearm: every gate declines on its own', () => {
  const ok = {
    enabled: true, rearm: true, voiceMode: 'tap', attention: null,
    from: 'thinking', to: 'idle',
  };
  assert.strictEqual(shouldRearm(ok), true);
  const cases = [
    ['the feature is off', { enabled: false }],
    ['the re-arm switch is off', { rearm: false }],
    ['a dialog is open', { attention: 'permission' }],
    // Not a preference: in hold mode one character cannot reach the CLI's
    // auto-repeat threshold, so it lands in the draft as a literal instead.
    ['voice mode is hold', { voiceMode: 'hold' }],
    ['voice mode is off', { voiceMode: 'off' }],
    ['voice mode is unknown', { voiceMode: null }],
  ];
  for (const [why, patch] of cases) {
    assert.strictEqual(shouldRearm({ ...ok, ...patch }), false, why);
  }
  // Undefined must read as off everywhere, the same way the settings reader
  // treats an omitted key.
  assert.strictEqual(shouldRearm({}), false);
  assert.strictEqual(shouldRearm(), false);
});

test('composerIsEmpty: ornament is empty, a draft is not, unreadable is not', () => {
  // THE MEASURED ROW, first and by itself, because this is the case the whole
  // guard exists to accept and the one an ASCII-space fixture cannot express.
  // Captured 2026-08-31 off a live seat (CLI 2.1.251): U+276F U+00A0, cursorX 2.
  assert.strictEqual(composerIsEmpty('\u276f\u00a0'), true,
    'the real composer is empty — U+00A0 separator, not U+0020');

  // The marker, with at most the one separator the CLI paints after it. Both
  // separators are accepted; only U+00A0 has been observed.
  for (const row of ['❯', '\u276f\u0020', '\u276f\u00a0', '>', '> ']) {
    assert.strictEqual(composerIsEmpty(row), true, JSON.stringify(row));
  }
  // A SECOND space is already a draft by the CLI's own `value.length > 0`
  // guard, and dictation prepends exactly one. A row with no marker is not
  // evidence of a composer at all — a dialog interior looks like that.
  for (const row of [
    '❯  ', '\u276f\u00a0\u00a0', '\u276f\u00a0x',
    '│ ', '│', '', '   ', ' ',
    // \s would admit these; the rule lists the two separators it has evidence
    // for, so an unrecognised row falls to the silent side.
    '\u276f\t', '\u276f\n',
  ]) {
    assert.strictEqual(composerIsEmpty(row), false, JSON.stringify(row));
  }
  // The CLI's tap handler RETURNS before swallowing the key when the composer
  // is non-empty, so a character written for any of these is inserted into the
  // draft AND arms nothing.
  for (const row of ['❯ a', '❯ finish the report', '> x', 'text']) {
    assert.strictEqual(composerIsEmpty(row), false, JSON.stringify(row));
  }
  // cursorRow() answers null off the normal buffer; "I cannot read this" and
  // "do not write" have to be the same answer.
  for (const bad of [null, undefined, 0, {}, []]) {
    assert.strictEqual(composerIsEmpty(bad), false, JSON.stringify(bad));
  }
});

// THE INDICATOR ROW AS THE CLI PAINTS IT, spelled as escapes. Ground truth is the
// outerHTML of a live recording row, captured on two boxes: the bullet, a U+0020,
// then `REC`. An earlier fixture here omitted that space to agree with the rule
// instead of the CLI, so every test in this file confirmed our own assumption and
// the feature was dead while the suite was green — do not close the space to make
// a failing rule pass. The space is written \u0020 for the same reason the bullet
// is escaped: it is the byte the rule was wrong about, and a literal one cannot be
// reviewed by eye.
const REC_ROW = ' agents \u23fa\u0020REC \u00b7 tap to send';

test('recorderBlocksRearm: the measured indicator row blocks, ordinary output does not', () => {
  // The case the whole gate exists for, first and by itself.
  assert.strictEqual(recorderBlocksRearm([REC_ROW]), true,
    'the measured REC row must block the re-arm');

  // The MEASURED false positives. U+23FA opens every ordinary tool bullet and
  // `REC` is a common substring, so an anchor of either alone hits real
  // transcript — these are rows this scan genuinely sees.
  for (const row of [
    '\u23fa Bash(ls -la)',
    '\u23fa Read(RECOVERY.md)',
    '\u23fa RECOVERY.md',
    '\u23fa RECORD the thing',
    'RECORD',
    'tap to send',
    '\u276f\u00a0',
    '',
  ]) {
    assert.strictEqual(recorderBlocksRearm([row]), false, JSON.stringify(row));
  }

  // Any row in the window blocks, not just the first: the indicator paints
  // BELOW the composer in the real footer layout.
  assert.strictEqual(recorderBlocksRearm(['\u276f\u00a0', 'border', REC_ROW]), true);
  assert.strictEqual(recorderBlocksRearm(['\u276f\u00a0', 'border']), false);

  // UNREADABLE BLOCKS — the opposite polarity to composerIsEmpty, and the
  // asymmetry is deliberate: a missed indicator STOPS a live recording and
  // loses the operator's words, a phantom one only skips one re-arm.
  for (const bad of [null, undefined, 'string', 0, {}]) {
    assert.strictEqual(recorderBlocksRearm(bad), true, JSON.stringify(bad));
  }
  // A read that succeeded and saw nothing is NOT unreadable.
  assert.strictEqual(recorderBlocksRearm([]), false);
  // A row that is not a string cannot be matched, and must not throw.
  assert.strictEqual(recorderBlocksRearm([null, undefined, 7]), false);
});

test('resolveTriggerKey takes a plain character and refuses a chord', () => {
  const plain = { key: ' ', ctrl: false, alt: false, shift: false, meta: false, super: false };
  assert.strictEqual(resolveTriggerKey(plain), ' ');
  assert.strictEqual(resolveTriggerKey({ ...plain, key: 'k' }), 'k');
  // A modifier chord cannot be armed by writing a byte — the CLI compares the
  // typed character against a single-character binding only.
  for (const mod of ['ctrl', 'alt', 'shift', 'meta', 'super']) {
    assert.strictEqual(resolveTriggerKey({ ...plain, key: 'k', [mod]: true }), null, mod);
  }
  // Named keys ('escape', 'up') are not characters either.
  assert.strictEqual(resolveTriggerKey({ ...plain, key: 'escape' }), null);
  assert.strictEqual(resolveTriggerKey({ ...plain, key: '' }), null);
  // Null is the CLEARED binding, not a missing default: the CLI's own default
  // is seeded by the read in voice-settings.js, so defaulting to a space here
  // would write one into a session that has no push-to-talk key at all.
  assert.strictEqual(resolveTriggerKey(null), null);
  assert.strictEqual(resolveTriggerKey(undefined), null);
});

// A harness for the re-arm half. The composer starts EMPTY, the CLI is in tap
// mode, and `env` is mutable so a test can change the world DURING the settle
// window — which is what the re-check tests need. `rearmMs` is a seam for the
// same reason `quietMs` is.
// The empty composer AS MEASURED off a live seat on 2026-08-31 (CLI 2.1.251):
// U+276F then U+00A0, with the cursor at column 2, read from the same
// `cursorRow()` truncation the watcher performs. The separator is a
// NON-BREAKING space, and writing it as an ASCII one here is what hid a rule
// that returned false on every real composer while this file stayed green.
// Spelled as escapes so it cannot be silently "fixed" by an editor.
const EMPTY_COMPOSER = '\u276f\u00a0';

const TEST_REARM_MS = 5;
function rearmHarness({
  rows = [EMPTY_COMPOSER],
  config = { enabled: true, rearm: true, phrase: DEFAULT_SUBMIT_PHRASE },
  attention = null,
  voiceMode = 'tap',
  trigger = ' ',
  abandonMs,
  speechAbandonMs,
  speaking = false,
  // This seat HOLDS the microphone, which is the situation every re-arm test
  // below is about. Defaulted true so those tests keep asserting what they were
  // written to assert; the target tests set it false explicitly, and the
  // production default is the opposite (see isMicTarget in the watcher).
  micTarget = true,
  // Clodex is FRONTMOST, which is the situation every re-arm test below is
  // about. Defaulted true for the same reason micTarget is; the production
  // default is the opposite (see isAppFocused in the watcher).
  appFocused = true,
} = {}) {
  const writes = [];
  const term = fakeTerminal({ rows: rows.map((r) => (typeof r === 'string' ? { text: r } : r)) });
  const env = { config, attention, voiceMode, trigger, speaking, micTarget, appFocused };
  // The terminal-quiet check compares timestamps, so a test that wants to say
  // "the CLI is still painting" has to control the clock rather than race it:
  // real elapsed time between a write and the assertion is longer than any
  // workable test settle. `offset` moves the clock forward by hand.
  // `frozen` pins the clock at a fixed instant so a test can say "the terminal
  // is painting continuously" without racing real timers; `offset` shifts it.
  // Indirect through the object so a test can set either AFTER construction.
  const clock = {
    offset: 0,
    frozen: null,
    now: () => (clock.frozen === null ? Date.now() + clock.offset : clock.frozen),
  };
  const watcher = track(createVoiceSubmitWatcher(term, {
    now: () => clock.now(),
    getConfig: () => env.config,
    getAttention: () => env.attention,
    getVoiceMode: () => env.voiceMode,
    getTriggerKey: () => env.trigger,
    getSpeakerBusy: () => env.speaking,
    // Read through `env` so a test can move the target AFTER construction —
    // which is the real shape: main's broadcast lands while the watcher lives.
    isMicTarget: () => env.micTarget,
    // Read through `env` for the same reason: the operator alt-tabs away DURING
    // the settle window, which is the case worth being able to express.
    isAppFocused: () => env.appFocused,
    write: (d) => writes.push(d),
    quietMs: TEST_QUIET_MS,
    rearmMs: TEST_REARM_MS,
    ...(abandonMs === undefined ? {} : { abandonMs }),
    ...(speechAbandonMs === undefined ? {} : { speechAbandonMs }),
  }));
  // A turn, then its end. Every re-arm needs the edge, so this is the shape
  // every test below starts from.
  // A real turn: thinking, then an idle carrying turnEnd. `midTurnIdle` is the
  // same state edge WITHOUT it — what the wire tracker's gap timer and the
  // jsonl watcher's inter-tool flush actually emit.
  const turn = () => { watcher.noteActivity('thinking'); watcher.noteActivity('idle', true); };
  const midTurnIdle = () => { watcher.noteActivity('thinking'); watcher.noteActivity('idle', false); };
  const done = () => settle(TEST_REARM_MS + TEST_QUIET_MS + ENTER_SETTLE_MS + 25);
  return { term, watcher, writes, env, turn, midTurnIdle, done, clock };
}

test('the idle edge writes the trigger character into an empty composer', async () => {
  const h = rearmHarness();
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [' ']);
  assert.strictEqual(h.watcher.rearmCount(), 1);
  h.watcher.dispose();
});

test('the trigger character written is the CONFIGURED one, not a hardcoded space', async () => {
  const h = rearmHarness({ trigger: 'k' });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, ['k']);
  h.watcher.dispose();
});

test('no character can arm a chord binding, so nothing is written', async () => {
  const h = rearmHarness({ trigger: null });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, []);
  assert.strictEqual(h.watcher.rearmCount(), 0);
  h.watcher.dispose();
});

test('THE INTERLOCK: a permission dialog gets no character', async () => {
  const h = rearmHarness({ attention: 'permission' });
  h.turn();
  await h.done();
  // Not a predicate assertion: the byte is what would answer the dialog.
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('THE INTERLOCK: a dialog opening DURING the settle window still blocks', async () => {
  const h = rearmHarness();
  h.turn();
  // The race this window exists for: `session-attention` and `session-activity`
  // reach the renderer from different watchers, so the idle edge can arrive
  // just before the notice that a dialog is up.
  h.env.attention = 'permission';
  await h.done();
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('a composer the operator is typing in is never written into', async () => {
  const h = rearmHarness({ rows: ['❯ half a thought'] });
  h.turn();
  await h.done();
  // The CLI would INSERT the character here rather than swallow it, so this
  // guard protects the draft as well as the recorder.
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('a draft typed DURING the settle window is not written into either', async () => {
  const h = rearmHarness();
  h.turn();
  h.term.write('❯ started typing');
  await h.done();
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('a new turn starting inside the settle window cancels the re-arm', async () => {
  const h = rearmHarness();
  h.turn();
  h.watcher.noteActivity('thinking');
  await h.done();
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('sitting idle re-arms once, not once per event', async () => {
  const h = rearmHarness();
  h.turn();
  await h.done();
  assert.strictEqual(h.watcher.rearmCount(), 1);
  // Repeat idle events with no turn between them are the LEVEL the spec
  // refused: each one would be another character into the composer.
  for (let i = 0; i < 5; i += 1) h.watcher.noteActivity('idle', true);
  await h.done();
  assert.deepStrictEqual(h.writes, [' ']);
  assert.strictEqual(h.watcher.rearmCount(), 1);
  // A real turn re-arms again — the feature would be useless otherwise.
  h.turn();
  await h.done();
  assert.strictEqual(h.watcher.rearmCount(), 2);
  h.watcher.dispose();
});

test('a seat that is merely idle at startup is not re-armed', async () => {
  // `activity` seeds null, so the first event cannot look like an arrival from
  // 'thinking'. A terminal built next to an idle agent has not just finished a
  // turn, and its composer may hold a draft from before.
  const h = rearmHarness();
  h.watcher.noteActivity('idle', true);
  await h.done();
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('the re-arm respects its own switch and the feature switch', async () => {
  for (const config of [
    { enabled: true, rearm: false, phrase: DEFAULT_SUBMIT_PHRASE },
    { enabled: false, rearm: true, phrase: DEFAULT_SUBMIT_PHRASE },
    null,
  ]) {
    const h = rearmHarness({ config });
    h.turn();
    await h.done();
    assert.deepStrictEqual(h.writes, [], JSON.stringify(config));
    h.watcher.dispose();
  }
});

test('only tap mode is re-armed', async () => {
  for (const voiceMode of ['hold', 'off', null]) {
    const h = rearmHarness({ voiceMode });
    h.turn();
    await h.done();
    assert.deepStrictEqual(h.writes, [], `voiceMode ${String(voiceMode)}`);
    h.watcher.dispose();
  }
});

test('an alternate-buffer screen is not a composer and gets nothing', async () => {
  const h = rearmHarness();
  h.term._state.type = 'alt';
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('dispose cancels a re-arm already in flight', async () => {
  const h = rearmHarness();
  h.turn();
  h.watcher.dispose();
  await h.done();
  assert.deepStrictEqual(h.writes, []);
});

// THE HAZARD THE RE-ARM SHIPPED WITH OPEN. The CLI's tap recorder finishes
// ~15s of silence, and only then does our character ARM it. A turn ending
// inside that window leaves it RECORDING, where the same character STOPS it
// and drops what the operator was saying. These assert on what reached the
// pty, not on a predicate: the gate can be deleted and leave every function
// still returning the right answer while the byte goes out anyway.
test('THE INTERLOCK: a live recording indicator gets no character', async () => {
  const h = rearmHarness({ rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW] });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [], 'the byte would STOP the live recording');
  assert.strictEqual(h.watcher.rearmCount(), 0);
  h.watcher.dispose();
});

test('the recorder having finished re-arms normally, which is the whole point', async () => {
  // The SAME layout with the indicator gone. Without this row the test above
  // passes for a gate that blocks unconditionally — the feature would be dead
  // and the suite green.
  const h = rearmHarness({
    rows: [{ text: EMPTY_COMPOSER, cursor: true }, ' agents \u00b7 tap to talk'],
  });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [' ']);
  h.watcher.dispose();
});

test('the indicator scan reads BELOW the cursor and never above it', async () => {
  // Both directions in one shape. The row above is ordinary transcript that
  // CONTAINS the indicator's exact bytes — an agent printing this row, or a
  // scan that walks up into scrollback, must not read as recording. U+23FA
  // opens every tool bullet, so upward scanning was a measured false positive.
  const h = rearmHarness({
    rows: [REC_ROW, { text: EMPTY_COMPOSER, cursor: true }],
  });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [' '], 'a REC row ABOVE the composer is transcript');
  h.watcher.dispose();
});

test('the indicator is seen even though it paints RIGHT of the cursor', async () => {
  // The composer read truncates at cursorX, so a scan reusing that read would
  // never see an indicator on the cursor's own row. Measured through a real
  // xterm: full row `❯  agents ⏺ REC · tap to send`, cursorX 2.
  //
  // The two cases are a PAIR and neither is meaningful alone. Silence is
  // produced just as well by a composer read that broke and saw a non-empty
  // row, so the second case — same shape, same cursorX, right-of-cursor
  // content that is NOT the indicator — is what says the silence came from
  // the indicator rather than from a widened composer read.
  const h = rearmHarness({
    rows: [{ text: EMPTY_COMPOSER + REC_ROW, cursorX: 2, cursor: true }],
  });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [], 'the untruncated row carries the indicator');

  const quiet = rearmHarness({
    rows: [{
      text: EMPTY_COMPOSER + ' agents \u00b7 tap to talk', cursorX: 2, cursor: true,
    }],
  });
  quiet.turn();
  await quiet.done();
  assert.deepStrictEqual(quiet.writes, [' '],
    'right-of-cursor content must not widen the composer read');
  quiet.watcher.dispose();
  h.watcher.dispose();
});

test('a throwing environment declines rather than writing', async () => {
  for (const patch of [
    { getConfig: () => { throw new Error('x'); } },
    { getAttention: () => { throw new Error('x'); } },
    { getVoiceMode: () => { throw new Error('x'); } },
    { getTriggerKey: () => { throw new Error('x'); } },
  ]) {
    const writes = [];
    const term = fakeTerminal({ rows: [{ text: '❯ ' }] });
    const watcher = createVoiceSubmitWatcher(term, {
      getConfig: () => ({ enabled: true, rearm: true, phrase: DEFAULT_SUBMIT_PHRASE }),
      getAttention: () => null,
      getVoiceMode: () => 'tap',
      getTriggerKey: () => ' ',
      // Wired TRUE so the decline below is attributable to the patched throw.
      // Left unwired they default false and every row would pass on one of the
      // two gates, asserting nothing about the throw each row exists to cover.
      isMicTarget: () => true,
      isAppFocused: () => true,
      write: (d) => writes.push(d),
      quietMs: TEST_QUIET_MS,
      rearmMs: TEST_REARM_MS,
      ...patch,
    });
    watcher.noteActivity('thinking');
    watcher.noteActivity('idle', true);
    await settle(TEST_REARM_MS + 25);
    assert.deepStrictEqual(writes, [], Object.keys(patch)[0]);
    watcher.dispose();
  }
});

test("re-arm and submit stay independent: neither writes the other's bytes", async () => {
  // The submit half sends backspaces then \r; the re-arm sends one character.
  // A regression routing either through the other shows up here as the wrong
  // byte sequence for the situation.
  const h = rearmHarness({ rows: ['❯ finish the report over and out'] });
  h.term.write('❯ finish the report over and out');
  await settle(TEST_QUIET_MS + ENTER_SETTLE_MS + 25);
  assert.deepStrictEqual(h.writes, ['\x7f'.repeat(13), '\r'], 'submit path unchanged');
  // And the re-arm declines that same composer, because it is not empty.
  const before = h.writes.length;
  h.turn();
  await h.done();
  assert.strictEqual(h.writes.length, before, 're-arm stayed out of a full composer');
  h.watcher.dispose();
});

// MF1: `thinking -> idle` is NOT turn-end. Two emitters produce that edge
// mid-turn — the wire tracker's gap-idle timer when a tool runs longer than
// its gap with nothing in flight, and the jsonl watcher's 1s text flush
// between tool calls. The CLI's key handler is LIVE mid-turn: measured in
// 2.1.251, it gates on the voice auth gate and `isActive`, and `isActive` at
// the main REPL is `!panelOpen`, not a busy flag. So a byte written on one of
// these edges is swallowed and ARMS the recorder mid-turn — a live microphone
// nobody asked for, on exactly the long turns this feature is for. Both gates
// below are load-bearing and cover different emitters; neither alone is
// enough.

test('MF1: a mid-turn idle with turnEnd false writes nothing', async () => {
  const h = rearmHarness();
  h.midTurnIdle();
  await h.done();
  assert.deepStrictEqual(h.writes, []);
  assert.strictEqual(h.watcher.rearmCount(), 0);
  h.watcher.dispose();
});

test('MF1: turnEnd must be exactly true, not merely truthy-by-absence', async () => {
  // The renderer passes `turnEnd === true`; an older main process that sends
  // no third argument at all must decline rather than re-arm on every flush.
  for (const flag of [undefined, null, 0, '', 'yes', 1]) {
    const h = rearmHarness();
    h.watcher.noteActivity('thinking');
    h.watcher.noteActivity('idle', flag);
    await h.done();
    assert.deepStrictEqual(h.writes, [], `turnEnd ${JSON.stringify(flag)}`);
    h.watcher.dispose();
  }
});

test('MF1: a paint AFTER the edge delays the re-arm, then it fires once quiet', async () => {
  // THE PRODUCTION ORDERING. On the wire path `turnCompleted` fires when the
  // tee finishes the upstream stream, so the CLI has not drawn its answer yet
  // and the composer repaint ALWAYS lands after the edge. A version of this
  // that returned on a recent paint declined permanently, on the only path
  // carrying a truthful turnEnd — the feature never fired at all.
  const h = rearmHarness();
  h.turn();
  await settle(1);
  h.term.write(EMPTY_COMPOSER);
  await h.done();
  // Delayed by the paint, not abandoned because of it.
  assert.deepStrictEqual(h.writes, [' ']);
  assert.strictEqual(h.watcher.rearmCount(), 1, 'exactly once, not once per reschedule');
  h.watcher.dispose();
});

test('MF1: a terminal that never goes quiet is never written into', async () => {
  // The reschedule must not decay into an unconditional write once the paints
  // stop being checked.
  //
  // The clock is driven rather than raced: each paint stamps `lastWriteAt`
  // 1000ms further ahead, so every attempt sees a paint that just happened, no
  // matter how the real timers jitter. Racing wall-clock here made this test
  // fail 3 runs in 5 — and a flaky pin on an interlock is worse than none,
  // because it gets muted.
  // Painting on a REAL timer cannot express this: `settle(5)` sleeps ~11ms, so
  // a gap wider than rearmMs opens between paints and the re-arm fires in it.
  // Freeze the clock instead — every attempt then reads a paint that happened
  // "now" — and let the loop run long enough in real time for several settles
  // to have fired.
  const h = rearmHarness();
  h.turn();
  h.term.write(EMPTY_COMPOSER);
  h.clock.frozen = h.clock.now();
  for (let i = 0; i < 6; i += 1) {
    h.term.write(EMPTY_COMPOSER);
    await settle(TEST_REARM_MS);
  }
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('MF1: one edge cannot reschedule forever — the abandon deadline holds', async () => {
  // A terminal that keeps painting past the deadline stops being waited on, so
  // one edge cannot hold a timer alive behind a spinner or a tailing log.
  // abandonMs 0: the deadline is already past on the first attempt, so the
  // branch under test is reached the moment the terminal is seen painting.
  const h = rearmHarness({ abandonMs: 0 });
  h.turn();
  // Freeze with a paint stamped NOW, so every attempt sees "still painting"
  // and the deadline has passed — abandon, rather than reschedule.
  h.term.write(EMPTY_COMPOSER);
  h.clock.frozen = h.clock.now();
  await h.done();
  assert.deepStrictEqual(h.writes, [], 'abandoned, not merely delayed');

  // Abandonment is per-EDGE, not permanent: unfreeze, let it go quiet, and a
  // fresh turn end re-arms normally.
  h.clock.frozen = null;
  await settle(TEST_REARM_MS + 5);
  assert.deepStrictEqual(h.writes, [], 'the abandoned edge must not resurrect');
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [' ']);
  h.watcher.dispose();
});

// ---------------------------------------------------- speech vs the re-arm
//
// THE RACE, reported from the live microphone, which is the only place it is
// observable: with the re-arm on and speech on, both fire on the same turn-end
// edge, so the recorder hears `say` and transcribes the narration into the
// composer. The interlocks that already existed cover neither half of this —
// interruptForRecorder covers a tap DURING narration, _maybeSpeak covers
// starting to speak into a LIVE mic, and this is the two starting together.
//
// These assert on what reached the pty, not on a predicate: the deferral can be
// deleted and leave every function still returning the right answer while the
// byte goes out anyway.

test('SPEECH: nothing is written while a narration is playing', async () => {
  const h = rearmHarness({ speaking: true });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [], 'the recorder would transcribe the narration');
  assert.strictEqual(h.watcher.rearmCount(), 0);
  h.watcher.dispose();
});

test('SPEECH OFF: the re-arm fires exactly as it does today', async () => {
  // The other direction, and it is not optional. The test above passes just as
  // well on a build whose re-arm never fires at all — this is what says the
  // deferral is a WAIT rather than a silence, and it is the operator's explicit
  // requirement that a seat with speech off is unchanged.
  const h = rearmHarness({ speaking: false });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [' ']);
  assert.strictEqual(h.watcher.rearmCount(), 1);
  h.watcher.dispose();
});

test('SPEECH: the deferred re-arm fires once the narration ENDS', async () => {
  // `say` blocks until playback completes, so main's exit callback flips this
  // flag at the end of audio. The wait must resume from it — a deferral that
  // never re-armed would be indistinguishable from the test above.
  const h = rearmHarness({ speaking: true });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [], 'still talking');
  h.env.speaking = false;
  await h.done();
  assert.deepStrictEqual(h.writes, [' '], 'the microphone comes back when the room is quiet');
  assert.strictEqual(h.watcher.rearmCount(), 1, 'once, not once per reschedule');
  h.watcher.dispose();
});

test('SPEECH: a narration does not spend the abandon budget', async () => {
  // REARM_ABANDON_MS bounds a DOOMED retry loop; waiting out audio is not that.
  //
  // THE SEQUENCE MATTERS, and an earlier version of this test did not have it.
  // The deadline is consulted ONLY inside the still-painting branch, so merely
  // deferring and then releasing never reads it — that test passed with the
  // extension deleted (found by mutation). The case where narration having
  // eaten the budget actually bites is: narration ends, the CLI then PAINTS,
  // and the paint-wait consults a deadline the narration already exhausted.
  //
  // The CLOCK IS DRIVEN, not raced, for the same reason the MF1 abandon test
  // drives it: on real timers the post-narration attempt usually lands after the
  // quiet window and skips the still-painting branch altogether, so the deadline
  // is never read and the test passes either way. Freezing with a paint stamped
  // NOW forces every attempt through the branch that consults it.
  //
  // abandonMs is just over one settle, so an unextended deadline is long gone by
  // the time the narration finishes.
  const h = rearmHarness({ speaking: true, abandonMs: TEST_REARM_MS + 1 });
  h.turn();
  for (let i = 0; i < 6; i += 1) await settle(TEST_REARM_MS);
  assert.deepStrictEqual(h.writes, [], 'still narrating');

  // Narration ends and the CLI repaints — the ordering the wire path always
  // produces, since the composer is drawn after the turn-end edge.
  h.env.speaking = false;
  h.term.write(EMPTY_COMPOSER);
  h.clock.frozen = h.clock.now();
  await settle(TEST_REARM_MS * 3);
  // Still painting, so nothing may have been written yet — but the edge must be
  // ALIVE, which is what the release below proves.
  assert.deepStrictEqual(h.writes, [], 'still painting');

  h.clock.frozen = null;
  await h.done();
  assert.deepStrictEqual(h.writes, [' '],
    'the paint after a long narration must not hit a deadline the narration ate');
  h.watcher.dispose();
});

test('SPEECH: a flag stuck true is abandoned rather than rescheduling forever', async () => {
  // The deferral pushes the abandon deadline out, so speech cannot spend the
  // re-arm's budget — which also means nothing else bounds this wait. The flag
  // mirrors a value MAIN owns, so a dropped false edge (a window that missed the
  // broadcast, a main that died mid-utterance) strands this side believing the
  // room is still talking, and an unbounded timer is what every other wait here
  // refuses. Found by mutation: with the flag pinned true the test process hung.
  const h = rearmHarness({ speaking: true, speechAbandonMs: TEST_REARM_MS });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [], 'nothing written while it believes the room is talking');

  // THE DISCRIMINATOR, and without it this test passes on an unbounded build:
  // releasing the flag with NO new turn must write nothing, because the edge was
  // abandoned. A wait that was merely still running would fire here instead.
  h.env.speaking = false;
  await h.done();
  assert.deepStrictEqual(h.writes, [], 'the abandoned edge must not resurrect when the flag clears');

  // And the abandonment is per-EDGE: a fresh turn end re-arms normally, so one
  // stuck flag costs a single re-arm rather than the feature.
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [' ']);
  h.watcher.dispose();
});

test('SPEECH: an abandoned deferral does not poison the NEXT turn', async () => {
  // THE LEAK, and it needs no operator action to reach: an injected dm, a
  // reminder or a peer message starts the new turn all by itself.
  //
  // `speechDeferredSince` is per-EDGE state, but it was cleared only on the
  // fall-through where speech is already over. Every early return from
  // attemptRearm during a deferral leaves it set — and two are reachable, the
  // stale-edge return and the still-painting abandon. So the NEXT edge inherits
  // the old start stamp, reads its budget as already spent, and returns without
  // deferring AND without rescheduling: nothing fires when speech ends, because
  // no timer survives. It then only heals on a turn end with no narration, which
  // is the uncommon case once speech is on.
  //
  // The distinguishing move from the test above: `speaking` stays TRUE across
  // the second edge. Clearing it first is what masked this.
  //
  // The CLOCK IS DRIVEN, and it has to be: the budget must be exhausted by the
  // FIRST edge and still have room for the second, so the gap between the edges
  // is jumped rather than slept. With a budget small enough to expire in real
  // settle time, the second edge abandons on its own merits and the test cannot
  // tell the leak from correct behaviour — which is exactly what a first
  // version of it did.
  const BUDGET = 200;
  const h = rearmHarness({ speaking: true, speechAbandonMs: BUDGET });

  h.turn();
  await settle(TEST_REARM_MS * 3);
  assert.deepStrictEqual(h.writes, [], 'first edge is deferring, narration playing');

  // Jump past the budget so the FIRST edge abandons — the state this leaks.
  h.clock.offset += BUDGET + 100;
  await settle(TEST_REARM_MS * 3);
  assert.deepStrictEqual(h.writes, [], 'first edge abandoned, no timer left');

  // A fresh turn arrives WHILE the narration is still playing — an injected dm,
  // a reminder or a peer message is enough to produce it.
  h.turn();
  await settle(TEST_REARM_MS * 3);
  assert.deepStrictEqual(h.writes, [], 'second edge: still speaking, so still nothing');

  // Speech ends. This edge is entitled to its OWN budget, so the re-arm the
  // operator is waiting for must fire. Without the reset in noteActivity the
  // second edge inherited the first's spent stamp, returned without scheduling
  // anything, and nothing survives to fire here.
  h.env.speaking = false;
  await h.done();
  assert.deepStrictEqual(h.writes, [' '],
    'the new edge must get its own budget, not the previous edge\'s exhausted one');
  h.watcher.dispose();
});

test('SPEECH: a tap DURING the narration is not re-armed on top of', async () => {
  // He tapped the microphone himself while the reply was being read out. Main
  // kills the narration (interruptForRecorder), so the flag clears — and the
  // deferred attempt must NOT then write a character into a recorder he just
  // started, where the byte would STOP it and drop what he is saying.
  const h = rearmHarness({
    speaking: true,
    rows: [{ text: EMPTY_COMPOSER, cursor: true }],
  });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, []);
  // The tap: the indicator lights, and the narration is killed by it.
  h.term._state.rows = [{ text: EMPTY_COMPOSER, cursor: true }, { text: REC_ROW }];
  h.env.speaking = false;
  await h.done();
  assert.deepStrictEqual(h.writes, [], 'the byte would stop the recording he just started');
  h.watcher.dispose();
});

test('SPEECH: an absent signal leaves the path byte-identical to before', async () => {
  // No `getSpeakerBusy` at all — an older main, or a host that wires no speaker.
  // The default must be "not speaking", or the feature wedges on every box that
  // cannot report.
  const writes = [];
  const term = fakeTerminal({ rows: [{ text: EMPTY_COMPOSER }] });
  const watcher = createVoiceSubmitWatcher(term, {
    getConfig: () => ({ enabled: true, rearm: true, phrase: DEFAULT_SUBMIT_PHRASE }),
    getAttention: () => null,
    getVoiceMode: () => 'tap',
    getTriggerKey: () => ' ',
    // The seat under test holds the microphone and Clodex is frontmost; the
    // absent SPEAKER signal is the variable this test is isolating.
    isMicTarget: () => true,
    isAppFocused: () => true,
    write: (d) => writes.push(d),
    quietMs: TEST_QUIET_MS,
    rearmMs: TEST_REARM_MS,
  });
  watcher.noteActivity('thinking');
  watcher.noteActivity('idle', true);
  await settle(TEST_REARM_MS + TEST_QUIET_MS + ENTER_SETTLE_MS + 25);
  assert.deepStrictEqual(writes, [' ']);
  watcher.dispose();
});

test('SPEECH: a throwing busy read declines to defer rather than wedging', async () => {
  const writes = [];
  const term = fakeTerminal({ rows: [{ text: EMPTY_COMPOSER }] });
  const watcher = createVoiceSubmitWatcher(term, {
    getConfig: () => ({ enabled: true, rearm: true, phrase: DEFAULT_SUBMIT_PHRASE }),
    getAttention: () => null,
    getVoiceMode: () => 'tap',
    getTriggerKey: () => ' ',
    getSpeakerBusy: () => { throw new Error('x'); },
    isMicTarget: () => true,
    isAppFocused: () => true,
    write: (d) => writes.push(d),
    quietMs: TEST_QUIET_MS,
    rearmMs: TEST_REARM_MS,
  });
  watcher.noteActivity('thinking');
  watcher.noteActivity('idle', true);
  await settle(TEST_REARM_MS + TEST_QUIET_MS + ENTER_SETTLE_MS + 25);
  assert.deepStrictEqual(writes, [' '],
    'a broken signal must not silence the feature — the cost of a missed defer is one narration');
  watcher.dispose();
});

test('SPEECH: the defer check sits BELOW the still-painting branch', async () => {
  // A source-shape pin on an ORDER no runtime fixture can reach. The abandon
  // deadline is consulted only inside the still-painting branch, so hoisting the
  // speech check above it breaks the `abandonMs: 0` pin's premise — and the
  // standing rule in this file's header says the same about any new top check.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'voice-submit-watcher.js'), 'utf-8');
  const body = src.slice(src.indexOf('function attemptRearm()'));
  const painting = body.indexOf('if (quietFor < rearmMs)');
  const speech = body.indexOf('getSpeakerBusy()');
  assert.ok(painting > 0 && speech > 0, 'both branches must still be there');
  assert.ok(painting < speech,
    'the speech defer must not be hoisted above the still-painting branch');
});

// ------------------------------------------------- the microphone has ONE target

// The operator was dictating to one seat when a DIFFERENT seat, in a DIFFERENT
// workspace window, finished a turn and re-armed. Both recorders went
// live and his speech landed in both composers — and a sentence ending in the
// trigger phrase would have SENT a turn to an agent he was not addressing.
//
// The fix is an invariant, not a gate: main names ONE seat box-wide, and a
// re-arm may arm that seat and no other. A per-seat "may I arm?" test is what
// failed, because `activeSession` is per-WINDOW — with two windows open, two
// seats each answer yes to it truthfully.
//
// Both directions are pinned below. A build that never re-arms at all also
// stops the operator's speech reaching two agents, and is not a fix.

test('TARGET: a seat that does not hold the microphone writes NOTHING', async () => {
  const h = rearmHarness({ micTarget: false });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [],
    'the background seat finished a turn and must not arm a second recorder');
  assert.strictEqual(h.watcher.rearmCount(), 0);
  h.watcher.dispose();
});

test('TARGET: the seat that DOES hold it still arms', async () => {
  // The other half, and the reason the pin above is not satisfied by a build
  // that re-arms nowhere. Identical fixture, one flag apart.
  const h = rearmHarness({ micTarget: true });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [' ']);
  assert.strictEqual(h.watcher.rearmCount(), 1);
  h.watcher.dispose();
});

test('TARGET: two seats, one microphone — only the holder arms on the same edge', async () => {
  // THE BUG ITSELF, with both seats present. Two watchers, as two workspace
  // windows have, each reading the SAME box-wide name: A holds it, B finishes a
  // turn. Asserting on B alone would pass against a build where nobody arms, so
  // both are driven through one edge and both are asserted.
  const target = { name: 'A' };
  const mk = (seat) => {
    const writes = [];
    const term = fakeTerminal({ rows: [{ text: EMPTY_COMPOSER }] });
    const watcher = track(createVoiceSubmitWatcher(term, {
      getConfig: () => ({ enabled: true, rearm: true, phrase: DEFAULT_SUBMIT_PHRASE }),
      getAttention: () => null,
      getVoiceMode: () => 'tap',
      getTriggerKey: () => ' ',
      isMicTarget: () => target.name === seat,
      isAppFocused: () => true,
      write: (d) => writes.push(d),
      quietMs: TEST_QUIET_MS,
      rearmMs: TEST_REARM_MS,
    }));
    return { watcher, writes };
  };
  const a = mk('A');
  const b = mk('B');

  // B's turn ends while the operator is talking to A — the reported sequence.
  b.watcher.noteActivity('thinking');
  b.watcher.noteActivity('idle', true);
  await settle(TEST_REARM_MS + TEST_QUIET_MS + ENTER_SETTLE_MS + 25);
  assert.deepStrictEqual(b.writes, [], 'B is not the target and must arm nothing');

  // And A, on its own edge, does arm: the microphone still works.
  a.watcher.noteActivity('thinking');
  a.watcher.noteActivity('idle', true);
  await settle(TEST_REARM_MS + TEST_QUIET_MS + ENTER_SETTLE_MS + 25);
  assert.deepStrictEqual(a.writes, [' '], 'A holds it and arms');
  assert.deepStrictEqual(b.writes, [], "A's edge did not arm B either");
});

test('TARGET: an absent signal DECLINES, opposite to the speaker default', async () => {
  // The polarities differ on purpose and the difference is the cost of being
  // wrong. An unwired speaker signal costs one narration transcribed into a
  // composer; an unwired target signal costs the operator's words reaching an
  // agent he did not address, which is what this ticket is about. So this one
  // fails CLOSED where getSpeakerBusy fails open.
  const writes = [];
  const term = fakeTerminal({ rows: [{ text: EMPTY_COMPOSER }] });
  const watcher = createVoiceSubmitWatcher(term, {
    getConfig: () => ({ enabled: true, rearm: true, phrase: DEFAULT_SUBMIT_PHRASE }),
    getAttention: () => null,
    getVoiceMode: () => 'tap',
    getTriggerKey: () => ' ',
    // Frontmost, so the decline below is attributable to the ABSENT target
    // signal this test is about and not to the other gate.
    isAppFocused: () => true,
    write: (d) => writes.push(d),
    quietMs: TEST_QUIET_MS,
    rearmMs: TEST_REARM_MS,
  });
  watcher.noteActivity('thinking');
  watcher.noteActivity('idle', true);
  await settle(TEST_REARM_MS + TEST_QUIET_MS + ENTER_SETTLE_MS + 25);
  assert.deepStrictEqual(writes, []);
  watcher.dispose();
});

test('TARGET: a throwing read declines, and does not take the watcher down', async () => {
  const writes = [];
  const term = fakeTerminal({ rows: [{ text: EMPTY_COMPOSER }] });
  const watcher = createVoiceSubmitWatcher(term, {
    getConfig: () => ({ enabled: true, rearm: true, phrase: DEFAULT_SUBMIT_PHRASE }),
    getAttention: () => null,
    getVoiceMode: () => 'tap',
    getTriggerKey: () => ' ',
    isMicTarget: () => { throw new Error('x'); },
    isAppFocused: () => true,
    write: (d) => writes.push(d),
    quietMs: TEST_QUIET_MS,
    rearmMs: TEST_REARM_MS,
  });
  watcher.noteActivity('thinking');
  watcher.noteActivity('idle', true);
  await settle(TEST_REARM_MS + TEST_QUIET_MS + ENTER_SETTLE_MS + 25);
  assert.deepStrictEqual(writes, []);
  watcher.dispose();
});

test('TARGET: exactly true, not merely truthy', async () => {
  // The value crosses IPC as a name compared in the renderer, so a host that
  // returned the NAME rather than the comparison would arm on a value that
  // never meant "this seat holds it" — and the truthy ones are the dangerous
  // half, since those arm.
  //
  // Constructed directly rather than through rearmHarness, whose `micTarget`
  // DEFAULTS to true: an `undefined` row there exercises the harness default
  // and asserts nothing about the watcher.
  for (const v of ['A', 1, {}, 'true', [], undefined, null, 0, '']) {
    const writes = [];
    const term = fakeTerminal({ rows: [{ text: EMPTY_COMPOSER }] });
    const watcher = createVoiceSubmitWatcher(term, {
      getConfig: () => ({ enabled: true, rearm: true, phrase: DEFAULT_SUBMIT_PHRASE }),
      getAttention: () => null,
      getVoiceMode: () => 'tap',
      getTriggerKey: () => ' ',
      isMicTarget: () => v,
      isAppFocused: () => true,
      write: (d) => writes.push(d),
      quietMs: TEST_QUIET_MS,
      rearmMs: TEST_REARM_MS,
    });
    watcher.noteActivity('thinking');
    watcher.noteActivity('idle', true);
    await settle(TEST_REARM_MS + TEST_QUIET_MS + ENTER_SETTLE_MS + 25);
    assert.deepStrictEqual(writes, [], `micTarget ${JSON.stringify(v)}`);
    watcher.dispose();
  }
});

test('TARGET: losing the microphone mid-wait declines at the timer', async () => {
  // The gate is re-read when the timer LANDS, not captured at the edge — an
  // external tap can move the target during the settle window, and a captured
  // answer would arm the seat that no longer holds it.
  const h = rearmHarness({ micTarget: true });
  h.turn();
  h.env.micTarget = false;
  await h.done();
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('TARGET: the check sits BELOW the still-painting branch', () => {
  // Same source-shape pin as the speech defer's, and the same standing rule:
  // the abandon deadline is consulted only inside the still-painting branch, so
  // a new check hoisted above it breaks the `abandonMs: 0` pin's premise.
  //
  // Also ABOVE the speech branch: a seat that cannot arm has no business
  // spending a speech budget waiting out a narration it will decline after.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'voice-submit-watcher.js'), 'utf-8');
  const body = src.slice(src.indexOf('function attemptRearm()'));
  const painting = body.indexOf('if (quietFor < rearmMs)');
  const target = body.indexOf('isMicTarget()');
  const speech = body.indexOf('getSpeakerBusy()');
  assert.ok(painting > 0 && target > 0 && speech > 0, 'all three must still be there');
  assert.ok(painting < target, 'the target check must not be hoisted above the still-painting branch');
  assert.ok(target < speech, 'a non-target seat must decline before it defers on speech');
});

// ------------------------------------------- the app must be FRONTMOST to arm

// The same bug class as the target above, one layer out. The operator was
// browsing the web with Clodex in the BACKGROUND when an agent's turn ended:
// the re-arm fired and the CLI transcribed the VIDEO he was watching into that
// seat's composer — four turns of ambient narration reached the agent.
//
// The target invariant does not stop it, and that is why this is a SECOND
// condition rather than a refinement: that seat legitimately held the
// microphone. The target answers WHICH seat; this answers whether anyone is
// there at all. Neither implies the other, and the tests below assert exactly
// that by moving one with the other held fixed.

test('FRONTMOST: a backgrounded app writes NOTHING, even on the target seat', async () => {
  const h = rearmHarness({ micTarget: true, appFocused: false });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [],
    'the microphone must not arm into a room Clodex is not in front of');
  assert.strictEqual(h.watcher.rearmCount(), 0);
  h.watcher.dispose();
});

test('FRONTMOST: with the app in front, the target seat still arms', async () => {
  // The other direction, and the reason the pin above is not satisfied by a
  // build that re-arms nowhere. Identical fixture, one flag apart.
  const h = rearmHarness({ micTarget: true, appFocused: true });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [' ']);
  assert.strictEqual(h.watcher.rearmCount(), 1);
  h.watcher.dispose();
});

test('FRONTMOST: the two conditions are INDEPENDENT — three of four cases decline', async () => {
  // The whole truth table, because a build that ANDed one condition into the
  // other would pass either pin above on its own. Each row carries its expected
  // writes as a literal rather than as a rule the test re-derives.
  const cases = [
    [true, true, [' ']],
    [true, false, []],
    [false, true, []],
    [false, false, []],
  ];
  for (const [micTarget, appFocused, expected] of cases) {
    const h = rearmHarness({ micTarget, appFocused });
    h.turn();
    await h.done();
    assert.deepStrictEqual(h.writes, expected,
      `target=${micTarget} frontmost=${appFocused}`);
    h.watcher.dispose();
  }
});

test('FRONTMOST: alt-tabbing away DURING the settle window declines at the timer', async () => {
  // The gate is re-read when the timer LANDS, not captured at the edge. This is
  // the realistic shape of the reported bug: the turn ends while he is still in
  // Clodex, and he switches to the browser before the re-arm fires.
  const h = rearmHarness({ appFocused: true });
  h.turn();
  h.env.appFocused = false;
  await h.done();
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('FRONTMOST: an absent signal DECLINES', async () => {
  // Fails CLOSED, opposite to getSpeakerBusy and identical to the target gate:
  // an unwired speaker signal costs one narration, an unwired focus signal
  // records the operator's living room.
  const writes = [];
  const term = fakeTerminal({ rows: [{ text: EMPTY_COMPOSER }] });
  const watcher = createVoiceSubmitWatcher(term, {
    getConfig: () => ({ enabled: true, rearm: true, phrase: DEFAULT_SUBMIT_PHRASE }),
    getAttention: () => null,
    getVoiceMode: () => 'tap',
    getTriggerKey: () => ' ',
    isMicTarget: () => true,
    write: (d) => writes.push(d),
    quietMs: TEST_QUIET_MS,
    rearmMs: TEST_REARM_MS,
  });
  watcher.noteActivity('thinking');
  watcher.noteActivity('idle', true);
  await settle(TEST_REARM_MS + TEST_QUIET_MS + ENTER_SETTLE_MS + 25);
  assert.deepStrictEqual(writes, []);
  watcher.dispose();
});

test('FRONTMOST: a throwing read declines rather than arming', async () => {
  const writes = [];
  const term = fakeTerminal({ rows: [{ text: EMPTY_COMPOSER }] });
  const watcher = createVoiceSubmitWatcher(term, {
    getConfig: () => ({ enabled: true, rearm: true, phrase: DEFAULT_SUBMIT_PHRASE }),
    getAttention: () => null,
    getVoiceMode: () => 'tap',
    getTriggerKey: () => ' ',
    isMicTarget: () => true,
    isAppFocused: () => { throw new Error('x'); },
    write: (d) => writes.push(d),
    quietMs: TEST_QUIET_MS,
    rearmMs: TEST_REARM_MS,
  });
  watcher.noteActivity('thinking');
  watcher.noteActivity('idle', true);
  await settle(TEST_REARM_MS + TEST_QUIET_MS + ENTER_SETTLE_MS + 25);
  assert.deepStrictEqual(writes, []);
  watcher.dispose();
});

test('FRONTMOST: exactly true, not merely truthy', async () => {
  for (const v of [1, {}, 'true', [], undefined, null, 0, '']) {
    const writes = [];
    const term = fakeTerminal({ rows: [{ text: EMPTY_COMPOSER }] });
    const watcher = createVoiceSubmitWatcher(term, {
      getConfig: () => ({ enabled: true, rearm: true, phrase: DEFAULT_SUBMIT_PHRASE }),
      getAttention: () => null,
      getVoiceMode: () => 'tap',
      getTriggerKey: () => ' ',
      isMicTarget: () => true,
      isAppFocused: () => v,
      write: (d) => writes.push(d),
      quietMs: TEST_QUIET_MS,
      rearmMs: TEST_REARM_MS,
    });
    watcher.noteActivity('thinking');
    watcher.noteActivity('idle', true);
    await settle(TEST_REARM_MS + TEST_QUIET_MS + ENTER_SETTLE_MS + 25);
    assert.deepStrictEqual(writes, [], `appFocused ${JSON.stringify(v)}`);
    watcher.dispose();
  }
});

test('FRONTMOST: the check sits BELOW the still-painting branch', () => {
  // The placement rule has not changed: the abandon deadline is consulted only
  // inside the still-painting branch, so a new check hoisted above it breaks
  // the `abandonMs: 0` pin's premise.
  //
  // Also above the speech branch, with the target: a seat that may not arm at
  // all has no business spending a speech budget waiting out a narration.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'voice-submit-watcher.js'), 'utf-8');
  const body = src.slice(src.indexOf('function attemptRearm()'));
  const painting = body.indexOf('if (quietFor < rearmMs)');
  const front = body.indexOf('isAppFocused()');
  const speech = body.indexOf('getSpeakerBusy()');
  assert.ok(painting > 0 && front > 0 && speech > 0, 'all three must still be there');
  assert.ok(painting < front, 'the frontmost check must not be hoisted above the still-painting branch');
  assert.ok(front < speech, 'a backgrounded app must decline before it defers on speech');
});

// MF2: our "empty" must not be laxer than the CLI's `value.length > 0`, or we
// write a character it declines to swallow — which lands in the draft and
// blocks every later re-arm.

test('MF2: a whitespace-bearing draft is not an empty composer', async () => {
  // Dictation prepends a space, so this is reachable with no mid-turn idle
  // involved at all.
  const h = rearmHarness({ rows: ['❯  '] });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, []);
  h.watcher.dispose();
});

test('MF2: a row with no prompt marker is not a composer', async () => {
  // A dialog interior and a mid-repaint screen both look like this, and the
  // settle window must not be the only thing standing between the byte and a
  // permission dialog.
  for (const row of ['│ ', '', '   ', '│']) {
    const h = rearmHarness({ rows: [row] });
    h.turn();
    await h.done();
    assert.deepStrictEqual(h.writes, [], JSON.stringify(row));
    h.watcher.dispose();
  }
});

// -------------------------------------------------------- the voice-origin marker

// The marker tells the receiving agent the text was spoken, so it can read a
// garbled word as a mis-transcription rather than a deliberate choice. Two
// properties carry the whole feature, and both are asserted on ORDER and on
// what reached the pty rather than on a return value:
//
//   1. IT MARKS ONLY VOICE. The trigger phrase submits a TYPED draft ending in
//      those words too, and marking that teaches the reader to distrust the
//      marker on text the operator typed exactly.
//   2. THE ARM PRECEDES ENTER. A marker registered after the submitted text
//      reaches the model rides the wrong turn — or, worse, the NEXT one, which
//      may be typed.

// The buffer harness above takes no marker seam; this is the same shape with
// one. `events` records the marker and the writes in ONE list, because the
// ordering between them is the property under test and two separate lists
// cannot express it.
function markHarness({
  rows = [''],
  // `composition: true` because the dictation half is gated on it — without it
  // the composition tests below reach no commit, and the `ENTER:` guards are
  // what say so rather than letting the mark assertions vacuum out.
  config = { enabled: true, composition: true, phrase: DEFAULT_SUBMIT_PHRASE },
  attention = null, evidenceMs,
} = {}) {
  const events = [];
  const term = fakeTerminal({ rows: rows.map((r) => (typeof r === 'string' ? { text: r } : r)) });
  const env = { config, attention };
  // The commit stub calls back into the watcher it is a dependency OF, exactly
  // as the real one does through xterm.
  const watcherRef = {};
  const watcher = track(createVoiceSubmitWatcher(term, {
    getConfig: () => env.config,
    getAttention: () => env.attention,
    write: (d) => events.push(d === '\r' ? 'ENTER' : 'ERASE'),
    markVoiceOrigin: () => events.push('MARK'),
    quietMs: TEST_QUIET_MS,
    pollMs: 1,
    readComposition: () => env.composed ?? null,
    // MODELS THE REAL BOUNDARY, and the synchronous noteInput is the whole
    // reason: commitComposition dispatches the keydown that makes xterm fire
    // onData with the dictated text, so the local onData branch calls noteInput
    // DURING the commit. A stub that omits it cannot catch a stamp written
    // before the commit — which its own echo then clears — and that failure is
    // invisible in a green suite.
    commitComposition: () => {
      env.composed = null;
      watcherRef.watcher.noteInput('finish the report over and out');
      return true;
    },
    ...(evidenceMs === undefined ? {} : { evidenceMs }),
  }));
  watcherRef.watcher = watcher;
  return {
    term, watcher, events, env,
    done: () => settle(TEST_QUIET_MS + ENTER_SETTLE_MS + 25),
  };
}

test('a TYPED draft ending in the phrase submits UNMARKED', async () => {
  // The case Bogdan asked to be told about explicitly. No composition, no
  // recording indicator — nothing but a row of text — so there is no positive
  // evidence of a microphone and the submit must carry no marker.
  const h = markHarness();
  h.term.write('❯ finish the report over and out');
  await h.done();
  assert.deepStrictEqual(h.events, ['ERASE', 'ENTER'],
    'a typed submit must reach the pty with no marker between');
  assert.strictEqual(h.watcher.fireCount(), 1, 'ENTER: it must still have SUBMITTED');
  assert.strictEqual(h.watcher.markCount(), 0);
  h.watcher.dispose();
});

test('a DICTATED submit is marked, and the mark precedes both writes', async () => {
  // The ordering assertion. The marker must be registered before the text can
  // reach the model, so it rides this turn rather than the next.
  const h = markHarness();
  h.env.composed = ' finish the report over and out';
  await settle(TEST_QUIET_MS + 30);
  assert.strictEqual(h.watcher.commitCount(), 1, 'ENTER: the composition must have committed');
  // The commit echoes as an ordinary write, exactly as the real boundary does.
  h.term.write('❯ finish the report over and out');
  await h.done();
  assert.deepStrictEqual(h.events, ['MARK', 'ERASE', 'ENTER'],
    'the marker must be armed BEFORE the erase and the Enter');
  assert.strictEqual(h.watcher.markCount(), 1);
  h.watcher.dispose();
});

test('the CLI recording indicator is evidence too, and it marks the submit', async () => {
  // The CLI's own voice mode produces no composition: it transcribes straight
  // into the composer, so the indicator is the only moment the microphone is
  // visible from here.
  const h = markHarness({ rows: ['❯ ', ' agents ⏺ REC · tap to send'] });
  await settle(10); // one poll, to observe the indicator
  h.term.write('❯ finish the report over and out');
  await h.done();
  assert.deepStrictEqual(h.events, ['MARK', 'ERASE', 'ENTER']);
  assert.strictEqual(h.watcher.markCount(), 1);
  h.watcher.dispose();
});

test('evidence goes STALE, and a later submit is unmarked', async () => {
  // The staleness bound: evidence cannot outlive the utterance that produced it
  // and mark a message typed long afterwards.
  const h = markHarness({ rows: ['❯ ', ' agents ⏺ REC · tap to send'], evidenceMs: 1 });
  await settle(10);
  h.term.write('❯ ', ' agents · tap to speak'); // the recorder stopped
  await settle(20); // longer than evidenceMs
  h.term.write('❯ finish the report over and out');
  await h.done();
  assert.deepStrictEqual(h.events, ['ERASE', 'ENTER'], 'stale evidence must not mark');
  assert.strictEqual(h.watcher.markCount(), 0);
  h.watcher.dispose();
});

test('one utterance marks ONE submit: the evidence is consumed', async () => {
  const h = markHarness();
  h.env.composed = ' finish the report over and out';
  await settle(TEST_QUIET_MS + 30);
  h.term.write('❯ finish the report over and out');
  await h.done();
  assert.strictEqual(h.watcher.markCount(), 1);
  // A SECOND submit with no fresh evidence — the operator typed this one.
  h.term.write('❯ ');
  await settle(TEST_QUIET_MS + 5);
  h.term.write('❯ send it over and out');
  await h.done();
  assert.strictEqual(h.watcher.fireCount(), 2, 'ENTER: the second submit must have FIRED');
  assert.strictEqual(h.watcher.markCount(), 1, 'but it must not inherit the first utterance');
  h.watcher.dispose();
});

test('a lit indicator does NOT mark a TYPED submit: typing is evidence of not-voice', () => {
  // THE DEFECT this pin exists for, and the claim it falsifies is the one the
  // first round of this feature shipped on: "typing produces neither".
  //
  // The recording indicator is not evidence that THIS draft was spoken. t571's
  // own re-arm writes the trigger character at every turn end, so the indicator
  // is lit at the START of an ordinary typed turn — and the operator's typed
  // words then submit carrying a marker telling the agent they were dictated.
  // That is a mislabel of the operator's exact words, which is the one thing
  // the marker must never do.
  //
  // Driven through `noteInput`, the seam the local onData branch calls: typing
  // is POSITIVE EVIDENCE OF NOT-VOICE and mutes the indicator path until the
  // recorder next RISES.
  //
  // THE INDICATOR STAYS PAINTED WHILE THE DRAFT IS TYPED, and that is the whole
  // fixture. `fakeTerminal.write` REPLACES the row set, so painting the draft
  // alone silently removes the ` REC ` row — and an earlier version of this test
  // passed for exactly that reason, because the indicator had vanished rather
  // than because the code was right. A live recording composer shows both rows,
  // and the recorder stays lit for ~15s of silence after the re-arm lights it.
  const REC = ' agents \u23fa\u0020REC \u00b7 tap to send';
  const h = markHarness({ rows: ['\u276f ', REC] });
  return (async () => {
    await settle(10); // the indicator is observed and stamps evidence
    // The operator TYPES. Every keystroke reaches the local onData branch.
    for (const ch of 'finish the report over and out') h.watcher.noteInput(ch);
    // `cursor: true` on the DRAFT row: the composer read follows the cursor, and
    // the indicator paints BELOW it — which is the geometry indicatorRows() scans
    // and the one a live recording composer actually has.
    h.term.write({ text: '\u276f finish the report over and out', cursor: true }, REC);
    await h.done();
    assert.deepStrictEqual(h.events, ['ERASE', 'ENTER'],
      'a typed draft must submit UNMARKED even with the recorder lit');
    assert.strictEqual(h.watcher.markCount(), 0);
    assert.strictEqual(h.watcher.fireCount(), 1, 'ENTER: it must still have SUBMITTED');
    h.watcher.dispose();
  })();
});

test('terminal chatter is not typing: a mouse report must not clear voice evidence', async () => {
  // The gate that keeps the clear from eating the evidence it is meant to
  // preserve. xterm's onData also carries mouse reports and query replies — the
  // Claude pane enables tracking — so an ungated clear would wipe the stamp on
  // scroll alone and silently un-mark genuinely spoken text.
  const h = markHarness({ rows: ['\u276f ', ' agents \u23fa\u0020REC \u00b7 tap to send'] });
  await settle(10);
  h.watcher.noteInput('\x1b[<0;10;5M'); // an SGR mouse report, not a keystroke
  h.term.write('\u276f finish the report over and out');
  await h.done();
  assert.deepStrictEqual(h.events, ['MARK', 'ERASE', 'ENTER'],
    'chatter must leave the microphone evidence standing');
  assert.strictEqual(h.watcher.markCount(), 1);
  h.watcher.dispose();
});

test('the tap keypress clears evidence, and the indicator re-stamps it', async () => {
  // Tap-listening is the workflow that matters, so this is the case the fix
  // must NOT break. The operator presses the trigger key (a keystroke, so it
  // clears), the recorder lights, the poll re-stamps, and the transcription
  // that follows submits MARKED.
  const h = markHarness({ rows: ['\u276f ', ' agents \u00b7 tap to speak'] });
  h.watcher.noteInput(' '); // the tap keypress itself
  h.term.write('\u276f ', ' agents \u23fa\u0020REC \u00b7 tap to send'); // the recorder lights
  await settle(10); // the poll re-stamps from the indicator
  h.term.write('\u276f finish the report over and out'); // the transcription lands
  await h.done();
  assert.deepStrictEqual(h.events, ['MARK', 'ERASE', 'ENTER'],
    'tap-listening must still be marked');
  assert.strictEqual(h.watcher.markCount(), 1);
  h.watcher.dispose();
});

test('a LONG utterance keeps refreshing: the level stamp is not a rising edge', async () => {
  // The reason the fix mutes the level stamp rather than replacing it with a
  // bare rising-edge one, which is the obvious simplification.
  //
  // The recorder lights ONCE and stays lit while the operator speaks for longer
  // than the evidence window. With a rising-edge-only stamp the single edge ages
  // out of `evidenceMs` and a genuinely spoken message submits UNMARKED — a
  // silent loss of the feature on exactly the long dictations it is for. The
  // level stamp refreshes it on every poll; nothing here types, so the mute
  // never engages.
  const REC = ' agents \u23fa\u0020REC \u00b7 tap to send';
  const h = markHarness({ rows: ['\u276f ', REC], evidenceMs: 25 });
  // Lit throughout, and polled well past the window with no fresh RISE.
  await settle(80);
  h.term.write({ text: '\u276f finish the report over and out', cursor: true }, REC);
  await h.done();
  assert.deepStrictEqual(h.events, ['MARK', 'ERASE', 'ENTER'],
    'a still-running recorder must keep the evidence fresh past the window');
  assert.strictEqual(h.watcher.markCount(), 1);
  h.watcher.dispose();
});

test('typing MUTES the lit indicator for the whole draft, not just one poll', async () => {
  // The r1 defect in its exact shape: the clear was per-keystroke and the poll
  // re-stamped 300ms later, so a draft typed over several seconds under a lit
  // recorder ended up marked anyway. The mute has to survive the GAPS between
  // keystrokes, which is what a single-keystroke test cannot show.
  const REC = ' agents \u23fa\u0020REC \u00b7 tap to send';
  const h = markHarness({ rows: ['\u276f ', REC] });
  await settle(10);
  h.watcher.noteInput('f');
  await settle(20); // several polls pass with the indicator still lit
  h.watcher.noteInput('i');
  await settle(20);
  h.term.write({ text: '\u276f finish the report over and out', cursor: true }, REC);
  await h.done();
  assert.deepStrictEqual(h.events, ['ERASE', 'ENTER'],
    'polls between keystrokes must not re-stamp the muted indicator');
  assert.strictEqual(h.watcher.markCount(), 0);
  assert.strictEqual(h.watcher.fireCount(), 1, 'ENTER: it must still have SUBMITTED');
  h.watcher.dispose();
});

test('a permission dialog blocks the marker with the submit', async () => {
  // The marker rides the fire, so the interlock covers it for free — but a
  // marker armed for a submit that never happened would ride the NEXT turn,
  // which is the failure this asserts is impossible.
  const h = markHarness({ attention: 'permission' });
  h.env.composed = ' finish the report over and out';
  await settle(TEST_QUIET_MS + 30);
  h.term.write('❯ finish the report over and out');
  await h.done();
  assert.deepStrictEqual(h.events, [], 'nothing may be written OR armed behind a dialog');
  assert.strictEqual(h.watcher.markCount(), 0);
  h.watcher.dispose();
});

test('a marker that THROWS cannot cost the operator the submit', async () => {
  // Arming may never affect the keystroke: a dead wirescope costs the marker,
  // never the Enter.
  const events = [];
  const term = fakeTerminal({ rows: [{ text: '' }] });
  const watcher = track(createVoiceSubmitWatcher(term, {
    getConfig: () => ({ enabled: true, composition: true, phrase: DEFAULT_SUBMIT_PHRASE }),
    getAttention: () => null,
    write: (d) => events.push(d === '\r' ? 'ENTER' : 'ERASE'),
    markVoiceOrigin: () => { throw new Error('proxy is down'); },
    quietMs: TEST_QUIET_MS,
    pollMs: 1,
    readComposition: () => null,
  }));
  // Force evidence through the indicator path, then submit.
  term.write('❯ ', ' agents ⏺ REC · tap to send');
  await settle(10);
  term.write('❯ finish the report over and out');
  await settle(TEST_QUIET_MS + ENTER_SETTLE_MS + 25);
  assert.deepStrictEqual(events, ['ERASE', 'ENTER'], 'the submit must survive a throwing marker');
  assert.strictEqual(watcher.fireCount(), 1);
  watcher.dispose();
});

test('with no marker seam the submit is entirely unchanged', async () => {
  // The feature is an annotation on a submit, never a precondition for one.
  const h = fastHarness();
  h.term.write('❯ finish the report over and out');
  await h.done();
  assert.deepStrictEqual(h.writes, ['\x7f'.repeat(13), '\r']);
  assert.strictEqual(h.watcher.markCount(), 0);
  h.watcher.dispose();
});

// ------------------------------------ the recorder surviving OUR OWN submit

// THE PROCESSING ROW, spelled as escapes and captured from the CLI BINARY rather
// than from a screen: the operator reports it lingers ~500ms, too short to catch
// by hand. `strings` on the 2.1.251 binary gives the voice indicator component
// verbatim, and its processing arm is `children:"Voice: processing…"` --
// ASCII `Voice: processing` then a SINGLE U+2026, not three dots.
//
// The rule deliberately does not encode that ellipsis, so this table carries the
// CLI's real bytes AND the three-ASCII-dot form a normalisation would produce. A
// rule anchored on the ellipsis passes the first and fails the second, which is
// the shape where a fixture agrees with a broken rule.
const PROCESSING_ROW = ' agents Voice: processing\u2026';
const PROCESSING_ROW_ASCII = ' agents Voice: processing...';

test('the PROCESSING state blocks the re-arm, in every form the row can take', () => {
  // The CLI REPLACES the lit indicator with this rather than adding to it, so a
  // gate anchored only on the lit form reads NOT-RECORDING for this whole
  // window. Measured in 2.1.251: the tap handler's processing arm returns
  // WITHOUT swallowing a single-char trigger, so the key never reaches the
  // voice session -- it falls through as a literal into the composer, and from
  // then on composerIsEmpty is false and EVERY later re-arm is blocked until
  // the operator clears the draft by hand.
  for (const row of [
    PROCESSING_ROW,
    PROCESSING_ROW_ASCII,
    'Voice: processing',
    'Voice:processing\u2026',
    'Voice:\u00a0processing\u2026',
    'voice: PROCESSING\u2026',
  ]) {
    assert.strictEqual(recorderBlocksRearm([row]), true, JSON.stringify(row));
  }

  // Below the composer too, which is where the real footer paints it.
  assert.strictEqual(recorderBlocksRearm(['\u276f ', 'border', PROCESSING_ROW]), true);

  // The anchor must not swallow ordinary transcript. `processing` alone is a
  // common word in this repo's own output, which is why the rule requires
  // `Voice:` in front of it.
  for (const row of [
    'processing 4 files',
    'Voice: recording',
    '\u23fa Bash(echo processing)',
    'Voice',
    '',
  ]) {
    assert.strictEqual(recorderBlocksRearm([row]), false, JSON.stringify(row));
  }
});

test('THE INTERLOCK, PROCESSING: a recorder still finishing gets no character', async () => {
  // The CALL SITE, not the predicate. The predicate test above pins
  // `recorderBlocksRearm` in isolation, which stays green even if attemptRearm
  // is mutated back to `recordingObserved` -- and that mutation reopens the
  // stuck-composer bug: during the processing window a single-char trigger is
  // not swallowed, so it lands in the draft as a literal and blocks every later
  // re-arm until the operator clears it by hand.
  const h = rearmHarness({ rows: [{ text: EMPTY_COMPOSER, cursor: true }, PROCESSING_ROW] });
  h.turn();
  await h.done();
  assert.deepStrictEqual(h.writes, [], 'the byte would land in the draft and stick');
  assert.strictEqual(h.watcher.rearmCount(), 0);
  h.watcher.dispose();
});

test('recordingObserved stays REC-ONLY, so processing never draws the stop key', () => {
  // The two predicates must NOT be unified. `recorderBlocksRearm` widened to the
  // processing state because a key written there is not swallowed and sticks in
  // the composer; this one must not, because by then the recorder has ALREADY
  // stopped and the same key would ARM a recording nobody asked for.
  assert.strictEqual(recordingObserved([PROCESSING_ROW]), false,
    'processing is not a LIVE recording, and a key written there arms one');
  assert.strictEqual(recordingObserved([PROCESSING_ROW_ASCII]), false);
  assert.strictEqual(recordingObserved([REC_ROW]), true);
  // Unreadable is NOT lit, the opposite of the re-arm gate's polarity.
  assert.strictEqual(recordingObserved(null), false);
});

// The submit half with a trigger key wired, which the buffer harness above does
// not carry. Writes are recorded RAW into ONE list: WHICH byte submits, and that
// the erase leads it, is the entire property under test, and a substring check
// or two separate lists cannot express it.
// Small enough that a test waits out real time, large enough to sit outside this
// file's observed timer jitter -- the same trade TEST_QUIET_MS makes.
const TEST_STOP_SETTLE_MS = 20;
const TEST_SUBMIT_POLL_MS = 5;
// The deadline default is deliberately LONGER than `done()` waits, so a test that
// does not name it asserts the processing-cleared path and never the abandon one.
// The abandon tests pass their own.
const TEST_SUBMIT_ABANDON_MS = 5000;

function stopHarness({
  rows = [''],
  config = { enabled: true, rearm: true, phrase: DEFAULT_SUBMIT_PHRASE },
  attention = null,
  trigger = ' ',
  submitAbandonMs = TEST_SUBMIT_ABANDON_MS,
} = {}) {
  const writes = [];
  const term = fakeTerminal({ rows: rows.map((r) => (typeof r === 'string' ? { text: r } : r)) });
  const env = { config, attention, trigger, micTarget: true, appFocused: true };
  const watcher = track(createVoiceSubmitWatcher(term, {
    getConfig: () => env.config,
    getAttention: () => env.attention,
    getTriggerKey: () => env.trigger,
    getVoiceMode: () => env.voiceMode ?? 'tap',
    // The seat under test is the one he is dictating into — the SUBMIT-time
    // stop below does not consult this, but the turn-end re-arm one test here
    // composes with does, and it is the target's re-arm being asserted.
    isMicTarget: () => env.micTarget,
    isAppFocused: () => env.appFocused,
    // `onWrite` fires INSIDE the write, so a test can change the world at an
    // exact point in the sequence. A real timer racing the watcher's own is the
    // alternative, and the margins here are inside this file's observed jitter.
    write: (d) => { writes.push(d); if (env.onWrite) env.onWrite(d); },
    quietMs: TEST_QUIET_MS,
    rearmMs: TEST_REARM_MS,
    pollMs: 1,
    stopSettleMs: TEST_STOP_SETTLE_MS,
    submitPollMs: TEST_SUBMIT_POLL_MS,
    submitAbandonMs,
  }));
  return {
    term, watcher, writes, env,
    // Both stages of a LIT submit: the quiet window, the erase/key gap, and the
    // deferred `\r` behind the stop settle. A `done()` that stopped at the key
    // would assert on a half-finished sequence and pass over a missing submit.
    done: () => settle(TEST_QUIET_MS + ENTER_SETTLE_MS + TEST_STOP_SETTLE_MS + 60),
  };
}

const DRAFT = '\u276f finish the report over and out';
// The backspaces the submit erases with: `over and out` plus the space before
// it. A literal, not a recomputation of the rule under test.
const ERASE = '\x7f'.repeat(13);

test('recorder LIT at submit: the key STOPS and our own `\\r` submits behind it', async () => {
  // THE DEFECT, in one assertion. This pin used to be [ERASE, ' '] -- the key
  // called the whole submit. At a live mic that key stopped the recorder and
  // submitted NOTHING, leaving the spoken phrase erased and the draft sitting
  // in the composer. Dropping the `\r` back out of this array restores that.
  //
  // The key does not submit because the CLI's submit is not in its key handler:
  // it is in `onTranscript`, behind a gate comparing the composer against the
  // voice module's private mirror of it. Our ERASE moves the composer and not
  // the mirror, so that gate declines. Nothing we can write makes the CLI submit
  // once the erase has run, and the erase cannot go -- without it the trigger
  // phrase ships inside the message. So the submit has to be OURS.
  const h = stopHarness({ rows: [{ text: '❯ ', cursor: true }, REC_ROW] });
  // `cursor: true` on the DRAFT row: write() REPLACES the row set and the cursor
  // defaults to the LAST row -- without this the composer read lands on the
  // indicator row and nothing fires at all.
  h.term.write({ text: DRAFT, cursor: true }, REC_ROW);
  await h.done();

  assert.strictEqual(h.watcher.fireCount(), 1, 'ENTER: the submit itself must have fired');
  // THE WHOLE ARRAY AND ITS ORDER. The erase must LEAD or the phrase ships
  // inside the message; the key must PRECEDE the `\r` or it arms a recorder
  // after the submit instead of stopping the one that is running; and the `\r`
  // must be there at all, which is the entire defect.
  assert.deepStrictEqual(h.writes, [ERASE, ' ', '\r']);
  assert.strictEqual(h.watcher.keyStopCount(), 1, 'exactly one key, not a repeat');
  assert.strictEqual(h.watcher.deferredSubmitCount(), 1);
  h.watcher.dispose();
});

// The spoken path's real ORDER, as a fixture: the recorder is lit when the
// phrase matches, and `Voice: processing` replaces it only after our key stops
// it. `onWrite` fires inside the write, so the repaint lands between the erase
// and the key -- which is where the CLI puts it.
//
// ONCE, and that is load-bearing for the two-match test: re-firing on a SECOND
// erase would repaint the FIRST draft over the second one and hold its
// processing footer up for good.
function litThenProcessing(h, row = PROCESSING_ROW) {
  let armed = true;
  h.env.onWrite = (d) => {
    if (!armed || !d.startsWith('\x7f')) return;
    armed = false;
    h.term.write({ text: DRAFT, cursor: true }, row);
  };
}

test('the deferred `\\r` WAITS for `Voice: processing` to clear', async () => {
  // The wait is the reason this is deferred rather than written straight behind
  // the key. The CLI's own submit runs from `onTranscript`, i.e. after the
  // footer clears; sending at the keystroke submits the INTERIM transcript that
  // is on screen at that instant.
  const h = stopHarness({ rows: [{ text: '❯ ', cursor: true }, REC_ROW] });
  h.term.write({ text: DRAFT, cursor: true }, REC_ROW);
  // LIT at the match, `Voice: processing` only once the key has stopped it --
  // the real order, and the only one that reaches the deferral at all. Painting
  // processing at match time instead makes `recordingObserved` read DARK, so the
  // test would run down the typed branch it is not about and assert nothing.
  litThenProcessing(h);
  // Long enough that a `\r` written on the first read would already be here.
  await settle(TEST_QUIET_MS + ENTER_SETTLE_MS + TEST_STOP_SETTLE_MS + 60);
  assert.deepStrictEqual(h.writes, [ERASE, ' '],
    'ENTER: the key must have gone out, and the `\\r` must NOT have followed it yet');

  // Transcription finishes: the footer clears and the final text is in place.
  h.term.write({ text: DRAFT, cursor: true }, ' agents \u00b7 tap to talk');
  await settle(TEST_SUBMIT_POLL_MS + 60);

  assert.deepStrictEqual(h.writes, [ERASE, ' ', '\r'], 'the poll releases the submit');
  assert.strictEqual(h.watcher.deferredSubmitCount(), 1);
  h.watcher.dispose();
});

test('processing that NEVER clears still submits, at the abandon deadline', async () => {
  // A wedged transcription, a footer scrape that stopped matching, a screen gone
  // unreadable: all present as processing forever. The erase has already run, so
  // giving up strands the operator's words in a composer with the phrase cut off
  // -- he cannot even re-trigger it. The deadline fires the submit instead.
  const h = stopHarness({
    rows: [{ text: '❯ ', cursor: true }, PROCESSING_ROW],
    submitAbandonMs: TEST_STOP_SETTLE_MS + 30,
  });
  h.term.write({ text: DRAFT, cursor: true }, REC_ROW);
  // LIT at the match, `Voice: processing` only once the key has stopped it --
  // the real order, and the only one that reaches the deferral at all. Painting
  // processing at match time instead makes `recordingObserved` read DARK, so the
  // test would run down the typed branch it is not about and assert nothing.
  litThenProcessing(h);
  await settle(TEST_QUIET_MS + ENTER_SETTLE_MS + TEST_STOP_SETTLE_MS + 140);

  assert.deepStrictEqual(h.writes, [ERASE, ' ', '\r'],
    'the deadline submits rather than stranding the erased draft');
  assert.strictEqual(h.watcher.deferredSubmitCount(), 1);
  h.watcher.dispose();
});

test('recorder DARK at submit: `\\r` submits alone and the key is never written', async () => {
  // THE LOAD-BEARING BRANCH. A dark recorder means the phrase was TYPED, and
  // there the key does not submit -- it ARMS a microphone nobody asked for.
  const idle = ' agents · tap to talk';
  const h = stopHarness({ rows: [{ text: '❯ ', cursor: true }, idle] });
  h.term.write({ text: DRAFT, cursor: true }, idle);
  await h.done();

  assert.strictEqual(h.watcher.fireCount(), 1, 'ENTER: the submit must still have fired');
  assert.deepStrictEqual(h.writes, [ERASE, '\r']);
  assert.strictEqual(h.watcher.keyStopCount(), 0);
  // NO deferred submit on this branch: the `\r` above IS the submit, and a
  // second one behind it would send an empty composer or the operator's next
  // draft.
  assert.strictEqual(h.watcher.deferredSubmitCount(), 0);
  h.watcher.dispose();
});

test('the PROCESSING row submits with `\\r` too: the recorder has already stopped', async () => {
  // `recordingObserved` is REC-ONLY and deliberately not widened to processing:
  // by the time that paints the recorder is down, so the key would arm rather
  // than submit. Same answer as dark, different row.
  const h = stopHarness({ rows: [{ text: '❯ ', cursor: true }, PROCESSING_ROW] });
  h.term.write({ text: DRAFT, cursor: true }, PROCESSING_ROW);
  await h.done();

  assert.deepStrictEqual(h.writes, [ERASE, '\r']);
  assert.strictEqual(h.watcher.keyStopCount(), 0);
  h.watcher.dispose();
});

test('still talking past the phrase: the key still stops, and the submit follows', async () => {
  // A DOCUMENTED EXPOSURE, not an oversight. The operator can keep talking past
  // the trigger phrase, and interim transcript for the NEW utterance lands
  // behind our erase. Declining then would mean not submitting at all -- he
  // ended an utterance with a sign-off and is owed a submit for it.
  //
  // The draft gate on the deferred `\r` does NOT catch this and is not meant
  // to: it asks whether a draft is still there, and a new utterance is one. What
  // bounds the exposure is the width of the window, not a read.
  const h = stopHarness({ rows: [{ text: '❯ ', cursor: true }, REC_ROW] });
  h.term.write({ text: DRAFT, cursor: true }, REC_ROW);
  // The new utterance's interim transcript paints right behind the erase.
  h.env.onWrite = (d) => {
    if (d === ERASE) h.term.write({ text: '❯ and another thing', cursor: true }, REC_ROW);
  };
  await h.done();

  assert.strictEqual(h.watcher.fireCount(), 1, 'ENTER: the submit must still have fired');
  assert.deepStrictEqual(h.writes, [ERASE, ' ', '\r']);
  assert.strictEqual(h.watcher.keyStopCount(), 1);
  h.watcher.dispose();
});

test('HOLD mode falls back to `\\r`: the character would land in the draft', async () => {
  // The swallow-and-toggle measured in the CLI is the TAP branch. In hold mode a
  // single written character cannot reach the auto-repeat threshold, so it is
  // inserted as a literal instead of submitting anything -- and the non-empty
  // composer it leaves behind blocks every later re-arm. `tapTrigger()` refuses
  // the mode WITHOUT writing, which is what makes the fallback safe.
  const h = stopHarness({ rows: [{ text: '❯ ', cursor: true }, REC_ROW] });
  h.env.voiceMode = 'hold';
  h.term.write({ text: DRAFT, cursor: true }, REC_ROW);
  await h.done();

  assert.strictEqual(h.watcher.fireCount(), 1, 'ENTER: the submit must still have fired');
  assert.deepStrictEqual(h.writes, [ERASE, '\r']);
  assert.strictEqual(h.watcher.keyStopCount(), 0);
  h.watcher.dispose();
});

test('no single-character trigger key falls back to `\\r`, lit or not', async () => {
  // `tapTrigger()`'s other refusal, and it must not write either: with no
  // character bound to push-to-talk there is no byte that could submit, so the
  // recorder being lit changes nothing about which byte goes out.
  const h = stopHarness({ rows: [{ text: '❯ ', cursor: true }, REC_ROW], trigger: null });
  h.term.write({ text: DRAFT, cursor: true }, REC_ROW);
  await h.done();

  assert.strictEqual(h.watcher.fireCount(), 1, 'ENTER: the submit must still have fired');
  assert.deepStrictEqual(h.writes, [ERASE, '\r']);
  assert.strictEqual(h.watcher.keyStopCount(), 0);
  h.watcher.dispose();
});

test('after a key stop, the turn-end re-arm still taps the key back', async () => {
  // The two halves compose: the key leaves the recorder stopped, and the
  // EXISTING turn-end path arms it again. This adds no second way to arm.
  const h = stopHarness({ rows: [{ text: '❯ ', cursor: true }, REC_ROW] });
  h.term.write({ text: DRAFT, cursor: true }, REC_ROW);
  await h.done();
  assert.deepStrictEqual(h.writes, [ERASE, ' ', '\r'], 'ENTER: the key stop must have happened');

  // The recorder is now off and the composer empty, exactly as after a real
  // key submit.
  h.term.write({ text: EMPTY_COMPOSER, cursor: true }, ' agents · tap to talk');
  h.watcher.noteActivity('thinking');
  h.watcher.noteActivity('idle', true);
  await settle(TEST_REARM_MS + TEST_QUIET_MS + 60);

  assert.deepStrictEqual(h.writes, [ERASE, ' ', '\r', ' '],
    'the turn-end re-arm taps the key back through its own existing path');
  assert.strictEqual(h.watcher.rearmCount(), 1);
  h.watcher.dispose();
});

test('THE INTERLOCK, DEFERRED: a dialog opened during the wait gets no `\\r`', async () => {
  // THE COST OF DEFERRING, and the reason the write re-reads its gates instead
  // of inheriting tick()'s. `shouldFire` was TRUE at the match; seconds later a
  // permission dialog is up, and this `\r` would ANSWER it. A submit written
  // 30ms behind the match had barely any window for that; this one is open for
  // as long as transcription runs, which is what makes the re-read load-bearing
  // rather than defensive.
  const h = stopHarness({ rows: [{ text: '❯ ', cursor: true }, REC_ROW] });
  h.term.write({ text: DRAFT, cursor: true }, REC_ROW);
  // LIT at the match, `Voice: processing` only once the key has stopped it --
  // the real order, and the only one that reaches the deferral at all. Painting
  // processing at match time instead makes `recordingObserved` read DARK, so the
  // test would run down the typed branch it is not about and assert nothing.
  litThenProcessing(h);
  await settle(TEST_QUIET_MS + ENTER_SETTLE_MS + TEST_STOP_SETTLE_MS + 40);
  assert.deepStrictEqual(h.writes, [ERASE, ' '], 'ENTER: the key must have gone out first');

  // The dialog opens WHILE the CLI is still transcribing, then the footer
  // clears -- which without the re-read releases the submit into the dialog.
  h.env.attention = 'permission';
  h.term.write({ text: DRAFT, cursor: true }, ' agents \u00b7 tap to talk');
  await settle(TEST_SUBMIT_POLL_MS + 60);

  assert.deepStrictEqual(h.writes, [ERASE, ' '], 'the `\\r` would have answered the dialog');
  assert.strictEqual(h.watcher.keyStopCount(), 1, 'the stop still happened; only the submit stood down');
  assert.strictEqual(h.watcher.deferredSubmitCount(), 0);
  h.watcher.dispose();
});

test('an EMPTY composer at release gets no `\\r`: something already submitted it', async () => {
  // The stray-submit case the spec names. If the composer is empty when the wait
  // ends, the draft has gone -- the operator sent it by hand, or a CLI version
  // whose gate we mis-modelled submitted it itself. Our `\r` would then land in
  // an empty composer or a fresh draft, which is a submit nobody asked for.
  const h = stopHarness({ rows: [{ text: '❯ ', cursor: true }, REC_ROW] });
  h.term.write({ text: DRAFT, cursor: true }, REC_ROW);
  // LIT at the match, `Voice: processing` only once the key has stopped it --
  // the real order, and the only one that reaches the deferral at all. Painting
  // processing at match time instead makes `recordingObserved` read DARK, so the
  // test would run down the typed branch it is not about and assert nothing.
  litThenProcessing(h);
  await settle(TEST_QUIET_MS + ENTER_SETTLE_MS + TEST_STOP_SETTLE_MS + 40);
  assert.deepStrictEqual(h.writes, [ERASE, ' '], 'ENTER: the key must have gone out first');

  h.term.write({ text: EMPTY_COMPOSER, cursor: true }, ' agents \u00b7 tap to talk');
  await settle(TEST_SUBMIT_POLL_MS + 60);

  assert.deepStrictEqual(h.writes, [ERASE, ' ']);
  assert.strictEqual(h.watcher.deferredSubmitCount(), 0);
  h.watcher.dispose();
});

test('a SECOND match cancels the first deferred `\\r`: one composer, one submit', async () => {
  // Two `\r` for one composer is what the cancel prevents: the first submits
  // the draft, the second lands in whatever it left behind. The content latch
  // does NOT cover this -- it keys on the composer's content, and a second
  // utterance is different content, so it re-arms by design.
  //
  // THE SHAPE IS WHAT MAKES THIS PIN ANYTHING, and getting it wrong is silent:
  // a version of this test that stopped after the second match passed with the
  // cancel DELETED, because the first deferral was still sitting behind an
  // uncleared footer and its `\r` simply had not come out yet. So the footer
  // has to CLEAR afterwards -- that is the moment a surviving deferral fires,
  // and the only moment its absence can be observed.
  const h = stopHarness({ rows: [{ text: '❯ ', cursor: true }, REC_ROW] });
  h.term.write({ text: DRAFT, cursor: true }, REC_ROW);
  litThenProcessing(h);
  await settle(TEST_QUIET_MS + ENTER_SETTLE_MS + TEST_STOP_SETTLE_MS + 40);
  assert.deepStrictEqual(h.writes, [ERASE, ' '], 'ENTER: the first stop, its submit still waiting');

  // He signs off again before the CLI finished the first. Still transcribing, so
  // this match reads the recorder as DARK and submits with its own `\r`.
  const DRAFT2 = '\u276f a second thought over and out';
  h.term.write({ text: DRAFT2, cursor: true }, PROCESSING_ROW);
  await settle(TEST_QUIET_MS + ENTER_SETTLE_MS + 40);
  assert.deepStrictEqual(h.writes, [ERASE, ' ', ERASE, '\r'],
    'ENTER: the second match must have submitted on its own');

  // Transcription finishes and he starts a THIRD draft, unfinished and with no
  // sign-off. A first deferral that survived releases into exactly this.
  h.term.write({ text: '❯ something else entirely', cursor: true }, ' agents \u00b7 tap to talk');
  await settle(TEST_SUBMIT_POLL_MS + TEST_STOP_SETTLE_MS + 80);

  assert.strictEqual(h.watcher.fireCount(), 2, 'ENTER: exactly the two matches, no third');
  assert.deepStrictEqual(h.writes, [ERASE, ' ', ERASE, '\r'],
    'the first deferred submit is cancelled, never released into the next draft');
  assert.strictEqual(h.watcher.deferredSubmitCount(), 0);
  h.watcher.dispose();
});

test('a KEYSTROKE during the wait cancels the deferred `\\r`', async () => {
  // THE WINDOW THE DEFERRAL OPENED, and it is seconds wide where the immediate
  // write's was 30ms. Transcription runs; he reads the interim text and types a
  // correction into the composer; the footer clears. Every gate the submit
  // re-reads passes -- his edit IS a draft -- so without this cancel the `\r`
  // sends him mid-sentence.
  const h = stopHarness({ rows: [{ text: '❯ ', cursor: true }, REC_ROW] });
  h.term.write({ text: DRAFT, cursor: true }, REC_ROW);
  litThenProcessing(h);
  await settle(TEST_QUIET_MS + ENTER_SETTLE_MS + TEST_STOP_SETTLE_MS + 40);
  assert.deepStrictEqual(h.writes, [ERASE, ' '],
    'ENTER: the key must have gone out with its submit still deferred');

  // He types into the composer while the CLI is still transcribing.
  h.watcher.noteInput('n');
  h.watcher.noteInput('o');

  // The footer clears and the composer holds his edit. THIS is the release
  // point: a deferral that survived fires exactly here, which is what makes the
  // absence below an observation rather than a test that ran out of time.
  h.term.write({ text: '❯ finish the report no wait', cursor: true }, ' agents \u00b7 tap to talk');
  await settle(TEST_SUBMIT_POLL_MS + TEST_STOP_SETTLE_MS + 80);

  assert.deepStrictEqual(h.writes, [ERASE, ' '], 'the `\\r` would have submitted mid-sentence');
  assert.strictEqual(h.watcher.keyStopCount(), 1, 'the stop still happened; only the submit stood down');
  assert.strictEqual(h.watcher.deferredSubmitCount(), 0);
  h.watcher.dispose();
});

test('a MOUSE REPORT during the wait does not cancel it: only keystrokes do', async () => {
  // The other half of the same gate, and the reason the cancel sits behind
  // `isHumanPtyInput` rather than on every byte. onData also carries mouse
  // reports and query replies; cancelling on those would strand the submit on a
  // scroll, which looks exactly like the feature silently not working.
  //
  // This is also the POSITIVE CONTROL for the test above: same shape, same
  // release point, and the `\r` DOES come out -- so a cancel test passing
  // because it never reached the window cannot hide here.
  const h = stopHarness({ rows: [{ text: '❯ ', cursor: true }, REC_ROW] });
  h.term.write({ text: DRAFT, cursor: true }, REC_ROW);
  litThenProcessing(h);
  await settle(TEST_QUIET_MS + ENTER_SETTLE_MS + TEST_STOP_SETTLE_MS + 40);
  assert.deepStrictEqual(h.writes, [ERASE, ' '], 'ENTER: the key must have gone out first');

  h.watcher.noteInput('\x1b[<0;10;5M'); // an SGR mouse report, not a keystroke

  h.term.write({ text: DRAFT, cursor: true }, ' agents \u00b7 tap to talk');
  await settle(TEST_SUBMIT_POLL_MS + 80);

  assert.deepStrictEqual(h.writes, [ERASE, ' ', '\r'], 'a scroll must not strand the submit');
  assert.strictEqual(h.watcher.deferredSubmitCount(), 1);
  h.watcher.dispose();
});

test('dispose during the wait writes nothing: no submit into a dead terminal', async () => {
  const h = stopHarness({ rows: [{ text: '❯ ', cursor: true }, REC_ROW] });
  h.term.write({ text: DRAFT, cursor: true }, REC_ROW);
  // LIT at the match, `Voice: processing` only once the key has stopped it --
  // the real order, and the only one that reaches the deferral at all. Painting
  // processing at match time instead makes `recordingObserved` read DARK, so the
  // test would run down the typed branch it is not about and assert nothing.
  litThenProcessing(h);
  await settle(TEST_QUIET_MS + ENTER_SETTLE_MS + TEST_STOP_SETTLE_MS + 40);
  assert.deepStrictEqual(h.writes, [ERASE, ' '], 'ENTER: the key must have gone out first');

  h.watcher.dispose();
  h.term.write({ text: DRAFT, cursor: true }, ' agents \u00b7 tap to talk');
  await settle(TEST_SUBMIT_POLL_MS + 60);

  assert.deepStrictEqual(h.writes, [ERASE, ' ']);
  assert.strictEqual(h.watcher.deferredSubmitCount(), 0);
});

test('processingObserved is its OWN polarity, not either neighbour', () => {
  // Three readings of one footer, and unifying any two breaks a different thing.
  assert.strictEqual(processingObserved([PROCESSING_ROW]), true);
  assert.strictEqual(processingObserved([PROCESSING_ROW_ASCII]), true);
  // A LIT recorder is not processing. Widened to match `recorderBlocksRearm`,
  // the wait would never end while the turn-end re-arm has the mic lit again,
  // and every deferred submit would go out at the abandon deadline instead.
  assert.strictEqual(processingObserved([REC_ROW]), false);
  assert.strictEqual(processingObserved([' agents \u00b7 tap to talk']), false);
  assert.strictEqual(processingObserved([]), false);
  // UNREADABLE is BUSY here -- the opposite of `recordingObserved`, which reads
  // it as dark. The caller is holding a `\r`, and firing it into a screen
  // nobody could read is the mistake that cannot be taken back; the abandon
  // deadline is what stops that costing more than latency.
  assert.strictEqual(processingObserved(null), true);
  assert.strictEqual(recordingObserved(null), false);
});

test('a recorder that clears LATE is still recovered, not abandoned first', async () => {
  // THE RECOVERY, not the constant. The test below asserts the arithmetic; this
  // asserts the behaviour it exists for, so an edit that keeps the number and
  // breaks the rescheduling cannot pass.
  //
  // The meter is what keeps the re-arm alive: while the mic is live the CLI
  // animates it on a 50ms tick, so the terminal never goes quiet, every attempt
  // takes the still-painting branch, and each one reschedules -- but only until
  // the deadline. That is the ONLY branch the deadline is consulted on, which is
  // why the constant has to outlast the recorder's own timeout.
  const h = rearmHarness({ rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW] });
  h.turn();
  for (let i = 0; i < 6; i++) {
    h.term.write(
      { text: EMPTY_COMPOSER + METER[i % 4], cursorX: EMPTY_COMPOSER.length, cursor: true },
      REC_ROW,
    );
    await settle(3);
  }
  assert.deepStrictEqual(h.writes, [], 'ENTER: it must decline for as long as the recorder is lit');

  // The recorder finishes: the indicator comes down and the meter stops.
  h.term.write({ text: EMPTY_COMPOSER, cursor: true }, ' agents \u00b7 tap to talk');
  await settle(TEST_REARM_MS + TEST_QUIET_MS + 60);

  assert.deepStrictEqual(h.writes, [' '], 'the still-live re-arm taps once the indicator clears');
  assert.strictEqual(h.watcher.rearmCount(), 1);
  h.watcher.dispose();
});

test('the abandon deadline outlasts the CLI 15s tap silence timeout', () => {
  // The regression was arithmetic: at a 10000ms deadline against the CLI's
  // 15000ms tap timeout, a turn ending while the recorder was lit ALWAYS
  // abandoned before the indicator cleared, and the mic never came back.
  //
  // 15000 is measured, not estimated: `strings` on the 2.1.251 binary gives
  // `var G=5000,U=15000,Y=120000` in the voice session module, where U drives
  // the tap-mode silence timer ("Toggle silence timeout - auto-finishing").
  const CLI_TAP_SILENCE_MS = 15000;
  assert.ok(REARM_ABANDON_MS > CLI_TAP_SILENCE_MS,
    `the deadline (${REARM_ABANDON_MS}ms) must outlast the CLI ${CLI_TAP_SILENCE_MS}ms timeout`);
});

// --- reporting the recorder to main, so speaking defers injection -----------
//
// The watcher already SAW the indicator (it feeds the voice-origin marker); the
// gap was that nothing told the main process, whose inject quiet-gate protects
// a TYPING operator and had no signal at all for a speaking one. These pin the
// renderer end of that hop: what is reported, when, and — the part that is easy
// to get subtly wrong — for which seats.

function recorderReportHarness({
  rows = [EMPTY_COMPOSER],
  // The submit feature OFF, which is the interesting default here: he dictates
  // whether or not he opted into hands-free submit, so the reporting must not
  // be downstream of that checkbox.
  config = null,
  scope = true,
} = {}) {
  const reports = [];
  const term = fakeTerminal({ rows: rows.map((r) => (typeof r === 'string' ? { text: r } : r)) });
  const env = { config, scope };
  const watcher = track(createVoiceSubmitWatcher(term, {
    getConfig: () => env.config,
    getAttention: () => null,
    write: () => {},
    quietMs: TEST_QUIET_MS,
    pollMs: 1,
    recorderScope: () => env.scope,
    noteVoiceRecording: () => reports.push('REC'),
  }));
  return { term, watcher, reports, env };
}

test('the lit recorder is reported to main even with hands-free submit OFF', async () => {
  // The half-fix this guards against: sampling below the config bail reports
  // only for seats that enabled an unrelated feature, and he is cut off on
  // every other seat exactly as before.
  const h = recorderReportHarness({ rows: [EMPTY_COMPOSER, REC_ROW] });
  await settle(10);
  assert.ok(h.reports.length > 0, 'a null config must not silence the report');
  h.watcher.dispose();
});

test('the report REPEATS while the recorder stays lit', async () => {
  // Level-triggered by design: main expires the stamp rather than waiting for
  // an off-frame, so a renderer that stops (window closed, seat switched, seat
  // crashed mid-utterance) releases the deferral instead of wedging it. One
  // edge-triggered report would make that release impossible.
  const h = recorderReportHarness({ rows: [EMPTY_COMPOSER, REC_ROW] });
  await settle(30);
  assert.ok(h.reports.length > 3,
    `a single report cannot hold a level-expiring stamp open (got ${h.reports.length})`);
  h.watcher.dispose();
});

test('nothing is reported when the recorder is dark', async () => {
  const h = recorderReportHarness({ rows: [EMPTY_COMPOSER, ' agents · tap to talk'] });
  await settle(10);
  assert.deepStrictEqual(h.reports, [],
    'a dark recorder must never defer delivery to the seat');
  h.watcher.dispose();
});

test('an out-of-scope seat reports nothing, lit or not', async () => {
  // Dictation reaches the FOCUSED composer, so a background seat's indicator is
  // not him speaking into it — and deferring that seat's messages on a stale
  // indicator elsewhere would be a delivery pause nobody could explain.
  const h = recorderReportHarness({ rows: [EMPTY_COMPOSER, REC_ROW], scope: false });
  await settle(10);
  assert.deepStrictEqual(h.reports, []);
  // ENTER: the same rows DO report once the seat is in scope, or the assertion
  // above is passing for want of an indicator rather than for want of scope.
  h.env.scope = true;
  await settle(10);
  assert.ok(h.reports.length > 0, 'ENTER: these rows must be reportable in scope');
  h.watcher.dispose();
});

test('a throwing recorderScope leaves a configured seat reporting anyway', async () => {
  // getAttention's own harness reads the sidebar row, which can be gone; this
  // thunk reads the same DOM and can throw the same way. A throw must not
  // silently disable the protection on a seat whose CONFIG already says it is
  // the active claude seat.
  //
  // What keeps it working is the SHORT CIRCUIT, not a fallback in the catch:
  // `!!cfg || !!recorderScope()` never evaluates the thunk once cfg is truthy,
  // so with a config the throw does not happen at all. The catch is reached only
  // when cfg is falsy, where the answer is already false.
  const reports = [];
  const term = fakeTerminal({ rows: [{ text: EMPTY_COMPOSER }, { text: REC_ROW }] });
  const env = { config: { enabled: true, phrase: DEFAULT_SUBMIT_PHRASE } };
  const watcher = track(createVoiceSubmitWatcher(term, {
    getConfig: () => env.config,
    getAttention: () => null,
    write: () => {},
    quietMs: TEST_QUIET_MS,
    pollMs: 1,
    recorderScope: () => { throw new Error('sidebar row vanished'); },
    noteVoiceRecording: () => reports.push('REC'),
  }));
  await settle(10);
  assert.ok(reports.length > 0,
    'a non-null config must still report when the scope thunk throws');

  // And with NO config either, the throw leaves it silent rather than escaping.
  reports.length = 0;
  env.config = null;
  await settle(10);
  assert.deepStrictEqual(reports, [],
    'ENTER: with both the scope throwing and no config, nothing is reported — and the poll survived');
  watcher.dispose();
});

// --- the DICTATED DRAFT report, which outlives the recorder -----------------
//
// The recorder goes dark the moment he stops talking, which is the moment he
// starts RE-READING what was transcribed. That reading window is the operator's
// actual exposure, and the recorder report cannot cover it.

const DRAFT_ROW = '\u276f\u00a0the long transcription he is re-reading';

function draftReportHarness({ rows = [DRAFT_ROW], scope = true, lit = true, onDraft = null } = {}) {
  const drafts = [];
  const recs = [];
  // The real screen shape: the composer occupies one or more rows, the cursor
  // sits on its LAST row, and the indicator paints BELOW that. Both reads depend
  // on this — the composer scan walks UP from the cursor, the indicator scan
  // walks DOWN from it.
  //
  // The cursor mark goes on the LAST composer row only. `fakeTerminal` resolves
  // the cursor to the FIRST row carrying the mark, so marking every row put it
  // on the HEAD — which made a multi-row fixture read as a single-row draft and
  // left the wrapped case untested while looking tested. Without any mark it
  // falls to the last row of all, i.e. the indicator, where the composer scan
  // finds nothing. Both mistakes are silent.
  const composer = rows.map((r, i) => (i === rows.length - 1 ? { text: r, cursor: true } : { text: r }));
  const term = fakeTerminal({ rows: lit ? [...composer, { text: REC_ROW }] : composer });
  const watcher = track(createVoiceSubmitWatcher(term, {
    getConfig: () => null,
    getAttention: () => null,
    write: () => {},
    quietMs: TEST_QUIET_MS,
    pollMs: 1,
    recorderScope: () => scope,
    noteVoiceRecording: () => recs.push('REC'),
    noteVoiceDraft: () => { drafts.push('DRAFT'); if (onDraft) onDraft(); },
  }));
  return { term, watcher, drafts, recs };
}

test('the dictated draft is reported after the recorder goes DARK', async () => {
  // The whole point: the indicator is gone, the words are still in the composer.
  const h = draftReportHarness();
  await settle(10);
  assert.ok(h.recs.length > 0, 'ENTER: the recorder was seen lit first, or there is no anchor');
  h.term._state.rows = [{ text: DRAFT_ROW, cursor: true }];  // he stops talking; indicator gone
  const before = h.drafts.length;
  await settle(10);
  assert.ok(h.drafts.length > before,
    'the draft must keep being reported once the recorder is dark — that is the exposure');
  h.watcher.dispose();
});

test('the draft report REPEATS, so main can expire it', async () => {
  // Level-triggered for the same reason the recorder report is: main expires the
  // stamp, so a watcher that stops (disposed, seat switched, window closed)
  // RELEASES the seat instead of parking its messages forever.
  const h = draftReportHarness();
  await settle(30);
  assert.ok(h.drafts.length > 3,
    `one edge cannot hold a level-expiring stamp open (got ${h.drafts.length})`);
  h.watcher.dispose();
});

test('an EMPTY composer reports no draft, however recently he spoke', async () => {
  // He submitted it. Nothing is at risk, so nothing may be parked.
  const h = draftReportHarness({ rows: [EMPTY_COMPOSER] });
  await settle(10);
  assert.ok(h.recs.length > 0, 'ENTER: the recorder is lit, so only the composer read can be declining');
  assert.deepStrictEqual(h.drafts, [],
    'an empty composer holds nothing to protect');
  h.watcher.dispose();
});

test('an UNREADABLE screen reports no draft — doubt must not park deliveries', async () => {
  // The polarity trap, at the reporting call site rather than only at the
  // predicate. cursorRow() returns null off the normal buffer, and a `null` that
  // read as "a draft is open" would park every message to the seat behind a
  // signal no reader can clear.
  const h = draftReportHarness();
  await settle(10);
  assert.ok(h.drafts.length > 0, 'ENTER: these rows DO report while readable');
  h.term._state.type = 'alternate';                   // a full-screen program: unreadable
  const before = h.drafts.length;
  await settle(10);
  assert.strictEqual(h.drafts.length, before,
    'an unreadable screen must not report a draft — doubt delivers, it never wedges');
  h.watcher.dispose();
});

test('an out-of-scope seat reports no draft', async () => {
  // Dictation reaches the FOCUSED composer; a background seat's leftover text is
  // not a dictated draft, and parking its messages would be unexplainable.
  const h = draftReportHarness({ scope: false });
  await settle(10);
  assert.deepStrictEqual(h.drafts, []);
  h.watcher.dispose();
});

test('a composer never touched by the recorder reports no draft', async () => {
  // The anchor is what makes this a DICTATED draft rather than any draft.
  // Without it the report fires on every seat with text in its composer and
  // quietly reroutes injection box-wide.
  const h = draftReportHarness({ lit: false });
  await settle(10);
  assert.deepStrictEqual(h.recs, [], 'ENTER: the recorder was never lit on this seat');
  assert.deepStrictEqual(h.drafts, [],
    'text alone is not evidence of dictation');
  h.watcher.dispose();
});

// The MEASURED multi-row shape (pty + xterm, CLI 2.1.251, 60 cols): the CLI
// HARD-PAINTS continuation rows — `isWrapped` is false on every one — and
// indents them with two ASCII spaces, while the head carries U+276F U+00A0.
const WRAP_HEAD = '\u276f\u00a0this is a long dictated thought that will certainly';
const WRAP_TAIL_1 = '  exceed a single visual row of sixty columns and keep';
const WRAP_TAIL_2 = '  going well past it';

test('a WRAPPED dictated draft is reported — the ticket’s own case', async () => {
  // A long transcription is precisely the draft that occupies more than one
  // row, so a single-row read left the protection off in the case it exists
  // for. The cursor is on the LAST continuation row, which carries no marker.
  const h = draftReportHarness({ rows: [WRAP_HEAD, WRAP_TAIL_1, WRAP_TAIL_2] });
  await settle(10);
  assert.ok(h.drafts.length > 0,
    'a draft that wraps must report — this is the long transcription he re-reads');
  h.watcher.dispose();
});

test('continuation rows over TRANSCRIPT, with no composer head, report nothing', async () => {
  // The bound's other side. Indented rows are not evidence by themselves: the
  // scan must find the marker at the head, and a screen of transcript above the
  // cursor must decline — otherwise the report fires on ordinary output.
  const h = draftReportHarness({
    rows: ['────────────────────────', '  ⚠ Transcript saving is off', '  going well past it'],
  });
  await settle(10);
  assert.ok(h.recs.length > 0, 'ENTER: the recorder is lit, so only the composer scan can be declining');
  assert.deepStrictEqual(h.drafts, [],
    'no marker at the head ⇒ no draft, however many indented rows sit above the cursor');
  h.watcher.dispose();
});

test('a wrapped EMPTY composer is not a draft', async () => {
  // The head is reachable and holds nothing. Reported separately from the
  // single-row empty case because the scan reaches it by a different path.
  const h = draftReportHarness({ rows: ['some transcript', EMPTY_COMPOSER] });
  await settle(10);
  assert.deepStrictEqual(h.drafts, [], 'an empty composer holds nothing to protect');
  h.watcher.dispose();
});

test('a throwing noteVoiceDraft does not break the poll', async () => {
  // Counted, not inferred. An earlier revision built its own terminal WITHOUT
  // the cursor mark, so the cursor sat on the indicator row, the draft read
  // declined, and the throwing reporter was never called at all — the subject
  // passed off the RECORDER report, which this change does not touch, and
  // deleting the throw left it green. `calls > 1` is what carries it: the first
  // proves the throw happened, the second that the poll ran again past it.
  let calls = 0;
  const h = draftReportHarness({
    onDraft: () => { calls++; throw new Error('ipc gone'); },
  });
  await settle(30);
  assert.ok(calls > 1,
    `the poll must keep reporting past a throwing reporter (calls=${calls})`);
  h.watcher.dispose();
});

test('a throwing noteVoiceRecording does not break the poll', async () => {
  // The poll also drives the composition half and the voice-origin evidence; a
  // throw escaping the report would take both down with it.
  const term = fakeTerminal({ rows: [{ text: EMPTY_COMPOSER }, { text: REC_ROW }] });
  const watcher = track(createVoiceSubmitWatcher(term, {
    getConfig: () => null,
    getAttention: () => null,
    write: () => {},
    quietMs: TEST_QUIET_MS,
    pollMs: 1,
    recorderScope: () => true,
    noteVoiceRecording: () => { throw new Error('ipc gone'); },
  }));
  await settle(10);
  assert.ok(true, 'the poll survived a throwing reporter');
  watcher.dispose();
});
