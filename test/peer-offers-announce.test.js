'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { RemoteServer } = require('../remote');
const { PeerConnection } = require('../peer-client');
const { offerCallbacks } = require('../remote-wiring');
const { offerPeerCallbacks } = require('../peer-wiring');
const { createOfferDirectory } = require('../offer-directory');

const TOKEN = 'operator-token-announce-1';

const DIALED_FACTS = { os: 'linux', arch: 'x64', cpus: 8, memMb: 16384, runtime: { platforms: ['linux/amd64'] } };
const DIALER_FACTS = { os: 'darwin', arch: 'arm64', cpus: 10, memMb: 32768, runtime: null };
const offerFor = (names, boxes) => ({
  scope: 'discovery', enabled: true, boxes, availability: 'always', peers: names.map((name) => ({ name })),
});
const entry = (boxes, facts) => ({ scope: 'discovery', boxes, open: true, kinds: ['container'], facts });

function waitFor(pred, what, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = pred();
      if (hit) return resolve(hit);
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

async function startDialed(t, { offer }) {
  const state = { offer, factsCalls: 0, received: 0 };
  const offerDirectory = createOfferDirectory();
  const cb = offerCallbacks({
    getBoxOffer: () => state.offer,
    getOfferFacts: () => { state.factsCalls++; return DIALED_FACTS; },
    offerDirectory,
  });
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: '/nonexistent', hostLabel: 'murmur', version: '9.9.9',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    token: TOKEN, suiteRunner: null,
    ...cb,
    receiveOffers: (msg) => { state.received++; return cb.receiveOffers(msg); },
  });
  await server.start();
  t.after(() => server.stop());
  return { port: server.port, state, offerDirectory };
}

function dial(t, port, { offer = null, fakeCallbacks = null } = {}) {
  const state = { offer, factsCalls: 0, seen: 0, computed: 0 };
  const offerDirectory = createOfferDirectory();
  const cb = fakeCallbacks || offerPeerCallbacks({
    getBoxOffer: () => state.offer,
    getOfferFacts: () => { state.factsCalls++; return DIALER_FACTS; },
    offerDirectory,
  });
  const conn = new PeerConnection({
    id: 'p1', label: 'murmur', url: `http://127.0.0.1:${port}`, token: TOKEN, emit: () => {},
    selfLabel: 'laptop', helloIntervalMs: 600000,
    computeOffers: (...a) => { state.computed++; return cb.computeOffers(...a); },
    onOffers: (...a) => { state.seen++; return cb.onOffers(...a); },
  });
  t.after(() => conn.stop());
  const tick = () => { clearTimeout(conn._helloTimer); conn._helloLoop(); };
  return { conn, state, offerDirectory, tick };
}

const withoutHandle = (rows) => rows.map(({ route, at, ...rest }) => {
  assert.ok(typeof route === 'string' && route.length > 0, 'row has a route handle');
  assert.ok(Number.isFinite(at) && at > 0, 'row has a timestamp');
  return rest;
});

test('two nodes over the loopback wire see each other\'s offers whichever one dialed', async (t) => {
  const dialed = await startDialed(t, { offer: offerFor(['laptop'], 3) });
  const dialer = dial(t, dialed.port, { offer: offerFor(['murmur'], 2) });
  dialer.tick();
  await waitFor(() => dialed.offerDirectory.list().length === 1 && dialer.offerDirectory.list().length === 1, 'both rows');
  assert.deepStrictEqual(withoutHandle(dialed.offerDirectory.list()), [
    { provenance: 'announce', name: 'laptop', offer: entry(2, DIALER_FACTS) },
  ]);
  assert.deepStrictEqual(withoutHandle(dialer.offerDirectory.list()), [
    { provenance: 'hello', name: 'murmur', offer: entry(3, DIALED_FACTS) },
  ]);
});

test('an offer that does not name the peer makes no row on either side and probes no facts', async (t) => {
  const dialed = await startDialed(t, { offer: offerFor(['someone'], 3) });
  const dialer = dial(t, dialed.port, { offer: offerFor(['someone'], 2) });
  dialer.tick();
  await waitFor(() => dialed.state.received === 1 && dialer.state.seen === 1, 'the announce and the hello ingest');
  assert.strictEqual(dialer.state.computed, 1, 'ENTER: the dialer built its announce');
  assert.deepStrictEqual(dialed.offerDirectory.list(), []);
  assert.deepStrictEqual(dialer.offerDirectory.list(), []);
  assert.strictEqual(dialer.state.factsCalls, 0, 'the dialer probed facts for an unnamed peer');
  assert.strictEqual(dialed.state.factsCalls, 0, 'the dialed node probed facts for an unnamed peer');
});

test('withdrawing the offer on the dialer clears its row on the dialed node at the next hello', async (t) => {
  const dialed = await startDialed(t, { offer: null });
  const dialer = dial(t, dialed.port, { offer: offerFor(['murmur'], 2) });
  dialer.tick();
  await waitFor(() => dialed.offerDirectory.list().length === 1, 'the announced row');
  assert.deepStrictEqual(withoutHandle(dialed.offerDirectory.list()).map((r) => r.name), ['laptop']);
  dialer.state.offer = null;
  dialer.tick();
  await waitFor(() => dialed.state.received === 2, 'the withdrawal');
  assert.deepStrictEqual(dialed.offerDirectory.list(), []);
});

function startFake(t, hello) {
  const seen = { hellos: [], offerPosts: 0 };
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    res.setHeader('content-type', 'application/json');
    if (p === '/api/peer/hello') { seen.hellos.push(req.url); return res.end(JSON.stringify(hello)); }
    if (p === '/api/peer/offers') seen.offerPosts++;
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.closeAllConnections(); server.close(); });
    resolve({ port: server.address().port, seen });
  }));
}

const counting = () => ({ computeOffers: () => entry(2, DIALER_FACTS), onOffers: () => {} });

test('a far side without the offers cap receives no announce and no ingest', async (t) => {
  const fake = await startFake(t, { ok: true, app: 'clodex', host: 'old', version: '1.0.0', caps: ['resources'] });
  const dialer = dial(t, fake.port, { fakeCallbacks: counting() });
  dialer.tick();
  await waitFor(() => dialer.conn.online, 'the hello');
  dialer.tick();
  await waitFor(() => fake.seen.hellos.length === 2, 'the second hello');
  assert.deepStrictEqual(fake.seen.hellos, ['/api/peer/hello?origin=laptop', '/api/peer/hello?origin=laptop']);
  assert.deepStrictEqual([fake.seen.offerPosts, dialer.state.computed, dialer.state.seen], [0, 0, 0]);
});

test('a suite-scoped connection sends no announce even when the far side claims the cap', async (t) => {
  const fake = await startFake(t, {
    ok: true, app: 'clodex', host: 'runner', version: '1.0.0', scope: 'suite', caps: ['offers'],
    offers: { own: entry(3, DIALED_FACTS) },
  });
  const dialer = dial(t, fake.port, { fakeCallbacks: counting() });
  dialer.tick();
  await waitFor(() => dialer.conn.online, 'the scoped hello');
  assert.strictEqual(dialer.conn.status().scope, 'suite', 'ENTER: the connection is suite-scoped');
  dialer.tick();
  await waitFor(() => fake.seen.hellos.length === 2, 'the second hello');
  assert.deepStrictEqual([fake.seen.offerPosts, dialer.state.computed, dialer.state.seen], [0, 0, 0]);
});

test('identityChanged in _helloLoop does not reference offers', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'peer-client.js'), 'utf8');
  const loop = src.indexOf('  _helloLoop() {');
  const start = src.indexOf('const identityChanged =', loop);
  assert.ok(loop > 0 && start > loop, 'ENTER: _helloLoop computes identityChanged');
  const expr = src.slice(start, src.indexOf(';', start));
  assert.ok(expr.includes('prev.caps'), 'ENTER: the slice is the identity comparison');
  assert.ok(!/offer/i.test(expr), 'identityChanged references offers');
});
