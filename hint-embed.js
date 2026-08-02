// Semantic re-ranking for hint arming, over a local embedding model.
//
// THE SPLIT THIS MODULE ASSUMES, AND WHY IT IS NOT ARBITRARY. Measured on the
// real 184-unit store, 28 paraphrase queries scored against the curated `tags`
// field (an independent ground truth: the tag was written when the unit was
// saved, by neither retriever):
//
//   precision@1   lexical 0.409   embedding 0.636   (embedding wins 5, loses 0)
//   gate on junk  lexical 1 false arm in 12         embedding CANNOT gate
//
// The second row is the load-bearing one. Top cosine for a real draft spans
// 0.536-0.708 and for junk drafts 0.490-0.600 — the bands OVERLAP, so no cosine
// threshold both admits "what does bogdan want this product to feel like" and
// rejects "the cat knocked the plant over". Lexical rejects junk because a query
// sharing no rare terms with any record cannot clear MIN_HITS, which is a
// different question than similarity and the reason both halves exist.
//
// So: LEXICAL DECIDES WHETHER TO ARM, EMBEDDING DECIDES WHAT TO ARM WITH. Do not
// "simplify" this into a cosine threshold — that experiment is above, with the
// numbers that killed it.
//
// Re-ranking only the lexical survivors was also tried and gained exactly
// nothing (0.500 -> 0.500 @1): lexical's cuts leave 0-7 records, so there is no
// order left to fix. The embedding must rank the WHOLE corpus, with lexical
// consulted only for the fire/no-fire decision.
//
// OLLAMA IS NOT A DEPENDENCY. It is not installed on users' machines and this
// module must never make it one: every failure path returns null, which the
// caller reads as "no opinion" and falls back to lexical order. Off unless the
// operator turns it on.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// nomic-embed-text is trained with asymmetric task prefixes and returns
// noticeably worse neighbours without them. They are part of the model's
// contract, not decoration — a document and a query embedded with the same
// prefix are being compared in the wrong space.
const DOC_PREFIX = 'search_document: ';
const QUERY_PREFIX = 'search_query: ';

const DEFAULT_MODEL = 'nomic-embed-text';
const DEFAULT_BASE = 'http://127.0.0.1:11434';

// The query embed is on the submit path. Measured at 11-13ms warm and 510ms
// cold, so this budget absorbs a cold start but will not let a wedged daemon
// hold the arm: past it the caller ranks lexically and the keystroke is
// unaffected either way (arming is already fire-and-forget).
const QUERY_TIMEOUT_MS = 1500;

// Embedding the corpus is the expensive half — 5.4s for 184 units, one time.
// It runs off the submit path and its budget is per REQUEST, not per corpus.
const DOC_TIMEOUT_MS = 10000;

// Cap what one backfill pass costs. A store that grew by thousands of units
// while the feature was off must not turn the next submit into a stall; the
// remainder is picked up by the passes after it.
const BACKFILL_BATCH = 64;

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

// Keyed by CONTENT, not by id: an edited unit keeps its id, and a cache keyed by
// id alone would serve the vector of the old text forever.
//
// The field separator must be a character that cannot occur in the fields, or
// moving a word from tags to scope leaves the key unchanged. It is written as a
// unicode ESCAPE below and must never be a raw NUL byte: a literal NUL makes
// grep classify this whole file as binary and silently skip every match in it.
function keyOf(rec) {
  const h = crypto.createHash('sha1');
  h.update(`${rec.text || ''}\u0000${rec.tags || ''}\u0000${rec.scope || ''}`);
  return `${rec.id}:${h.digest('hex').slice(0, 12)}`;
}

// A document longer than the model's context makes the request FAIL, not
// degrade — measured against the real basket, where 7 of 13,926 records came
// back null while the corpus median is 664 chars. Dropping them is a silent
// hole in the index, so they are truncated instead.
//
// NO CHARACTER CAP IS CORRECT FOR BOTH KINDS OF TEXT, which is why the retry
// below exists rather than a bigger constant. The limit is 8192 TOKENS, and
// tokenization varies by a factor of ~2.5 with content: prose runs ~4 chars per
// token, while the CLI transcripts and JSON that fill long operator messages run
// ~1.6. Measured: a 6,114-char record failed where 8,000-char prose succeeded,
// and its largest embeddable prefix was 5,010.
const MAX_DOC_CHARS = 8000;

// Successive halvings on failure. Four steps reach 1,000 chars, below the
// worst measured tokenization for any record in the corpus.
const TRUNCATE_RETRIES = 4;

function docTextOf(rec) {
  // Tags and scope lead the document text so a unit's curated topic labels are
  // inside the embedded span. They are the shortest statement of what a unit is
  // about, and the body often never says it outright. They also lead so that
  // truncation eats the BODY's tail rather than the labels.
  const label = [rec.scope || '', rec.tags || ''].filter(Boolean).join(' ');
  const body = String(rec.text || '');
  const head = `${DOC_PREFIX}${label}\n`;
  return body.length > MAX_DOC_CHARS
    ? head + body.slice(0, MAX_DOC_CHARS)
    : head + body;
}

// `fetch` is injected so the tests never depend on a daemon being installed, and
// so a test asserting the no-daemon path can prove it rather than describe it.
function createEmbedder({
  base = DEFAULT_BASE, model = DEFAULT_MODEL, fetchImpl = null, log = null,
} = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const debug = (m) => { try { if (log && log.debug) log.debug('hint', m); } catch {} };

  async function embed(text, timeoutMs) {
    if (!doFetch) return null;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const res = await doFetch(`${base}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: text }),
        signal: ctl ? ctl.signal : undefined,
      });
      if (!res || !res.ok) return null;
      const body = await res.json();
      const v = body && body.embedding;
      return Array.isArray(v) && v.length ? v : null;
    } catch (e) {
      debug(`embed failed: ${e && e.message}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Halve and retry rather than give up: a null here is a permanent hole in the
  // index, and an over-long document is the ONE failure mode a shorter prompt
  // actually fixes. A down daemon fails identically at every length, so this
  // costs at most TRUNCATE_RETRIES extra requests on a record that was never
  // going to work — bounded, and only on the ingestion path.
  async function embedDoc(rec) {
    let text = docTextOf(rec);
    for (let i = 0; i <= TRUNCATE_RETRIES; i++) {
      const v = await embed(text, DOC_TIMEOUT_MS);
      if (v) return v;
      // The task prefix has to survive every truncation — a document embedded
      // without it lands in the wrong space, which is worse than a short one.
      const body = text.slice(DOC_PREFIX.length);
      if (body.length <= 500) return null;
      text = DOC_PREFIX + body.slice(0, Math.floor(body.length / 2));
    }
    return null;
  }

  return {
    embedQuery: (text) => embed(`${QUERY_PREFIX}${text}`, QUERY_TIMEOUT_MS),
    embedDoc,
  };
}

// Vectors are ~768 floats each; 184 units is ~2.5MB as JSON. Persisted so the
// 5.4s corpus pass is paid once across restarts rather than once per launch.
function createVectorCache({ file, readFile = fs.readFileSync, writeFile = fs.writeFileSync } = {}) {
  let map = null;
  let dirty = false;
  const load = () => {
    if (map) return map;
    map = new Map();
    if (!file) return map;
    try {
      const o = JSON.parse(readFile(file, 'utf-8'));
      for (const [k, v] of Object.entries(o || {})) if (Array.isArray(v)) map.set(k, v);
    } catch { /* a missing or corrupt cache costs a re-embed, never a failure */ }
    return map;
  };
  return {
    get(k) { return load().get(k) || null; },
    set(k, v) { load().set(k, v); dirty = true; },
    // Pruning is keyed on the live key set so edited and deleted units do not
    // accumulate: without it the file grows by a full vector on every edit.
    //
    // PRUNING RUNS BEFORE THE DIRTY CHECK, NOT INSIDE IT. A pass that embeds
    // nothing new is exactly the pass that follows a deletion, so gating the
    // prune on `dirty` means deleted vectors are never collected at all.
    flush(liveKeys) {
      if (!file) return;
      const m = load();
      if (liveKeys) {
        for (const k of [...m.keys()]) if (!liveKeys.has(k)) { m.delete(k); dirty = true; }
      }
      if (!dirty) return;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeFile(file, JSON.stringify(Object.fromEntries(m)));
        dirty = false;
      } catch { /* an unwritable cache is slow, never fatal */ }
    },
    size() { return load().size; },
  };
}

// `listRecords(agent) -> [{id, text, tags, scope, ...}]` supplies the corpus in
// the same record shape the lexical retriever returns, so a re-ranked result is
// substitutable for a lexical one at the arming site.
// `liveKeys() -> Set` is the union of cache keys across EVERY agent, used only
// for garbage collection. Injected separately from listRecords because that one
// is per-agent by design and cannot answer "what is still referenced anywhere".
function createSemanticRanker({
  listRecords, embedder, cache, log = null, backfillBatch = BACKFILL_BATCH,
  liveKeys = null,
} = {}) {
  const debug = (m) => { try { if (log && log.debug) log.debug('hint', m); } catch {} };
  let backfilling = false;

  // Embeds what the cache is missing, bounded. Runs detached from any submit:
  // its whole purpose is to move the corpus cost off the path the user waits on.
  async function backfill(records) {
    if (backfilling) return;
    backfilling = true;
    try {
      let done = 0;
      for (const r of records) {
        if (done >= backfillBatch) break;
        const k = keyOf(r);
        if (cache.get(k)) continue;
        const v = await embedder.embedDoc(r);
        // A daemon that is down fails on every record, so the first failure ends
        // the pass rather than grinding through the corpus timing out on each.
        if (!v) break;
        cache.set(k, v);
        done++;
      }
      // GC ONLY AGAINST THE WHOLE KEY UNIVERSE, NEVER ONE AGENT'S SLICE. The
      // cache file is shared by every agent, so pruning to the records of the
      // agent that happened to trigger this pass evicts everyone else's vectors
      // — measured: warming a second agent took the file 29.7MB -> 23.4MB and
      // left the first agent at 0 of 570 units cached, so the two agents then
      // re-embedded each other's work forever. `liveKeys` supplies the union;
      // without it the prune is skipped rather than done wrongly.
      cache.flush(liveKeys ? liveKeys() : null);
      if (done) debug(`embedded ${done} unit(s), cache=${cache.size()}`);
    } catch (e) {
      debug(`backfill failed: ${e && e.message}`);
    } finally {
      backfilling = false;
    }
  }

  return {
    source: 'semantic',

    // Returns null — NOT an empty array — when it has no opinion (daemon down,
    // nothing embedded yet, query embed failed). The distinction is the whole
    // fallback contract: [] would mean "ranked, found nothing" and suppress the
    // lexical result the caller should be using instead.
    async rank(draft, { agent, limit = 1 } = {}) {
      let records;
      try { records = listRecords(agent) || []; } catch { return null; }
      if (!records.length) return null;

      const vectors = [];
      for (const r of records) {
        const v = cache.get(keyOf(r));
        if (v) vectors.push({ rec: r, vec: v });
      }
      // Ranking a corpus that is mostly unembedded would silently restrict the
      // answer to whatever happened to be cached, which reads as a confident
      // result over a fraction of the store. Better to defer to lexical and let
      // the backfill catch up.
      const coverage = vectors.length / records.length;
      if (coverage < 0.9) {
        Promise.resolve(backfill(records)).catch(() => {});
        return null;
      }

      const qv = await embedder.embedQuery(draft);
      if (!qv) return null;

      const scored = vectors
        .map(({ rec, vec }) => ({ rec, sim: cosine(qv, vec) }))
        .sort((a, b) => (b.sim - a.sim) || String(a.rec.id).localeCompare(String(b.rec.id)))
        .slice(0, limit);

      // Backfill anything added since, after the answer is computed.
      if (coverage < 1) Promise.resolve(backfill(records)).catch(() => {});

      return scored.map(({ rec, sim }) => ({
        ...rec,
        source: rec.source || 'memory',
        // COSINE IS NOT A GATE AND THIS NUMBER MUST NOT BE TREATED AS ONE. Real
        // drafts top out at 0.536-0.708 and junk at 0.490-0.600 on this corpus,
        // so the value is reported for the audit line and is deliberately not
        // compared against any threshold. Whether to arm was already settled by
        // the lexical gate before this ran.
        confidence: Math.max(0, Math.min(1, sim)),
        evidence: { sim, corpus: vectors.length, ranker: 'semantic' },
      }));
    },

    // Called off the hot path so the one-time corpus cost lands somewhere the
    // user is not waiting.
    warm(agent) {
      let records;
      try { records = listRecords(agent) || []; } catch { return Promise.resolve(); }
      return backfill(records).catch(() => {});
    },
  };
}

module.exports = {
  createEmbedder, createVectorCache, createSemanticRanker,
  cosine, keyOf, docTextOf,
  DOC_PREFIX, QUERY_PREFIX, DEFAULT_MODEL, DEFAULT_BASE,
  QUERY_TIMEOUT_MS, DOC_TIMEOUT_MS, BACKFILL_BATCH, MAX_DOC_CHARS,
};
