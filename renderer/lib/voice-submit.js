// voice-submit.js — the trigger-phrase matcher and activation gate behind
// hands-free submit. Pure: no DOM, no terminal, no settings read.
//
// The CLI declines to auto-submit when the FINAL streamed segment is under
// three words, so a trailing-off utterance leaves the composer full.
//
// It reads ONE row, the cursor row truncated at the cursor, and anchors at `$`:
// a wrapped draft ends on the cursor row, so no upward walk is needed.

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
// we write a character the CLI will not swallow into the draft. Hence at most ONE
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
// open. Doubt delivers here, the same direction as the speaking gate.
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

// RECORDING_INDICATOR and PROCESSING_INDICATOR: docs/notes/voice-engine.md.
const RECORDING = RECORDING_INDICATOR;
const PROCESSING = PROCESSING_INDICATOR;

// RECORDING only; during processing a key would arm, not submit.
function recordingObserved(rows) {
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => typeof row === 'string' && RECORDING.test(row));
}

// `recordingObserved` cannot answer "has the transcript landed".
// UNREADABLE reads as STILL BUSY.
function processingObserved(rows) {
  if (!Array.isArray(rows)) return true;
  return rows.some((row) => typeof row === 'string' && PROCESSING.test(row));
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
  recordingObserved,
  processingObserved,
  readVoiceSubmitSettings,
  spaceTriggerAction,
  ptyTypedSinceEnter,
};
