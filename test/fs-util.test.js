// Run: node --test
// Covers the fs primitives: ensureDir (recursive + mode), atomicWriteFileSync
// (tmp-then-rename durability, no torn/leftover temp files), readJsonSafe
// (forgiving parse).
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { ensureDir, atomicWriteFileSync, readJsonSafe } = require('../fs-util');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fs-util-'));
}

test('ensureDir: creates nested dirs, idempotent', () => {
  const base = tmpDir();
  const nested = path.join(base, 'a', 'b', 'c');
  ensureDir(nested);
  assert.ok(fs.statSync(nested).isDirectory());
  ensureDir(nested); // second call must not throw
  fs.rmSync(base, { recursive: true, force: true });
});

test('atomicWriteFileSync: writes content and leaves no temp file behind', () => {
  const base = tmpDir();
  const target = path.join(base, 'store.json');
  atomicWriteFileSync(target, '{"ok":true}');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"ok":true}');
  // no leftover .tmp files in the directory
  const leftovers = fs.readdirSync(base).filter(f => f.includes('.tmp.'));
  assert.deepStrictEqual(leftovers, []);
  fs.rmSync(base, { recursive: true, force: true });
});

test('atomicWriteFileSync: overwrites atomically (previous content fully replaced)', () => {
  const base = tmpDir();
  const target = path.join(base, 'f.txt');
  atomicWriteFileSync(target, 'first');
  atomicWriteFileSync(target, 'second');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'second');
  fs.rmSync(base, { recursive: true, force: true });
});

test('atomicWriteFileSync: creates the parent directory if missing', () => {
  const base = tmpDir();
  const target = path.join(base, 'sub', 'deep', 'f.txt');
  atomicWriteFileSync(target, 'hi');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'hi');
  fs.rmSync(base, { recursive: true, force: true });
});

test('readJsonSafe: parses valid JSON, returns null on garbage or missing', () => {
  const base = tmpDir();
  const good = path.join(base, 'good.json');
  fs.writeFileSync(good, '{"a":1}');
  assert.deepStrictEqual(readJsonSafe(good), { a: 1 });
  const bad = path.join(base, 'bad.json');
  fs.writeFileSync(bad, 'not json');
  assert.strictEqual(readJsonSafe(bad), null);
  assert.strictEqual(readJsonSafe(path.join(base, 'missing.json')), null);
  fs.rmSync(base, { recursive: true, force: true });
});
