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
    // No "too common to matter" cut here, and adding one back needs a different
    // weight function to mean anything: log(1 + total/df) bottoms out at log(2)
    // = 0.693 for a term in EVERY record, so any threshold below that is
    // unreachable by construction. A term that common still cannot arm on its
    // own — MIN_HITS and the floor stop it.
    s += Math.log(1 + total / n);
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

// AN ABSOLUTE FLOOR CANNOT SEE QUERY LENGTH, AND THAT IS THE SECOND HALF OF THE
// PRECISION PROBLEM. A long draft accumulates matched weight for free: every
// stray hint observed in production on 2026-08-01 came from a long message
// whose winner cleared the floor on volume alone. Measured over the live store,
// absolute score does NOT separate them (a good short draft scored 13.40, a
// stray 10.20, an unrelated draft 7.42 — all clear of a 5.2 floor).
//
// Coverage does: the winner's score as a fraction of the total weight the query
// could possibly match. It asks "how much of what you said does this record
// actually account for", which is scale-free in query length.
//
//   related drafts (7):    42% .. 100%
//   unrelated drafts (9):  19% ..  32%   (4 of them arm nothing at all)
//
// 0.35 sits in the gap with margin on both sides. Small sample by construction
// — it is 16 drafts against one agent's store, not a benchmark — so treat the
// number as re-derivable, and re-measure it before trusting it on a store with
// a different shape.
const MIN_COVERAGE = 0.35;

// The most any record could score against this query. MUST WEIGH TERMS EXACTLY
// AS `score` DOES — it is the denominator of that numerator, and any divergence
// makes a perfect match land somewhere other than 1.0, silently shifting every
// threshold derived from coverage. Zero when a draft is all stop words, which is
// why callers guard the division.
function selfScore(queryTerms, df, total) {
  let s = 0;
  for (const q of new Set(queryTerms)) s += Math.log(1 + total / (df.get(q) || 1));
  return s;
}

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
  const self = selfScore(q, df, records.length);
  return records
    .filter((r) => !exclude.has(r.id))
    .map((r) => ({ rec: r, ...score(q, r, df, records.length) }))
    // Both cuts are needed and neither subsumes the other: the floor rejects a
    // weak match on a short draft, coverage rejects a weak match that a long
    // draft inflated past the floor.
    .filter((r) => r.hits.length >= MIN_HITS && r.score >= floor
      && (self > 0 ? r.score / self : 0) >= MIN_COVERAGE)
    .sort((a, b) => (b.score - a.score) || String(a.rec.id).localeCompare(String(b.rec.id)))
    .slice(0, limit)
    .map((r) => ({
      ...r.rec,
      confidence: confidenceOf(r.score, floor),
      evidence: {
        score: r.score,
        hits: r.hits,
        corpus: records.length,
        floor,
        coverage: self > 0 ? r.score / self : 0,
      },
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
// than the round trip to fetch it; a long one is offered as a preview so the
// model spends the rest of the tokens only if it wants them.
const FULL_BODY_CAP = 700;

// The preview has to be long enough to judge relevance from. At 180 chars it cut
// mid-sentence and read as a stub, so the pitch lost to its own truncation and
// no recall was worth spending. The proxy caps a single hint at 2500 chars, so
// this stays well inside the budget even with several results.
const PREVIEW_CAP = 900;

// A line that is nothing but `key=value` pairs from the remember directive.
const DIRECTIVE_LINE = /^(?:(?:scope|tags|tags_v|pinned|source|id|learned_at)=\S*\s*)+$/i;

// Tags and scope are curated topic labels, and they carry relevance the excerpt
// can miss — a unit whose preview reads off-topic may still be exactly right for
// the tag it carries. Cheap to include, so always include them.
function labelOf(r) {
  const tags = String(r.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const bits = [];
  if (r.scope) bits.push(`scope=${r.scope}`);
  if (tags.length) bits.push(`tags=${tags.join(',')}`);
  return bits.length ? `  [${bits.join(' ')}]` : '';
}

function compose(results) {
  if (!results || !results.length) return null;
  // The second sentence is load-bearing and must not be dropped as verbosity.
  // Hints ride uncached at 1x on every request carrying them, so this one is
  // armed `turn_start_only` and the proxy pops it after one delivery — a model
  // that judges it useful but defers acting until after a tool call finds it
  // gone, and reaching for a tool first is the default behaviour. Naming the
  // deadline is what converts a one-shot delivery into something the model can
  // preserve for itself. It stays silent on WHY delivery is one-shot: the
  // billing reason is not the model's to reason about.
  const parts = ['This may relate to what the user is asking. If it does not, ignore it.'
    + '\nIt is attached to this request only and will not be repeated. If it is useful,'
    + ' act on it or restate what matters in your reply now — do not defer it to a later step.'];
  for (const r of results) {
    const b = String(r.text || '').trim();
    if (!b) continue;
    if (b.length <= FULL_BODY_CAP) {
      parts.push(`\n${r.id}:${labelOf(r)}\n${b}`);
    } else {
      // A unit saved via `[agent:memory remember] scope=x tags=y pinned=true`
      // keeps that directive as its first line, so the naive first line pitches
      // the unit by its metadata and gives the model no reason to spend a
      // recall. Skip leading directive-only lines; fall back to the first line
      // if every line looks like one.
      const prose = b.split('\n').filter((l) => l.trim() && !DIRECTIVE_LINE.test(l.trim())).join('\n');
      const full = (prose || b).trim();
      const preview = full.slice(0, PREVIEW_CAP);
      // A body between FULL_BODY_CAP and PREVIEW_CAP fits entirely, so claiming
      // truncation would offer a recall that returns nothing the model already
      // has — the offer has to be conditional on something actually being cut.
      parts.push(preview.length < full.length
        ? `\n${r.id}:${labelOf(r)}\n${preview}...`
          + `\n(truncated at ${preview.length} of ${full.length} chars — emit [agent:memory recall] `
          + `${r.id} on its own line to load it in full)`
        : `\n${r.id}:${labelOf(r)}\n${preview}`);
    }
  }
  return parts.length > 1 ? parts.join('\n') : null;
}

module.exports = {
  terms, haystack, rank, compose, unitsAsRecords, createMemoryRetriever,
  minScoreFor, confidenceOf, selfScore, MIN_HITS, MIN_COVERAGE, FULL_BODY_CAP, STOP,
};
