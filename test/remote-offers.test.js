'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { RemoteServer } = require('../remote');
const { offerCallbacks } = require('../remote-wiring');
const { createOfferDirectory } = require('../offer-directory');

const OP_TOKEN = 'operator-token-offers-1';
const SUITE_TOKEN = 'suite-token-offers-PLANTED';

const OFFER = {
  scope: 'discovery', enabled: true, boxes: 2, availability: 'always',
  peers: [{ name: 'laptop' }, { name: 'constructor' }],
};
const FACTS = { os: 'darwin', arch: 'arm64', cpus: 10, memMb: 32768, runtime: { platforms: ['linux/arm64'] } };
const OWN = {
  scope: 'discovery', boxes: 2, open: true, kinds: ['container'],
  facts: { os: 'darwin', arch: 'arm64', cpus: 10, memMb: 32768, runtime: { platforms: ['linux/arm64'] } },
};
const ANNOUNCED = {
  scope: 'discovery', boxes: 1, open: false, kinds: ['container'],
  facts: { os: 'linux', arch: 'x64', cpus: 8, memMb: 16384, runtime: null },
};

function req(port, pathname, { method = 'GET', token = OP_TOKEN, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

async function startNode(t, { offer = OFFER, wired = true, maxRows } = {}) {
  let n = 0;
  const state = { offer, clock: 5000, factsCalls: 0 };
  const offerDirectory = createOfferDirectory({ now: () => state.clock, newRoute: () => `route-${++n}`, ...(maxRows ? { maxRows } : {}) });
  const callbacks = wired
    ? offerCallbacks({ getBoxOffer: () => state.offer, getOfferFacts: () => { state.factsCalls++; return FACTS; }, offerDirectory })
    : {};
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: '/nonexistent', hostLabel: 'murmur', version: '9.9.9',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    token: OP_TOKEN, suiteToken: SUITE_TOKEN, suiteRunner: null, ...callbacks,
  });
  await server.start();
  t.after(() => server.stop());
  return { port: server.port, state, offerDirectory };
}

const announce = (port, from, own, token = OP_TOKEN) =>
  req(port, '/api/peer/offers', { method: 'POST', token, body: JSON.stringify({ v: 1, from, own }) });

test('hello: no origin means no offers key, but the cap is advertised', async (t) => {
  const { port } = await startNode(t);
  const hello = (await req(port, '/api/peer/hello')).json;
  assert.ok(hello.caps.includes('offers'), `caps lack offers: ${hello.caps}`);
  assert.ok(!('offers' in hello));
});

test('hello: a listed origin is shown the own entry with its facts', async (t) => {
  const { port } = await startNode(t);
  const hello = (await req(port, '/api/peer/hello?origin=laptop')).json;
  assert.deepStrictEqual(hello.offers, { own: OWN });
});

test('hello: an unlisted origin is shown nothing', async (t) => {
  const { port } = await startNode(t);
  const listed = (await req(port, '/api/peer/hello?origin=laptop')).json;
  assert.ok('offers' in listed, 'ENTER: the listed name sees the offer on this node');
  const hello = (await req(port, '/api/peer/hello?origin=stranger')).json;
  assert.ok(!('offers' in hello), `an unlisted origin saw ${JSON.stringify(hello.offers)}`);
});

test('hello: a disabled offer shows nothing to a listed origin', async (t) => {
  const { port } = await startNode(t, { offer: { ...OFFER, enabled: false } });
  const hello = (await req(port, '/api/peer/hello?origin=laptop')).json;
  assert.ok(hello.caps.includes('offers'));
  assert.ok(!('offers' in hello));
});

test('callbacks absent: no cap, both routes 501, resource absent', async (t) => {
  const { port } = await startNode(t, { wired: false });
  const hello = (await req(port, '/api/peer/hello?origin=laptop')).json;
  assert.ok(!hello.caps.includes('offers'));
  assert.ok(!('offers' in hello));
  assert.strictEqual((await announce(port, 'laptop', ANNOUNCED)).status, 501);
  assert.strictEqual((await req(port, '/api/offers')).status, 501);
  const names = (await req(port, '/api/resources')).json.resources.map((r) => r.name);
  assert.ok(names.includes('sessions'), 'ENTER: the resource document lists the node');
  assert.ok(!names.includes('offers'));
});

test('a scoped hello keeps its documented shape with a listed origin', async (t) => {
  const { port } = await startNode(t);
  const op = (await req(port, '/api/peer/hello')).json;
  const scoped = (await req(port, '/api/peer/hello?origin=laptop', { token: SUITE_TOKEN })).json;
  assert.deepStrictEqual(scoped, { ok: true, app: 'clodex', host: 'murmur', version: '9.9.9', bootId: op.bootId, caps: [], scope: 'suite' });
});

test('a suite token gets 403 on both offer routes', async (t) => {
  const { port, offerDirectory } = await startNode(t);
  assert.strictEqual((await req(port, '/api/offers')).status, 200, 'ENTER: the operator token reaches the route');
  assert.strictEqual((await announce(port, 'laptop', ANNOUNCED, SUITE_TOKEN)).status, 403);
  assert.strictEqual((await req(port, '/api/offers', { token: SUITE_TOKEN })).status, 403);
  assert.deepStrictEqual(offerDirectory.list(), []);
});

test('POST /api/peer/offers stores a valid own as an announce row with a route handle', async (t) => {
  const { port, offerDirectory } = await startNode(t);
  const r = await announce(port, 'laptop', ANNOUNCED);
  assert.deepStrictEqual([r.status, r.json], [200, { ok: true }]);
  assert.deepStrictEqual(offerDirectory.list(), [
    { route: 'route-1', provenance: 'announce', name: 'laptop', offer: ANNOUNCED, at: 5000 },
  ]);
});

test('POST /api/peer/offers refuses an own with an extra key or scope run whole', async (t) => {
  const { port, offerDirectory } = await startNode(t);
  assert.strictEqual((await announce(port, 'laptop', { ...ANNOUNCED, host: 'laptop.local' })).status, 400);
  assert.strictEqual((await announce(port, 'laptop', { ...ANNOUNCED, scope: 'run' })).status, 400);
  assert.strictEqual((await announce(port, 'bad name', ANNOUNCED)).status, 400);
  const badVersion = await req(port, '/api/peer/offers', { method: 'POST', body: JSON.stringify({ v: 2, from: 'laptop', own: ANNOUNCED }) });
  assert.strictEqual(badVersion.status, 400);
  assert.deepStrictEqual(offerDirectory.list(), []);
});

test('POST /api/peer/offers stores relayed nothing and an empty own clears the row', async (t) => {
  const { port, offerDirectory } = await startNode(t);
  const body = JSON.stringify({ v: 1, from: 'laptop', own: ANNOUNCED, relayed: [ANNOUNCED] });
  assert.strictEqual((await req(port, '/api/peer/offers', { method: 'POST', body })).status, 200);
  assert.strictEqual(offerDirectory.list().length, 1);
  assert.strictEqual((await announce(port, 'laptop', null)).status, 200);
  assert.deepStrictEqual(offerDirectory.list(), []);
});

test('a dialer named constructor is stored and read back', async (t) => {
  const { port } = await startNode(t);
  assert.strictEqual((await announce(port, 'constructor', ANNOUNCED)).status, 200);
  const doc = (await req(port, '/api/offers')).json;
  assert.deepStrictEqual(doc.offers, [
    { route: 'route-1', provenance: 'announce', name: 'constructor', offer: ANNOUNCED, at: 5000 },
  ]);
});

test('GET /api/offers returns own plus the stored rows; equal facts from two routes stay two rows', async (t) => {
  const { port } = await startNode(t);
  await announce(port, 'laptop', ANNOUNCED);
  await announce(port, 'laptop-vpn', ANNOUNCED);
  const r = await req(port, '/api/offers');
  assert.deepStrictEqual(r.json, {
    ok: true,
    own: OWN,
    offers: [
      { route: 'route-1', provenance: 'announce', name: 'laptop', offer: ANNOUNCED, at: 5000 },
      { route: 'route-2', provenance: 'announce', name: 'laptop-vpn', offer: ANNOUNCED, at: 5000 },
    ],
  });
});

test('suite code never reads the box offer or the offers directory', () => {
  const root = path.join(__dirname, '..');
  const banned = /boxOffer|offer-directory|offerDirectory|_offerFor|_receiveOffers|_listOffers/;
  for (const file of ['suite-runner.js', 'suite-client.js', 'suite-dispatch.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(src.length > 1000, `ENTER: ${file} was read`);
    assert.ok(!banned.test(src), `${file} references the box offer`);
  }
  const remote = fs.readFileSync(path.join(root, 'remote.js'), 'utf8');
  const start = remote.indexOf('  _handleSuite(');
  assert.ok(start > 0, 'ENTER: remote.js has its suite handler');
  const end = remote.indexOf('\n  }\n', start);
  const suite = remote.slice(start, end);
  assert.ok(suite.includes('suiteDispatch('), 'ENTER: the slice is the suite handler');
  assert.ok(!banned.test(suite), 'remote.js suite routes reference the box offer');
});

test('facts are probed only for an enabled offer and a listed origin', async (t) => {
  const { port, state } = await startNode(t);
  await req(port, '/api/peer/hello?origin=stranger');
  await req(port, '/api/peer/hello');
  assert.strictEqual(state.factsCalls, 0, 'an unlisted or absent origin probed facts');
  const listed = (await req(port, '/api/peer/hello?origin=laptop')).json;
  assert.deepStrictEqual(listed.offers, { own: OWN });
  assert.strictEqual(state.factsCalls, 1);
  state.offer = { ...OFFER, enabled: false };
  await req(port, '/api/peer/hello?origin=laptop');
  assert.strictEqual(state.factsCalls, 1, 'a disabled offer probed facts');
  state.offer = null;
  const doc = (await req(port, '/api/offers')).json;
  assert.deepStrictEqual([doc.ok, doc.own], [true, null]);
  assert.strictEqual(state.factsCalls, 1, 'GET /api/offers with no offer probed facts');
});

test('GET /api/offers answers 500 when the offer source throws', async (t) => {
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: '/nonexistent',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    token: OP_TOKEN, listOffers: () => { throw new Error('facts exploded'); },
  });
  await server.start();
  t.after(() => server.stop());
  const r = await req(server.port, '/api/offers');
  assert.deepStrictEqual([r.status, r.json], [500, { ok: false, error: 'facts exploded' }]);
});

test('POST /api/peer/offers answers 503 when the directory is full', async (t) => {
  const { port, offerDirectory } = await startNode(t, { maxRows: 1 });
  const first = await announce(port, 'laptop', ANNOUNCED);
  assert.deepStrictEqual([first.status, first.json], [200, { ok: true }]);
  const second = await announce(port, 'constructor', ANNOUNCED);
  assert.deepStrictEqual([second.status, second.json], [503, { ok: false, error: 'offers directory full' }]);
  assert.deepStrictEqual(offerDirectory.list().map((r) => r.name), ['laptop']);
});
