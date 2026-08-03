// Automatic contextual hint arming: accumulate the draft the user is typing,
// pre-arm on a typing pause, and re-arm on Enter.
//
// THE ARM MUST PRECEDE ENTER. A hint is `turn_start_only` + `once`, so it rides
// the FIRST request of a turn; Enter reaches the CLI in ~0ms and a rank takes
// 190-320ms (measured 2026-08-03, 2,220 units), so arming ON Enter always lands
// one turn late. Arming while typing was reverted once (e9b1781) as racing
// nothing — true only while the ranker was synchronous. Its two real objections
// are answered by the debounce (cancelled per keystroke, so only a pause ranks)
// and by `holding` (a live pre-arm holds the inject queue, since an injected
// turn is the only thing that could pop the hint before the draft is sent).
//
// The registered hint is a REGISTER, not a queue: every pass overwrites it on a
// fixed id, and a pass that finds nothing CLEARS it. Without that clear an
// edited-away draft keeps serving the winner it no longer describes.
//
// ARMING MAY NEVER AFFECT THE KEYSTROKE. Every entry point here is fire and
// forget: no caller awaits, a proxy failure is logged at debug and swallowed.
// The user's byte reaches the PTY whether or not wirescope is even running.

const { draftChunkSignal } = require('./proxy-util');

// A pasted wall of text is not a question. Past the cap the accumulator stops
// growing, which makes the overflow state sticky until the draft is reset.
const DRAFT_CAP = 4096;

// Below this many content-bearing terms a draft is not yet a question, and
// whatever it ranks against is noise.
const MIN_TERMS = 3;

// Typing pause that triggers the pre-arm. Must clear a slow typist's
// inter-keystroke gap and still leave room for a 190-320ms rank before Enter.
const DEBOUNCE_MS = 300;

// Cap on the inject hold, so a walked-away draft cannot starve deliveries. Keep
// it under the queue's own INJECT_QUIET_MAXWAIT — the hold is the narrower claim.
const HOLD_MAX_MS = 30 * 1000;

// Cosine floor for the personal path, measured 2026-08-03 over the live 2,220
// unit corpus. It is NOT a general junk threshold — that experiment is in
// hint-embed.js and failed, because junk and real drafts overlap on cosine.
// Admission there happens on question SHAPE first, so this only has to separate
// a weak personal match from a strong one. At 0.55: 7 right, 2 wrong, 1 silent
// over 10 questions, with 0 false arms over 14 work drafts. Raising it to 0.58
// drops recall to 4 right and buys nothing, since the shape test already
// rejected everything the threshold would have caught.
const PERSONAL_MIN_SIM = 0.55;

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
// THE ACCUMULATOR MODELS A LINE EDITOR, NOT A TYPEWRITER. An append-only
// accumulator desynchronises from the screen the moment the user edits by any
// means other than the backspace key: Ctrl-W, Ctrl-K and cursor-then-type all
// leave words in the ranked draft that the user has already removed, and the
// divergence survives until Enter, which is exactly when it gets ranked. That
// is a silent corruption of every query it touches.
//
// What CANNOT be modelled from the input byte stream is marked `desync` instead
// of guessed at: history recall (up/down arrow) and tab completion both replace
// the line with text that never came through this function, so no amount of
// key handling recovers them. The caller must not arm on a desynced draft — a
// wrong draft ranks confidently against the wrong thing, which is worse than
// not arming at all. Sticky until the draft is reset, because there is no way
// back to a known state short of starting over.
//
// Returns `cleared` for Ctrl-C/Ctrl-U (abandoned: the caller must disarm) and
// `closes` for Enter (submitted: one final arm pass, then reset). They are
// different outcomes even though draftChunkSignal reports \x03 as a close.
//
// `prev` is the previous return value; a bare string is accepted as the
// cursor-at-end state so a caller with only the text can still fold.
function foldDraft(prev, chunk, inPaste = false) {
  const s = chunk == null ? '' : String(chunk);
  const st = (prev && typeof prev === 'object') ? prev : { draft: String(prev || '') };
  let out = String(st.draft || '');
  let cur = Number.isInteger(st.cursor) ? Math.min(Math.max(st.cursor, 0), out.length) : out.length;
  let desync = !!st.desync;
  let paste = !!inPaste;
  let closes = false;
  let cleared = false;
  let i = 0;

  const insert = (text) => {
    if (out.length >= DRAFT_CAP) return;
    out = out.slice(0, cur) + text + out.slice(cur);
    cur += text.length;
  };
  const reset = () => { out = ''; cur = 0; desync = false; };
  // Backwards over whitespace, then over the word itself — readline's Ctrl-W.
  const wordStart = () => {
    let j = cur;
    while (j > 0 && /\s/.test(out[j - 1])) j--;
    while (j > 0 && !/\s/.test(out[j - 1])) j--;
    return j;
  };
  const wordEnd = () => {
    let j = cur;
    while (j < out.length && /\s/.test(out[j])) j++;
    while (j < out.length && !/\s/.test(out[j])) j++;
    return j;
  };

  while (i < s.length) {
    if (!paste && s.startsWith(PASTE_START, i)) { paste = true; i += PASTE_START.length; continue; }
    if (paste && s.startsWith(PASTE_END, i)) { paste = false; i += PASTE_END.length; continue; }
    const c = s[i];
    if (paste) {
      // Inside a bracketed paste the CLI treats \r as literal — the paste does
      // not submit — so paste bytes accumulate without ever closing the draft.
      insert(c);
      i++;
      continue;
    }
    if (c === '\x1b') {
      i++;
      if (s[i] === '[' || s[i] === 'O') {
        const introducer = i;
        i++;
        while (i < s.length && !(s.charCodeAt(i) >= 0x40 && s.charCodeAt(i) <= 0x7e)) i++;
        const seq = s.slice(introducer + 1, i + 1);
        const final = s[i];
        i++;
        // An unterminated sequence means the chunk boundary split it. Nothing
        // is desynced yet — but the tail arrives as a bare fragment next chunk
        // and would be read as content, so treat it as unmodelable.
        if (final === undefined) { desync = true; continue; }
        if (seq === 'D' || seq === 'OD') cur = Math.max(0, cur - 1);
        else if (seq === 'C' || seq === 'OC') cur = Math.min(out.length, cur + 1);
        else if (seq === 'H' || seq === '1~' || seq === 'OH') cur = 0;
        else if (seq === 'F' || seq === '4~' || seq === 'OF') cur = out.length;
        else if (seq === '3~') out = out.slice(0, cur) + out.slice(cur + 1); // Delete
        // Up/down recall a history entry, replacing the line with text that
        // never passed through here. Unrecoverable by construction.
        else if (seq === 'A' || seq === 'B' || seq === 'OA' || seq === 'OB') desync = true;
        continue;
      }
      // ESC-prefixed word motions (Alt-B / Alt-F / Alt-D). Without these the
      // letter lands in the draft as content.
      const k = s[i];
      i++;
      if (k === 'b' || k === 'B') { cur = wordStart(); continue; }
      if (k === 'f' || k === 'F') { cur = wordEnd(); continue; }
      if (k === 'd' || k === 'D') { out = out.slice(0, cur) + out.slice(wordEnd()); continue; }
      if (k === undefined) { desync = true; continue; }
      // A bare ESC (or an unknown meta key) may open a mode this function does
      // not model. Do not silently drop it.
      desync = true;
      continue;
    }
    if (c === '\x03' || c === '\x15') { reset(); cleared = true; i++; continue; }
    if (c === '\x7f' || c === '\b') {
      if (cur > 0) { out = out.slice(0, cur - 1) + out.slice(cur); cur--; }
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') { closes = true; i++; continue; }
    if (c === '\x01') { cur = 0; i++; continue; }                                  // Ctrl-A
    if (c === '\x05') { cur = out.length; i++; continue; }                         // Ctrl-E
    if (c === '\x02') { cur = Math.max(0, cur - 1); i++; continue; }               // Ctrl-B
    if (c === '\x06') { cur = Math.min(out.length, cur + 1); i++; continue; }      // Ctrl-F
    if (c === '\x0b') { out = out.slice(0, cur); i++; continue; }                  // Ctrl-K
    if (c === '\x04') { out = out.slice(0, cur) + out.slice(cur + 1); i++; continue; } // Ctrl-D
    if (c === '\x17') {                                                           // Ctrl-W
      const j = wordStart();
      out = out.slice(0, j) + out.slice(cur);
      cur = j;
      i++;
      continue;
    }
    const code = s.charCodeAt(i);
    if (code >= 0x20) { insert(c); i++; continue; }
    // Tab completion, Ctrl-P/N history, Ctrl-Y yank, Ctrl-T transpose: each
    // changes the line in ways the byte stream alone does not describe. Ctrl-L
    // (redraw) is harmless but not worth a special case — a redraw during
    // typing is rare and losing one hint costs nothing.
    if (code !== 0x0c) desync = true;
    i++;
  }
  cur = Math.min(Math.max(cur, 0), out.length);
  return { draft: out, cursor: cur, closes, cleared, desync, inPaste: paste, overflow: out.length >= DRAFT_CAP };
}

// `id on=term,term score=N.NN` — the audit line for one armed unit.
function whyOf(r) {
  const ev = (r && r.evidence) || {};
  // A semantically ranked unit has no matched terms — the audit line must say
  // WHICH ranker chose it, or a wrong hint cannot be attributed to the half that
  // produced it.
  if (typeof ev.sim === 'number') return `${r.id} by=semantic sim=${ev.sim.toFixed(3)}`;
  const hits = Array.isArray(ev.hits) ? ev.hits.join(',') : '';
  const s = typeof ev.score === 'number' ? ev.score.toFixed(2) : '?';
  const c = typeof ev.coverage === 'number' ? ` cov=${(ev.coverage * 100).toFixed(0)}%` : '';
  return `${r.id} on=${hits || '?'} score=${s}${c}`;
}

function countTerms(draft, terms) {
  try { return terms(draft).length; } catch { return 0; }
}

// deps:
//   retriever   { retrieve(draft, {agent, limit, exclude}) -> [record] }
//   semantic    { rank(draft, {agent, limit}) -> Promise<[record]|null> }  optional
//   compose     (records) -> string|null
//   terms       (text) -> [string]        (the ranker's own tokenizer)
//   loadState   (agent, id) -> 'full'|'title'|'absent'
//   armHints    ({base, route, id, text, ttl_s}) -> Promise
//   clearHints  ({base, route, id}) -> Promise
function createHintArm({
  retriever, semantic = null, compose, terms, loadState, armHints, clearHints,
  // Injected like `terms` so this module keeps no opinion about the tokenizer or
  // the admission grammar; absent, the personal path is simply off.
  personalAsk = null,
  // `Date.now` unbound rather than an arrow: a nested paren in a default value
  // makes free-identifier-leaks.test.js fail to parse THIS WHOLE PARAM LIST, so
  // every dep above would stop counting as defined here and the scan would
  // report them as leaks from main.js scope.
  // Applied AFTER every ranker and ledger, so it narrows what was already
  // admitted and can never widen it. Absent, the winner rides alone.
  selectWithinBudget = null, maxUnits = 3,
  log = null, now = Date.now,
  // Read per call, never captured: the setting is a live checkbox, so a value
  // sampled at construction would need an app restart to take effect.
  enabled = null,
  cooldownMs = COOLDOWN_MS, minTerms = MIN_TERMS,
  debounceMs = DEBOUNCE_MS, holdMaxMs = HOLD_MAX_MS,
} = {}) {
  // agent -> Map(unit id -> offered-at ms). Deliberately NOT shared with
  // memory-load's live set: "already in context" and "already offered" are
  // different questions, and conflating them makes the first one start lying.
  const offered = new Map();
  // session key -> { timer, lastIds, holdSince }
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
    if (!armed.has(key)) armed.set(key, { timer: null, lastIds: null, holdSince: 0 });
    return armed.get(key);
  };

  const cancelTimer = (key) => {
    const st = armed.get(key);
    if (st && st.timer) { clearTimeout(st.timer); st.timer = null; }
  };

  const hold = (key) => { stateFor(key).holdSince = now(); };
  const release = (key) => { const st = armed.get(key); if (st) st.holdSince = 0; };

  // THE REGISTER IS LAST-WRITE-WINS, AND THE EMPTY WRITE IS THE ONE THAT WAS
  // MISSING. Re-ranking a changed draft already overwrites the hint on the fixed
  // id, but a draft that edits its way out of matching ANYTHING used to leave the
  // previous winner registered, so it rode a turn it no longer described.
  function clearArmed(key, ctx) {
    const st = armed.get(key);
    if (!st || !st.lastIds) return;
    st.lastIds = null;
    const { base, route } = ctx || {};
    if (!base || !route) return;
    try {
      Promise.resolve(clearHints({ base, route, id: HINT_ID }))
        .catch((e) => debug(`stale clear failed for ${route}: ${e.message}`));
    } catch (e) { debug(`stale clear threw for ${route}: ${e.message}`); }
  }

  // The two ledgers, applied per candidate AFTER whichever ranker produced it:
  // the suppression matrix is a property of the record, not of the ranking, so
  // filtering last is what keeps a suppressed winner from taking the slot a live
  // runner-up could fill.
  function admissible(pool, agent, limit) {
    const out = [];
    for (const r of pool || []) {
      if (stateOf(agent, r.id) === 'full') continue; // the body is already there
      if (inCooldown(agent, r.id)) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  function pick(draft, agent, limit) {
    const pool = retriever.retrieve(draft, { agent, limit: Math.max(limit * 4, 8) }) || [];
    return admissible(pool, agent, limit);
  }

  // THE GATE IS LEXICAL, THE ORDER IS SEMANTIC, AND THE HALVES ARE NOT
  // INTERCHANGEABLE. Measured over 28 paraphrase queries against the curated
  // tags: embedding ranks better (precision@1 0.636 vs 0.409, winning 5 and
  // losing 0) but CANNOT abstain — top cosine for junk drafts (0.490-0.600)
  // overlaps real ones (0.536-0.708), so no threshold separates them. Lexical
  // abstains correctly because a draft sharing no rare terms with any record
  // cannot clear MIN_HITS.
  //
  // So the semantic ranker is consulted only once `pick` has already decided
  // something is worth arming, and it re-ranks the WHOLE corpus rather than the
  // survivors: lexical's cuts leave too few records to reorder (measured: no
  // change at all, 0.500 -> 0.500).
  async function refine(lexical, draft, agent, limit) {
    if (!semantic) return lexical;
    let ranked;
    // A null return means "no opinion" (daemon down, corpus not embedded yet)
    // and MUST fall through to the lexical order — the whole point is that the
    // embedding is optional infrastructure.
    try { ranked = await semantic.rank(draft, { agent, limit: Math.max(limit * 4, 8) }); } catch (e) {
      debug(`semantic rank failed for ${agent}: ${e.message}`);
      return lexical;
    }
    if (!ranked || !ranked.length) return lexical;
    const out = admissible(ranked, agent, limit);
    return out.length ? out : lexical;
  }

  // A question about the USER, admitted by shape because the lexical gate
  // structurally cannot rank it (see personalAsk in hint-retrieve.js: a one-term
  // query ties every match). This is the ONE path where the embedding decides
  // whether to arm and not merely in what order — so it is gated on the semantic
  // ranker having an actual opinion, and a null (no daemon, corpus not embedded)
  // returns empty and leaves the lexical outcome untouched. Without Ollama this
  // whole branch is inert and arming is bit-identical to what it was before.
  async function personal(draft, agent, limit) {
    if (!semantic || !personalAsk || !personalAsk(draft)) return [];
    let ranked;
    try { ranked = await semantic.rank(draft, { agent, limit: Math.max(limit * 4, 8) }); } catch (e) {
      debug(`personal rank failed for ${agent}: ${e.message}`);
      return [];
    }
    if (!ranked || !ranked.length) return [];
    // The cosine floor is the abstain the embedding cannot do on its own. It is
    // only defensible here because admission already happened on shape: measured
    // over 14 work drafts (incl. "why is my test failing", "where is my config
    // file") the shape test admitted none of them, so this threshold never has
    // to separate junk from real — only a weak personal match from a strong one.
    const top = ranked.filter((r) => !(typeof r.evidence?.sim === 'number')
      || r.evidence.sim >= PERSONAL_MIN_SIM);
    return top.length ? admissible(top, agent, limit) : [];
  }

  // A hold outlives the pass that opened it — it must cover the span from "rank
  // in flight" through "armed, draft not yet sent". Only a pass that armed
  // nothing releases; the `finally` is what keeps a throw in `rank` from leaking
  // a hold and stalling that session's deliveries for the whole cap.
  async function fire(key, draft, ctx, { preArm = false } = {}) {
    try { await rank(key, draft, ctx); } finally {
      const st = armed.get(key);
      if (preArm && (!st || !st.lastIds)) release(key);
    }
  }

  async function rank(key, draft, ctx) {
    // The budget, not this, is what decides how many units ride — this only has
    // to be wide enough to give it a choice. Every ranker and both ledgers run
    // over the whole set, so a suppressed unit still cannot reach the budget.
    const { agent, base, route, limit = selectWithinBudget ? maxUnits : 1 } = ctx || {};
    if (!base || !route || !agent) return;
    // YIELD BEFORE THE RANK. `async` only defers a body from its first await
    // onward, and `pick` is synchronous — measured at 60ms over the live 2,220
    // record corpus, which onDraft's caller would otherwise eat on the keystroke
    // path. setImmediate rather than a microtask: a microtask still runs before
    // the loop gets to pending I/O, which is the thing being protected.
    await new Promise((r) => setImmediate(r));
    let results;
    try { results = pick(draft, agent, limit); } catch (e) { debug(`rank failed for ${agent}: ${e.message}`); return; }
    const nothing = () => clearArmed(key, ctx);
    // Only when lexical found nothing: a draft the normal gate can serve is
    // served by it, so this cannot regress any existing arm.
    if (!results.length) {
      try { results = await personal(draft, agent, limit); } catch (e) {
        debug(`personal failed for ${agent}: ${e.message}`);
        results = [];
      }
    }
    if (!results.length) { nothing(); return; }
    try { results = await refine(results, draft, agent, limit); } catch (e) {
      debug(`refine failed for ${agent}: ${e.message}`);
    }
    if (!results.length) { nothing(); return; }
    // Last, on the final ordering: the budget spends on what the rankers
    // actually chose, and cutting here rather than earlier keeps a unit the
    // semantic pass would have promoted from being dropped for its size first.
    if (selectWithinBudget) {
      try { results = selectWithinBudget(results); } catch (e) {
        debug(`budget failed for ${agent}: ${e.message}`);
      }
      if (!results.length) { nothing(); return; }
    }
    const ids = results.map((r) => r.id).join(',');
    const st = stateFor(key);
    // A draft that grows without changing the winner must not re-POST: the text
    // registered is a function of the result set, not of the keystroke count.
    // This is also what makes the Enter pass free after a pre-arm hit the same
    // winner — the safety-net POST only fires when the pre-arm did not run.
    if (st.lastIds === ids) return;
    let text;
    try { text = compose(results); } catch (e) { debug(`compose failed: ${e.message}`); return; }
    if (!text) { nothing(); return; }
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
      // The matched TERMS and score, never the draft itself: precision is
      // unauditable without knowing why a unit won, but a draft is raw operator
      // text and may carry a secret, so only the ranker's own filtered tokens
      // are safe to write. Dropping this is what made every judgement about
      // hint quality a guess.
      debug(`armed ${route} ${results.map(whyOf).join(' | ')}`);
    }).catch((e) => { st.lastIds = null; debug(`arm failed for ${route}: ${e.message}`); });
  }

  return {
    // A keystroke cancels the pending pre-arm and reschedules it, so only a
    // pause ranks. Enter (`final`) skips the debounce and re-POSTs — idempotent
    // on the fixed hint id, and the safety net for a draft sent inside 300ms.
    onDraft(key, draft, ctx = {}, { final = false, overflow = false, desync = false } = {}) {
      cancelTimer(key);
      if (enabled && !enabled()) return;
      // Each of these gates says the CURRENT draft cannot be ranked — which is
      // also a reason not to keep serving a hint ranked against an earlier one.
      if (overflow) { clearArmed(key, ctx); return; }
      // The accumulator no longer matches the screen (history recall, tab
      // completion). Ranking it would answer a question the user never asked,
      // and would do it with full confidence.
      if (desync) { clearArmed(key, ctx); return; }
      // MIN_TERMS assumes a short draft is not yet a question. That holds for
      // prose, but "do i have kids" reduces to ONE content term and is a
      // complete question — so a draft the shape test recognises skips the
      // length floor. It is not a weaker gate: personalAsk is strictly narrower
      // than "has three terms", and its branch still needs a semantic opinion.
      const short = countTerms(draft, terms) < minTerms;
      if (short && !(personalAsk && semantic && personalAsk(draft))) { clearArmed(key, ctx); return; }
      // Deliberately NOT awaited, and the rejection is swallowed here rather
      // than left to bubble: `fire` became async when the semantic ranker landed
      // and an unhandled rejection on the keystroke path would crash the main
      // process on a daemon hiccup.
      const go = (preArm) => Promise.resolve(fire(key, draft, ctx, { preArm }))
        .catch((e) => debug(`fire failed: ${e && e.message}`));
      if (final) { go(false); return; }
      const st = stateFor(key);
      // Held from the TIMER, not from the rank it starts: by the time the pause
      // elapses the operator has stopped typing, so the inject queue's own
      // typing-gate has already stopped covering this draft.
      hold(key);
      st.timer = setTimeout(() => { st.timer = null; go(true); }, debounceMs);
      // A pending arm must never be the reason the process stays alive.
      if (st.timer && typeof st.timer.unref === 'function') st.timer.unref();
    },

    // The draft was abandoned (Ctrl-C / Ctrl-U) or submitted. On abandon the
    // registered hint is DELETED rather than left to ride its TTL: an armed hint
    // from a discarded draft pops on whatever the user types next.
    disarm(key, ctx = {}) {
      cancelTimer(key);
      release(key);
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
      release(key);
      const st = stateFor(key);
      st.lastIds = null;
    },

    // True while a pre-armed hint waits for the draft that earned it. The inject
    // queue gates on this: a turn start is the only thing that pops a one-shot
    // hint, and an injected message is the only thing that starts one here.
    holding(key) {
      const st = armed.get(key);
      if (!st || !st.holdSince) return false;
      if (now() - st.holdSince >= holdMaxMs) { st.holdSince = 0; return false; }
      return true;
    },

    // Context cleared or compacted: whatever was offered is no longer in front
    // of the model, so the cooldown ends early. This is the "or until cleared,
    // whichever comes first" half of the rule.
    onContextReset(agent) { offered.delete(agent); },

    forget(key) { cancelTimer(key); release(key); armed.delete(key); },

    // Test/inspection surface.
    _offered(agent) { return new Map(offered.get(agent) || []); },
    _armedIds(key) { const st = armed.get(key); return st ? st.lastIds : null; },
  };
}

module.exports = {
  foldDraft, createHintArm,
  DRAFT_CAP, MIN_TERMS, COOLDOWN_MS, HINT_ID, TTL_S, DEBOUNCE_MS, HOLD_MAX_MS,
};
