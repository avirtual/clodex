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

// A QUESTION ABOUT THE USER, which the lexical gate structurally cannot serve.
// Measured 2026-08-03 against the live stores: `score` sums log(1 + N/df) over
// matched terms, and every term in that sum is a property of the corpus, not of
// the record — so for a one-term query every match scores IDENTICALLY ("live"
// tied 28 records at 4.09) and coverage is 1.0 for all of them. There is no
// order to pick a winner from, which is why the answer here is a different
// admission signal rather than a lower threshold.
//
// The shape is deliberately narrow, and each half earns its place: the
// interrogative opener alone admits "what does this function do", the
// first-person marker alone admits "fix my lint error". The work-vocabulary veto
// is what separates "where do i live" from "where is my config file" — both are
// first-person questions, and only one is about the person.
const ASK_RE = /^\s*(?:who|what|what's|whats|where|when|which|how|do|does|did|is|are|am|tell|remind)\b/i;
const SELF_RE = /\b(?:my|mine|myself|i|me|i'm|im)\b/i;
const WORK_RE = new RegExp('\\b(?:test|tests|lint|commit|diff|branch|rebase|merge|build|builds|deploy'
  + '|bug|bugs|error|errors|code|file|files|function|repo|pr|ci|log|logs|patch|stack|dependency'
  + '|npm|git|api|server|script|config|typecheck|suite|release)\\b', 'i');

// Long drafts are excluded: this admits on SHAPE, not content, and a shape test
// stops meaning anything once a message carries enough text for the lexical gate
// to do its job properly.
const PERSONAL_MAX_TERMS = 6;

function personalAsk(draft) {
  const d = String(draft || '');
  if (!ASK_RE.test(d) || !SELF_RE.test(d) || WORK_RE.test(d)) return false;
  return terms(d).length <= PERSONAL_MAX_TERMS;
}

// COSINE ALONE CANNOT ORDER A ONE-TERM PERSONAL QUESTION, which is the failure
// this filter exists for. Measured 2026-08-03 on the live 1,711-unit corpus:
// "who are my colleagues?" scored max 0.6003 with the 15th result at 0.5836 — a
// spread of 0.017 across the entire shipped range, and 197 units above the 0.55
// floor. The three that rode were about agent collaboration and AWS networking;
// the unit naming actual colleagues sat at rank 10. The ranking was not wrong,
// it was undefined: every unit in a store about one person is similar to any
// question about that person.
//
// Requiring a shared term restores the discrimination the embedding lost, and it
// can only ever REMOVE a result the caller had already decided to ship — that
// subset property is what keeps it clear of the 0-false-arms baseline the shape
// test was measured against. Over 14 personal questions: 17 on-topic units of 42
// shipped becomes 17 of 29, and four questions the store cannot answer at all
// (pets, music, wife, studies) go silent instead of shipping three confident
// units about Kubernetes.
// The question is plural and the fact is singular almost every time it matters:
// "who are my COLLEAGUES" against "a COLLEAGUE of Bogdan's". Measured, the fold
// changed the shipped set on 4 of 18 questions and improved all four — it is what
// surfaces the two units naming actual colleagues (0.5870, 0.5756) in place of a
// unit about consulting engagements, and "Bogdan LIVES somewhere his son can play
// outside" in place of one about CSS living in stylesheets. Deliberately not a
// stemmer: this runs on the submit path, and everything past trailing -s was
// noise on this corpus.
function foldPlural(t) {
  return t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t;
}

function withSharedTerm(results, draft) {
  const q = terms(draft).map(foldPlural);
  if (!q.length) return results || [];
  return (results || []).filter((r) => {
    const body = new Set(terms(haystack(r)).map(foldPlural));
    return q.some((t) => body.has(t));
  });
}

function unitsAsRecords(units, source = 'memory') {
  return (units || []).map((u) => ({
    id: u.id, text: u.body, tags: u.tags || '', scope: u.scope || '', source,
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

// A shared store every agent can match against, ranked as its OWN corpus.
// `listUnits` takes the set name, not an agent: these units belong to no one.
function createCommonRetriever({ listUnits, set = 'chat-extract' }) {
  return {
    source: 'common',
    retrieve(draft, { limit = 1, exclude } = {}) {
      let units;
      try { units = listUnits(set); } catch { return []; }
      return rank(unitsAsRecords(units, 'common'), draft, { limit, exclude: exclude || new Set() });
    },
  };
}

// Ranks each source over its own corpus and merges the winners, rather than
// concatenating records into one pool. Both cuts in `rank` are corpus-relative
// — the floor is log(1+N) and coverage divides by a df built over the whole
// store — so pooling lets one source's SIZE silence the other's hits: merging
// a 1650-unit store into a 570-unit one raised the floor 6.35 -> 7.71 and
// dropped a memory hit that scored 6.88. Measured, not hypothetical.
//
// Confidence is comparable across sources by construction (each is normalised
// against its own floor in confidenceOf), which is what makes the merge sort
// meaningful.
function createCompositeRetriever(retrievers) {
  const live = (retrievers || []).filter(Boolean);
  return {
    source: 'composite',
    retrieve(draft, opts = {}) {
      const { limit = 1 } = opts;
      const out = [];
      for (const r of live) {
        // One source throwing must not silence the others.
        try { out.push(...(r.retrieve(draft, { ...opts, limit }) || [])); } catch { /* skip */ }
      }
      return out
        .sort((a, b) => (b.confidence - a.confidence) || String(a.id).localeCompare(String(b.id)))
        .slice(0, limit);
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

// One record's block, byte for byte as compose emits it. Shared with
// selectWithinBudget so the budget is measured on what actually ships — an
// estimate here drifts from compose the first time either side is edited.
// Returns null for a blank body, which is compose's skip condition.
function blockFor(r) {
  const b = String(r.text || '').trim();
  if (!b) return null;
  if (b.length <= FULL_BODY_CAP) return `\n${r.id}:${labelOf(r)}\n${b}`;
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
  return preview.length < full.length
    ? `\n${r.id}:${labelOf(r)}\n${preview}...`
      + `\n(truncated at ${preview.length} of ${full.length} chars — emit [agent:memory recall] `
      + `${r.id} on its own line to load it in full)`
    : `\n${r.id}:${labelOf(r)}\n${preview}`;
}

// THE COST OF A HINT IS CHARACTERS, NOT UNITS, so the cut is a character budget.
// A fixed count of one spends the whole allowance on one long preview but only
// ~150 chars on a short unit — and the common store is deliberately short, so
// that is where a count wastes the most. Measured 2026-08-03 over the live
// stores across 8 hits: 8 units delivered at a count of 1, 19 at this budget.
//
// THE CEILING IS NOT NEGOTIABLE. Every unit rides as ONE hint, and the proxy
// caps a single hint at HINTS_MAX_ONE=2500 chars (hints.py) — over which it
// DECLINES THE WHOLE SET rather than truncating, so an over-budget hint delivers
// nothing at all. This is the composed-body allowance; composeFits() below is
// what actually enforces the wire limit, since the preamble rides on top.
const HINT_BUDGET = 1800;

// A second guard, because the budget alone would admit a tail of tiny units.
// Past three the tail is padding whatever the sizes say — measured: raising it
// to 4 bought one extra unit across the whole probe set.
const HINT_MAX_UNITS = 3;

// A runner-up must be in the same league as the winner. Confidence SATURATES on
// this corpus (six units tied at 0.57, two at 1.00), so this cannot separate
// good from bad — it only stops a strong winner from dragging in a weak tail.
const RUNNERUP_MIN_RATIO = 0.6;

// The winner rides UNCONDITIONALLY, whatever it costs: this must never deliver
// less than the count of one it replaces, so the budget governs only what gets
// ADDED to it.
function selectWithinBudget(results, {
  budget = HINT_BUDGET, maxUnits = HINT_MAX_UNITS, minRatio = RUNNERUP_MIN_RATIO,
} = {}) {
  const live = (results || []).filter((r) => blockFor(r));
  if (!live.length) return [];
  const out = [live[0]];
  let spent = (blockFor(live[0]) || '').length;
  const top = Number(live[0].confidence) || 0;
  for (const r of live.slice(1)) {
    if (out.length >= maxUnits) break;
    if (top > 0 && (Number(r.confidence) || 0) / top < minRatio) break;
    const cost = (blockFor(r) || '').length;
    if (spent + cost > budget) break;
    out.push(r);
    spent += cost;
  }
  // The budget governs the bodies; the wire cap governs the whole composed
  // hint, preamble included. Only the second one can lose us the delivery.
  return composeFits(out);
}

// The proxy's per-hint ceiling (hints.py HINTS_MAX_ONE), minus room for the
// envelope. Duplicated from the proxy by necessity — it is a wire limit, not a
// shared constant — and deliberately under it: at the cap the proxy declines the
// WHOLE set, so being wrong in this direction costs a few hundred chars while
// being wrong in the other costs the entire hint.
const WIRE_MAX_ONE = 2400;

// Drop units from the TAIL until the composed hint fits the wire. The tail is
// the right end to cut: it is the weakest match, and cutting the winner to keep
// two runners-up would deliver the ranking upside down. A single unit that
// cannot fit alone still rides — it is the winner, and the proxy's own cap is
// then the thing that declines it, which is visible in the arm's debug line
// rather than silently dropped here.
function composeFits(results) {
  let picked = results || [];
  while (picked.length > 1) {
    const text = compose(picked);
    if (text && text.length <= WIRE_MAX_ONE) return picked;
    picked = picked.slice(0, -1);
  }
  return picked;
}

function compose(results) {
  if (!results || !results.length) return null;
  // EVERY WORD HERE IS BILLED UNCACHED ON EVERY REQUEST THAT CARRIES A HINT, so
  // only what is USELESS ONE SESSION EARLIER lives here. The standing rules —
  // including the retraction guard for the turn after this one — are in
  // ipc-prompt's MEMORY section, which rides the cached system prompt once.
  // What must stay: provenance (an anonymous block reads as invented, and a
  // named source bounds its authority) and the deadline (turn_start_only means
  // a model that defers acting until after a tool call finds it gone, and
  // reaching for a tool first is the default). Silent on WHY it is one-shot:
  // billing is not the model's to reason about.
  const parts = ['From your operator\'s memory store — may relate to what the user is asking;'
    + ' if not, ignore it.'
    + '\nAttached to this request only and not repeated: if useful, act on it or restate what'
    + ' matters in your reply now, not in a later step.'];
  for (const r of results) {
    const block = blockFor(r);
    if (block) parts.push(block);
  }
  return parts.length > 1 ? parts.join('\n') : null;
}

module.exports = {
  terms, haystack, rank, compose, blockFor, selectWithinBudget, withSharedTerm,
  unitsAsRecords, createMemoryRetriever,
  createCommonRetriever, createCompositeRetriever, personalAsk,
  minScoreFor, confidenceOf, selfScore, MIN_HITS, MIN_COVERAGE, FULL_BODY_CAP, STOP,
  HINT_BUDGET, HINT_MAX_UNITS, RUNNERUP_MIN_RATIO, WIRE_MAX_ONE, composeFits,
};
