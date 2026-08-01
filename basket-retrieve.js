// Retriever over the operator basket: things the operator actually said, plus
// the reply that answered each one. Same interface as the memory retriever
// (`retrieve(draft, {agent, limit, exclude}) -> [record]`), so the arming side
// never learns there are two sources.
//
// WHY THIS IS NOT THE MEMORY RETRIEVER WITH A DIFFERENT PATH. Two properties of
// the corpus break the memory retriever's assumptions, both measured on the real
// 13,926-message basket:
//
//   1. SCALE. The memory store re-reads and re-indexes on every query, which is
//      2ms over 182 units and 330ms over the basket — 230ms of it tokenizing.
//      An index that is rebuilt per keystroke-submit is not affordable here, so
//      this module builds an inverted index ONCE and reuses it.
//   2. FLATNESS. 13,926 short messages have far flatter document frequencies
//      than 182 curated units, so `MIN_COVERAGE = 0.35` — derived on the memory
//      store — saturates: unrelated records tie at 100%. The thresholds here are
//      re-derived against THIS corpus and must not be copied back.
//
// The postings list is the whole point: a query touches the records containing
// its terms (hundreds) rather than all 13,926.

const fs = require('fs');
const { terms } = require('./hint-retrieve');

// A term in this many records or more is structural to how the operator writes,
// not a topic ("the", "should", "clodex" in a Clodex corpus). Kept as a FRACTION
// because the basket grows continuously — an absolute count would silently stop
// filtering as the corpus doubles.
const MAX_DF_RATIO = 0.08;

// COVERAGE DOES NOT DISCRIMINATE ON THIS CORPUS, AND NO LEXICAL THRESHOLD
// REPLACES IT. Measured over the real 13,926-message basket: with 14k records
// averaging 200 tokens, SOME record contains every surviving query term, so
// both a precise query and a vague one reach 100% coverage. Absolute matched
// mass fails the same way (the worst vague query scores 25.1, higher than a
// good one at 17.3). Requiring a rare term helps but still admits a wrong
// record that matched on one rare word.
//
// That is a property of corpus size, not of the numbers chosen: on 182 curated
// units coverage separated related from unrelated cleanly (42-100% vs 19-32%),
// and the same statistic collapses here. So these thresholds are a FLOOR that
// keeps obvious noise out, NOT a precision mechanism — the basket needs the
// semantic tier before its hits are worth arming on, and this retriever must
// stay behind that gate.
//
// Do not "tune" these upward hoping for precision. That was tried across
// coverage 0.5-0.9, rare-term floors 4.5-5.5 and mass floors; every setting
// either admitted the vague queries or rejected the good ones, because the two
// populations overlap on every lexical statistic available here.
const MIN_HITS = 2;
const MIN_COVERAGE = 0.5;

// Recency prior. A curated memory unit was promoted because it was durable; a
// basket line is just something that was said, and the operator's position on a
// subject moves. Mild by construction: the multiplier spans 1.0 down to 0.75
// over two years, which cannot let a recent irrelevant line outrank an older
// exact match (measured: the widest same-query score gap this closes is 8%).
const HALF_LIFE_DAYS = 365;
function recencyOf(ts, now) {
  if (!ts) return 0.85;
  const age = (now - Date.parse(ts)) / 86400000;
  if (!(age >= 0)) return 1;
  return 0.75 + 0.25 * Math.pow(0.5, age / HALF_LIFE_DAYS);
}

function buildIndex(records) {
  const df = new Map();
  const postings = new Map();
  const docTerms = [];
  for (let i = 0; i < records.length; i++) {
    // Index the reply as well as the message: a question is routinely findable
    // by words that appear only in the answer. The RECORD returned is still the
    // exchange, so a hit on the reply half surfaces the operator's words too.
    const t = new Set(terms(`${records[i].text} ${records[i].reply || ''}`));
    docTerms.push(t);
    for (const w of t) {
      df.set(w, (df.get(w) || 0) + 1);
      let p = postings.get(w);
      if (!p) { p = []; postings.set(w, p); }
      p.push(i);
    }
  }
  return { records, df, postings, docTerms, total: records.length };
}

function parseBasket(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o && o.text) out.push(o);
    } catch { /* a truncated tail line must not lose the whole basket */ }
  }
  return out;
}

// `allow(record) -> boolean` is CONFINEMENT, and it runs before scoring rather
// than as a penalty: a record the querying session may not see must be
// unrankable at any score, not merely unlikely. Records are dropped at INDEX
// time so a confined record cannot reach the scorer through any path.
function rank(index, draft, { limit = 1, exclude = new Set(), allow = null, now = Date.now() } = {}) {
  const q = [...new Set(terms(draft))];
  if (!q.length || !index.total) return [];
  const cap = Math.max(2, Math.floor(index.total * MAX_DF_RATIO));

  const weight = new Map();
  let self = 0;
  for (const w of q) {
    const n = index.df.get(w) || 0;
    if (!n || n > cap) continue;
    const wt = Math.log(1 + index.total / n);
    weight.set(w, wt);
    self += wt;
  }
  if (!(self > 0)) return [];

  // Score only the records that contain at least one surviving query term.
  const acc = new Map();
  for (const [w, wt] of weight) {
    for (const i of index.postings.get(w) || []) {
      const cur = acc.get(i);
      if (cur) { cur.s += wt; cur.hits.push(w); } else acc.set(i, { s: wt, hits: [w] });
    }
  }

  const out = [];
  for (const [i, v] of acc) {
    if (v.hits.length < MIN_HITS) continue;
    const coverage = v.s / self;
    if (coverage < MIN_COVERAGE) continue;
    const r = index.records[i];
    if (exclude.has(r.id)) continue;
    if (allow && !allow(r)) continue;
    out.push({
      id: r.id,
      text: r.reply ? `${r.text}\n\n-> ${r.reply}` : r.text,
      tags: '',
      scope: '',
      source: 'basket',
      cwd: r.cwd || null,
      ts: r.ts || null,
      // Confidence is this retriever's own mapping onto the shared 0-1 band:
      // coverage already IS a 0-1 quantity here, damped by recency so a stale
      // line cannot present as more certain than a current one.
      confidence: Math.min(1, coverage * recencyOf(r.ts, now)),
      evidence: { score: v.s, hits: v.hits, coverage, corpus: index.total, self },
    });
  }
  return out
    .sort((a, b) => (b.confidence - a.confidence) || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit);
}

// The index is cached against the basket file's mtime+size. Rebuilding costs
// ~280ms over 14k records, which is affordable once per change and not once per
// submit. `readFileSync` of the same 15MB is 15ms, so the stat guard is what
// makes the difference, not the read.
// NOT WIRED INTO ARMING. The lexical thresholds above do not separate relevant
// from irrelevant on this corpus (see MIN_COVERAGE), so arming on these hits
// would spend tail budget on noise. This module exists so the index, the
// confinement seam and the record shape are built and measured; the gate that
// makes its output worth showing is the semantic tier in t141.
function createBasketRetriever({ file, readFile = fs.readFileSync, statFile = fs.statSync, allow = null } = {}) {
  let cache = null;
  const load = () => {
    let st;
    try { st = statFile(file); } catch { return null; }
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (cache && cache.stamp === stamp) return cache.index;
    let recs;
    try { recs = parseBasket(readFile(file, 'utf-8')); } catch { return null; }
    cache = { stamp, index: buildIndex(recs) };
    return cache.index;
  };
  return {
    source: 'basket',
    // Building on demand keeps app launch free; call this off the hot path to
    // move the one-time cost somewhere it is not felt.
    warm() { try { load(); } catch { /* a cold index is slow, never fatal */ } },
    retrieve(draft, { limit = 1, exclude, allow: perQuery } = {}) {
      const index = load();
      if (!index) return [];
      return rank(index, draft, { limit, exclude: exclude || new Set(), allow: perQuery || allow });
    },
  };
}

module.exports = {
  createBasketRetriever, buildIndex, rank, parseBasket, recencyOf,
  MIN_HITS, MIN_COVERAGE, MAX_DF_RATIO, HALF_LIFE_DAYS,
};
