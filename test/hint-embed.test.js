// Semantic re-ranking. The properties that must hold are NOT "does it rank
// well" — that was measured offline against the curated tags and is recorded in
// the module header. What the code has to guarantee is that an optional,
// absent, slow or broken embedding daemon never degrades into a wrong answer or
// a blocked keystroke.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createEmbedder, createVectorCache, createSemanticRanker,
  cosine, keyOf, docTextOf, DOC_PREFIX, QUERY_PREFIX,
} = require('../hint-embed');

const RECORDS = [
  { id: 'u1', text: 'the helm chart reads values.yaml at render time', tags: 'deploy', scope: 'clodex' },
  { id: 'u2', text: 'never commit or push, leave the tree dirty for review', tags: 'process', scope: 'clodex' },
  { id: 'u3', text: 'env vars are not configuration, use a settings checkbox', tags: 'product-philosophy', scope: 'clodex' },
];

// A fake embedding space: each record gets a unit vector on its own axis, and a
// query is built to point at whichever axis the test wants to win. That makes
// the EXPECTED ORDER a property of the test, not of a model download.
function axisFetch({ pick = 0, failQuery = false, failDocs = false, count = null } = {}) {
  const calls = { docs: 0, queries: 0 };
  const impl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const isQuery = String(body.prompt).startsWith(QUERY_PREFIX);
    if (isQuery) {
      calls.queries++;
      if (failQuery) return { ok: false, json: async () => ({}) };
      const v = [0, 0, 0];
      v[pick] = 1;
      return { ok: true, json: async () => ({ embedding: v }) };
    }
    calls.docs++;
    if (failDocs) return { ok: false, json: async () => ({}) };
    const idx = RECORDS.findIndex((r) => String(body.prompt).includes(r.text));
    const v = [0, 0, 0];
    if (idx >= 0) v[idx] = 1; else v[0] = 0.5;
    return { ok: true, json: async () => ({ embedding: v }) };
  };
  impl.calls = calls;
  if (count) impl.count = count;
  return impl;
}

function mkRanker(fetchImpl, records = RECORDS, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-emb-'));
  const cache = createVectorCache({ file: path.join(dir, 'vec.json') });
  const embedder = createEmbedder({ fetchImpl });
  return {
    ranker: createSemanticRanker({ listRecords: () => records, embedder, cache, ...opts }),
    cache,
    dir,
  };
}

test('embed: documents and queries use the model\'s asymmetric task prefixes', async () => {
  // nomic-embed-text is trained with different prefixes for the two sides.
  // Embedding both with the same one compares them in the wrong space and
  // silently returns worse neighbours — nothing fails, the answers just get
  // mediocre, which is exactly the kind of defect no other test would catch.
  const seen = [];
  const embedder = createEmbedder({
    fetchImpl: async (url, opts) => {
      seen.push(JSON.parse(opts.body).prompt);
      return { ok: true, json: async () => ({ embedding: [1, 0, 0] }) };
    },
  });
  await embedder.embedQuery('how do i deploy');
  await embedder.embedDoc(RECORDS[0]);
  assert.ok(seen[0].startsWith(QUERY_PREFIX), `query prefix missing: ${seen[0].slice(0, 30)}`);
  assert.ok(seen[1].startsWith(DOC_PREFIX), `document prefix missing: ${seen[1].slice(0, 30)}`);
  assert.notStrictEqual(QUERY_PREFIX, DOC_PREFIX, 'the two sides must not share a prefix');
});

test('embed: the document text carries tags and scope, not just the body', async () => {
  // Curated labels are the shortest statement of what a unit is about and the
  // body often never says it outright. Dropping them from the embedded span
  // costs exactly the queries this feature exists to answer.
  const doc = docTextOf(RECORDS[2]);
  assert.ok(doc.includes('product-philosophy'), 'tags must be inside the embedded text');
  assert.ok(doc.includes('clodex'), 'scope must be inside the embedded text');
  assert.ok(doc.includes('env vars are not configuration'), 'and the body too');
});

test('embed: no daemon means NO OPINION, never an empty ranking', async () => {
  // null and [] are different answers at the call site: [] would read as
  // "ranked, nothing relevant" and suppress the lexical result that should be
  // used instead. This is the whole fallback contract.
  const { ranker } = mkRanker(async () => { throw new Error('ECONNREFUSED'); });
  const out = await ranker.rank('anything at all', { agent: 'clodex' });
  assert.strictEqual(out, null, 'a down daemon must return null so the caller keeps the lexical order');
});

test('embed: a query embed failure falls back even with the corpus cached', async () => {
  const { ranker, cache } = mkRanker(axisFetch({ pick: 1 }));
  await ranker.warm('clodex');
  assert.strictEqual(cache.size(), 3, 'precondition: the corpus is embedded');

  // Only the query side fails now — the corpus is warm, so a naive
  // implementation would happily rank against a garbage or missing query vector.
  const { ranker: r2 } = (() => {
    const embedder = createEmbedder({ fetchImpl: axisFetch({ failQuery: true }) });
    return { ranker: createSemanticRanker({ listRecords: () => RECORDS, embedder, cache }) };
  })();
  assert.strictEqual(await r2.rank('helm chart values', { agent: 'clodex' }), null,
    'a failed query embed is no opinion, not a ranking against nothing');
});

test('embed: ranks by similarity once the corpus is embedded', async () => {
  const { ranker } = mkRanker(axisFetch({ pick: 2 }));
  await ranker.warm('clodex');
  const out = await ranker.rank('what did i say about configuration', { agent: 'clodex', limit: 3 });
  assert.ok(out, 'a warm corpus must produce a ranking');
  assert.strictEqual(out[0].id, 'u3', 'the record on the query axis wins');
  assert.strictEqual(out[0].evidence.ranker, 'semantic', 'the result names the ranker that produced it');
  assert.ok(out[0].evidence.sim > 0.99, 'and carries the similarity for the audit line');
});

test('embed: a partly-embedded corpus defers instead of ranking a fraction of it', async () => {
  // Ranking whatever happens to be cached returns a confident answer over a
  // slice of the store, with nothing in the result saying so. Deferring to
  // lexical while the backfill catches up is the only honest option.
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ id: `p${i}`, text: `padding record ${i}`, tags: '', scope: '' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-emb-'));
  const cache = createVectorCache({ file: path.join(dir, 'vec.json') });
  // Seed exactly one vector, leaving coverage far below the bar.
  cache.set(keyOf(many[0]), [1, 0, 0]);
  const ranker = createSemanticRanker({
    listRecords: () => many,
    embedder: createEmbedder({ fetchImpl: async () => { throw new Error('down'); } }),
    cache,
  });
  assert.strictEqual(await ranker.rank('padding record 0', { agent: 'clodex' }), null,
    'coverage below the bar must defer, even though the exact match IS cached');
});

test('embed: the cache is keyed by content so an edited unit is re-embedded', async () => {
  // Keying by id alone would serve the vector of the old text forever — the
  // unit keeps its id across an edit, and nothing else would ever notice.
  const before = keyOf(RECORDS[0]);
  const after = keyOf({ ...RECORDS[0], text: 'the helm chart now reads a different file' });
  assert.notStrictEqual(before, after, 'an edited body must produce a different cache key');
  assert.ok(after.startsWith('u1:'), 'and the key still names its unit for debugging');

  const tagged = keyOf({ ...RECORDS[0], tags: 'deploy,infra' });
  assert.notStrictEqual(before, tagged, 'tags are embedded, so changing them must invalidate too');

  // Field boundaries must be part of the hash. With a separator that can occur
  // inside a field (a space), moving a word from tags to scope hashes the same
  // bytes and the unit keeps serving the vector of its old text — invisible,
  // because both fields together still read correctly.
  // The moved word must not be the LAST one, or a trailing separator
  // distinguishes the two by accident and the case proves nothing.
  const a = keyOf({ id: 'x', text: 'body words', tags: 'alpha', scope: 'beta' });
  const b = keyOf({ id: 'x', text: 'body', tags: 'words alpha', scope: 'beta' });
  assert.notStrictEqual(a, b,
    'the same words split differently across fields must not collide — the separator has to be a '
    + 'character the fields cannot contain');
});

test('embed: the corpus is embedded once across restarts', async () => {
  const fetchImpl = axisFetch({ pick: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-emb-'));
  const file = path.join(dir, 'vec.json');
  const mk = () => createSemanticRanker({
    listRecords: () => RECORDS,
    embedder: createEmbedder({ fetchImpl }),
    cache: createVectorCache({ file }),
  });
  await mk().warm('clodex');
  const afterFirst = fetchImpl.calls.docs;
  assert.strictEqual(afterFirst, 3, 'the first pass embeds the corpus');

  // A fresh ranker over the same file is what a restart looks like. Re-embedding
  // costs 5.4s on the real store and would be paid on every launch.
  await mk().warm('clodex');
  assert.strictEqual(fetchImpl.calls.docs, afterFirst, 'a restart must reuse the persisted vectors');
});

test('embed: a deleted unit does not accumulate in the cache file', async () => {
  const fetchImpl = axisFetch({ pick: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-emb-'));
  const file = path.join(dir, 'vec.json');
  const cache = createVectorCache({ file });
  const ranker = createSemanticRanker({
    listRecords: () => RECORDS, embedder: createEmbedder({ fetchImpl }), cache,
    liveKeys: () => new Set(RECORDS.map(keyOf)),
  });
  await ranker.warm('clodex');
  assert.strictEqual(cache.size(), 3);

  const fewer = RECORDS.slice(0, 2);
  const cache2 = createVectorCache({ file });
  const r2 = createSemanticRanker({
    listRecords: () => fewer, embedder: createEmbedder({ fetchImpl }), cache: cache2,
    liveKeys: () => new Set(fewer.map(keyOf)),
  });
  await r2.warm('clodex');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.ok(!Object.keys(onDisk).some((k) => k.startsWith('u3:')),
    'a vector for a unit that no longer exists must be pruned, not carried forever');
});

// ONE CACHE FILE, MANY AGENTS. Pruning to the records of whichever agent
// triggered the pass evicts every other agent's vectors — measured on the live
// cache, warming a second agent took it 29.7MB -> 23.4MB and left the first at
// 0 of 570 units cached, so each agent then re-embedded the others' work on
// every pass and no agent was ever fully covered.
test('embed: warming one agent does not evict another agent\'s vectors', async () => {
  const fetchImpl = axisFetch({ pick: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-emb-'));
  const file = path.join(dir, 'vec.json');

  const A = [{ id: 'a1', text: 'agent A unit one', tags: '', scope: '' }];
  const B = [{ id: 'b1', text: 'agent B unit one', tags: '', scope: '' }];
  // The GC universe is every agent's keys, which is what engine.js supplies.
  const union = () => new Set([...A, ...B].map(keyOf));

  const mk = (recs) => createSemanticRanker({
    listRecords: () => recs, embedder: createEmbedder({ fetchImpl }),
    cache: createVectorCache({ file }), liveKeys: union,
  });

  await mk(A).warm('agent-a');
  await mk(B).warm('agent-b');

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.ok(Object.keys(onDisk).some((k) => k.startsWith('a1:')),
    "agent A's vector must survive agent B's backfill");
  assert.ok(Object.keys(onDisk).some((k) => k.startsWith('b1:')),
    "and agent B's must be there too");
});

test('embed: a backfill pass is bounded', async () => {
  // A store that grew while the feature was off must not turn one pass into a
  // thousand sequential HTTP calls.
  const many = [];
  for (let i = 0; i < 50; i++) many.push({ id: `p${i}`, text: `padding record ${i}`, tags: '', scope: '' });
  const fetchImpl = axisFetch({ pick: 0 });
  const { ranker } = mkRanker(fetchImpl, many, { backfillBatch: 10 });
  await ranker.warm('clodex');
  assert.strictEqual(fetchImpl.calls.docs, 10, 'one pass embeds at most the batch size');
});

test('embed: a down daemon abandons the pass instead of timing out per record', async () => {
  const many = [];
  for (let i = 0; i < 30; i++) many.push({ id: `p${i}`, text: `padding record ${i}`, tags: '', scope: '' });
  const fetchImpl = axisFetch({ failDocs: true });
  const { ranker } = mkRanker(fetchImpl, many);
  await ranker.warm('clodex');
  assert.strictEqual(fetchImpl.calls.docs, 1,
    'the first failure ends the pass — 30 records x a 10s timeout is 5 minutes of pointless waiting');
});

test('embed: a corrupt cache file costs a re-embed, not a crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-emb-'));
  const file = path.join(dir, 'vec.json');
  fs.writeFileSync(file, '{"u1:abc": [1,0,0], TRUNCATED');
  const cache = createVectorCache({ file });
  assert.strictEqual(cache.size(), 0, 'an unparseable cache reads as empty');
  const fetchImpl = axisFetch({ pick: 0 });
  const ranker = createSemanticRanker({
    listRecords: () => RECORDS, embedder: createEmbedder({ fetchImpl }), cache,
  });
  await ranker.warm('clodex');
  assert.strictEqual(fetchImpl.calls.docs, 3, 'and the corpus is simply re-embedded');
});

test('embed: cosine is orientation, not magnitude', () => {
  assert.ok(Math.abs(cosine([1, 0], [2, 0]) - 1) < 1e-9, 'scale must not change similarity');
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9, 'orthogonal vectors score zero');
  assert.strictEqual(cosine([0, 0], [1, 0]), 0, 'a zero vector cannot divide by zero');
});
