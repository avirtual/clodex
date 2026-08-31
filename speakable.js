// speakable.js — turn an agent's final reply into something worth hearing from
// across the room, or into nothing at all.
//
// Pure string -> string, no I/O: the process side lives in speaker.js. Every
// rule here answers one question — would a person reading this aloud say it?
// A file path spelled character by character, a URL, a diff, a markdown table
// read as "pipe pipe pipe" are all unbearable, and the operator asked for the
// prose only.
//
// DROPPING BEATS MANGLING. Where a construct cannot be spoken well it is
// removed entirely rather than approximated, because the cost of a missing
// clause is a shorter sentence and the cost of a mangled one is the operator
// reaching for the mute.

// Utterance ceiling, in characters. Roughly 20-25 seconds at `say`'s default
// rate — long enough for a real answer, short enough that a wrong one can be
// waited out rather than killed. A ten-paragraph reply read verbatim is the
// failure the operator named when he asked for this; without a bound, one
// unlucky turn narrates for four minutes.
const SPEAK_MAX_CHARS = 350;

// Below this, a truncation is not worth making: cutting "Done." to "Do" says
// less than saying nothing. Only reached when a reply's FIRST sentence already
// exceeds the ceiling, so it bounds the mangling that hard truncation does.
const SPEAK_MIN_CHARS = 24;

// An intent line is machinery, not speech, and its BODY is greedy — it runs to
// a bare [agent:end] or to the end of the reply. Speaking a dm body aloud
// narrates a message addressed to another agent, which is the sharpest form of
// "not the final text" this repo can produce. Matched on the same shape the
// scanner uses, anchored at line start after decoration is stripped.
const INTENT_OPEN = /^\s*(?:[-*>]\s*)?\[agent:([a-z-]+)/i;
const INTENT_END = /^\s*(?:[-*>]\s*)?\[agent:end\]/i;

// A fence toggles; anything between toggles is code and is dropped whole. An
// UNCLOSED fence drops the rest of the reply rather than speaking it, which is
// the safe direction: the tail of an unclosed fence is code by construction.
const FENCE = /^\s*(?:```|~~~)/;

function stripBlocks(text) {
  const out = [];
  let inFence = false;
  let inIntent = false;
  for (const line of String(text).split('\n')) {
    if (FENCE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (inIntent) {
      if (INTENT_END.test(line) || INTENT_OPEN.test(line)) inIntent = !INTENT_END.test(line);
      continue;
    }
    const open = INTENT_OPEN.exec(line);
    if (open) {
      // `end` closes a body and opens nothing; every other verb may carry one.
      inIntent = open[1].toLowerCase() !== 'end';
      continue;
    }
    // A table row is data, and its cells are fragments that do not compose into
    // a sentence. Two pipes is the discriminator: one pipe appears in ordinary
    // prose about shell commands.
    if ((line.match(/\|/g) || []).length >= 2) continue;
    out.push(line);
  }
  return out.join('\n');
}

// True for a token no one would read aloud: paths, URLs, and bare filenames.
// Deliberately conservative about the slash — `and/or` and `TCP/IP` are words,
// so a slash alone is not enough; it must look anchored (leading /, ~, ./) or
// carry a file extension.
function isUnspeakableToken(tok) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) return true;      // scheme://
  if (/^(?:~|\.{1,2})?\//.test(tok)) return true;              // /abs ~/home ./rel ../up
  if (/\//.test(tok) && /\/[\w.-]+\.[a-z0-9]{1,5}\b/i.test(tok)) return true; // dir/file.ext
  if (/^[\w-]+\.[a-z0-9]{1,5}$/i.test(tok) && !/^\d+\.\d+$/.test(tok)) {
    // A bare `renderer.js`. The version-number exclusion above matters: "3.14"
    // and "0.16" are numbers a sentence can legitimately be about.
    return /\.(?:js|ts|json|md|css|html|sh|py|yaml|yml|toml|lock|aiff|png|jsx|tsx)$/i.test(tok);
  }
  return false;
}

// Give a fragment a sentence end unless it already has one. Only used where a
// line break carried the pause that punctuation now has to carry instead.
function endStopped(body) {
  const t = body.trim();
  if (!t) return '';
  return /[.!?:;,]$/.test(t) ? t : `${t}.`;
}

function stripInline(text) {
  return String(text)
    // Link text is the speakable half; the target never is.
    .replace(/!?\[([^\]\n]*)\]\(([^)\n]*)\)/g, '$1')
    // Backtick delimiters go BEFORE the path pass, so `renderer/renderer.js`
    // reaches it as a bare token and is dropped. Removing them later would
    // leave every path quoted and spoken.
    .replace(/`{1,3}([^`\n]*)`{1,3}/g, '$1')
    // A heading is a fragment and the line break after it is the only pause it
    // has; end-stopping it is what keeps "Summary" from running into the
    // sentence below it.
    .replace(/^\s{0,3}#{1,6}\s+(.*?)\s*$/gm, (_m, body) => endStopped(body))
    .replace(/^\s{0,3}>\s?/gm, '')           // block quotes
    // A list item is a sentence for the ear. The trailing period is added with
    // the marker removed, or consecutive items run together into one
    // unpunctuated string and `say` reads them without a pause.
    .replace(/^\s*[-*+]\s+(.*?)\s*$/gm, (_m, body) => endStopped(body))
    .replace(/^\s*\d+[.)]\s+(.*?)\s*$/gm, (_m, body) => endStopped(body))
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')      // rules
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')   // strong / strike
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '$1'); // emphasis
}

function dropTokens(text) {
  return String(text)
    .split(/(\s+)/)
    .map((tok) => (/\s/.test(tok) ? tok : (isUnspeakableToken(tok.replace(/^[([{"']+|[)\]}"',.;:]+$/g, '')) ? '' : tok)))
    .join('');
}

// Cut at the last sentence end at or below the ceiling, so the narration stops
// where a person would. Falling back to a word boundary and then to a hard cut
// is what keeps a single 400-character sentence from being dropped entirely.
function truncate(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  const sentence = head.search(/[.!?](?=[^.!?]*$)/);
  if (sentence >= SPEAK_MIN_CHARS) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(' ');
  if (word >= SPEAK_MIN_CHARS) return head.slice(0, word);
  return text.slice(0, max);
}

// The whole pipeline. Returns '' for a turn with nothing worth saying — a pure
// tool-call turn, a diff, a reply that was only an intent — and the caller
// speaks nothing rather than clearing its throat.
function speakable(text, { max = SPEAK_MAX_CHARS } = {}) {
  if (!text || typeof text !== 'string') return '';
  let t = dropTokens(stripInline(stripBlocks(text)));
  // Horizontal space only, and per-line trimming that PRESERVES blank lines: a
  // collapse of every whitespace run would eat the paragraph breaks before the
  // rule below can read them, silently running two sentences together.
  t = t.replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
  // Paragraph breaks become sentence breaks so `say` pauses where the writing
  // did; a newline alone runs two sentences together.
  t = t.replace(/\n{2,}/g, '. ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/(?:\.\s*){2,}/g, '. ').trim();
  if (!t) return '';
  return truncate(t, max).trim();
}

module.exports = { speakable, isUnspeakableToken, SPEAK_MAX_CHARS, SPEAK_MIN_CHARS };
