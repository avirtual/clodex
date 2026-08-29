// voice-submit.js — the trigger-phrase matcher and activation gate behind
// hands-free submit. Pure: no DOM, no terminal, no settings read.
//
// The CLI declines to auto-submit when the FINAL streamed segment is under
// three words, so a trailing-off utterance leaves the composer full. This
// matches a chosen sign-off at the END of the composer so the renderer can send
// Enter itself.

// A fixed three-word radio sign-off. The default is the part that must not
// misfire, and every shorter candidate collides with ordinary speech in this
// repo: we dictate "send it", "send the message" and "message bob" constantly,
// and any one-word trigger appears mid-sentence. Three words in a fixed order,
// matched only at the very end of the composer, cannot be reached by accident.
const DEFAULT_SUBMIT_PHRASE = 'over and out';

// Dictation auto-punctuates, so the spoken form arrives as `Over and out.` far
// more often than bare. Punctuation is stripped from both sides of every word
// of the CONFIGURED phrase and consumed after the match in the composer.
const EDGE_PUNCT = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

// The composer's prompt. Box-drawing and padding may precede it; the trailing
// space is required, so a bare `>` in prose is not a prompt.
const COMPOSER_PROMPT = /^[\s│┃┊┆|]*>[ ]/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Lowercased, punctuation-stripped words. A token that is ONLY punctuation
// drops out rather than becoming an empty alternative that matches everywhere.
function triggerWords(phrase) {
  if (typeof phrase !== 'string') return [];
  return phrase.toLowerCase().split(/\s+/)
    .map((w) => w.replace(EDGE_PUNCT, ''))
    .filter(Boolean);
}

// '' for anything unusable, so a caller can fall back to the default rather
// than arm a matcher with no words — which would match every composer.
function normalizePhrase(phrase) {
  return triggerWords(phrase).join(' ');
}

// The composer contents, given the cursor row truncated at the cursor. null
// when the row carries no prompt: the watcher fires Enter, so "I could not
// identify a composer" must be indistinguishable from "do not fire".
function composerTail(rowUpToCursor) {
  if (typeof rowUpToCursor !== 'string') return null;
  const m = COMPOSER_PROMPT.exec(rowUpToCursor);
  return m ? rowUpToCursor.slice(m[0].length) : null;
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
  const m = re.exec(content);
  if (!m) return null;
  return { erase: content.length - m.index };
}

// Re-checked at FIRE time, not at arm time: voice mode is box-wide and read
// from a file that a `/voice` in any terminal rewrites, and the dialog can open
// during the quiet window.
//
// `attention === 'permission'` is the interlock, and it is not a preference:
// the CLI is showing a dialog and the Enter this feature sends would ANSWER it.
// Hold mode is excluded because the CLI's own autoSubmit already covers
// release-to-send there — a second Enter would submit the next draft.
function shouldFire({ enabled, voiceMode, attention } = {}) {
  if (enabled !== true) return false;
  if (voiceMode !== 'tap') return false;
  if (attention === 'permission') return false;
  return true;
}

// Strict `=== true`: the key travels through the `settings:get` whitelist,
// where an omission arrives as undefined, and undefined must read as off.
function readVoiceSubmitSettings(settings) {
  const raw = settings && typeof settings === 'object' ? settings : {};
  return {
    enabled: raw.voiceSubmit === true,
    phrase: normalizePhrase(raw.voiceSubmitPhrase) || DEFAULT_SUBMIT_PHRASE,
  };
}

module.exports = {
  DEFAULT_SUBMIT_PHRASE,
  triggerWords,
  normalizePhrase,
  composerTail,
  matchTrigger,
  shouldFire,
  readVoiceSubmitSettings,
};
