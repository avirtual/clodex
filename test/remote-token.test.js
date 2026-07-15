// Run: node --test
// Covers the GUI-managed remote-wire token (remote-token.js): file-backed
// read/write/clear in <userData>/remote.env and the env-wins precedence the
// wire gate (remote-wiring's syncRemoteServer) resolves against.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TOKEN_KEY, remoteEnvPath,
  readRemoteEnvToken, writeRemoteEnvToken, hasRemoteEnvToken, resolveRemoteToken,
} = require('../remote-token');

function tmpUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotetok-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('remoteEnvPath: <userData>/remote.env', () => {
  assert.strictEqual(remoteEnvPath('/data'), path.join('/data', 'remote.env'));
});

test('absent file → null / hasToken false', () => {
  const { dir, cleanup } = tmpUserData();
  try {
    assert.strictEqual(readRemoteEnvToken(dir), null);
    assert.strictEqual(hasRemoteEnvToken(dir), false);
  } finally { cleanup(); }
});

test('write sets the token (0600) and reads back; the file uses the canonical key', () => {
  const { dir, cleanup } = tmpUserData();
  try {
    const has = writeRemoteEnvToken(dir, '  s3cret-token  ');
    assert.strictEqual(has, true, 'returns hasToken=true');
    assert.strictEqual(readRemoteEnvToken(dir), 's3cret-token', 'trimmed on write');
    assert.strictEqual(hasRemoteEnvToken(dir), true);
    const file = remoteEnvPath(dir);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'mode 0600');
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`^${TOKEN_KEY}=s3cret-token\\n$`));
  } finally { cleanup(); }
});

test('clear (empty/null) removes the token and deletes the single-key file', () => {
  const { dir, cleanup } = tmpUserData();
  try {
    writeRemoteEnvToken(dir, 'x');
    assert.strictEqual(writeRemoteEnvToken(dir, ''), false, 'empty → hasToken false');
    assert.strictEqual(readRemoteEnvToken(dir), null);
    assert.ok(!fs.existsSync(remoteEnvPath(dir)), 'file deleted when no keys remain');
    // Clearing an already-clear token is a no-op, not a throw.
    assert.strictEqual(writeRemoteEnvToken(dir, null), false);
  } finally { cleanup(); }
});

test('a whitespace-only token clears rather than storing blank', () => {
  const { dir, cleanup } = tmpUserData();
  try {
    writeRemoteEnvToken(dir, 'real');
    assert.strictEqual(writeRemoteEnvToken(dir, '   '), false);
    assert.strictEqual(readRemoteEnvToken(dir), null);
  } finally { cleanup(); }
});

test('resolveRemoteToken: env var WINS over the file token', () => {
  assert.strictEqual(resolveRemoteToken('env-tok', 'file-tok'), 'env-tok');
});

test('resolveRemoteToken: file token used when no env var', () => {
  assert.strictEqual(resolveRemoteToken(undefined, 'file-tok'), 'file-tok');
  assert.strictEqual(resolveRemoteToken('', 'file-tok'), 'file-tok');
});

test('resolveRemoteToken: null when neither is set', () => {
  assert.strictEqual(resolveRemoteToken(undefined, null), null);
  assert.strictEqual(resolveRemoteToken('', ''), null);
});
