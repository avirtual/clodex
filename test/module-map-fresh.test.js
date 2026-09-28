'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { extractFile, indexFile, parseMap, checkMap } = require('../scripts/symbol-index.js');

const REPO = path.join(__dirname, '..');
const MAP_DIR = path.join(REPO, 'docs', 'map');

// One slot per giant, each on its own line with a blank line between, so the
// six map tickets landing in parallel edit non-adjacent lines and merge clean.
// A commented slot is a placeholder, not coverage: the map ticket that lands
// the file uncomments its line, and a map on disk that is still commented reds.
const EXPECTED_MAPS = [
  // 'engine.md',

  'ipc-handlers.md',

  'renderer.md',

  'session-manager.md',

  // 'stores.md',

  'team-tickets.md',
];

const WHY_EMPTY_IS_NOT_VACUOUS = 'no maps ship with the gate; each giant lands in its own ticket, which appends its file to EXPECTED_MAPS. '
  + 'Until then the extractor floors and the per-rule fixture subjects carry the coverage, and this listing check still reds a map that lands unlisted, '
  + 'or, once the list fills, a listed map that vanishes';

const GIANTS = [
  { file: 'team-tickets.js', floor: 240, enter: [{ name: '_spawnTicketSeat', depth: 1 }] },
  { file: 'session-manager.js', floor: 340, enter: [{ name: '_armBootNudge', depth: 2, parent: 'SessionManager' }, { name: 'createSessionManager', depth: 0 }] },
  { file: 'renderer/renderer.js', floor: 380, enter: [{ name: 'switchSession', depth: 0 }] },
  { file: 'ipc-handlers.js', floor: 260, enter: [] },
  { file: 'engine.js', floor: 100, enter: [{ name: 'createEngine', depth: 0 }] },
  { file: 'stores.js', floor: 150, enter: [{ name: 'initStores', depth: 0 }] },
];

for (const g of GIANTS) {
  test(`extractor floor + ENTER on ${g.file}`, () => {
    const res = indexFile(path.join(REPO, g.file));
    assert.ok(!res.error, `${g.file} failed to parse: ${res.error}`);
    assert.ok(res.symbols.length >= g.floor, `${g.file}: ${res.symbols.length} symbols, floor ${g.floor} (about 90% of the count when the gate landed; a collapsed extraction would pass every map check vacuously)`);
    for (const s of res.symbols) assert.ok(s.depth <= 2, `${g.file}: ${s.name} recorded at depth ${s.depth}`);
    for (let i = 1; i < res.symbols.length; i++) {
      assert.ok(res.symbols[i].start >= res.symbols[i - 1].start, `${g.file}: symbols not sorted by start at ${i}`);
    }
    for (const e of g.enter) {
      const hit = res.symbols.find((s) => s.name === e.name);
      assert.ok(hit, `ENTER: ${e.name} not recorded in ${g.file}`);
      assert.strictEqual(hit.depth, e.depth, `${g.file}: ${e.name} depth`);
      if (e.parent) assert.strictEqual(hit.parent, e.parent, `${g.file}: ${e.name} parent`);
    }
  });
}

test('ipc-handlers.js records literal-channel handlers as handle:<channel>', () => {
  const res = indexFile(path.join(REPO, 'ipc-handlers.js'));
  const handlers = res.symbols.filter((s) => s.kind === 'handler');
  assert.ok(handlers.length >= 50, `ipc-handlers.js: ${handlers.length} handlers`);
  for (const h of handlers) assert.match(h.name, /^(handle|on|intent):/);
});

function filler(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`  const v${i} = ${i};`);
  return out.join('\n');
}

const FIXTURE_SRC = [
  'function alpha() { return 1; }',
  'function beta() {',
  filler(44),
  '  return alpha();',
  '}',
  'function gamma() { return alpha(); }',
  'function delta() {',
  filler(44),
  '}',
  'module.exports = { alpha, beta, gamma, delta };',
  '',
].join('\n');

const HEAD = [
  '## Head — alpha … beta',
  '',
  '| symbol | purpose | state | calls | pins |',
  '|---|---|---|---|---|',
  '| alpha | one | none | - | alpha.test.js |',
  '| `beta` | long | none | alpha | unpinned |',
  '',
  '### Invariants',
  '- `alpha` returns one.',
  '',
];

const TAIL = [
  '## Tail — gamma ... gamma',
  '',
  '| symbol | purpose | state | calls | pins |',
  '|---|---|---|---|---|',
  '| gamma | proxy | none | alpha | test/alpha.test.js |',
  '',
  '### Hazards',
  '- `gamma()` hides `alpha`.',
  '',
];

const EXEMPT = ['## EXEMPT', '', '- delta — generated filler', ''];

function fixtureMap({ head = HEAD, tail = TAIL, exempt = EXEMPT, order = 'head-first' } = {}) {
  const regions = order === 'head-first' ? [...head, ...tail] : [...tail, ...head];
  return ['# fixture.js', '', ...regions, ...exempt].join('\n');
}

function fixtureTestDir() {
  const dir = mkTmpRoot('module-map-fresh-');
  fs.writeFileSync(path.join(dir, 'alpha.test.js'), "test('alpha and gamma', () => {});\n");
  fs.writeFileSync(path.join(dir, 'other.test.js'), "test('unrelated', () => {});\n");
  return dir;
}

function run(mapText, testDir = fixtureTestDir()) {
  const extracted = extractFile(FIXTURE_SRC);
  assert.ok(!extracted.error, extracted.error);
  return checkMap({ map: parseMap(mapText), extracted, testDir }).failures;
}

test('fixture baseline: the clean map checks with zero failures, and delta is long enough to need EXEMPT', () => {
  const extracted = extractFile(FIXTURE_SRC);
  const delta = extracted.symbols.find((s) => s.name === 'delta');
  const beta = extracted.symbols.find((s) => s.name === 'beta');
  assert.ok(delta.lines >= 40 && beta.lines >= 40, `delta ${delta.lines}, beta ${beta.lines}`);
  const map = parseMap(fixtureMap());
  assert.strictEqual(map.module, 'fixture.js');
  assert.deepStrictEqual(map.regions.map((r) => [r.name, r.first, r.last]), [['Head', 'alpha', 'beta'], ['Tail', 'gamma', 'gamma']]);
  assert.deepStrictEqual(map.regions[0].rows.map((r) => [r.symbol, r.pins]), [['alpha', ['alpha.test.js']], ['beta', []]]);
  assert.deepStrictEqual(map.exempt, [{ symbol: 'delta', reason: 'generated filler' }]);
  assert.deepStrictEqual(map.errors, []);
  assert.deepStrictEqual(run(fixtureMap()), []);
});

test('forward: a row naming a symbol the extractor does not record fails once, naming it', () => {
  const tail = TAIL.map((l) => l.replace('| gamma |', '| gone |'));
  const failures = run(fixtureMap({ tail }));
  assert.deepStrictEqual(failures.map((f) => [f.kind, f.symbol]), [['forward', 'gone']]);
});

test('forward: an invariant bullet that names no recorded symbol fails', () => {
  const head = HEAD.map((l) => l.replace('- `alpha` returns one.', '- `nothing` returns one.'));
  const failures = run(fixtureMap({ head }));
  assert.deepStrictEqual(failures.map((f) => [f.kind, f.symbol]), [['forward', 'nothing']]);
});

test('reverse: a 40-line function in no table and not EXEMPT fails', () => {
  const failures = run(fixtureMap({ exempt: ['## EXEMPT', ''] }));
  assert.deepStrictEqual(failures.map((f) => [f.kind, f.symbol]), [['reverse', 'delta']]);
});

test('reverse: EXEMPT satisfies it, and a table row does too', () => {
  const head = HEAD.filter((l) => !l.startsWith('| `beta`'));
  const failures = run(fixtureMap({ head }));
  assert.deepStrictEqual(failures.map((f) => [f.kind, f.symbol]), [['reverse', 'beta']]);
  assert.deepStrictEqual(run(fixtureMap()), []);
});

test('pin: a pin that does not mention the symbol and a pin that does not exist fail with distinct details', () => {
  const head = HEAD.map((l) => l.replace('| alpha.test.js |', '| other.test.js, missing.test.js |'));
  const failures = run(fixtureMap({ head }));
  assert.deepStrictEqual(failures.map((f) => [f.kind, f.symbol]), [['pin', 'alpha'], ['pin', 'alpha']]);
  assert.match(failures[0].detail, /other\.test\.js .*never mentions alpha/);
  assert.match(failures[1].detail, /missing\.test\.js .*does not exist/);
});

test('order: two regions listed in the reverse of their file order fail', () => {
  const failures = run(fixtureMap({ order: 'tail-first' }));
  assert.deepStrictEqual(failures.map((f) => [f.kind, f.symbol]), [['order', 'alpha']]);
});

test('format: a bad table header fails', () => {
  const tail = TAIL.map((l) => l.replace('| symbol | purpose | state | calls | pins |', '| symbol | purpose | calls | state | pins |'));
  const failures = run(fixtureMap({ tail }));
  assert.ok(failures.length >= 1);
  assert.deepStrictEqual([...new Set(failures.map((f) => f.kind))], ['format']);
  assert.match(failures[0].detail, /table header/);
});

test('format: a malformed region heading, a missing H1 and a module path that does not exist fail', () => {
  const head = HEAD.map((l) => l.replace('## Head — alpha … beta', '## Head alpha to beta'));
  const failures = run(fixtureMap({ head }).replace('# fixture.js', 'fixture.js'));
  assert.ok(failures.some((f) => f.kind === 'format' && /line 1/.test(f.detail)), JSON.stringify(failures));
  assert.ok(failures.some((f) => f.kind === 'format' && /region heading/.test(f.detail)), JSON.stringify(failures));
  const map = parseMap(fixtureMap());
  const res = checkMap({ map, extracted: extractFile(FIXTURE_SRC), testDir: fixtureTestDir(), root: REPO });
  assert.deepStrictEqual(res.failures.map((f) => f.kind), ['format']);
  assert.match(res.failures[0].detail, /fixture\.js does not exist/);
});

test('format: a second table inside one region fails', () => {
  const head = [...HEAD, '| symbol | purpose | state | calls | pins |', '|---|---|---|---|---|', '| alpha | again | none | - | unpinned |', ''];
  const failures = run(fixtureMap({ head }));
  assert.deepStrictEqual(failures.map((f) => f.kind), ['format']);
  assert.match(failures[0].detail, /second table/);
});

test('pin: a pin naming a directory under test/ yields one pin failure instead of throwing', () => {
  const dir = fixtureTestDir();
  fs.mkdirSync(path.join(dir, 'lib'));
  const head = HEAD.map((l) => l.replace('| alpha.test.js |', '| lib |'));
  const failures = run(fixtureMap({ head }), dir);
  assert.deepStrictEqual(failures.map((f) => [f.kind, f.symbol]), [['pin', 'alpha']]);
  assert.match(failures[0].detail, /lib .*is not a file/);
});

const PARENT_SRC = [
  'class Alpha {',
  '  run() {',
  filler(44),
  '  }',
  '}',
  'class Beta {',
  '  run() {',
  filler(44),
  '  }',
  '}',
  'class Gamma {',
  '  stop() { return 0; }',
  '}',
  'handle(\'x:y\', () => 1);',
  '',
].join('\n');

function runParent(rows, testDir = fixtureTestDir()) {
  const text = ['# fixture.js', '', '## All — Alpha … Gamma', '', '| symbol | purpose | state | calls | pins |', '|---|---|---|---|---|', ...rows, '', '## EXEMPT', '', '- Alpha — fixture class', '- Beta — fixture class', ''].join('\n');
  const extracted = extractFile(PARENT_SRC);
  assert.ok(!extracted.error, extracted.error);
  return checkMap({ map: parseMap(text), extracted, testDir }).failures;
}

test('forward: parent.method picks one of two same-named methods, a bare name covers both, and a parent without it fails', () => {
  assert.deepStrictEqual(runParent(['| Beta.run | b | none | - | unpinned |']).map((f) => [f.kind, f.detail.split(' ')[0]]), [['reverse', 'Alpha.run']]);
  assert.deepStrictEqual(runParent(['| run | both | none | - | unpinned |']), []);
  assert.deepStrictEqual(runParent(['| run | both | none | - | unpinned |', '| Gamma.run | none | none | - | unpinned |']).map((f) => [f.kind, f.symbol]), [['forward', 'Gamma.run']]);
});

test('pin: a handler row is matched by its channel string, not by the word handle', () => {
  const dir = fixtureTestDir();
  fs.writeFileSync(path.join(dir, 'chan.test.js'), "invoke('x:y');\n");
  fs.writeFileSync(path.join(dir, 'word.test.js'), 'handle();\n');
  const rows = ['| run | both | none | - | unpinned |'];
  assert.deepStrictEqual(runParent([...rows, '| handle:x:y | h | none | - | chan.test.js |'], dir), []);
  const failures = runParent([...rows, '| handle:x:y | h | none | - | word.test.js |'], dir);
  assert.deepStrictEqual(failures.map((f) => [f.kind, f.symbol]), [['pin', 'handle:x:y']]);
});

function mapFilesIn(dir) {
  return fs.readdirSync(dir).filter((f) => f !== 'README.md' && f.endsWith('.md')).sort();
}

test('real maps listing ignores README.md and anything that is not a .md file', () => {
  const dir = mkTmpRoot('module-map-fresh-');
  for (const f of ['README.md', 'a.md', '.DS_Store', '.a.md.swp', 'b.md~']) fs.writeFileSync(path.join(dir, f), '');
  assert.deepStrictEqual(mapFilesIn(dir), ['a.md']);
});

test('real maps: docs/map holds exactly EXPECTED_MAPS, and each checks with zero failures', () => {
  assert.ok(fs.existsSync(path.join(MAP_DIR, 'README.md')), 'ENTER: docs/map/README.md is not on disk');
  const listed = mapFilesIn(MAP_DIR);
  assert.deepStrictEqual(listed, [...EXPECTED_MAPS].sort(), WHY_EMPTY_IS_NOT_VACUOUS);
  for (const file of listed) {
    const map = parseMap(fs.readFileSync(path.join(MAP_DIR, file), 'utf8'));
    assert.ok(map.module, `${file}: no module on line 1`);
    assert.strictEqual(file, `${path.basename(map.module, '.js')}.md`, `${file} maps ${map.module}`);
    const extracted = indexFile(path.join(REPO, map.module));
    const { failures } = checkMap({ map, extracted, testDir: path.join(REPO, 'test'), root: REPO });
    assert.deepStrictEqual(failures, [], `${file}:\n${failures.map((f) => `${f.kind}: ${f.detail}`).join('\n')}`);
  }
});
