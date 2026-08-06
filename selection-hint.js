// selection-hint.js — the operator's drawer SELECTION as a tail hint.
//
// Two tiers, and the difference is intent, not size:
//
//   PEEK (selecting text, no click) — the operator highlighted something while
//     reading. That is a weak signal: people select to read, to scroll, to mark
//     their place. It rides ONE request (`once` + a short TTL) and says so in
//     its own text, because a model told "the user selected this" will otherwise
//     treat it as an instruction and answer about it unprompted.
//   ATTACH (the Copy button) — a deliberate gesture. Longer TTL, no `once`, so
//     it survives the tool calls between "I attached this" and the turn that
//     actually uses it, and it is cleared explicitly rather than by expiry.
//
// The framing text is the whole product here. A hint arrives with no
// provenance the model can check, so an unhedged block reads as a system
// instruction: the peek tier MUST say it may be irrelevant, or every incidental
// highlight becomes a question the agent answers.
//
// Electron-free (like session-manager's M3 infra) so the composition, the caps
// and the scrub are unit-testable without a window.

'use strict';

// Per-tier wire caps. A selection is operator-chosen so it is usually small,
// but "select all" in a log pane is one chord away and the tail is billed
// UNCACHED on every request that carries it. Peek is tighter than attach
// because nobody asked for it.
const PEEK_MAX_CHARS = 2000;
const ATTACH_MAX_CHARS = 8000;

// Peek rides the next request and must not outlive the operator's attention;
// attach must survive the tool calls between the gesture and the turn that uses
// it. Both are REQUIRED by the proxy alongside `once` (proxylab/hints.py).
const PEEK_TTL_S = 120;
const ATTACH_TTL_S = 1800;

// Distinct ids so a peek never overwrites an attach, and neither collides with
// hint-arm's `memory-context`. Fixed per tier: a re-arm must OVERWRITE rather
// than accrete, since only the newest selection is the current one.
const PEEK_ID = 'operator-selection';
const ATTACH_ID = 'operator-attachment';

const TRUNCATION_NOTE = '\n… (selection truncated)';

// Cut to `max`, allowing for the scrub's expansion, then scrub, then cut again.
// ORDER MATTERS AND THE SECOND CUT IS THE GUARANTEE: `scrub` REPLACES each token
// with a shorter marker, so a token straddling the cap slides under it after
// scrubbing and the cut lands mid-token, leaving a prefix the scrub can no
// longer match. Cutting after the scrub is what prevents that.
function clampAndScrub(text, max, scrub, tokens) {
  let out = String(text == null ? '' : text);
  const over = out.length > max;
  const margin = tokens.reduce((m, t) => Math.max(m, t.length), 0);
  if (over) out = out.slice(0, max + margin);
  for (const t of tokens) out = scrub(out, t);
  if (over) {
    out = out.slice(0, Math.min(max, Math.max(0, out.length - margin))) + TRUNCATION_NOTE;
  }
  return out;
}

// The peek framing. Every clause is load-bearing:
//   - "may have nothing to do with what they are asking" — without it an
//     incidental highlight becomes a question the agent answers unprompted.
//   - "do not mention it" — a model told to ignore something still tends to
//     narrate that it is ignoring it, which is worse than silence (measured on
//     hint-retrieve's memory blocks; same failure, same fix).
//   - naming the SURFACE — "the terminal" vs "the IPC log" is what lets the
//     model tell an error the operator hit from a line they were merely reading.
function peekText(where, body) {
  return 'The user has text selected in Clodex\'s ' + where + ' right now. '
    + 'It may be what they are asking about, or it may have nothing to do with it — '
    + 'they select text for their own reasons. Use it only if it fits the question; '
    + 'if it does not, ignore it and do not mention it.\n'
    + 'Attached to this request only.\n'
    + '<selection>\n' + body + '\n</selection>';
}

// The attach framing. Deliberate, so it is stated as such — and it must say it
// PERSISTS, or the model treats a second turn's carriage as a fresh attachment
// and re-acknowledges text the operator handed it several turns ago.
function attachText(where, body) {
  return 'The user attached this text from Clodex\'s ' + where + '. '
    + 'This was a deliberate gesture, so treat it as relevant to what they are asking.\n'
    + 'It stays attached until they clear it — it is the same text on later '
    + 'requests, not a new attachment each turn.\n'
    + '<attachment>\n' + body + '\n</attachment>';
}

// Human labels for the drawer tab ids. The VISIBLE tab names, so the operator
// and the model are talking about the same surface — "it's in the ctl tab"
// resolves against what the hint already said. Unknown ids degrade to a generic
// phrase rather than leaking a raw id into model-visible text.
const WHERE = Object.freeze({
  term: 'Terminal tab',
  ctl: 'clodexctl tab',
  log: 'IPC log tab',
  activity: 'subagent Activity tab',
});

// Build the hint payload for a tier, or null when there is nothing to send.
// `scrub` and `tokens` are injected (the token store is the caller's), which is
// what keeps this module free of both electron and the CLI client.
function buildSelectionHint({ text, tab, attach = false, scrub = (s) => s, tokens = [] }) {
  const raw = String(text == null ? '' : text);
  // Trim only for the EMPTINESS test; the body keeps its indentation, which is
  // content for a diff, a stack trace or a YAML block.
  if (!raw.trim()) return null;
  const where = WHERE[tab] || 'bottom panel';
  const max = attach ? ATTACH_MAX_CHARS : PEEK_MAX_CHARS;
  const body = clampAndScrub(raw, max, scrub, tokens);
  return {
    // `bytes`/`truncated` describe what actually went, for the operator's status
    // line. The caller strips them: reporting the RAW length is a lie in exactly
    // the direction that matters — "48.8 KB riding" for a selection the cap cut
    // to 2 KB tells the operator the agent has context it does not have.
    bytes: body.length,
    truncated: raw.length > max,
    id: attach ? ATTACH_ID : PEEK_ID,
    text: attach ? attachText(where, body) : peekText(where, body),
    ttl_s: attach ? ATTACH_TTL_S : PEEK_TTL_S,
    // Peek pops on the first request that carries it; attach persists until
    // cleared. `turn_start_only` on both: a hint that lands mid-turn arrives
    // after the model has already read the question it was meant to inform.
    once: !attach,
    turn_start_only: true,
  };
}

module.exports = {
  buildSelectionHint, clampAndScrub, WHERE,
  PEEK_ID, ATTACH_ID, PEEK_TTL_S, ATTACH_TTL_S,
  PEEK_MAX_CHARS, ATTACH_MAX_CHARS, TRUNCATION_NOTE,
};
