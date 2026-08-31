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

// The re-arm half. Separate from `shouldFire` because it answers a different
// question: not "may I submit this draft" but "may I write one character into
// an empty composer to arm the CLI's recorder".
//
// The CLI's tap handler arms only from a keypress — its own
// "Re-arming focus recording after silence timeout" branch is the first branch
// INSIDE handleKeyEvent, and the flag it tests is set only by the FOCUS-mode
// silence timer, never by tap's. So nothing re-arms tap without a byte.
//
// EDGE, not level: `from`/`to` are the previous and current activity states,
// and only thinking -> idle passes. A level test would re-arm on every repeat
// event for as long as the seat sits idle, writing into a composer the operator
// may be typing in by hand.
//
// `voiceMode === 'tap'` is required here although `shouldFire` deliberately
// ignores the mode. The asymmetry is real: submit acts on words the operator
// already committed, whatever typed them, while this arms the CLI's own tap
// recorder and is meaningless anywhere else. In hold mode a single character
// cannot reach the auto-repeat threshold, so it would land in the draft as a
// literal instead.
function shouldRearm({ enabled, rearm, voiceMode, attention, from, to } = {}) {
  if (enabled !== true) return false;
  if (rearm !== true) return false;
  if (voiceMode !== 'tap') return false;
  // The same interlock as shouldFire, and it matters MORE here: an agent that
  // stopped to ask permission is idle, so the dialog opens exactly on this
  // edge, and any byte written then answers it.
  if (attention === 'permission') return false;
  return from === 'thinking' && to === 'idle';
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

// The CLI's own recording indicator, as it lands in the BUFFER. Measured
// 2026-08-31 through a real xterm replaying the painted spans (CLI 2.1.251):
// the row reads ` agents ⏺REC · tap to send`, and the bullet and
// `REC` are ADJACENT — U+23FA is width 1 in xterm's UnicodeV6 table (it is in
// none of the wide ranges), so the two spans the DOM shows separately occupy
// consecutive cells with nothing between them. Do not write a space into this
// pattern: there is no cell there to match. Spelled as an escape because a
// pasted glyph is one editor normalisation away from a rule that matches
// nothing, and this one cannot be seen by eye.
//
// The adjacency IS the anchor, and it is chosen over the alternatives on
// measured collisions rather than taste. U+23FA alone opens EVERY tool-call
// bullet (`⏺ Bash(ls)`) and matches arbitrary transcript; `REC` alone
// matches ordinary words (`RECORD`, `Read(RECOVERY.md)`); both were confirmed
// to hit real rows. The bullet followed IMMEDIATELY by `REC` hit none of them,
// because every ordinary bullet paints a space after itself.
const RECORDING = /\u23faREC/u;

// The CLI's PROCESSING indicator, which REPLACES the lit one rather than joining
// it: the moment recording stops, `\u23faREC` is gone and this is painted in its
// place, while the CLI finishes transcribing.
//
// That replacement is why this pattern has to exist, and the harm it prevents is
// measured, not assumed. In 2.1.251 the tap handler's processing arm is
// `if(voiceState==="processing"){if(J===null)stopImmediatePropagation();return}`,
// where `J` is the bare single-char binding. With a one-character trigger `J` is
// non-null, so the key is NOT swallowed and the handler returns before touching
// the voice session: nothing is aborted, and the character falls through into
// the composer as a literal. From that moment `composerIsEmpty` is false, so
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
const PROCESSING = /Voice:\s*processing/i;

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

// Was this submit VOICE-originated, and so worth marking as transcribed?
//
// The trigger phrase submits a TYPED draft ending in those words too, and that
// message is not dictated. Marking it would teach the reader to distrust the
// marker, which is worse than no marker: a reader told to treat literals as
// suspect on text the operator typed exactly will start second-guessing exact
// words. So this reads POSITIVE EVIDENCE ONLY and its default is NO.
//
// Two things stamp evidence — a composition commit, and the CLI's recording
// indicator on screen — and NEITHER PROVES THIS DRAFT WAS SPOKEN. The indicator
// says only that the recorder was running, and t571's re-arm lights it by
// machine at every turn end, so a draft typed into a lit composer would be
// marked. Typing therefore clears the stamp AND mutes the indicator path until
// the recorder next rises (the watcher's noteInput); this function only judges
// what survived that.
//
// `windowMs` bounds staleness so evidence cannot outlive the utterance that
// produced it. Null (never seen) is not stale, it is absent, and both answer no.
function isVoiceOriginated({ evidenceAt, now, windowMs } = {}) {
  if (typeof evidenceAt !== 'number' || !Number.isFinite(evidenceAt)) return false;
  if (typeof now !== 'number' || typeof windowMs !== 'number') return false;
  return now - evidenceAt <= windowMs && now >= evidenceAt;
}

// Whether the screen shows the CLI recording RIGHT NOW. Deliberately NOT widened
// to the processing state the way `recorderBlocksRearm` is, and the asymmetry is
// the point: this one answers "is a recording live enough that one key would STOP
// it", and during processing the recorder has ALREADY stopped — a key written
// then ARMS a recording nobody asked for, which is the inverted failure the
// submit-time stop must never produce.
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
    rearm: enabled && raw.voiceSubmitRearm === true,
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
  shouldRearm,
  composerIsEmpty,
  recorderBlocksRearm,
  isVoiceOriginated,
  recordingObserved,
  resolveTriggerKey,
  readVoiceSubmitSettings,
};
