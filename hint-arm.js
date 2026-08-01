// Automatic contextual hint arming: watch the draft the user is typing, rank the
// agent's memory against it, and register the best match as a one-shot tail hint
// so it is already in place when Enter is pressed.
//
// WHY ARM WHILE TYPING RATHER THAN ON ENTER. The CLI builds and sends the
// request within tens of milliseconds of the Enter keystroke, so a hint armed at
// Enter loses a race it cannot see losing: it lands after the request has left
// and pops on the NEXT turn, attached to the wrong question. Ranking is 0.14ms
// in-process, so arming continuously as the draft grows removes the race instead
// of managing it. Enter's pass is a correction, not the first attempt.
//
// ARMING MAY NEVER AFFECT THE KEYSTROKE. Every entry point here is fire and
// forget: no caller awaits, a proxy failure is logged at debug and swallowed.
// The user's byte reaches the PTY whether or not wirescope is even running.

const { draftChunkSignal } = require('./proxy-util');

// A pasted wall of text is not a question. Past the cap the accumulator stops
// growing, which makes the overflow state sticky until the draft is reset.
const DRAFT_CAP = 4096;

// Bounds POST volume, not compute. The embed tier (16ms warm, measured) fits
// inside this same window unchanged, which is why the number is where it is.
const DEBOUNCE_MS = 120;

// Below this many content-bearing terms a draft is not yet a question, and
// whatever it ranks against is noise.
const MIN_TERMS = 3;

// Do not re-offer the same unit to the same agent inside this window. Cleared
// early by a context clear/compact, which is the other half of the rule.
const COOLDOWN_MS = 10 * 60 * 1000;

// Fixed id so a re-arm OVERWRITES rather than accreting entries in the scope.
const HINT_ID = 'memory-context';
const TTL_S = 180;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Fold one chunk of HUMAN input into the accumulated draft. Only the caller's
// isHumanPtyInput gate decides what reaches here — injected text (dm delivery,
// nudges, ticket bodies) must never be folded, and there is deliberately no
// second gate in this module to disagree with the first one.
//
// Returns `cleared` for Ctrl-C/Ctrl-U (abandoned: the caller must disarm) and
// `closes` for Enter (submitted: one final arm pass, then reset). They are
// different outcomes even though draftChunkSignal reports \x03 as a close.
function foldDraft(draft, chunk, inPaste = false) {
  const s = chunk == null ? '' : String(chunk);
  let out = String(draft || '');
  let paste = !!inPaste;
  let closes = false;
  let cleared = false;
  let i = 0;
  const push = (c) => { if (out.length < DRAFT_CAP) out += c; };

  while (i < s.length) {
    if (!paste && s.startsWith(PASTE_START, i)) { paste = true; i += PASTE_START.length; continue; }
    if (paste && s.startsWith(PASTE_END, i)) { paste = false; i += PASTE_END.length; continue; }
    const c = s[i];
    if (paste) {
      // Inside a bracketed paste the CLI treats \r as literal — the paste does
      // not submit — so paste bytes accumulate without ever closing the draft.
      push(c);
      i++;
      continue;
    }
    if (c === '\x1b') {
      // Arrow keys and other CSI sequences arrive as ESC [ A. Without this the
      // '[' and 'A' land in the draft as content and poison the ranking.
      i++;
      if (s[i] === '[' || s[i] === 'O') {
        i++;
        while (i < s.length && !(s.charCodeAt(i) >= 0x40 && s.charCodeAt(i) <= 0x7e)) i++;
        i++;
      }
      continue;
    }
    if (c === '\x03' || c === '\x15') { out = ''; cleared = true; i++; continue; }
    if (c === '\x7f' || c === '\b') { out = out.slice(0, -1); i++; continue; }
    if (c === '\r' || c === '\n') { closes = true; i++; continue; }
    const code = s.charCodeAt(i);
    if (code >= 0x20) push(c);
    i++;
  }
  return { draft: out, closes, cleared, inPaste: paste, overflow: out.length >= DRAFT_CAP };
}

function countTerms(draft, terms) {
  try { return terms(draft).length; } catch { return 0; }
}

// deps:
//   retriever   { retrieve(draft, {agent, limit, exclude}) -> [record] }
//   compose     (records) -> string|null
//   terms       (text) -> [string]        (the ranker's own tokenizer)
//   loadState   (agent, id) -> 'full'|'title'|'absent'
//   armHints    ({base, route, id, text, ttl_s}) -> Promise
//   clearHints  ({base, route, id}) -> Promise
function createHintArm({
  retriever, compose, terms, loadState, armHints, clearHints,
  // `Date.now` unbound rather than an arrow: a nested paren in a default value
  // makes free-identifier-leaks.test.js fail to parse THIS WHOLE PARAM LIST, so
  // every dep above would stop counting as defined here and the scan would
  // report them as leaks from main.js scope.
  log = null, now = Date.now,
  debounceMs = DEBOUNCE_MS, cooldownMs = COOLDOWN_MS, minTerms = MIN_TERMS,
} = {}) {
  // agent -> Map(unit id -> offered-at ms). Deliberately NOT shared with
  // memory-load's live set: "already in context" and "already offered" are
  // different questions, and conflating them makes the first one start lying.
  const offered = new Map();
  // session key -> { timer, lastIds }
  const armed = new Map();

  const debug = (msg) => { try { if (log && log.debug) log.debug('hint', msg); } catch {} };

  const stateOf = (agent, id) => {
    // A lookup that throws resolves to ABSENT, never to FULL. The asymmetry is
    // the whole design: a false ABSENT costs a few hundred tail tokens, a false
    // FULL silently withholds something and leaves no trace in any log.
    try {
      const v = loadState ? loadState(agent, id) : 'absent';
      return v === 'full' || v === 'title' ? v : 'absent';
    } catch { return 'absent'; }
  };

  const inCooldown = (agent, id) => {
    const m = offered.get(agent);
    if (!m || !m.has(id)) return false;
    return (now() - m.get(id)) < cooldownMs;
  };

  const stateFor = (key) => {
    if (!armed.has(key)) armed.set(key, { timer: null, lastIds: null });
    return armed.get(key);
  };

  const cancelTimer = (key) => {
    const st = armed.get(key);
    if (st && st.timer) { clearTimeout(st.timer); st.timer = null; }
  };

  function pick(draft, agent, limit) {
    // Over-fetch, then apply the two ledgers per result: the suppression matrix
    // is a property of each candidate, so filtering after the rank is what keeps
    // a suppressed winner from taking the slot a live runner-up could fill.
    const pool = retriever.retrieve(draft, { agent, limit: Math.max(limit * 4, 8) }) || [];
    const out = [];
    for (const r of pool) {
      if (stateOf(agent, r.id) === 'full') continue; // the body is already there
      if (inCooldown(agent, r.id)) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  function fire(key, draft, ctx) {
    const { agent, base, route, limit = 1 } = ctx || {};
    if (!base || !route || !agent) return;
    let results;
    try { results = pick(draft, agent, limit); } catch (e) { debug(`rank failed for ${agent}: ${e.message}`); return; }
    if (!results.length) return;
    const ids = results.map((r) => r.id).join(',');
    const st = stateFor(key);
    // A draft that grows without changing the winner must not re-POST: the text
    // registered is a function of the result set, not of the keystroke count.
    if (st.lastIds === ids) return;
    let text;
    try { text = compose(results); } catch (e) { debug(`compose failed: ${e.message}`); return; }
    if (!text) return;
    st.lastIds = ids;
    let p;
    try {
      p = armHints({ base, route, id: HINT_ID, text, ttl_s: TTL_S, turn_start_only: true, once: true });
    } catch (e) { st.lastIds = null; debug(`arm threw for ${route}: ${e.message}`); return; }
    Promise.resolve(p).then((res) => {
      // Recorded on a successful POST, not on the rank: a unit the proxy never
      // accepted has not been offered, and burning its cooldown would suppress
      // the retry the failure exists to allow.
      if (res && res.status && res.status >= 400) { st.lastIds = null; debug(`arm ${route} -> ${res.status}`); return; }
      if (!offered.has(agent)) offered.set(agent, new Map());
      const m = offered.get(agent);
      for (const r of results) m.set(r.id, now());
      debug(`armed ${route} ${ids}`);
    }).catch((e) => { st.lastIds = null; debug(`arm failed for ${route}: ${e.message}`); });
  }

  return {
    // Called on every human keystroke with the session's accumulated draft.
    // `final` (Enter) skips the debounce — the draft will not grow again.
    onDraft(key, draft, ctx = {}, { final = false, overflow = false } = {}) {
      cancelTimer(key);
      if (overflow) return;
      if (countTerms(draft, terms) < minTerms) return;
      if (final) { fire(key, draft, ctx); return; }
      const st = stateFor(key);
      st.timer = setTimeout(() => { st.timer = null; fire(key, draft, ctx); }, debounceMs);
      // A pending arm must never be the reason the process stays alive.
      if (st.timer.unref) st.timer.unref();
    },

    // The draft was abandoned (Ctrl-C / Ctrl-U) or submitted. On abandon the
    // registered hint is DELETED rather than left to ride its TTL: an armed hint
    // from a discarded draft pops on whatever the user types next.
    disarm(key, ctx = {}) {
      cancelTimer(key);
      const st = stateFor(key);
      const had = st.lastIds;
      st.lastIds = null;
      if (!had) return; // nothing was registered — the clear is free but pointless
      const { base, route } = ctx;
      if (!base || !route) return;
      try {
        Promise.resolve(clearHints({ base, route, id: HINT_ID }))
          .catch((e) => debug(`disarm failed for ${route}: ${e.message}`));
      } catch (e) { debug(`disarm threw for ${route}: ${e.message}`); }
    },

    // Enter: the arm already happened, only the per-session memo resets. The
    // cooldown ledger deliberately survives — a submitted draft is exactly when
    // the offer is live.
    onSubmit(key) {
      cancelTimer(key);
      const st = stateFor(key);
      st.lastIds = null;
    },

    // Context cleared or compacted: whatever was offered is no longer in front
    // of the model, so the cooldown ends early. This is the "or until cleared,
    // whichever comes first" half of the rule.
    onContextReset(agent) { offered.delete(agent); },

    forget(key) { cancelTimer(key); armed.delete(key); },

    // Test/inspection surface.
    _offered(agent) { return new Map(offered.get(agent) || []); },
    _armedIds(key) { const st = armed.get(key); return st ? st.lastIds : null; },
  };
}

module.exports = {
  foldDraft, createHintArm,
  DRAFT_CAP, DEBOUNCE_MS, MIN_TERMS, COOLDOWN_MS, HINT_ID, TTL_S,
};
