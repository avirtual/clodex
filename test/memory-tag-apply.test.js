// apply.js is the only thing in the tagging pipeline that writes a memory unit,
// so these cases are the guard on model output reaching disk. Two properties
// carry the weight: a rejected line changes NOTHING, and an applied line
// changes tags/tags_v and nothing else.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMemoryStore, parseMemoryUnit } = require('../memory-store');
const { apply } = require('../scripts/memory-tag/apply');
const { census, readUnitFile, VOCAB_VERSION } = require('../scripts/memory-tag/unit-file');
const { mkTmpRoot } = require('./lib/tmp-roots');

const AGENT = 'alpha';

// Units are created through remember() and then given extra frontmatter by a
// raw rewrite, because remember() cannot write unknown keys — and unknown-key
// survival is precisely what these tests are for.
function fixture(specs) {
  const root = mkTmpRoot('clodex-tag-');
  const store = createMemoryStore(root);
  const ids = [];
  for (const s of specs) {
    const u = store.remember(AGENT, { scope: s.scope || '', text: s.text, pinned: !!s.pinned });
    if (s.extra) {
      const f = path.join(root, AGENT, `${u.id}.md`);
      fs.writeFileSync(f, fs.readFileSync(f, 'utf-8').replace(`source: ${AGENT}`, `source: ${AGENT}\n${s.extra}`));
    }
    ids.push(u.id);
  }
  return { root, ids, read: id => fs.readFileSync(path.join(root, AGENT, `${id}.md`), 'utf-8') };
}

function writeTagfile(root, text) {
  const f = path.join(root, 'tags.txt');
  fs.writeFileSync(f, text);
  return f;
}

function run(root, text) {
  return apply(writeTagfile(root, text), { root, agent: AGENT });
}

test('apply: a valid line writes tags + tags_v and preserves pinned and unknown keys', () => {
  const { root, ids, read } = fixture([
    { text: 'a unit with curation metadata', pinned: true, scope: 'ops', extra: 'superseded_by: mem-9-zzz' },
  ]);
  const before = read(ids[0]);

  const { applied, rejected } = run(root, `${ids[0]}: plugins,ipc-transport\n`);
  assert.deepStrictEqual(rejected, []);
  assert.strictEqual(applied.length, 1);

  const after = parseMemoryUnit(read(ids[0]));
  assert.strictEqual(after.meta.tags, 'plugins,ipc-transport');
  // tags_v is what makes --unprocessed converge: without it every tagged unit
  // re-queues and the nightly re-tags the whole store forever.
  assert.strictEqual(after.meta.tags_v, String(VOCAB_VERSION), 'tags_v was not written');
  // Everything the rewrite must not disturb, checked against the file as it
  // was rather than against re-stated literals.
  const b = parseMemoryUnit(before);
  assert.strictEqual(after.body, b.body, 'the rewrite altered the body');
  assert.strictEqual(after.meta.pinned, 'true', 'the rewrite dropped pinned');
  assert.strictEqual(after.meta.superseded_by, 'mem-9-zzz',
    'the rewrite dropped an unknown frontmatter key — the property 7498631 added');
  for (const k of ['id', 'scope', 'learned_at', 'source']) {
    assert.strictEqual(after.meta[k], b.meta[k], `the rewrite altered ${k}`);
  }
  // pinned stays last: unpin deletes that line, and a key after it would leave
  // the pre-pin byte shape unrecoverable.
  const keys = read(ids[0]).split('\n---')[0].split('\n').map(l => (l.match(/^(\w+):/) || [])[1]).filter(Boolean);
  assert.strictEqual(keys[keys.length - 1], 'pinned');
});

test('apply: an unknown id is rejected and writes nothing', () => {
  const { root, ids, read } = fixture([{ text: 'untouched unit' }]);
  const before = read(ids[0]);

  const { applied, rejected } = run(root, 'mem-9999999999-nosuch: plugins\n');
  assert.strictEqual(applied.length, 0);
  assert.strictEqual(rejected.length, 1);
  assert.match(rejected[0].why, /no unit mem-9999999999-nosuch in store/);
  assert.strictEqual(read(ids[0]), before, 'a rejected line must leave every unit byte-identical');
});

test('apply: malformed tags are rejected, each with its own reason', () => {
  // One case per rule, so a rule going missing names itself in the failure
  // rather than showing up as an off-by-one in a total.
  const { root, ids, read } = fixture([{ text: 'unit under test' }]);
  const before = read(ids[0]);
  const cases = [
    ['Plugins', /not lowercase-hyphenated/],
    ['has space', /not `<id>: tag1,tag2`|not lowercase-hyphenated/],
    ['under_score', /not lowercase-hyphenated/],
    ['-leading', /not lowercase-hyphenated/],
    ['trailing-', /not lowercase-hyphenated/],
    ['double--hyphen', /not lowercase-hyphenated/],
    ['a'.repeat(25), /is 25 chars, max 24/],
    ['one,two,three,four', /4 tags, max 3/],
    ['', /no tags/],
    ['dup,dup', /duplicate tag/],
  ];
  for (const [tags, why] of cases) {
    const { applied, rejected } = run(root, `${ids[0]}: ${tags}\n`);
    assert.strictEqual(applied.length, 0, `"${tags}" should not apply`);
    assert.strictEqual(rejected.length, 1, `"${tags}" should reject once`);
    assert.match(rejected[0].why, why, `"${tags}" rejected for the wrong reason`);
    assert.strictEqual(read(ids[0]), before, `"${tags}" modified the unit anyway`);
  }
});

test('apply: a boundary-length tag and exactly 3 tags are accepted', () => {
  // The other side of the two limits above: a max that rejects its own boundary
  // is off by one, and no rejection test can tell.
  const { root, ids } = fixture([{ text: 'boundary unit' }]);
  const max = 'a'.repeat(24);
  const { applied, rejected } = run(root, `${ids[0]}: ${max},two,three\n`);
  assert.deepStrictEqual(rejected, []);
  assert.strictEqual(applied.length, 1);
  assert.strictEqual(readUnitFile(root, AGENT, ids[0]).meta.tags, `${max},two,three`);
});

test('apply: one bad line does not stop the good ones, and only the bad one is untouched', () => {
  const { root, ids, read } = fixture([
    { text: 'first unit' }, { text: 'second unit' }, { text: 'third unit' },
  ]);
  const beforeThird = read(ids[2]);

  const { applied, rejected } = run(root,
    `${ids[0]}: alpha\n${ids[2]}: NOPE\n${ids[1]}: beta,gamma\n`);
  assert.strictEqual(applied.length, 2);
  assert.strictEqual(rejected.length, 1);
  assert.strictEqual(rejected[0].n, 2, 'the report must name the line number in the file');

  assert.strictEqual(readUnitFile(root, AGENT, ids[0]).meta.tags, 'alpha');
  assert.strictEqual(readUnitFile(root, AGENT, ids[1]).meta.tags, 'beta,gamma');
  assert.strictEqual(read(ids[2]), beforeThird);
});

test('apply: blank lines and comments are skipped, not rejected', () => {
  const { root, ids } = fixture([{ text: 'commented run' }]);
  const { applied, rejected } = run(root, `# census follows\n\n${ids[0]}: alpha\n\n`);
  assert.deepStrictEqual(rejected, []);
  assert.strictEqual(applied.length, 1);
});

test('apply: --dry-run reports what it would do and writes nothing', () => {
  const { root, ids, read } = fixture([{ text: 'dry unit' }]);
  const before = read(ids[0]);
  const { applied, rejected } = apply(writeTagfile(root, `${ids[0]}: alpha,beta\n`),
    { root, agent: AGENT, dryRun: true });
  assert.strictEqual(applied.length, 1);
  assert.deepStrictEqual(rejected, []);
  assert.strictEqual(read(ids[0]), before, 'dry-run wrote to disk');
});

test('apply: re-tagging replaces the tag set and does not append to it', () => {
  const { root, ids } = fixture([{ text: 'retagged unit', extra: 'tags: old-one,old-two\ntags_v: 1' }]);
  run(root, `${ids[0]}: new-one\n`);
  assert.strictEqual(readUnitFile(root, AGENT, ids[0]).meta.tags, 'new-one');
});

test('census: counts comma-split tags across the store, most-used first', () => {
  const { root, ids } = fixture([
    { text: 'one', extra: 'tags: alpha,beta' },
    { text: 'two', extra: 'tags: alpha' },
    { text: 'three', extra: 'tags: alpha,gamma' },
    { text: 'four' },
  ]);
  assert.strictEqual(ids.length, 4);
  assert.deepStrictEqual(census(root, AGENT), [
    { tag: 'alpha', n: 3 }, { tag: 'beta', n: 1 }, { tag: 'gamma', n: 1 },
  ]);
});

test('census: a store with no tags yields nothing, and the run proceeds censusless', () => {
  const { root } = fixture([{ text: 'untagged one' }, { text: 'untagged two' }]);
  assert.deepStrictEqual(census(root, AGENT), []);
});
