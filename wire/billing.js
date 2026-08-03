'use strict';

// Pricing + running totals: port of proxylab/billing.py (PRICES tables,
// _price_for, _billing, _billing_openai, _new_totals, _bump, _accumulate).
// Semantics matched field-for-field against the Python — the golden gate
// (CLODEUX-PLAN.md W2 step 3) diffs this module against current proxylab
// code over the capture corpus, so "close enough" is not enough:
//   - output_tokens comes from usage_final ONLY (no usage_start fallback);
//   - service_tier comes from usage_start ONLY;
//   - input/cache_read fall back start-ward on KEY ABSENCE (Python
//     dict.get(k, fallback)), not on null;
//   - cache_creation uses Python or-semantics: an EMPTY object in
//     usage_final falls through to usage_start's;
//   - a flat cache_creation_input_tokens with no 5m/1h split is priced at
//     the cheaper 5m premium, and the basis string says so.
// Billing contract (wirescope, billing.py:241): usage_final is the
// CUMULATIVE last message_delta — never sum iterations[].
//
// Pure module: no disk I/O, no event emitters. The proxy owns when to bill
// (tee close) and the app owns persistence.

// Approximate public list prices, USD per 1M tokens. EDIT as rates change.
// Matched by LONGEST model-name prefix (so "claude-opus-4-8" beats the
// legacy bare "claude-opus-4" entry). est_usd is a DERIVED estimate; the
// authoritative billing signal is the token breakdown itself. Write
// premiums: 5m=1.25x, 1h=2x; reads=0.10x of input.
// NOTE: opus REPRICED at 4.5 — $15/$75 is 4.0/4.1 ONLY; 4.5+ is $5/$25.
const PRICES = {
  'claude-fable-5':  { in: 10.0, out: 50.0, cache_write_5m: 12.5,  cache_write_1h: 20.0, cache_read: 1.00 },
  // Intro rate, superseded on 2026-09-01 by PRICES_DATED — no hand-edit due on
  // the flip day, and editing this row instead would retro-reprice traffic
  // billed before it.
  'claude-sonnet-5': { in: 2.0,  out: 10.0, cache_write_5m: 2.50,  cache_write_1h: 4.0,  cache_read: 0.20 },
  'claude-opus-4-5': { in: 5.0,  out: 25.0, cache_write_5m: 6.25,  cache_write_1h: 10.0, cache_read: 0.50 },
  'claude-opus-4-6': { in: 5.0,  out: 25.0, cache_write_5m: 6.25,  cache_write_1h: 10.0, cache_read: 0.50 },
  'claude-opus-4-7': { in: 5.0,  out: 25.0, cache_write_5m: 6.25,  cache_write_1h: 10.0, cache_read: 0.50 },
  'claude-opus-4-8': { in: 5.0,  out: 25.0, cache_write_5m: 6.25,  cache_write_1h: 10.0, cache_read: 0.50 },
  // opus-5 needs its OWN row: longest-prefix matching cannot reach it from any
  // "claude-opus-4*" entry, so without this it is UNPRICED — billing() returns
  // est_usd null and bump() adds zero while still ticking requests, which reads
  // as a real-but-tiny cost rather than as a gap. Measured 2026-08-03: a live
  // seat logged 160 requests at $0.07 against a true ~$10.83.
  'claude-opus-5':   { in: 5.0,  out: 25.0, cache_write_5m: 6.25,  cache_write_1h: 10.0, cache_read: 0.50 },
  // legacy opus 4.0 / 4.1 (also catches their dated full ids)
  'claude-opus-4':   { in: 15.0, out: 75.0, cache_write_5m: 18.75, cache_write_1h: 30.0, cache_read: 1.50 },
  'claude-sonnet-4': { in: 3.0,  out: 15.0, cache_write_5m: 3.75,  cache_write_1h: 6.0,  cache_read: 0.30 },
  'claude-haiku-4':  { in: 1.0,  out: 5.0,  cache_write_5m: 1.25,  cache_write_1h: 2.0,  cache_read: 0.10 },
};

// OpenAI side (codex routes), same longest-prefix matching on their axes:
// no client cache writes (caching is server-side), cached input bills at
// 10% of input. NOTE: codex traffic rides a ChatGPT plan and is never
// dollar-billed — est_usd is the API-EQUIVALENT price of the same tokens,
// so codex carriage is comparable with the anthropic numbers.
const PRICES_OPENAI = {
  'gpt-5.5':       { in: 5.0,  cached_in: 0.50,  out: 30.0 },
  'gpt-5.4':       { in: 2.5,  cached_in: 0.25,  out: 15.0 },
  'gpt-5.4-mini':  { in: 0.75, cached_in: 0.075, out: 4.5 },
  'gpt-5.3-codex': { in: 1.75, cached_in: 0.175, out: 14.0 },
};

// FAST MODE (research preview, beta `fast-mode-2026-02-01`): opus-5 / opus-4-8
// run at a PREMIUM — $10/$50 vs $5/$25 — across the full context window. The
// universal cache multipliers still apply on top (5m 1.25x, 1h 2x, read 0.1x),
// so the effective row equals fable-5's. Taken from `usage.speed` on the
// RESPONSE, which is authoritative for BILLING: the request's `speed:"fast"` is
// only an ASK — opus-4-6 silently downgrades and a 429/529 can refuse it, and
// in both cases usage.speed says "standard" and standard rates are charged.
// Absent field (every non-beta request) => standard, the base PRICES row.
// Mirrors proxylab billing.py PRICES_SPEED_FAST; keep the two in lock-step.
const PRICES_SPEED_FAST = {
  'claude-opus-5':   { in: 10.0, out: 50.0, cache_write_5m: 12.5, cache_write_1h: 20.0, cache_read: 1.00 },
  'claude-opus-4-8': { in: 10.0, out: 50.0, cache_write_5m: 12.5, cache_write_1h: 20.0, cache_read: 1.00 },
};

// Scheduled repricings: prefix -> [(effective_from "YYYY-MM-DD", row)], later
// dates LAST (the walk keeps the last row whose date has been reached). Live
// traffic is priced at receipt time, so no hand-edit is needed on the flip day —
// and a receipt already billed under the old rate is never retro-repriced, which
// is correct: it records what was charged.
// Mirrors proxylab billing.py PRICES_DATED; keep the two in lock-step.
const PRICES_DATED = {
  // sonnet-5 intro rate ends 2026-08-31; standard (== sonnet-4) after.
  'claude-sonnet-5': [['2026-09-01', { in: 3.0, out: 15.0, cache_write_5m: 3.75, cache_write_1h: 6.0, cache_read: 0.30 }]],
};

// Local calendar date, mirroring the vendor's time.strftime("%Y-%m-%d",
// time.localtime(now)). LOCAL, not UTC: toISOString would flip the schedule up
// to a day early or late depending on the offset's sign, and the two ports must
// agree on which side of midnight a receipt falls.
function localDay(now) {
  const d = now instanceof Date ? now : (now == null ? new Date() : new Date(now));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Longest-prefix match (a first-hit walk silently shadowed
// "claude-opus-4-8" with the legacy "claude-opus-4" entry). null = unpriced.
//
// Options are an OBJECT, deliberately unlike the vendor's positional
// `_price_for(model, table=None, now=None, speed=None)`: a port of a now-taking
// call site onto a positional JS signature lands `now` in `speed` and fails
// OPEN — no throw, just wrong rates, the same shape as the missing opus-5 row
// that billed live turns at zero. Named keys cannot be mis-ordered.
//
// `now` is a Date or epoch MILLISECONDS (JS convention); the vendor's takes
// epoch SECONDS. Only tests inject it — production reads the wall clock.
//
// Overlay order mirrors the vendor: dated first, then fast on the SAME winning
// prefix, so fast wins where both could apply. Matching on the winning prefix
// (not re-walking) is what keeps a fast request against a model with no premium
// entry on standard rates instead of falling through to a shorter prefix's.
function priceFor(model, { table = null, now = null, speed = null } = {}) {
  if (!model) return null;
  let best = null;
  for (const [pfx, p] of Object.entries(table || PRICES)) {
    if (model.startsWith(pfx) && (best === null || pfx.length > best[0].length)) {
      best = [pfx, p];
    }
  }
  if (best === null) return null;
  // Both overlays are for the DEFAULT table only: an explicit table is the
  // caller's own axis (openai), and overlaying anthropic rows onto it would be
  // nonsense. Belt-and-braces today — both overlay tables hold only claude-*
  // keys, so no openai id can match one — but it is what keeps that true if
  // either table grows a colliding prefix. Mirrors the vendor's `table is None`.
  let row = best[1];
  if (!table && PRICES_DATED[best[0]]) {
    const today = localDay(now);
    for (const [eff, dated] of PRICES_DATED[best[0]]) {
      if (today >= eff) row = dated;
    }
  }
  if (!table && speed === 'fast' && PRICES_SPEED_FAST[best[0]]) row = PRICES_SPEED_FAST[best[0]];
  return row;
}

const _unpricedWarned = new Set();

function warnUnpriced(model, tableName) {
  if (_unpricedWarned.has(model)) return;
  _unpricedWarned.add(model);
  console.error(`[pricing] WARNING: no ${tableName} entry matches ${JSON.stringify(model)} — ` +
    'est_usd=null for its traffic; cumulative est_usd is now a FLOOR. ' +
    'Tracked in totals.unpriced_requests/unpriced_models; add rates ' +
    `to ${tableName}.`);
}

function usd(tokens, ratePerM) {
  return round6((tokens || 0) * ratePerM / 1_000_000);
}

// Python round(x, 6): correctly rounded on the double's EXACT binary
// value, ties to EVEN. toFixed rounds ties up, and exact ties are not
// rare here — token*rate/1e6 lands on one whenever the product is a
// dyadic rational (the golden gate caught 3 in the first corpus run,
// e.g. 203125 read-tokens * $0.50/1M = 0.1015625). Decompose the double
// with BigInt and round exactly; no float tricks.
function round6(x) {
  if (!Number.isFinite(x) || x === 0) return x;
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const bits = dv.getBigUint64(0);
  const sign = bits >> 63n ? -1 : 1;
  const rawExp = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & 0xfffffffffffffn;
  let exp;
  if (rawExp === 0) { exp = 1 - 1075; } else { mant |= 0x10000000000000n; exp = rawExp - 1075; }
  // |x| * 10^6 = mant * 10^6 * 2^exp; round half-to-even to integer q
  let num = mant * 1000000n;
  let den = 1n;
  if (exp >= 0) num <<= BigInt(exp);
  else den = 1n << BigInt(-exp);
  let q = num / den;
  const twiceRem = 2n * (num % den);
  if (twiceRem > den || (twiceRem === den && (q & 1n) === 1n)) q += 1n;
  return sign * Number(q) / 1e6;
}

// Python dict.get(k, fallback): fall back on key ABSENCE, an explicit
// null stays null.
function getOr(obj, key, fallback) {
  return key in obj ? obj[key] : fallback;
}

function norm(v) {
  return v === undefined ? null : v;
}

// Python or-chain truthiness: null/undefined/0/''/false and EMPTY objects
// all fall through.
function pyTruthy(v) {
  if (v == null || v === 0 || v === '' || v === false) return false;
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return false;
  return true;
}

// Formatted per-request billing. count_tokens is NOT billed for tokens
// (returns only an input count) — it spends request-rate-limit budget only.
function billing(kind, { modelResolved = null, usageFinal = null, usageStart = null, countTokens = null } = {}) {
  if (kind === 'count_tokens') {
    const ct = countTokens || {};
    return { endpoint: 'count_tokens', billable: false,
      note: 'count_tokens not billed for tokens; consumes request-rate-limit only',
      counted_input_tokens: norm(ct.input_tokens), est_usd: 0.0 };
  }
  const uf = usageFinal || {};
  const us = usageStart || {};
  const cc = (pyTruthy(uf.cache_creation) && uf.cache_creation)
    || (pyTruthy(us.cache_creation) && us.cache_creation) || {};
  const tokens = {
    input_tokens: norm(getOr(uf, 'input_tokens', us.input_tokens)),
    output_tokens: norm(uf.output_tokens),
    cache_read_input_tokens: norm(getOr(uf, 'cache_read_input_tokens', us.cache_read_input_tokens)),
    cache_write_5m_tokens: norm(cc.ephemeral_5m_input_tokens),
    cache_write_1h_tokens: norm(cc.ephemeral_1h_input_tokens),
    // flat total — fallback when the 5m/1h split is absent from the response
    cache_write_flat_tokens: norm(getOr(uf, 'cache_creation_input_tokens', us.cache_creation_input_tokens)),
    thinking_tokens: norm((uf.output_tokens_details || {}).thinking_tokens),
    service_tier: norm(us.service_tier),
    // fast mode (premium rates); final wins, absent => standard
    speed: norm(getOr(uf, 'speed', us.speed)),
  };
  const p = priceFor(modelResolved, { speed: tokens.speed });
  let est = null;
  let unpriced = false;
  let basis = 'approx public list USD/1M; edit PRICES';
  if (p) {
    let w5 = tokens.cache_write_5m_tokens;
    const w1 = tokens.cache_write_1h_tokens;
    if (w5 == null && w1 == null && tokens.cache_write_flat_tokens) {
      // no TTL split returned: don't silently drop the write cost — price
      // the flat total at the cheaper 5m premium and say so in the basis.
      w5 = tokens.cache_write_flat_tokens;
      basis += '; cache_creation split absent, flat total priced at 5m rate';
    }
    // Identity check against the standard row, not `speed === 'fast'` alone: a
    // fast request on a model with no premium entry is billed standard, and
    // saying otherwise in the basis would misreport what was actually charged.
    if (tokens.speed === 'fast' && p !== priceFor(modelResolved, {})) {
      basis += '; FAST MODE premium rates (usage.speed=fast)';
    }
    est = round6(usd(tokens.input_tokens, p.in)
      + usd(tokens.output_tokens, p.out)
      + usd(tokens.cache_read_input_tokens, p.cache_read)
      + usd(w5, p.cache_write_5m)
      + usd(w1, p.cache_write_1h));
  } else if (modelResolved) {
    // PRICING BLINDNESS guard: an unmatched model must be LOUD, not a
    // silent null that lets the totals report a confident under-count.
    unpriced = true;
    warnUnpriced(modelResolved, 'PRICES');
  }
  return { endpoint: 'messages', billable: true, model: modelResolved,
    tokens, est_usd: est, unpriced, price_basis: basis };
}

// Bill an openai /responses receipt in the same shape bump() consumes.
// OpenAI's input_tokens INCLUDES the cached portion — split it out so the
// shared totals keep anthropic semantics (input = uncached at full rate,
// cache_read = cached at the discounted rate). reasoning_tokens are part
// of output_tokens on their wire, surfaced as thinking_tokens.
function billingOpenai(modelResolved, usage) {
  const u = usage || {};
  const totalIn = u.input_tokens || 0;
  const cached = (u.input_tokens_details || {}).cached_tokens || 0;
  const tokens = {
    input_tokens: Math.max(totalIn - cached, 0),
    output_tokens: norm(u.output_tokens),
    cache_read_input_tokens: cached,
    cache_write_5m_tokens: null, cache_write_1h_tokens: null,
    cache_write_flat_tokens: null,
    thinking_tokens: norm((u.output_tokens_details || {}).reasoning_tokens),
    service_tier: null,
  };
  const p = priceFor(modelResolved, { table: PRICES_OPENAI });
  let est = null;
  let unpriced = false;
  const basis = 'API-equivalent USD/1M (chatgpt-plan traffic is never ' +
    'dollar-billed); edit PRICES_OPENAI';
  if (p) {
    est = round6(usd(tokens.input_tokens, p.in)
      + usd(cached, p.cached_in)
      + usd(tokens.output_tokens, p.out));
  } else if (modelResolved) {
    unpriced = true;
    warnUnpriced(modelResolved, 'PRICES_OPENAI');
  }
  return { endpoint: 'responses', billable: true, model: modelResolved,
    tokens, est_usd: est, unpriced, price_basis: basis };
}

function newTotals() {
  return { requests: 0, billed_requests: 0, count_tokens_requests: 0,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
    cache_write_tokens: 0, est_usd: 0.0,
    // PRICING-BLINDNESS guard: est_usd EXCLUDES these. A nonzero
    // unpriced_requests means the cumulative $ is a floor, not a total.
    unpriced_requests: 0, unpriced_models: [],
    // SERVER-SIDE refusal classifier hits (stop_reason:"refusal" — zero
    // content blocks, the model never ran). Count + evidence, not anecdotes.
    refusals: 0,
    // Completed user turns, receipt-counted: one terminal response
    // (stop_reason != tool_use) = one turn; tool-loop hops, title
    // side-calls and subagent traffic excluded at the call site
    // (stop.is_turn). CLI retries dedupe for free — a failed request never
    // produces a terminal response.
    turns: 0 };
}

function localIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function bump(totals, bill, stop) {
  totals.requests += 1;
  if (stop && stop.is_turn) totals.turns = (totals.turns || 0) + 1;
  if (stop && stop.stop_reason === 'refusal') {
    totals.refusals = (totals.refusals || 0) + 1;
    // keep the FULL stop_details: the category + explanation are the only
    // non-generic facts, and the UI renders them. `at` (epoch) lets a view
    // tell whether the captured last request IS the blocked context.
    const ev = { ts: localIso(), at: Math.round(Date.now()) / 1000,
      model: bill.model || null,
      category: ((stop.stop_details || {}).category) ?? null,
      stop_details: stop.stop_details || null,
      request_id: stop.request_id || null };
    if (!totals.refusal_events) totals.refusal_events = [];
    totals.refusal_events.push(ev);
    totals.refusal_events.splice(0, totals.refusal_events.length - 20); // keep the last 20
  }
  if (bill.endpoint === 'count_tokens') {
    totals.count_tokens_requests += 1;
  } else {
    totals.billed_requests += 1;
    const t = bill.tokens || {};
    totals.input_tokens += t.input_tokens || 0;
    totals.output_tokens += t.output_tokens || 0;
    totals.cache_read_tokens += t.cache_read_input_tokens || 0;
    const w = (t.cache_write_5m_tokens || 0) + (t.cache_write_1h_tokens || 0);
    totals.cache_write_tokens += w || (t.cache_write_flat_tokens || 0);
    totals.est_usd = round6(totals.est_usd + (bill.est_usd || 0));
    if (bill.unpriced) {
      totals.unpriced_requests = (totals.unpriced_requests || 0) + 1;
      const m = bill.model;
      if (!totals.unpriced_models) totals.unpriced_models = [];
      if (m && !totals.unpriced_models.includes(m)) totals.unpriced_models.push(m);
    }
  }
}

// Global + per-session running totals (the API never returns one).
// In-memory only; the app snapshots/persists as it sees fit.
class Ledger {
  constructor() {
    this.totals = newTotals();
    this.sessions = new Map(); // sessionKey → totals
  }

  session(key) {
    let t = this.sessions.get(key);
    if (!t) { t = newTotals(); this.sessions.set(key, t); }
    return t;
  }

  accumulate(bill, sessionKey, stop) {
    bump(this.totals, bill, stop);
    bump(this.session(sessionKey), bill, stop);
    return { ...this.totals };
  }

  forget(sessionKey) {
    this.sessions.delete(sessionKey);
  }
}

module.exports = {
  PRICES, PRICES_OPENAI, PRICES_SPEED_FAST, PRICES_DATED, priceFor, usd, round6,
  billing, billingOpenai, newTotals, bump, Ledger,
};
