// Run: node --test
// Covers the shared atomic 0600 env-file primitives (env-file.js) that back both
// the sandbox's auth.env and the host's remote.env.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readEnvFile, writeEnvFile } = require('../env-file');

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-'));
  return { dir, file: path.join(dir, 'x.env'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('readEnvFile: missing file → {}', () => {
  const { file, cleanup } = tmp();
  try { assert.deepStrictEqual(readEnvFile(file), {}); } finally { cleanup(); }
});

test('write then read round-trips a multi-key set', () => {
  const { file, cleanup } = tmp();
  try {
    writeEnvFile(file, { A: 'one', B: 'two' });
    assert.deepStrictEqual(readEnvFile(file), { A: 'one', B: 'two' });
  } finally { cleanup(); }
});

test('written file is mode 0600', () => {
  const { file, cleanup } = tmp();
  try {
    writeEnvFile(file, { A: 'secret' });
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  } finally { cleanup(); }
});

test('write overwrites atomically (no leftover .tmp, new content wins)', () => {
  const { dir, file, cleanup } = tmp();
  try {
    writeEnvFile(file, { A: 'first' });
    writeEnvFile(file, { A: 'second', C: 'c' });
    assert.deepStrictEqual(readEnvFile(file), { A: 'second', C: 'c' });
    assert.ok(!fs.existsSync(`${file}.tmp`), 'temp file renamed away');
    assert.deepStrictEqual(fs.readdirSync(dir), ['x.env'], 'only the target remains');
  } finally { cleanup(); }
});

test('empty set / all-null values delete the file', () => {
  const { file, cleanup } = tmp();
  try {
    writeEnvFile(file, { A: 'x' });
    assert.ok(fs.existsSync(file));
    writeEnvFile(file, {});
    assert.ok(!fs.existsSync(file), 'empty set deletes');
    // All-null also deletes; deleting an already-absent file is a no-op (no throw).
    writeEnvFile(file, { A: null });
    assert.ok(!fs.existsSync(file));
  } finally { cleanup(); }
});

test('keys are written in sorted order (stable on-disk shape)', () => {
  const { file, cleanup } = tmp();
  try {
    writeEnvFile(file, { Z: '1', A: '2', M: '3' });
    const raw = fs.readFileSync(file, 'utf8');
    assert.strictEqual(raw, 'A=2\nM=3\nZ=1\n');
  } finally { cleanup(); }
});

test('values may contain = ; only the first splits', () => {
  const { file, cleanup } = tmp();
  try {
    writeEnvFile(file, { TOKEN: 'ab=cd=ef' });
    assert.deepStrictEqual(readEnvFile(file), { TOKEN: 'ab=cd=ef' });
  } finally { cleanup(); }
});
