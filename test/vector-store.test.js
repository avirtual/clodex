// The append-only vector store. What must hold is not "does cosine work" but
// that the file survives the ways it will actually be damaged: a crash mid-
// append, a sidecar that outlived its blob, a model swap, and unbounded growth
// from records that keep changing.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createVectorStore, sidecarPath, BYTES_PER_DIM } = require('../vector-store');

const D = 8;
function mk(dims = D, model = 'test-model') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-vec-'));
  const file = path.join(dir, 'vec.bin');
  return { dir, file, store: createVectorStore({ file, dims, model }) };
}
// A unit vector on one axis, so similarity is exactly predictable.
function axis(i, dims = D) {
  const v = new Float32Array(dims);
  v[i % dims] = 1;
  return v;
}

test('vector-store: a vector round-trips and is found by similarity', () => {
  const { dir, store } = mk();
  store.add('a', axis(0));
  store.add('b', axis(1));
  store.add('c', axis(2));
  store.flush();

  assert.strictEqual(store.size(), 3);
  assert.ok(store.has('b'));
  const got = store.get('b');
  assert.strictEqual(got.length, D);
  assert.strictEqual(got[1], 1);

  const hits = store.search(axis(1), { limit: 2 });
  assert.strictEqual(hits[0].key, 'b', 'the vector on the query axis wins');
  assert.ok(hits[0].sim > 0.99);
  assert.ok(hits[1].sim < 0.01, 'and an orthogonal vector scores ~0');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('vector-store: the store survives a restart', () => {
  const { dir, file } = mk();
  const first = createVectorStore({ file, dims: D, model: 'test-model' });
  first.add('a', axis(0));
  first.add('b', axis(1));
  first.flush();

  const second = createVectorStore({ file, dims: D, model: 'test-model' });
  assert.strictEqual(second.size(), 2, 'a fresh store reads what the previous one wrote');
  assert.strictEqual(second.search(axis(0), { limit: 1 })[0].key, 'a');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('vector-store: an append does not rewrite the file', () => {
  // THE WHOLE POINT OF THE FORMAT. Measured on 13,926 real records: appending
  // one vector to a JSON blob costs 1114ms because the file is parsed, mutated
  // and re-serialised; appending to this costs one write of dims*4 bytes. A
  // wall-clock assertion would be flaky, so the write PATTERN is asserted.
  const { dir, file } = mk();
  const writes = [];
  const appends = [];
  const store = createVectorStore({
    file, dims: D, model: 'test-model',
    writeFile: (p, data) => { writes.push(p); return fs.writeFileSync(p, data); },
    appendFile: (p, data) => { appends.push(p); return fs.appendFileSync(p, data); },
  });
  for (let i = 0; i < 20; i++) store.add(`k${i}`, axis(i));
  assert.strictEqual(appends.length, 20, 'each vector is one append');
  assert.strictEqual(writes.filter((p) => p === file).length, 0,
    'the blob itself is never rewritten on the add path');

  store.flush();
  assert.strictEqual(writes.filter((p) => p.startsWith(sidecarPath(file))).length, 1,
    'and a batch of 20 adds costs ONE sidecar write, not 20');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('vector-store: a torn tail from a crash mid-append is discarded', () => {
  const { dir, file } = mk();
  const store = createVectorStore({ file, dims: D, model: 'test-model' });
  store.add('a', axis(0));
  store.add('b', axis(1));
  store.flush();

  // A partial row: the process died halfway through writing vector three.
  fs.appendFileSync(file, Buffer.alloc(D * BYTES_PER_DIM - 5, 0xff));

  const after = createVectorStore({ file, dims: D, model: 'test-model' });
  assert.strictEqual(after.rows(), 2,
    'a partial row must be dropped — reading it as a vector yields a plausible direction built '
    + 'from whatever bytes landed, which is worse than losing the record');
  assert.strictEqual(after.search(axis(0), { limit: 1 })[0].key, 'a', 'and the intact rows still rank');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('vector-store: a sidecar pointing past the blob drops the dangling rows', () => {
  const { dir, file } = mk();
  const store = createVectorStore({ file, dims: D, model: 'test-model' });
  store.add('a', axis(0));
  store.add('b', axis(1));
  store.flush();

  // The blob was truncated (disk full, partial restore) but the sidecar was not.
  fs.truncateSync(file, D * BYTES_PER_DIM);

  const after = createVectorStore({ file, dims: D, model: 'test-model' });
  assert.strictEqual(after.size(), 1, 'the row beyond the blob is dropped, not served');
  assert.strictEqual(after.get('b'), null, 'and it reads as absent rather than as garbage');
  assert.ok(after.get('a'), 'the surviving row is untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('vector-store: a model or dimension change starts over instead of mixing spaces', () => {
  // Cosine between a 768-dim row and a 1024-dim query is not an error, it is a
  // confident wrong answer. Same for two different models at the same width:
  // the numbers are comparable, the MEANINGS are not.
  const { dir, file } = mk();
  const first = createVectorStore({ file, dims: D, model: 'model-a' });
  first.add('a', axis(0));
  first.flush();

  const swapped = createVectorStore({ file, dims: D, model: 'model-b' });
  assert.strictEqual(swapped.size(), 0, 'a different model invalidates every existing row');

  const widened = createVectorStore({ file, dims: D * 2, model: 'model-a' });
  assert.strictEqual(widened.size(), 0, 'so does a different width');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('vector-store: a re-added key supersedes its old row and search returns one hit', () => {
  const { dir, store } = mk();
  store.add('a', axis(0));
  store.add('b', axis(1));
  // The record's text changed, so it is embedded again under the same key.
  store.add('a', axis(2));
  store.flush();

  assert.strictEqual(store.rows(), 3, 'the old row is still on disk — appends never rewrite');
  assert.strictEqual(store.size(), 2, 'but only two keys are live');
  const hits = store.search(axis(2), { limit: 5 });
  assert.strictEqual(hits.filter((h) => h.key === 'a').length, 1,
    'a superseded row must not surface as a second hit for the same record');
  assert.strictEqual(hits[0].key, 'a');
  assert.ok(hits[0].sim > 0.99, 'and the CURRENT vector is what ranks');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('vector-store: compact reclaims superseded rows without changing answers', () => {
  const { dir, store } = mk();
  for (let i = 0; i < 5; i++) store.add(`k${i}`, axis(i));
  // Every record re-embedded twice: 15 rows on disk, 5 live.
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 5; i++) store.add(`k${i}`, axis(i));
  }
  store.flush();
  const before = store.search(axis(3), { limit: 3 });
  assert.strictEqual(store.stats().garbage, 10, 'precondition: there is garbage to reclaim');

  const r = store.compact();
  assert.strictEqual(r.reclaimed, 10);
  assert.strictEqual(store.rows(), 5, 'only live rows remain');
  assert.strictEqual(store.stats().garbage, 0);
  assert.deepStrictEqual(store.search(axis(3), { limit: 3 }), before,
    'compaction is a storage operation — it must not change what a query returns');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('vector-store: compaction survives a restart', () => {
  const { dir, file } = mk();
  const store = createVectorStore({ file, dims: D, model: 'test-model' });
  for (let i = 0; i < 4; i++) store.add(`k${i}`, axis(i));
  for (let i = 0; i < 4; i++) store.add(`k${i}`, axis(i));
  store.flush();
  store.compact();

  const after = createVectorStore({ file, dims: D, model: 'test-model' });
  assert.strictEqual(after.rows(), 4, 'the compacted blob is what a fresh store reads');
  assert.strictEqual(after.size(), 4);
  assert.strictEqual(after.search(axis(2), { limit: 1 })[0].key, 'k2',
    'and the sidecar row numbers were rewritten to match, or every lookup is off by the garbage count');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('vector-store: confinement is applied during the scan, not after', () => {
  const { dir, store } = mk();
  store.add('public', axis(0));
  store.add('private', axis(0));  // identical vector: a perfect match
  store.flush();
  const hits = store.search(axis(0), { limit: 5, allow: (k) => k !== 'private' });
  assert.ok(!hits.some((h) => h.key === 'private'),
    'a confined record must be unrankable at any score, including an exact match');
  assert.strictEqual(hits[0].key, 'public');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('vector-store: a wrong-width vector is refused rather than stored', () => {
  const { dir, store } = mk();
  assert.throws(() => store.add('bad', new Float32Array(D + 1)), /dims/,
    'a mis-sized row would shift every subsequent row by its difference — the file is addressed '
    + 'by fixed width, so one bad append corrupts everything after it');
  assert.strictEqual(store.size(), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('vector-store: a corrupt sidecar costs a re-embed, not a crash', () => {
  const { dir, file } = mk();
  const store = createVectorStore({ file, dims: D, model: 'test-model' });
  store.add('a', axis(0));
  store.flush();
  fs.writeFileSync(sidecarPath(file), '{"version":1,"dims":8,"rows":{TRUNCATED');

  const after = createVectorStore({ file, dims: D, model: 'test-model' });
  assert.strictEqual(after.size(), 0, 'an unparseable sidecar reads as empty');
  assert.doesNotThrow(() => after.add('a', axis(0)), 'and the store is still usable');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('vector-store: an absent file is an empty store, not an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-vec-'));
  const store = createVectorStore({ file: path.join(dir, 'nope', 'vec.bin'), dims: D, model: 'm' });
  assert.strictEqual(store.size(), 0);
  assert.deepStrictEqual(store.search(axis(0)), []);
  assert.strictEqual(store.add('a', axis(0)), true, 'and the first add creates the path');
  fs.rmSync(dir, { recursive: true, force: true });
});
