// Run: node --test
// Covers fs-explorer: directory listing (dirs-first, noise-filtered), file
// read (binary/oversize/traversal guards), write (confinement + mkdir), and the
// path-safety boundary that keeps everything inside the session root.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fse = require('../fs-explorer');

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
