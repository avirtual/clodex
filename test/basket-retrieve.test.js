// Basket retriever: the operator's own words as a retrieval source.
//
// The interesting properties here are NOT "does it rank well" — the module's
// own header records that lexical scoring does not discriminate on a corpus
// this size, which is why it is not wired into arming. What must hold
// regardless of scoring is: confinement cannot be defeated by relevance, the
// index survives a corrupt tail, and a query does not touch every record.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createBasketRetriever, buildIndex, rank, parseBasket, recencyOf, MIN_HITS,
} = require('../basket-retrieve');

function mkBasket(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-basket-'));
  const file = path.join(dir, 'operator.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const CORPUS = [
  { id: 'm1', ts: '2026-07-01T00:00:00Z', cwd: '/pub/repo', text: 'never commit tag or push, leave the tree dirty for review' },
  { id: 'm2', ts: '2026-07-02T00:00:00Z', cwd: '/pub/repo', text: 'we do not add random env vars, it has to be a checkbox in clodex settings' },
  { id: 'm3', ts: '2026-07-03T00:00:00Z', cwd: '/pub/repo', text: 'the helm chart deploy needs a values file', reply: 'Confirmed, the chart reads values.yaml at render time.' },
  { id: 'secret', ts: '2026-07-04T00:00:00Z', cwd: '/private/crypto-trader', text: 'the helm chart deploy needs a values file for the trading bot' },
];

test('basket: an exchange is indexed by its reply as well as the operator text', () => {
  const idx = buildIndex([CORPUS[2]]);
  // "values.yaml" appears ONLY in the reply. A question is routinely findable
  // by words that appear in the answer, which is why the exchange is the unit.
  const hits = rank(idx, 'what does values.yaml do at render time', { limit: 1 });
  assert.strictEqual(hits.length, 1, 'a term present only in the reply must still find the exchange');
  assert.ok(hits[0].text.includes('helm chart deploy'),
    'and the record returned carries the operator half, not just the matched reply');
});

test('basket: confinement is enforced before ranking, not by scoring', () => {
  const idx = buildIndex(CORPUS);
  const draft = 'the helm chart deploy needs a values file for the trading bot';

  // The confined record is a PERFECT lexical match — it is the draft verbatim.
  // A confinement test that passes because the record scored low is not a test.
  const open = rank(idx, draft, { limit: 4 });
  assert.ok(open.some((r) => r.id === 'secret'),
    'precondition: without confinement this record wins outright, so the next assertion means something');

  const confined = rank(idx, draft, {
    limit: 4,
    allow: (r) => !String(r.cwd || '').startsWith('/private/'),
  });
  assert.ok(!confined.some((r) => r.id === 'secret'),
    'a record the session may not read must be unrankable at ANY score — finance context must not '
    + 'be reachable from a public repo even on an exact match');
  assert.ok(confined.some((r) => r.id === 'm3'), 'and the permitted near-duplicate still surfaces');
});

test('basket: a corrupt line does not lose the rest of the basket', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-basket-'));
  const file = path.join(dir, 'operator.jsonl');
  // A crash mid-append leaves a truncated tail. Losing 13,926 records because
  // the last one is half-written is not an acceptable failure mode.
  fs.writeFileSync(file, `${JSON.stringify(CORPUS[0])}\n${JSON.stringify(CORPUS[1])}\n{"id":"trunc","te`);
  const recs = parseBasket(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(recs.length, 2, 'the intact records survive a truncated tail line');
});

test('basket: one message journalled per destination is ONE document', () => {
  // One broadcast is journalled once per destination worktree, so the same text
  // recurs across ids. Left as separate documents they inflate df — duplicate
  // mass alone pushed `self`, `load`, `tickets` and `forge` over MAX_DF_RATIO —
  // hand one exchange several independent shots at a single ranked list.
  const line = (cwd) => JSON.stringify({ id: 'bcast', text: 'we had an issue overnight. there?', cwd, ts: '2026-08-01T00:00:00Z' });
  const recs = parseBasket([
    line('/w/tl'), line('/w/tl-clone-1'), line('/w/tl-clone-2'),
    JSON.stringify(CORPUS[0]),
  ].join('\n'));
  const b = recs.filter((r) => r.id === 'bcast');
  assert.strictEqual(b.length, 1, 'three deliveries of one message collapse to one document');
  assert.deepStrictEqual(b[0].cwds, ['/w/tl', '/w/tl-clone-1', '/w/tl-clone-2'],
    'and EVERY origin is carried — keeping only the first silently confines the '
    + 'record to one worktree, so a session in tl-clone-2 stops seeing a message it was sent');
});

test('basket: two different messages from one session stay distinct', () => {
  // The collapse key is id+text, not id. A cwd-only difference is a duplicate
  // delivery; different text is not, however it was journalled.
  const recs = parseBasket([
    JSON.stringify({ id: 'a', text: 'first thing', cwd: '/w/x' }),
    JSON.stringify({ id: 'a', text: 'second thing', cwd: '/w/x' }),
  ].join('\n'));
  assert.strictEqual(recs.length, 2, 'a shared id does not merge distinct exchanges');
});

test('basket: the index is reused until the file changes', () => {
  const file = mkBasket(CORPUS);
  let reads = 0;
  const r = createBasketRetriever({
    file,
    readFile: (...a) => { reads++; return fs.readFileSync(...a); },
  });
  r.retrieve('helm chart deploy values file', { limit: 1 });
  r.retrieve('env vars checkbox clodex settings', { limit: 1 });
  r.retrieve('commit tag push tree dirty review', { limit: 1 });
  assert.strictEqual(reads, 1,
    'rebuilding the index per query costs 285ms on the real basket and runs on the keystroke path');

  // Touching the file must invalidate: a message captured seconds ago has to be
  // retrievable, so a cache that never notices a write is worse than no cache.
  const rec = { id: 'm9', ts: '2026-07-09T00:00:00Z', cwd: '/pub/repo', text: 'the sandbox integration vision for clodex sessions' };
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  const hit = r.retrieve('sandbox integration vision', { limit: 1 });
  assert.strictEqual(reads, 2, 'a changed file must be re-read');
  assert.ok(hit.length && hit[0].id === 'm9', 'and the newly appended message is retrievable');
});

test('basket: a query scores only records containing its terms', () => {
  // The postings list is the whole reason this is affordable: 330ms scoring all
  // 13,926 records became sub-millisecond by touching only the candidates. A
  // linear scan would still pass every other test in this file, so cost is
  // asserted structurally — the candidate set, not the wall clock.
  const many = [];
  for (let i = 0; i < 500; i++) {
    many.push({ id: `pad${i}`, ts: '2026-07-01T00:00:00Z', cwd: '/pub/repo', text: `padding record ${i} about unrelated matters` });
  }
  const idx = buildIndex([...CORPUS, ...many]);

  const candidates = new Set();
  for (const w of ['checkbox', 'settings']) {
    for (const i of idx.postings.get(w) || []) candidates.add(i);
  }
  assert.ok(candidates.size <= 4,
    `a two-term query must reach a handful of records, not the corpus (${candidates.size} of ${idx.total})`);
  assert.ok(idx.total > 500, 'and the corpus really is large enough for that to mean something');

  const hits = rank(idx, 'checkbox clodex settings env vars', { limit: 1 });
  assert.strictEqual(hits[0].id, 'm2', 'the right record is still found through the index');
});

test('basket: recency damps an old record without letting it lose to noise', () => {
  const now = Date.parse('2026-08-01T00:00:00Z');
  const fresh = recencyOf('2026-08-01T00:00:00Z', now);
  const old = recencyOf('2024-08-01T00:00:00Z', now);
  assert.ok(fresh > old, 'a newer line ranks above an identical older one');
  assert.ok(old >= 0.75,
    `the prior must stay mild (${old}) — a recent irrelevant line must not outrank an older exact `
    + 'match, which a steep decay would allow');
  assert.strictEqual(recencyOf(null, now) <= 1, true, 'a record with no timestamp is not boosted');
});

test('basket: a single matched term never arms', () => {
  const idx = buildIndex(CORPUS);
  assert.strictEqual(MIN_HITS, 2);
  // "helm" alone hits two records; one coincidental term is the shape of noise,
  // exactly as in the memory retriever.
  const hits = rank(idx, 'helm', { limit: 3 });
  assert.deepStrictEqual(hits, [], 'one term is a coincidence, not a topic');
});
