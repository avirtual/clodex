'use strict';
// peer-url-seam.test.js — F001, the HIGH one. A peer URL crosses two modules
// that never reference each other:
//
//   peer-deploy.js  classifyPeerDest   ACCEPTS the destination the operator typed
//   peer-client.js  dialOptions        DIALS it
//
// Both halves were tested, in different files, and both were green. The
// contract BETWEEN them was owned by nothing, and it was broken: acceptance
// welcomed `https://` (peer-import.js:59, peer-deploy.js:214, pinned at
// test/peer-deploy.test.js:277) while the dial used `http.request` with
// `port: u.port || 80` unconditionally — so an operator who configured an https
// peer got a plaintext socket carrying `Authorization: Bearer <token>` in the
// clear, on every control request AND on the SSE stream.
//
// So this file is the SEAM, not a second dial test: every URL below is driven
// through BOTH halves, and the assertion is that they agree about the scheme.
// Fixing the dial without this test leaves the next fork free to re-diverge —
// which is exactly how it diverged the first time, given cli/src/client.js:105
// has always selected the module off `u.protocol` correctly.

const test = require('node:test');
const assert = require('node:assert');

const { classifyPeerDest } = require('../peer-deploy');
const { dialOptions } = require('../peer-client');

// [ typed destination, accepted as a url?, dialled over TLS?, expected port ]
const CORPUS = [
  ['https://box.example.com:8080/x', true, true, 8080],
  ['https://box.example.com',        true, true, 443],
  ['https://127.0.0.1',              true, true, 443],
  // The classifier matches the scheme case-insensitively and passes the raw
  // string through untouched (peer-deploy.js:214, pinned at
  // test/peer-deploy.test.js:279), so the dial must not be case-sensitive
  // either — a scheme it lowercases and one it does not would be two rules.
  ['HTTPS://host',                   true, true, 443],
  ['http://host:7900',               true, false, 7900],
  ['http://host',                    true, false, 80],
  ['HTTP://host',                    true, false, 80],
];

test('accept and dial agree about the scheme for every peer URL', () => {
  for (const [raw, isUrl, secure, port] of CORPUS) {
    const c = classifyPeerDest(raw);
    assert.equal(c.kind, isUrl ? 'url' : c.kind,
      `${raw}: classifyPeerDest should accept this as a url, got ${JSON.stringify(c)}`);
    // The url the classifier hands on is what the peer is stored with and what
    // peer-wiring.js:199 forwards verbatim to the connection — so dial exactly
    // that string, not the raw one, or the seam is not the real one.
    const d = dialOptions(c.url.replace(/\/+$/, ''), '/api/hello');
    assert.equal(d.secure, secure,
      `${raw}: accepted as ${secure ? 'https' : 'http'} but dialled as `
      + `${d.secure ? 'https' : 'http'} — a scheme accepted and not dialled is `
      + 'the bearer token in the clear (F001)');
    assert.equal(d.port, port, `${raw}: wrong port`);
  }
});

// The default-port half on its own, because it was a SECOND way to reach
// cleartext: `u.port || 80` sent a scheme-only https URL to port 80 even if the
// module had been selected correctly.
test('a scheme-only URL takes its scheme default port, not always 80', () => {
  assert.equal(dialOptions('https://box.example.com', '/api/hello').port, 443);
  assert.equal(dialOptions('http://box.example.com', '/api/hello').port, 80);
});

test('dialOptions carries the path and query through unchanged', () => {
  const d = dialOptions('https://box.example.com:8443', '/api/attach/x?since=7');
  assert.deepEqual(d, {
    secure: true, hostname: 'box.example.com', port: 8443,
    path: '/api/attach/x?since=7',
  });
});

// A base URL with a path prefix (the classifier accepts one — the pinned case
// is `https://box.example.com:8080/x`) must keep that prefix ahead of the API
// path, and must not lose TLS on the way.
test('a base URL with a path prefix keeps both the prefix and the scheme', () => {
  const d = dialOptions('https://box.example.com:8080/x', '/api/hello');
  assert.equal(d.secure, true);
  assert.equal(d.port, 8080);
  assert.equal(d.path, '/x/api/hello');
});

// PeerConnection builds its socket pools from the base URL's scheme, and Node
// refuses an http.Agent to https.request (ERR_INVALID_PROTOCOL). A pool built
// for the wrong scheme is therefore not a slow leak — it is a peer that cannot
// connect at all — so pin that the pools follow the URL.
test('the connection builds TLS socket pools for an https peer', () => {
  const { PeerConnection } = require('../peer-client');
  const mk = (url) => new PeerConnection({
    id: 'p1', label: 'p', url, token: 't', emit: () => {},
  });
  const secure = mk('https://box.example.com');
  assert.equal(secure._reqAgent.protocol, 'https:');
  assert.equal(secure._sseAgent.protocol, 'https:');
  const plain = mk('http://box.example.com');
  assert.equal(plain._reqAgent.protocol, 'http:');
  assert.equal(plain._sseAgent.protocol, 'http:');
  for (const c of [secure, plain]) { c._reqAgent.destroy(); c._sseAgent.destroy(); }
});
