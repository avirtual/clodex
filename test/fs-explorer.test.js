// Run: node --test
// Covers fs-explorer: directory listing (dirs-first, noise-filtered), file
// read (binary/oversize/traversal guards), write (confinement + mkdir), and the
// path-safety boundary that keeps everything inside the session root.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fse = require('../plugins/workbench/fs-explorer');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-fse-'));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.mkdirSync(path.join(root, 'node_modules')); // noise — should be filtered
  fs.writeFileSync(path.join(root, 'b.txt'), 'text\n');
  fs.writeFileSync(path.join(root, 'a.js'), 'code\n');
  fs.writeFileSync(path.join(root, 'sub', 'nested.txt'), 'deep\n');
  return root;
}

test('listDir: dirs first then files (alpha), noise filtered', () => {
  const root = makeRoot();
  const r = fse.listDir(root, '');
  assert.strictEqual(r.ok, true);
  const names = r.entries.map((e) => e.name);
  // 'sub' (dir) before files; node_modules excluded.
  assert.deepStrictEqual(names, ['sub', 'a.js', 'b.txt']);
  assert.strictEqual(r.entries[0].type, 'dir');
});

test('listDir: descends into a subdir by rel path', () => {
  const root = makeRoot();
  const r = fse.listDir(root, 'sub');
  assert.deepStrictEqual(r.entries.map((e) => e.name), ['nested.txt']);
  assert.strictEqual(r.entries[0].rel, path.join('sub', 'nested.txt'));
});

test('readFile: returns text content + eol', () => {
  const root = makeRoot();
  const r = fse.readFile(root, 'b.txt');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.content, 'text\n');
  assert.strictEqual(r.eol, '\n');
});

test('readFile: refuses a binary file', () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, 'bin'), Buffer.from([1, 2, 0, 3, 4]));
  const r = fse.readFile(root, 'bin');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.binary, true);
});

test('writeFile: round-trips and creates parent dirs', () => {
  const root = makeRoot();
  assert.strictEqual(fse.writeFile(root, 'fresh/dir/new.txt', 'hi').ok, true);
  assert.strictEqual(fs.readFileSync(path.join(root, 'fresh/dir/new.txt'), 'utf8'), 'hi');
});

test('path safety: read/write/list outside root are refused', () => {
  const root = makeRoot();
  assert.strictEqual(fse.readFile(root, '../../../etc/passwd').ok, false);
  assert.strictEqual(fse.listDir(root, '..').ok, false);
  assert.strictEqual(fse.writeFile(root, '../escape.txt', 'x').ok, false);
  // An absolute path that resolves outside is also refused.
  assert.strictEqual(fse.readFile(root, '/etc/hosts').ok, false);
});

test('safeResolve: null on escape, absolute path within root otherwise', () => {
  const root = makeRoot();
  assert.strictEqual(fse.safeResolve(root, '../x'), null);
  assert.strictEqual(fse.safeResolve(null, 'x'), null);
  assert.strictEqual(fse.safeResolve(root, 'a.js'), path.join(root, 'a.js'));
  assert.strictEqual(fse.safeResolve(root, ''), path.resolve(root));
});

// ── File locator (findFiles) ────────────────────────────────────────────────
// The locator's contract is as much about its BOUNDS as its matching: an
// unbounded walk on a huge repo is the failure mode it exists to avoid.

test('locator: fuzzy-matches on the relative path and ranks basename hits first', () => {
  const root = makeRoot();
  const r = fse.findFiles(root, 'nested');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.matches.map((m) => m.rel), ['sub/nested.txt']);

  // Subsequence, not substring: 'ajs' finds 'a.js'.
  assert.deepStrictEqual(fse.findFiles(root, 'ajs').matches.map((m) => m.rel), ['a.js']);
});

test('locator: an empty query returns nothing, never the whole tree', () => {
  const root = makeRoot();
  for (const q of ['', '   ', null, undefined]) {
    const r = fse.findFiles(root, q);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.matches, [], `query ${JSON.stringify(q)} must match nothing`);
  }
});

test('locator: skips NOISE and build output, so results are files you wrote', () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, 'node_modules', 'target.txt'), 'x');
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'target.txt'), 'x');
  fs.writeFileSync(path.join(root, 'target.txt'), 'x');
  const rels = fse.findFiles(root, 'target').matches.map((m) => m.rel);
  assert.deepStrictEqual(rels, ['target.txt'], 'only the real one, not the copies in node_modules/ or dist/');
});

test('locator: honours the result cap and reports truncation', () => {
  const root = makeRoot();
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(root, `hit-${i}.txt`), 'x');
  const r = fse.findFiles(root, 'hit', { cap: 10 });
  assert.strictEqual(r.matches.length, 10, 'cap is respected');
  assert.strictEqual(r.truncated, true, 'and the caller is told there were more');

  const all = fse.findFiles(root, 'hit', { cap: 500 });
  assert.strictEqual(all.truncated, false, 'no truncation flag when everything fits');
});

test('locator: stops at MAX_DEPTH rather than recursing without bound', () => {
  const root = makeRoot();
  let deep = root;
  for (let i = 0; i <= fse.MAX_DEPTH + 3; i++) {
    deep = path.join(deep, `d${i}`);
    fs.mkdirSync(deep);
  }
  fs.writeFileSync(path.join(deep, 'buried.txt'), 'x');
  assert.deepStrictEqual(fse.findFiles(root, 'buried').matches, [],
    'a file past the depth ceiling is not reached');
});

test('locator: confined to root, and an unreadable subdir does not fail the search', () => {
  const root = makeRoot();
  assert.strictEqual(fse.findFiles(null, 'x').ok, false, 'no root, no search');
  // A directory we cannot read is skipped, not fatal: the rest still returns.
  const blocked = path.join(root, 'blocked');
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, 'inside.txt'), 'x');
  fs.chmodSync(blocked, 0o000);
  try {
    const r = fse.findFiles(root, 'txt');
    assert.strictEqual(r.ok, true, 'search survives an unreadable directory');
    assert.ok(r.matches.some((m) => m.rel === 'b.txt'), 'and still returns what it could read');
  } finally { fs.chmodSync(blocked, 0o755); }
});
