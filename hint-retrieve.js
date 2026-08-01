// Retrieval behind the hint injector: rank records against a draft and pick the
// ones worth spending tail budget on. Lifted from scripts/hint-probe.js, whose
// lexical loop was proven end to end against the live store.
//
// The retriever interface is deliberately not memory-specific:
//
//   retrieve(draft, { agent, limit }) -> [{ id, text, tags, scope, source,
//                                           confidence, evidence }]
//
// Project facts, docs and an embedding tier are separate tickets and must slot
// in here without hint-arm.js changing. Scores from different retrievers are
// NOT comparable (lexical IDF reaches 12 on the real corpus; cosine tops out at
// 1), so each retriever normalises into `confidence` and a merge across sources
// waits until a second one exists.

// Terms that co-occur with everything in a store carry no signal; matching on
// them surfaces a random record with high confidence.
const STOP = new Set(('a an and are as at be but by for from had has have how i if in into is it its me my '
  + 'not of on or our so that the their them then there these they this to was we were what when where which '
  + 'who why will with you your do does did can could should would about get got make made just like now new '
  + 'more most some any all one two been being over under out up down no yes than also very much many via per')
  .split(' '));

function terms(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

// scope and tags are the curated topic labels — the shortest path from a
// question's subject to a record about it. Omitting them made "tell me about
// the family" miss a record whose scope is literally `family`.
function haystack(rec) {
  return `${rec.text} ${rec.tags || ''} ${rec.scope || ''}`;
}

function score(queryTerms, rec, df, total) {
  const body = new Set(terms(haystack(rec)));
  let s = 0;
  const hits = [];
  for (const q of new Set(queryTerms)) {
    if (!body.has(q)) continue;
    const n = df.get(q) || 1;
    const w = Math.log(1 + total / n);
    if (w < 0.35) continue; // present in most records — no discrimination
    s += w;
    hits.push(q);
  }
  return { score: s, hits };
}

// THE FLOOR IS DERIVED FROM THE CORPUS, NEVER A CONSTANT. hint-probe's
// MIN_SCORE=2 was tuned at N=4 and does not transfer: at N=179 a single df=1
// term is worth log(1+179)=5.19 by itself, so any absolute floor at or below
// that is cleared by one coincidental rare word ("chicken" in a draft about
// dinner scored 5.19 against the live store). Measured, the two populations
// overlap on score alone — unrelated drafts topped out at 5.59, related ones
// bottomed at 5.19 — so a bigger number is not the fix.
//
// log(1+N) is by construction the weight of one maximally-rare term, i.e. the
// smallest floor one lucky word cannot clear on its own. MIN_HITS is what
// actually separates the populations: coincidence hits one term, relevance hits
// several. Both halves are needed; see the four-store table in
// tasks/hint-injector/JOURNAL.md.
const MIN_HITS = 2;
function minScoreFor(total) { return Math.log(1 + Math.max(1, total)); }

// Lexical IDF has no upper bound, so normalising needs a saturation point
// rather than a max: the floor maps to 0.5 and twice the floor to 1.0. The band
// is 0-1 for every retriever; the mapping onto it is each retriever's own.
function confidenceOf(s, floor) {
  if (!(floor > 0)) return 0;
  return Math.min(1, s / (2 * floor));
}

function rank(records, draft, { exclude = new Set(), limit = 1 } = {}) {
  const q = terms(draft);
  if (!q.length || !records.length) return [];
  const df = new Map();
  for (const r of records) {
    for (const t of new Set(terms(haystack(r)))) df.set(t, (df.get(t) || 0) + 1);
  }
  // df is built over the WHOLE corpus, then candidates are excluded — a term's
  // rarity is a property of the store, not of who is still in the running.
  const floor = minScoreFor(records.length);
  return records
    .filter((r) => !exclude.has(r.id))
    .map((r) => ({ rec: r, ...score(q, r, df, records.length) }))
    .filter((r) => r.hits.length >= MIN_HITS && r.score >= floor)
    .sort((a, b) => (b.score - a.score) || String(a.rec.id).localeCompare(String(b.rec.id)))
    .slice(0, limit)
    .map((r) => ({
      ...r.rec,
      confidence: confidenceOf(r.score, floor),
      evidence: { score: r.score, hits: r.hits, corpus: records.length, floor },
    }));
}

function unitsAsRecords(units) {
  return (units || []).map((u) => ({
    id: u.id, text: u.body, tags: u.tags || '', scope: u.scope || '', source: 'memory',
  }));
}

// The one retriever this ticket ships. `listUnits` is injected rather than
// reaching for memory-store, so the interface stays the seam a second source
// plugs into.
function createMemoryRetriever({ listUnits }) {
  return {
    source: 'memory',
    retrieve(draft, { agent, limit = 1, exclude } = {}) {
      let units;
      try { units = listUnits(agent); } catch { return []; }
      return rank(unitsAsRecords(units), draft, { limit, exclude: exclude || new Set() });
    },
  };
}

// Two shapes by size. A short record rides in full because reading it costs less
// than the round trip to fetch it; a long one is offered by title so the model
// spends the tokens only if it wants them.
const FULL_BODY_CAP = 700;

// A line that is nothing but `key=value` pairs from the remember directive.
const DIRECTIVE_LINE = /^(?:(?:scope|tags|tags_v|pinned|source|id|learned_at)=\S*\s*)+$/i;

function compose(results) {
  if (!results || !results.length) return null;
  const parts = ['This may relate to what the user is asking. If it does not, ignore it.'];
  for (const r of results) {
    const b = String(r.text || '').trim();
    if (!b) continue;
    if (b.length <= FULL_BODY_CAP) {
      parts.push(`\n${r.id}:\n${b}`);
    } else {
      // A unit saved via `[agent:memory remember] scope=x tags=y pinned=true`
      // keeps that directive as its first line, so the naive first line pitches
      // the unit by its metadata and gives the model no reason to spend a
      // recall. Skip leading directive-only lines; fall back to the first line
      // if every line looks like one.
      const title = (b.split('\n').find((l) => l.trim() && !DIRECTIVE_LINE.test(l.trim()))
        || b.split('\n')[0]).trim().slice(0, 180);
      parts.push(`\n${r.id}: ${title}...`
        + `\n(truncated — emit [agent:memory recall] ${r.id} on its own line to load it in full)`);
    }
  }
  return parts.length > 1 ? parts.join('\n') : null;
}

module.exports = {
  terms, haystack, rank, compose, unitsAsRecords, createMemoryRetriever,
  minScoreFor, confidenceOf, MIN_HITS, FULL_BODY_CAP, STOP,
};
