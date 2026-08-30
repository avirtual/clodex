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
// and any one-word trigger appears mid-sentence. The words are common; the
// ordered sequence, at the very end of a draft, is not.
const DEFAULT_SUBMIT_PHRASE = 'over and out';

// Dictation auto-punctuates, so the spoken form arrives as `Over and out.` far
// more often than bare. Punctuation is stripped from both sides of every word
// of the CONFIGURED phrase and consumed after the match in the composer.
const EDGE_PUNCT = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

// The CLI draws its input box with a border on EVERY row and the `> ` prompt on
// the FIRST only, so a draft that outgrows one row leaves the cursor on a
// border-prefixed continuation. Reading one row would make the feature decline
// forever in exactly the long-draft case it exists for.
const BOX_GLYPH = /[│┃┊┆|]/;
const BOX_LEFT = /^[\s│┃┊┆|]*/;
const BOX_RIGHT = /[\s│┃┊┆|]*$/;
// The trailing space is required, so a bare `>` in prose is not a prompt.
const PROMPT_HEAD = /^>[ ]/;

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

// One screen row, stripped of the box it is drawn in. The right border is
// stripped only ABOVE the cursor row: the cursor row arrives already truncated
// at the cursor, so anything trailing there is the operator's own text.
function stripRow(text, { atCursor }) {
  const left = BOX_LEFT.exec(text)[0];
  let rest = text.slice(left.length);
  if (!atCursor) rest = rest.replace(BOX_RIGHT, '');
  const prompt = PROMPT_HEAD.test(rest);
  return {
    text: prompt ? rest.slice(2) : rest,
    prompt,
    // A real border GLYPH, not merely leading blanks: `BOX_LEFT` matches the
    // empty string, so without this every unindented transcript line would read
    // as a continuation and the walk would climb out of the box.
    bordered: BOX_GLYPH.test(left),
  };
}

// `rows`: the screen rows ending at the cursor, top-first, the LAST one already
// truncated at the cursor column. Returns `{ content, erase }` or null — the
// watcher fires Enter, so "I could not identify a composer" and "do not fire"
// must be the same answer.
function findSubmit(rows, phrase) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const parts = [];
  let cursorRowLen = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (!r || typeof r.text !== 'string') return null;
    const atCursor = i === rows.length - 1;
    const s = stripRow(r.text, { atCursor });
    if (atCursor) cursorRowLen = s.text.length;
    parts.unshift(s.text);
    if (s.prompt) {
      const content = parts.join('\n');
      const hit = matchTrigger(content, phrase);
      if (!hit) return { content, erase: 0 };
      // CLAMPED to the cursor row, so the erase can never cross a row boundary
      // — where the count is unknowable. The screen cannot say whether the CLI
      // soft-wrapped one logical line or the operator hard-broke two, and the
      // two differ by the newline a backspace would have to eat. Deleting more
      // than was matched eats the draft, so the floor is the safe direction: a
      // phrase straddling the wrap leaves its head in the submitted message.
      const erase = Math.min(hit.erase, cursorRowLen);
      return { content, erase };
    }
    // Only a bordered or SOFT-WRAPPED row continues the box upward. Anything
    // else means the walk left the composer without finding a prompt.
    if (!s.bordered && !r.isWrapped) return null;
  }
  // Ran out of rows still inside the box: the prompt is above the window the
  // caller supplied. Declining is the safe answer.
  return null;
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
  stripRow,
  findSubmit,
  matchTrigger,
  shouldFire,
  readVoiceSubmitSettings,
};
