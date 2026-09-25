'use strict';

// voice-submit.test.js — the hands-free submit matcher (renderer/lib/voice-submit.js).

const { test } = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_SUBMIT_PHRASE, normalizePhrase, findSubmit, matchTrigger,
  foldConfusables, shouldFire, readVoiceSubmitSettings,
  shouldRearm, composerIsEmpty, recorderBlocksRearm, recordingObserved, processingObserved,
  resolveTriggerKey,
} = require('../renderer/lib/voice-submit');

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
  // nobody could read is the mistake that cannot be taken back.
  assert.strictEqual(processingObserved(null), true);
  assert.strictEqual(recordingObserved(null), false);
});
