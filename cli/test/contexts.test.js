'use strict';
// contexts.test.js — the contexts store: parse/validate, 0600 create + mode
// warn, and the file<env<flags resolution precedence (incl. url-switches-to-
// direct and independent token overlay).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../src/contexts');

function tmpFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  return path.join(d, 'contexts.json');
}

test('load of an absent file returns an empty store', () => {
  const store = C.load(path.join(os.tmpdir(), 'does-not-exist-xyz', 'c.json'));
  assert.deepStrictEqual(store, { current: null, contexts: {} });
});

test('save writes 0600 and round-trips', () => {
  const f = tmpFile();
  C.save({ current: 'home', contexts: { home: { url: 'http://h', token: 't' } } }, f);
  const mode = fs.statSync(f).mode & 0o777;
  assert.strictEqual(mode, 0o600);
  const back = C.load(f, { warn: () => {} });
  assert.strictEqual(back.current, 'home');
  assert.strictEqual(back.contexts.home.url, 'http://h');
});

test('loose mode triggers a warning', () => {
  const f = tmpFile();
  C.save({ current: null, contexts: {} }, f);
  fs.chmodSync(f, 0o644);
  let warned = '';
  C.load(f, { warn: (m) => { warned = m; } });
  assert.match(warned, /group\/world-readable/);
});

test('invalid JSON is a usage error', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ not json');
  assert.throws(() => C.load(f, { warn: () => {} }), /not valid JSON/);
});

test('validateEntry: exactly one transport, {port} required for tunnel', () => {
  assert.throws(() => C.validateEntry({}), /needs one transport/);
  assert.throws(() => C.validateEntry({ url: 'http://h', ssh: 'x' }), /conflicting transports/);
  assert.throws(() => C.validateEntry({ tunnel: ['kubectl'] }), /\{port\} placeholder/);
  assert.throws(() => C.validateEntry({ tunnel: [] }), /non-empty argv/);
  C.validateEntry({ url: 'http://h' });
  C.validateEntry({ tunnel: ['x', '{port}:7900'] });
});

const STORE = { current: 'home', contexts: {
  home: { url: 'http://127.0.0.1:7900', token: 'homeTok' },
  work: { ssh: 'user@box', remotePort: 7900, token: 'workTok' },
} };

test('resolve: current context, no env/flags', () => {
  const r = C.resolve(STORE, { env: {} });
  assert.strictEqual(r.url, 'http://127.0.0.1:7900');
  assert.strictEqual(r.token, 'homeTok');
  assert.strictEqual(r.name, 'home');
});

test('resolve: --ctx overrides current', () => {
  const r = C.resolve(STORE, { ctxName: 'work', env: {} });
  assert.strictEqual(r.ssh, 'user@box');
  assert.strictEqual(r.token, 'workTok');
});

test('resolve: unknown --ctx is a usage error', () => {
  assert.throws(() => C.resolve(STORE, { ctxName: 'nope', env: {} }), /no such context/);
});

test('resolve: env URL switches transport to direct, drops file ssh', () => {
  const r = C.resolve(STORE, { ctxName: 'work', env: { CLODEX_URL: 'http://env-host:1' } });
  assert.strictEqual(r.url, 'http://env-host:1');
  assert.strictEqual(r.ssh, undefined);
  // token still comes from the file entry? No — env URL replaced the entry.
});

test('resolve: env token overlays without changing transport', () => {
  const r = C.resolve(STORE, { env: { CLODEX_TOKEN: 'envTok' } });
  assert.strictEqual(r.url, 'http://127.0.0.1:7900');
  assert.strictEqual(r.token, 'envTok');
});

test('resolve: flags beat env and file; --url forces direct', () => {
  const r = C.resolve(STORE, {
    env: { CLODEX_URL: 'http://env', CLODEX_TOKEN: 'envTok' },
    flags: { url: 'http://flag', token: 'flagTok' },
  });
  assert.strictEqual(r.url, 'http://flag');
  assert.strictEqual(r.token, 'flagTok');
  assert.strictEqual(r.name, '(flags)');
});

test('resolve: no context anywhere is a usage error', () => {
  assert.throws(() => C.resolve({ current: null, contexts: {} }, { env: {} }), /no context selected/);
});

test('resolve: --url and --ssh together is rejected, not silently ordered', () => {
  assert.throws(
    () => C.resolve(STORE, { env: {}, flags: { url: 'http://flag', ssh: 'user@box' } }),
    /either --url or --ssh, not both/);
});
