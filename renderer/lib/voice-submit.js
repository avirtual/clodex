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

// Strict `=== true`: the key travels through the `settings:get` whitelist,
// where an omission arrives as undefined, and undefined must read as off.
//
// `composition` is ANDed with `enabled` rather than standing alone, so the
// checkbox that disarms the feature disarms all of it. It is a second key and
// not a widening of the first because the risk differs in kind: the buffer half
// reads text the operator has already committed, while the composition half
// reads words still being transcribed, and acts on them with no undo.
function readVoiceSubmitSettings(settings) {
  const raw = settings && typeof settings === 'object' ? settings : {};
  const enabled = raw.voiceSubmit === true;
  return {
    enabled,
    composition: enabled && raw.voiceSubmitComposition === true,
    phrase: normalizePhrase(raw.voiceSubmitPhrase) || DEFAULT_SUBMIT_PHRASE,
  };
}

module.exports = {
  DEFAULT_SUBMIT_PHRASE,
  foldConfusables,
  triggerWords,
  normalizePhrase,
  findSubmit,
  matchTrigger,
  shouldFire,
  readVoiceSubmitSettings,
};
