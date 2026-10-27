'use strict';
// Unit tests for auth-token.js (remote-auth-plan.md [internal design doc, not in this repo] §1) — the shared
// operator-token gate used by web-host.js and remote.js. Pure leaf: token in,
// { check, fromReq, configured } out. These pin the precedence order and the
// constant-time / no-token semantics both hosts rely on.

const test = require('node:test');
const assert = require('node:assert');
const { makeTokenGate } = require('../auth-token');

// A minimal Node-http-ish request double for fromReq.
function req({ url = '/', headers = {} } = {}) {
  return { url, headers };
}

// ── check() ──────────────────────────────────────────────────────────────────

test('check: no token configured → always true (caller layers its own trust)', () => {
  for (const t of [null, undefined, '']) {
    const { check, configured } = makeTokenGate(t);
    assert.strictEqual(configured, false);
    assert.strictEqual(check('anything'), true);
    assert.strictEqual(check(null), true);
    assert.strictEqual(check(undefined), true);
  }
});

test('check: token configured → exact match passes, everything else fails', () => {
  const { check, configured } = makeTokenGate('s3cret');
  assert.strictEqual(configured, true);
  assert.strictEqual(check('s3cret'), true);
  // EQUAL LENGTH, every byte wrong. Without this row the whole test is
  // vacuous: 'wrong' is 5 bytes against a 6-byte secret, so every negative
  // case below differs in LENGTH, and `p.length === secret.length` with no
  // byte compare at all passes all of them — while accepting any same-length
  // token an attacker sends. This row is the only thing asserting bytes.
  assert.strictEqual(check('AAAAAA'), false);
  assert.strictEqual(check('wrong'), false);      // shorter (5 vs 6)
  assert.strictEqual(check('s3cre'), false);      // shorter
  assert.strictEqual(check('s3cret!'), false);    // longer
  assert.strictEqual(check(''), false);
  assert.strictEqual(check(null), false);
  assert.strictEqual(check(undefined), false);
});

test('check: a length mismatch is handled without throwing (no unequal-length timingSafeEqual)', () => {
  const { check } = makeTokenGate('abcdef');
  // If the length guard were missing, crypto.timingSafeEqual throws on unequal
  // lengths — assert it simply returns false instead.
  assert.doesNotThrow(() => check('a'));
  assert.strictEqual(check('a'), false);
});

// ── fromReq() ────────────────────────────────────────────────────────────────

test('fromReq: ?token= query wins first', () => {
  const { fromReq } = makeTokenGate('x');
  assert.strictEqual(fromReq(req({ url: '/?token=fromquery' })), 'fromquery');
});

test('fromReq: Authorization: Bearer when no query token', () => {
  const { fromReq } = makeTokenGate('x');
  assert.strictEqual(fromReq(req({ headers: { authorization: 'Bearer frombearer' } })), 'frombearer');
  // Case-insensitive scheme.
  assert.strictEqual(fromReq(req({ headers: { authorization: 'bearer lower' } })), 'lower');
});

test('fromReq: clodex_remote_token cookie is the last resort', () => {
  const { fromReq } = makeTokenGate('x');
  assert.strictEqual(fromReq(req({ headers: { cookie: 'a=1; clodex_remote_token=fromcookie; b=2' } })), 'fromcookie');
  // URL-encoded cookie value is decoded.
  assert.strictEqual(fromReq(req({ headers: { cookie: 'clodex_remote_token=a%20b' } })), 'a b');
});

test('fromReq: precedence is query → bearer → cookie', () => {
  const { fromReq } = makeTokenGate('x');
  const all = req({
    url: '/?token=Q',
    headers: { authorization: 'Bearer B', cookie: 'clodex_remote_token=C' },
  });
  assert.strictEqual(fromReq(all), 'Q');
  const bearerAndCookie = req({ headers: { authorization: 'Bearer B', cookie: 'clodex_remote_token=C' } });
  assert.strictEqual(fromReq(bearerAndCookie), 'B');
});

test('fromReq: none present → null', () => {
  const { fromReq } = makeTokenGate('x');
  assert.strictEqual(fromReq(req()), null);
  assert.strictEqual(fromReq(req({ headers: { authorization: 'Basic zzz', cookie: 'other=1' } })), null);
});

test('fromReq: a malformed url still falls through to header/cookie', () => {
  const { fromReq } = makeTokenGate('x');
  // Not really reachable via Node http (url is always at least '/'), but the
  // try/catch must not swallow the header path if URL parsing ever throws.
  assert.strictEqual(fromReq({ url: 'http://[', headers: { authorization: 'Bearer B' } }), 'B');
});

test('originAllowed / originRefusal: Host must be loopback, Origin (when sent) must be this same loopback host', () => {
  const { originAllowed, originRefusal } = require('../auth-token');
  const rows = [
    { host: '127.0.0.1:7810', origin: undefined, want: null },
    { host: 'localhost:7810', origin: 'http://localhost:7810', want: null },
    { host: '127.0.0.1:7810', origin: 'http://127.0.0.1:7810', want: null },
    { host: '127.4.5.6:7900', origin: undefined, want: null },
    { host: '[::1]:7810', origin: 'http://[::1]:7810', want: null },
    { host: 'localhost', origin: 'http://localhost', want: null },
    { host: 'localhost:80', origin: 'http://localhost', want: null },
    { host: 'LOCALHOST:7810', origin: 'http://localhost:7810', want: null },
    { host: 'localhost:7810', origin: 'https://evil.example', want: 'Origin' },
    { host: 'localhost:7810', origin: 'http://localhost:3000', want: 'Origin' },
    { host: 'localhost:7810', origin: 'null', want: 'Origin' },
    { host: 'localhost:7810', origin: 'http://[', want: 'Origin' },
    { host: 'localhost:7810', origin: 'file:///etc/passwd', want: 'Origin' },
    { host: 'evil.example', origin: undefined, want: 'Host' },
    { host: 'evil.example:7810', origin: 'http://evil.example:7810', want: 'Host' },
    { host: '127.0.0.1.evil.example:7810', origin: undefined, want: 'Host' },
    { host: undefined, origin: undefined, want: 'Host' },
  ];
  for (const r of rows) {
    const headers = {};
    if (r.host !== undefined) headers.host = r.host;
    if (r.origin !== undefined) headers.origin = r.origin;
    const label = `host=${r.host} origin=${r.origin}`;
    assert.strictEqual(originRefusal({ headers }), r.want, label);
    assert.strictEqual(originAllowed({ headers }), r.want === null, label);
  }
});
