const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mkTmpRoot } = require('./lib/tmp-roots');

const { createMemoryStore, parseProfileYaml, serializeProfile, composeDigest } = require('../memory-store');

function tmpStore() {
  const dir = mkTmpRoot('clodex-profile-');
  return { store: createMemoryStore(dir), dir };
}

const SUBSET = [
  'game:',
  '  name: Bob',
  '  level: 7',
  '  vip: true',
  '  nick: null',
  '  quoted: "a: b"',
  "  single: 'it''s'",
  '  tags:',
  '    - fast',
  '    - 3',
  '  compact:',
  '  - one',
  '  horses:',
  '    Star: bay',
  '    Big Dust: 2',
  '  none: []',
  '  empty: {}',
  '# a comment',
  'notes:',
  '  likes: carrots # trailing comment',
  '',
].join('\n');

test('parseProfileYaml: accepts the strict subset (scalars, flat lists, one-level maps, comments)', () => {
  assert.deepStrictEqual(parseProfileYaml(SUBSET), {
    game: {
      name: 'Bob', level: 7, vip: true, nick: null, quoted: 'a: b', single: "it's",
      tags: ['fast', 3], compact: ['one'], horses: { Star: 'bay', 'Big Dust': 2 }, none: [], empty: {},
    },
    notes: { likes: 'carrots' },
  });
  assert.deepStrictEqual(parseProfileYaml(''), { game: {}, notes: {} });
});

test('parseProfileYaml: rejects anchors, aliases, tags, depth 3, bad keys, non-scalar list items, documents', () => {
  const cases = [
    ['game:\n  a: &x 1', /anchors and aliases/],
    ['game:\n  a: *x', /anchors and aliases/],
    ['game:\n  a: !!str 1', /tags are not allowed/],
    ['game:\n  a: |\n    text', /block scalars/],
    ['game:\n  h:\n    s:\n      d: 1', /nesting deeper than one level/],
    ['game:\n  h:\n    s: [1]', /nesting deeper than one level/],
    ['game:\n  Bad: 1', /bad key "Bad"/],
    ['game:\n  a b: 1', /bad key "a b"/],
    ['game:\n  l:\n    - a: b', /list items must be scalars/],
    ['game:\n  l:\n    - - x', /list items must be scalars/],
    ['game:\n  l:\n    - []', /list items must be scalars/],
    ['game:\n  a: [1, 2]', /flow collections/],
    ['---\ngame: {}', /multi-document/],
    ['game: {}\n...', /multi-document/],
    ['%YAML 1.2\ngame: {}', /multi-document/],
    ['other:\n  a: 1', /unknown top-level key "other"/],
    ['game:\n  a: 1\ngame:\n  b: 2', /duplicate key game/],
    ['game:\n  a: 1\n  a: 2', /duplicate key a/],
    ['game:\n\ta: 1', /tabs/],
    ['game:\n   a: 1', /bad indentation/],
    ['game: 3', /game must be a map/],
    ['  a: 1', /content before game/],
    ['game:\n  l:\n    - a\n    k: v', /cannot mix/],
  ];
  for (const [text, re] of cases) {
    assert.throws(() => parseProfileYaml(text), re, `accepted: ${JSON.stringify(text)}`);
  }
});

test('serializeProfile: canonical order and quoting, and round-trips through the parser', () => {
  const profile = {
    notes: { mood: 'happy' },
    game: {
      zeta: 1, alpha: 'yes', num: '42', blank: '', colon: 'k: v', hash: 'a #b', lead: '-x', nl: 'a\nb',
      tags: ['x', null, false, 1.5], horses: { Star: 'bay', 'true': 'quoted key', 'a: b': 1 }, nothing: [],
    },
  };
  const yaml = serializeProfile(profile);
  assert.strictEqual(yaml, [
    'game:',
    '  zeta: 1',
    '  alpha: "yes"',
    '  num: "42"',
    '  blank: ""',
    '  colon: "k: v"',
    '  hash: "a #b"',
    '  lead: "-x"',
    '  nl: "a\\nb"',
    '  tags:',
    '    - x',
    '    - null',
    '    - false',
    '    - 1.5',
    '  horses:',
    '    Star: bay',
    '    "true": quoted key',
    '    "a: b": 1',
    '  nothing: []',
    'notes:',
    '  mood: happy',
    '',
  ].join('\n'));
  assert.deepStrictEqual(parseProfileYaml(yaml), { game: profile.game, notes: profile.notes });
  assert.strictEqual(serializeProfile({ game: {}, notes: {} }), '');
});

test('profileSet: refuses at 4097 serialised bytes, accepts 4096', () => {
  const { store } = tmpStore();
  const over = store.profileSet('alpha', { game: { k: 'a'.repeat(4085) } });
  assert.deepStrictEqual(over, { ok: false, error: 'profile exceeds 4096 bytes (4097)' });
  assert.deepStrictEqual(store.profileGet('alpha'), { ok: true, profile: null }, 'a refused write left nothing on disk');
  const at = store.profileSet('alpha', { game: { k: 'a'.repeat(4084) } });
  assert.strictEqual(at.ok, true);
  assert.strictEqual(at.bytes, 4096);
});

test('profileSet merge: upsert, null drops, a map value replaces the key whole', () => {
  const { store } = tmpStore();
  store.profileSet('alpha', { game: { name: 'Bob', level: 1 }, notes: { horses: { Star: 'a' }, tip: 'x' } });
  const out = store.profileSet('alpha', { game: { level: 2, coins: 5 }, notes: { horses: { Star: 'b', Dusty: 'c' }, tip: null } });
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.profile, {
    game: { name: 'Bob', level: 2, coins: 5 },
    notes: { horses: { Star: 'b', Dusty: 'c' } },
  });
  const narrowed = store.profileSet('alpha', { notes: { horses: { Dusty: 'd' } } });
  assert.deepStrictEqual(narrowed.profile.notes.horses, { Dusty: 'd' }, 'no deep merge: Star is gone');
  const got = store.profileGet('alpha');
  assert.deepStrictEqual(got.profile, narrowed.profile);
  assert.strictEqual(got.yaml, narrowed.yaml);
  assert.strictEqual(got.bytes, Buffer.byteLength(got.yaml));
  assert.match(got.updatedAt, /^\d{4}-\d\d-\d\dT/);
});

test('profileSet merge=false replaces the whole body', () => {
  const { store } = tmpStore();
  store.profileSet('alpha', { game: { name: 'Bob' }, notes: { tip: 'x' } });
  const out = store.profileSet('alpha', { game: { level: 3, nick: null } }, { merge: false });
  assert.deepStrictEqual(out.profile, { game: { level: 3, nick: null }, notes: {} });
  assert.deepStrictEqual(store.profileGet('alpha').profile, { game: { level: 3, nick: null }, notes: {} });
});

test('profileSet: validates input before writing', () => {
  const { store } = tmpStore();
  const bad = [
    [{ other: {} }, /unknown profile section: other/],
    [{ game: [] }, /game: must be a map/],
    [{ game: { Bad: 1 } }, /bad key "Bad"/],
    [{ game: { l: [{ a: 1 }] } }, /list items must be scalars/],
    [{ game: { m: { a: { b: 1 } } } }, /nesting deeper than one level/],
    [{ game: { n: Infinity } }, /unsupported value/],
    ['game: {}', /must be an object/],
  ];
  for (const [input, re] of bad) {
    const out = store.profileSet('alpha', input);
    assert.strictEqual(out.ok, false, `accepted ${JSON.stringify(input)}`);
    assert.match(out.error, re);
  }
  assert.deepStrictEqual(store.profileGet('alpha'), { ok: true, profile: null });
});

test('profile file: type profile frontmatter, list()/digest omit it, recall misses it, update/forget refuse it', () => {
  const { store, dir } = tmpStore();
  const unit = store.remember('alpha', { text: 'a real unit about profile handling' });
  store.profileSet('alpha', { game: { name: 'Bob' } });
  const raw = fs.readFileSync(path.join(dir, 'alpha', 'profile.md'), 'utf8');
  assert.match(raw, /^---\nid: profile\ntype: profile\nupdated_at: \S+\n---\n\ngame:\n {2}name: Bob\n$/);
  assert.deepStrictEqual(store.list('alpha').map(u => u.id), [unit.id]);
  assert.ok(!composeDigest(store.list('alpha')).includes('name: Bob'));
  assert.strictEqual(store.recall('alpha', 'Bob'), null);
  assert.strictEqual(store.recall('alpha', 'profile').id, unit.id, 'keyword recall over units is unchanged');
  assert.deepStrictEqual(store.update('alpha', 'profile', { text: 'x' }), { ok: false, error: 'profile is not a unit' });
  assert.throws(() => store.forget('alpha', 'profile'), /^Error: profile is not a unit$/);
  assert.ok(fs.existsSync(path.join(dir, 'alpha', 'profile.md')));
});

test('profileDelete: existed true then false; invalid agent refused', () => {
  const { store, dir } = tmpStore();
  store.profileSet('alpha', { notes: { a: 1 } });
  assert.deepStrictEqual(store.profileDelete('alpha'), { ok: true, existed: true });
  assert.ok(!fs.existsSync(path.join(dir, 'alpha', 'profile.md')));
  assert.deepStrictEqual(store.profileDelete('alpha'), { ok: true, existed: false });
  assert.strictEqual(store.profileDelete('..').ok, false);
  assert.strictEqual(store.profileGet('..').ok, false);
});
