'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const {
  RemoteServer, resolveRemoteBasePath, DEFAULT_REMOTE_BASE_PATH,
} = require('../remote');

const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

function req(port, pathname) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function withServer(extra, fn) {
  const server = new RemoteServer({
    port: 0, pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    ...extra,
  });
  await server.start();
  try { return await fn(server.port); } finally { server.stop(); }
}

test('unset base path serves the live /c route byte-identically', async () => {
  await withServer({}, async (port) => {
    const api = await req(port, '/c/api/sessions');
    assert.equal(api.status, 200, '/c/api/sessions resolves');
    assert.equal(JSON.parse(api.body).ok, true);

    const bare = await req(port, '/c');
    assert.equal(bare.status, 301, 'bare /c redirects');
    assert.equal(bare.headers.location, '/c/', 'to /c/');

    const page = await req(port, '/c/');
    assert.equal(page.status, 200, '/c/ serves the viewer page');

    const unprefixed = await req(port, '/api/sessions');
    assert.equal(unprefixed.status, 200, 'the root mount still serves unprefixed');
  });
});

test('a configured prefix replaces /c rather than adding to it', async () => {
  await withServer({ basePath: '/i' }, async (port) => {
    const now = await req(port, '/i/api/sessions');
    assert.equal(now.status, 200, '/i/api/sessions resolves');

    const bare = await req(port, '/i');
    assert.equal(bare.status, 301, 'bare /i redirects');
    assert.equal(bare.headers.location, '/i/', 'to /i/');

    const old = await req(port, '/c/api/sessions');
    assert.equal(old.status, 404, '/c stops being magic once another prefix is configured');

    const unprefixed = await req(port, '/api/sessions');
    assert.equal(unprefixed.status, 200, 'the root mount is unaffected');
  });
});

test('a multi-segment prefix strips its own length, not two characters', async () => {
  await withServer({ basePath: 'i/deep/path' }, async (port) => {
    const api = await req(port, '/i/deep/path/api/sessions');
    assert.equal(api.status, 200, 'the whole prefix is stripped');

    const bare = await req(port, '/i/deep/path');
    assert.equal(bare.status, 301, 'bare multi-segment prefix redirects');
    assert.equal(bare.headers.location, '/i/deep/path/', 'to itself with a trailing slash');

    const partial = await req(port, '/i/api/sessions');
    assert.equal(partial.status, 404, 'a prefix of the prefix is not the prefix');
  });
});

test('accepted spellings all normalise to a leading slash and no trailing slash', () => {
  assert.equal(resolveRemoteBasePath('c'), '/c');
  assert.equal(resolveRemoteBasePath('/c'), '/c');
  assert.equal(resolveRemoteBasePath('/c/'), '/c');
  assert.equal(resolveRemoteBasePath('c/'), '/c');
  assert.equal(resolveRemoteBasePath('  /c/  '), '/c');
  assert.equal(resolveRemoteBasePath('i/deep/path'), '/i/deep/path');
  assert.equal(resolveRemoteBasePath('/i/deep/path/'), '/i/deep/path');
  assert.equal(resolveRemoteBasePath('phone-2.0_x~y'), '/phone-2.0_x~y');
});

test('absent or blank means unset, and unset means the default', () => {
  assert.equal(DEFAULT_REMOTE_BASE_PATH, '/c');
  assert.equal(resolveRemoteBasePath(undefined), '/c');
  assert.equal(resolveRemoteBasePath(null), '/c');
  assert.equal(resolveRemoteBasePath(''), '/c');
  assert.equal(resolveRemoteBasePath('   '), '/c');
});

const REJECTED = [
  ['..', 'a bare parent traversal'],
  ['/..', 'a rooted parent traversal'],
  ['/c/../etc', 'traversal buried mid-path'],
  ['/c/..', 'traversal at the tail'],
  ['.', 'the current-directory segment'],
  ['/c//i', 'an empty interior segment'],
  ['//', 'nothing but separators'],
  ['/', 'the root itself is not a prefix'],
  ['c\\d', 'a backslash segment separator'],
  ['\\c', 'a leading backslash'],
  ['c d', 'a space inside a segment'],
  ['c?q=1', 'a query string'],
  ['c#frag', 'a fragment'],
  ['%2e%2e', 'a percent-encoded traversal'],
  ['/c/%2e%2e/etc', 'a percent-encoded traversal mid-path'],
  ['http://evil/c', 'an absolute URL'],
  ['//evil/c', 'a protocol-relative host'],
  ['c\nd', 'an embedded newline'],
];

for (const [value, why] of REJECTED) {
  test(`rejected base path ${JSON.stringify(value)} (${why}) falls back to /c`, () => {
    const seen = [];
    assert.equal(resolveRemoteBasePath(value, (m) => seen.push(m)), '/c');
    assert.equal(seen.length, 1, 'exactly one warning for a rejected value');
    assert.match(seen[0], /CLODEX_REMOTE_BASE_PATH/, 'the warning names the variable');
  });
}

test('a rejected value is warned about once, not once per construction', () => {
  const seen = [];
  const warn = (m) => seen.push(m);
  const value = '/only-warned-once/../x';
  assert.equal(resolveRemoteBasePath(value, warn), '/c');
  assert.equal(resolveRemoteBasePath(value, warn), '/c');
  assert.equal(seen.length, 1, 'the second resolution is silent');
});

test('a rejected value leaves the server serving the default route', async () => {
  await withServer({ basePath: '/c/../etc', warn: () => {} }, async (port) => {
    const api = await req(port, '/c/api/sessions');
    assert.equal(api.status, 200, 'the live route survives a bad configuration');
    const escaped = await req(port, '/etc/api/sessions');
    assert.equal(escaped.status, 404, 'the refused value is not sanitised into an adjacent prefix');
  });
});
