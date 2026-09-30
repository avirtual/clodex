// voice-submit.js — the trigger-phrase matcher and activation gate behind
// hands-free submit. Pure: no DOM, no terminal, no settings read.
//
// The CLI declines to auto-submit when the FINAL streamed segment is under
// three words, so a trailing-off utterance leaves the composer full. This
// matches a chosen sign-off at the END of the composer so the renderer can send
// Enter itself.
//
// It reads ONE row: the cursor row, truncated at the cursor. The match is
// anchored at `$` with a left word boundary, so it matches that row's TAIL and
// needs no prompt, no border stripping and no upward walk to locate the draft.
// A wrapped draft is covered for free — the phrase is at the very end, so it is
// on the row the cursor is on.
//
// What the prompt used to buy was telling the operator's draft from AGENT
// OUTPUT ending in the phrase (a live hazard: an agent discussing this feature
// prints it). The CURSOR is the better evidence — it rests in the composer, not
// in scrollback — and the alt-screen decline in the watcher covers the rest.

const { RECORDING_INDICATOR, PROCESSING_INDICATOR } = require('../../voice-engine');

// A fixed three-word radio sign-off. The default is the part that must not
// misfire, and every shorter candidate collides with ordinary speech in this
// repo: we dictate "send it", "send the message" and "message bob" constantly,
// and any one-word trigger appears mid-sentence. The words are common; the
// ordered sequence, at the very end of a draft, is not.
const DEFAULT_SUBMIT_PHRASE = 'over and out';

// Dictation auto-punctuates, so the spoken form arrives as `Over and out.` far
// more often than bare. Punctuation is stripped from both sides of every word
// of the CONFIGURED phrase and consumed after the match in the composer.
const EDGE_PUNCT = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

// Dictation emits typographic punctuation; an operator types the ASCII form
// into the phrase field. EDGE_PUNCT strips only at word EDGES, so a U+2019 in
// the MIDDLE of `that’s` survives into the regex and is matched literally
// against a configured `that's` that never arrives that way. Folding both sides
// is what makes the two forms meet.
//
// Every entry MUST be a single character mapping to a single character:
// `matchTrigger` counts its erase against the RAW content but matches against
// the folded one, so a substitution that changes length shifts the count and
// the erase strands or eats text. That is also why this is a small table and
// not a Unicode normalization pass — NFKD does not fold U+2019 to an
// apostrophe at all, and a wide fold silently changes which phrases match.
const CONFUSABLES = new Map([
  ['\u2019', "'"], ['\u2018', "'"], ['\u02bc', "'"],
  ['\u2014', '-'], ['\u2013', '-'],
]);
const CONFUSABLE_RE = /[\u2019\u2018\u02bc\u2014\u2013]/g;

function foldConfusables(s) {
  return s.replace(CONFUSABLE_RE, (c) => CONFUSABLES.get(c));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Lowercased, punctuation-stripped words. A token that is ONLY punctuation
// drops out rather than becoming an empty alternative that matches everywhere.
function triggerWords(phrase) {
  if (typeof phrase !== 'string') return [];
  return foldConfusables(phrase.toLowerCase()).split(/\s+/)
    .map((w) => w.replace(EDGE_PUNCT, ''))
    .filter(Boolean);
}

// '' for anything unusable, so a caller can fall back to the default rather
// than arm a matcher with no words — which would match every composer.
function normalizePhrase(phrase) {
  return triggerWords(phrase).join(' ');
}

// The cursor row's tail, matched for the phrase. `text` is that row already
// truncated at the cursor column. Returns `{ content, erase }`, or null only
// for an unusable row — the watcher fires Enter, so "I cannot read this" and
// "do not fire" must be the same answer.
//
// `erase` is bounded by the match, which is what makes reading a raw row safe:
// the backspaces can never reach past the phrase into the prompt ornament or
// anything else the CLI drew to the left of the draft.
function findSubmit(text, phrase) {
  if (typeof text !== 'string') return null;
  const hit = matchTrigger(text, phrase);
  return { content: text, erase: hit ? hit.erase : 0 };
}

// `{ erase }` — how many CHARACTERS to backspace over, counted from the cursor,
// covering the phrase, its trailing punctuation, and the whitespace on both
// sides of it. Characters, not columns: a backspace deletes a character, and a
// column count would over-delete on any row carrying a wide char.
//
// The leading `(?:\s|^)` is the left word boundary and the `$` the right one.
// Without the first, "handover and out" fires; without the second, "over and
// outside" does — both are matches a bare substring test would accept.
function matchTrigger(content, phrase) {
  if (typeof content !== 'string') return null;
  const words = triggerWords(phrase);
  if (!words.length) return null;
  const body = words.map(escapeRe).join('\\s+');
  const re = new RegExp(`(?:\\s+|^)${body}[\\p{P}\\p{S}]*\\s*$`, 'iu');
  const m = re.exec(foldConfusables(content));
  if (!m) return null;
  return { erase: content.length - m.index };
}

// Re-checked at FIRE time, not at arm time: the dialog can open during the
// quiet window.
//
// `attention === 'permission'` is the interlock, and it is not a preference:
// the CLI is showing a dialog and the Enter this feature sends would ANSWER it.
//
// Deliberately independent of the CLI's voice mode. Gating on `tap` was a proxy
// for "the operator is dictating" and refused the case it was most wanted in:
// macOS on-device dictation types into the composer while the CLI's own mode
// reads `off`. The phrase is the intent, whatever typed it.
function shouldFire({ enabled, attention } = {}) {
  if (enabled !== true) return false;
  if (attention === 'permission') return false;
  return true;
}

// The composer with nothing typed in it, matched against the CURSOR ROW
// truncated at the cursor.
//
// The bar this has to clear is the CLI's own, and it is `value.length > 0`:
// the tap handler returns on ANY non-empty composer, so a single space of
// draft is already enough to make it decline. Ours must decline there too, or
// we write a character the CLI will not swallow — it lands in the draft, and
// the now-non-empty composer blocks every later re-arm. Hence at most ONE
// space: that one is the separator the CLI paints after the marker, and a
// second is the operator's (or dictation's, which prepends one).
//
// The marker is REQUIRED, and that direction is chosen for how it fails. If
// the glyph is wrong this returns false and the feature goes quiet; if the
// marker were optional a bare whitespace row would read as an empty composer,
// and a dialog interior and a mid-repaint screen both look exactly like that.
// A silent feature is recoverable, a character typed into a permission dialog
// is not.
//
// THE SEPARATOR IS U+00A0, NOT U+0020. Measured 2026-08-31 off a live seat
// (CLI 2.1.251) from the same read this rule is given: cursor row
// `U+276F U+00A0`, cursorX 2. An earlier revision of this rule spelled it with
// an ASCII space and therefore returned false on every genuinely empty
// composer — the feature was dead with the suite green, because the fixtures
// encoded the same assumption the rule did.
//
// Both separators are listed EXPLICITLY rather than as `\s?`, which would also
// match U+00A0 and pass the same tests. `\s` additionally admits tab, newline
// and the rest of the Unicode space run — none of which has been observed in
// this position, and each of which is a screen state we have no reading of.
// Listing what was measured keeps an unrecognised row falling to the silent
// side, which is the direction chosen throughout this rule.
const COMPOSER_EMPTY = /^[\u276f>][\u0020\u00a0]?$/u;

function composerIsEmpty(row) {
  if (typeof row !== 'string') return false;
  return COMPOSER_EMPTY.test(row);
}

// The composer holding TEXT, as its own POSITIVE rule rather than the negation
// of the one above. `composerIsEmpty(null)` is false, so `!composerIsEmpty(row)`
// answers "there is a draft" for every row it could not read — a null off the
// alternate buffer, a mid-repaint screen, a dialog interior. Its caller parks
// deliveries on this answer, and a park that no reader can release is a seat
// nobody can reach; so an unreadable screen MUST NOT count as a draft still
// open. Doubt delivers here, the same direction as the speaking gate and the
// opposite of `recorderBlocksRearm`, where doubt blocks.
//
// The marker and its separator are required for the same reason they are in
// COMPOSER_EMPTY: without them any transcript row with a word on it is a draft.
const COMPOSER_DRAFT = /^[\u276f>][\u0020\u00a0][\s\S]*\S/u;

function composerHasDraft(row) {
  if (typeof row !== 'string') return false;
  return COMPOSER_DRAFT.test(row);
}

// A CONTINUATION row of a multi-row composer draft.
//
// MEASURED 2026-08-31 through a real pty + a real xterm at 60 cols (CLI
// 2.1.251), by typing a draft longer than one row and never submitting it:
//
//   row 7  isWrapped=false  U+276F U+00A0 'this is a long dictated thought…'
//   row 8  isWrapped=false  U+0020 U+0020 'exceed a single visual row…'
//   row 9  isWrapped=false  U+0020 U+0020 'going well past it'   ← the cursor
//
// TWO facts decide the reader, and neither is guessable from a fixture. The CLI
// HARD-PAINTS its continuation rows (CR + cursor-down, then a fresh indent), so
// `isWrapped` is FALSE on every one of them — an isWrapped walk finds nothing
// and a reader built on one is dead on the case it exists for. And the indent is
// two ASCII U+0020, NOT the U+00A0 that separates the marker on the head row, so
// the two cannot be matched by one pattern.
//
// `\S` is required: a row of pure whitespace is the blank line under the
// composer, not a continuation of it.
const COMPOSER_CONTINUATION = /^\u0020\u0020\S/u;

function composerContinues(row) {
  if (typeof row !== 'string') return false;
  return COMPOSER_CONTINUATION.test(row);
}

// The CLI's own recording indicator, as it lands in the BUFFER:
// `⏺ REC · tap to send`, with a U+0020 between the bullet and `REC`.
// Ground truth is the outerHTML of a LIVE recording row captured on two separate
// boxes; the indicator bytes are identical on both, U+23FA U+0020 R E C.
//
// The DOM splits the bullet into its own span ONLY to carry a different
// letter-spacing (a width correction for the wide glyph), and the space sits
// inside the ` REC` span at normal spacing. That span split is a STYLING
// boundary, NOT a cell boundary. Reading it as cell adjacency is what produced
// the earlier space-less rule, which therefore matched nothing for its whole
// life: every gate asking "is the recorder lit" answered false while the mic was
// live. Do not close the space again.
//
// The trailing `(?!\w)` is what makes the space safe, and it is why this must
// not be relaxed to `\u23fa\s*REC`. Measured against real rows, the bare-space
// and `\s*` forms both also match `⏺ RECOVERY.md` and `⏺ RECORD the
// thing`, and a phantom lit recorder arms a mic nobody asked for. Ordinary tool
// bullets (`⏺ Bash(ls)`, `⏺ Read(RECOVERY.md)`) are rejected by every
// candidate; the word boundary is the only thing that also separates the
// indicator from a bullet whose next word merely STARTS with `REC`.
//
// Bullet and space are both spelled as escapes: a pasted glyph is one editor
// normalisation away from a rule that matches nothing, and the space most of all
// — it is the byte this rule was wrong about, and a literal one cannot be
// reviewed by eye.
//
// U+23FA is the MACOS glyph; every other platform paints U+25CF. Clodex ships
// macOS-only, so no branch is written here and this rule is dark off macos.
const RECORDING = RECORDING_INDICATOR;

// The CLI's PROCESSING indicator, which REPLACES the lit one rather than joining
// it: the moment recording stops, `\u23fa REC` is gone and this is painted in its
// place, while the CLI finishes transcribing.
//
// That replacement is why this pattern has to exist, and the harm it prevents is
// measured, not assumed. The tap handler's processing arm in 2.1.251, VERBATIM
// from the minified binary (its own identifiers, so this string is greppable):
//
//   if(Ln==="processing"){if(J===null)ie.stopImmediatePropagation();return}
//
// `Ln` is the voice state, `ie` the key event, and `J` the bare single-char
// binding — the same rule as `resolveTriggerKey` below. With a one-character
// trigger `J` is non-null, so the key is NOT swallowed and the handler returns
// before touching the voice session: nothing is aborted, and the character
// falls through into the composer as a literal. From that moment `composerIsEmpty` is false, so
// every later re-arm declines — the mic never comes back until the operator
// clears the draft by hand. A permanent stuck state, not one lost utterance.
//
// Anchored on `Voice:` + `processing` and NOTHING ELSE. The trailing ellipsis is
// deliberately not encoded: the CLI's own literal is a single U+2026, but that is
// one editor normalisation away from the three-ASCII-dot form, and a rule that
// matches neither is a dead rule nobody can see is dead. `\s*` rather than a
// literal space because JS `\s` admits U+00A0, which is the separator the CLI
// actually paints elsewhere in this footer — spelling a U+0020 here is the exact
// defect COMPOSER_EMPTY carried while its fixtures agreed with it.
//
// `indicatorRows()` scans the composer row too, so a draft that literally
// contains this text blocks the operator's own re-arm; that direction is the
// safe one and is deliberate — excluding the composer row would blind the whole
// footer scan, which is the only thing indicator detection reads.
const PROCESSING = PROCESSING_INDICATOR;

// Whether the re-arm must stand down — the recorder is BUSY (running OR still
// finishing), or the screen could not be read at all.
//
// The polarity is deliberate and it is the OPPOSITE of `composerIsEmpty`'s,
// which declines silently on anything it does not recognise. Here the two
// mistakes are not symmetric: failing to see the recorder writes the trigger
// character into a LIVE recording and STOPS it, losing what the operator is
// saying, while seeing one that is not there only leaves the re-arm undone and
// the operator taps the key themselves. So an unreadable screen blocks.
//
// `rows` is the cursor row and everything below it, UNTRUNCATED. Untruncated
// because the indicator paints to the RIGHT of the cursor, and downward-only
// because the rows ABOVE the composer are transcript, where the bullet is
// ordinary output — a whole-buffer scan is a measured false positive.
function recorderBlocksRearm(rows) {
  if (!Array.isArray(rows)) return true;
  return rows.some((row) => typeof row === 'string'
    && (RECORDING.test(row) || PROCESSING.test(row)));
}

// Whether the screen shows the CLI recording RIGHT NOW. Deliberately NOT widened
// to the processing state the way `recorderBlocksRearm` is, and the asymmetry is
// the point: this one answers "is a recording live enough that one key would
// SUBMIT and stop it", and during processing the recorder has ALREADY stopped —
// a key written then ARMS a recording nobody asked for and submits nothing,
// which is the inverted failure the tap-path submit must never produce.
//
// Same pattern and same rows as `recorderBlocksRearm`, opposite failure
// handling: this one feeds a marker rather than an interlock, so an unreadable
// screen is "no evidence" rather than "assume the worst". Reading the
// recorder's state must never be confused with the re-arm's decision to stand
// down.
function recordingObserved(rows) {
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => typeof row === 'string' && RECORDING.test(row));
}

// Is the CLI still TRANSCRIBING — the third reading of the same footer rows, and
// the third polarity, which is why it is not folded into either neighbour.
//
// `recorderBlocksRearm` is RECORDING-or-PROCESSING and answers "may I write a
// trigger character"; `recordingObserved` is RECORDING-only and answers "would
// one key submit or arm". Neither answers "has the transcript landed yet", and
// substituting one for it breaks a different thing in each direction: the
// blocking one never clears while a re-armed recorder is lit, and the lit one
// reads processing as finished on the very tick it is running.
//
// UNREADABLE reads as STILL BUSY, the opposite of `recordingObserved` beside it.
// The caller is waiting to send a submit, and firing into a screen nobody could
// read is the mistake that cannot be taken back.
function processingObserved(rows) {
  if (!Array.isArray(rows)) return true;
  return rows.some((row) => typeof row === 'string' && PROCESSING.test(row));
}

// The character that arms the recorder, or null when no character can.
//
// The CLI resolves its own trigger the same way: it takes the Chat-context
// binding for `voice:pushToTalk` and uses its key ONLY when that key is a
// single character with no modifier. A modifier chord matches through a
// different comparison that no written byte can satisfy.
//
// Null in, null out, and that is not a missing default: the CLI's own default
// (space) is seeded by the READ, in voice-settings.js, so a null arriving here
// is either a binding the operator cleared or a config not yet loaded. Both
// must decline.
function resolveTriggerKey(binding) {
  if (!binding || typeof binding !== 'object') return null;
  if (binding.ctrl || binding.alt || binding.shift || binding.meta || binding.super) return null;
  return typeof binding.key === 'string' && binding.key.length === 1 ? binding.key : null;
}

// Strict `=== true`: the key travels through the `settings:get` whitelist,
// where an omission arrives as undefined, and undefined must read as off.
function readVoiceSubmitSettings(settings) {
  const raw = settings && typeof settings === 'object' ? settings : {};
  const enabled = raw.voiceSubmit === true;
  return {
    enabled,
    phrase: normalizePhrase(raw.voiceSubmitPhrase) || DEFAULT_SUBMIT_PHRASE,
  };
}

function spaceTriggerAction({ data, typedSinceEnter, voiceOn, recording, hasSink, agentSeat, altScreen } = {}) {
  if (data !== ' ' || !voiceOn || !hasSink || !agentSeat || altScreen) return null;
  if (recording) return 'stop';
  return typedSinceEnter ? null : 'start';
}

function ptyTypedSinceEnter(prev, data) {
  const text = String(data).replace(/\x1b\[[0-?]*[ -\/]*[@-~]|\x1bO./g, '');
  const cut = Math.max(text.lastIndexOf('\r'), text.lastIndexOf('\x1b'), text.lastIndexOf('\x03'));
  if (cut !== -1) return cut < text.length - 1;
  return text.length > 0 ? true : prev === true;
}

module.exports = {
  DEFAULT_SUBMIT_PHRASE,
  foldConfusables,
  triggerWords,
  normalizePhrase,
  findSubmit,
  matchTrigger,
  shouldFire,
  composerIsEmpty,
  composerHasDraft,
  composerContinues,
  recorderBlocksRearm,
  recordingObserved,
  processingObserved,
  resolveTriggerKey,
  readVoiceSubmitSettings,
  spaceTriggerAction,
  ptyTypedSinceEnter,
};
