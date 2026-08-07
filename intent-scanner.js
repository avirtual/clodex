// Intent Scanner (port of wb-wrap/scanner.py). Turns one line of assistant
// output into a structured `[agent:…]` intent (or null). Pure string work — no
// Electron, no main.js state — so the grammar (dm/who/name/context/memory/
// spawn/file/resend/exec/remind/notify-user/team-review/review-done/task/reboot
// + the `\[agent:` escape) is unit-testable in isolation.
// Seam: plain named functions on raw strings; the caller owns column-1
// anchoring by feeding it a single line at a time.
// Gotcha: cleanLine strips a leading run of DECORATOR glyphs (bullets, box
// chars) the CLI prepends to rendered lines — parseIntent trims after, so a
// bulleted `• [agent:who]` still matches, but an INDENTED one won't (the
// leading space survives cleanLine only if it's not in PREFIX_CHARS — space IS,
// so indentation is also stripped here; column-1 enforcement is the caller's).

const { parseWithRegistry } = require('./intent-registry');

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;
const PREFIX_CHARS = new Set(' \t\u2B24\u25CF\u2022\u25B6\u25B7\u25BA\u25B9\u25CB\u25CF\u25C9\u25CE\u25C6\u25C7\u25A0\u25A1\u25AA\u25AB\u2605\u2606\u2192\u27F6\u2500\u2501\u00B7\u2023\u2219\u226B\u00BB');

function stripDecorators(line) {
  let i = 0;
  while (i < line.length && PREFIX_CHARS.has(line[i])) i++;
  return line.slice(i);
}

function cleanLine(line) {
  return stripDecorators(line.replace(ANSI_RE, ''));
}

function parseIntent(rawLine) {
  const cleaned = cleanLine(rawLine).trim();
  if (!cleaned) return null;

  // Escaped intent. Stays in the SHELL, ahead of the table: an escape is a
  // QUOTE, not a verb, so no registry row (core or plugin) may ever see the
  // line — a plugin row that could match a backslash-prefixed line would
  // reopen the misfire the escape exists to close.
  const escMatch = cleaned.match(/^\\(\[agent:.*)/);
  if (escMatch) return { type: 'escape', text: escMatch[1] };

  // `end` = explicit body TERMINATOR, the only intent that IS nothing: it
  // closes an open multi-line body capture (dm/memory/remind/notify-user/…)
  // and is then discarded — _extractIntents never emits it and _handleIntent
  // never sees it. Exists because free-text bodies otherwise run to the next
  // intent or end of turn, so an agent could not write operator prose AFTER
  // a body (the prose was swallowed into the message — observed live on a
  // memory-remember). Bare-only like who/name: trailing text would be
  // ambiguous (body? prose?), so it doesn't parse. Also shell-owned: it is
  // structural (never gated, never dispatched, never shadowable by a plugin).
  if (/^\[agent:end\]\s*$/.test(cleaned)) return { type: 'end' };

  // Every actual VERB lives in intent-registry.js — core rows in the order
  // this chain used to run them, then plugin rows. See that file's header for
  // why the table exists and which laws it enforces.
  //
  // The second argument is the same line with the ANSI still in it. Only a row
  // whose body is EXECUTED reads it (parseTerm): for everything else the strip
  // is a convenience, but for a shell command it would rewrite the payload and
  // run the rewrite, which is what the vetter refuses to let happen.
  return parseWithRegistry(cleaned, stripDecorators(rawLine).trim());
}

// Fenced code blocks are QUOTES. A markdown fence only RENDERS as a quoted
// block — in the raw turn text every line inside it is still its own line at
// column 1, so before this, an intent-shaped example inside a fence FIRED
// (observed live: a documentation block sent two real dms). fencedLines maps
// each line of a turn to whether it sits in a fence (delimiter lines
// inclusive); the caller treats fenced lines as literal text — no intent
// parse, no body boundary, no near-miss bounce. Only LINE-anchored fences
// count: inline backticks are already safe (all intent regexes are
// ^-anchored, mid-line never fires), so there is no character-level backtick
// counting. CommonMark rules, pragmatically: an opener is 3+ backticks or
// tildes after optional indentation (info string allowed); the closer must
// use the opener's char, run at least as long, and carry nothing but
// whitespace — anything else is fence CONTENT (``` inside a ~~~ block stays
// literal). An unclosed fence runs to end of turn: correct markdown
// semantics, and the failure mode (a real intent below swallowed as quoted
// text) is visible in the rendered output, unlike the misfire it replaces.
function fencedLines(lines) {
  const fenced = new Array(lines.length).fill(false);
  let open = null; // { ch, len } of the current opener
  for (let k = 0; k < lines.length; k++) {
    const m = lines[k].match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (m) {
      const ch = m[1][0];
      if (!open) {
        open = { ch, len: m[1].length };
        fenced[k] = true;
        continue;
      }
      if (ch === open.ch && m[1].length >= open.len && !m[2].trim()) {
        open = null;
        fenced[k] = true;
        continue;
      }
    }
    if (open) fenced[k] = true;
  }
  return fenced;
}

// Near-miss detector for the silent-drop bounce: a line that LOOKS like an
// intent emission (cleans to `[agent:` at its start) yet parses to nothing —
// a typo'd verb, a malformed arg list, a made-up example. parseIntent must
// keep returning null for these: it doubles as the dm-body BOUNDARY in
// _extractIntents, so recognizing near-misses there would truncate any body
// that quotes an unescaped example. The caller consults this only at the TOP
// LEVEL of its scan, where such a line is otherwise dropped in silence.
// Escaped \[agent: lines never match — the backslash survives cleanLine.
// Returns the CLEANED line (ANSI/decorators stripped, ready for a bounce
// message) on a match, null otherwise.
function looksLikeIntent(rawLine) {
  const cleaned = cleanLine(rawLine).trim();
  return cleaned.startsWith('[agent:') ? cleaned : null;
}

// Stable identity of one intent occurrence for the wire-vs-jsonl shadow
// differ (both paths see the same assistant text, so the same intent hashes
// to the same key on both sides). Body capped so a huge dm doesn't bloat
// the shadow log's keys.
function shadowIntentKey(agent, intent) {
  // urgent is part of the identity: a held dm RESENT with the flag inside the
  // dedupe TTL must dispatch, not be swallowed as a duplicate of the bounce.
  const head = (intent.sub || intent.target || intent.name || intent.id || intent.cmd || intent.spec || '') + (intent.urgent ? '+urgent' : '');
  // `text` = the synthesized `unknown` intent's raw line: without it every
  // near-miss in a turn would collapse to one dedupe key and only the first
  // distinct typo would bounce.
  const body = (intent.body || intent.path || intent.text || '').trim().slice(0, 200);
  return `${agent}|${intent.type}|${head}|${body}`;
}

module.exports = { ANSI_RE, PREFIX_CHARS, cleanLine, parseIntent, fencedLines, looksLikeIntent, shadowIntentKey };
