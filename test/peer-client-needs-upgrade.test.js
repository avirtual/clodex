'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { PeerConnection } = require('../peer-client');
const { serveDialect } = require('./lib/peer-dialect');

function box(dialect) {
  const state = { attaches: 0, resourceFetches: 0, helloTicks: 0, streams: [] };
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/api/peer/hello') state.helloTicks++;
    if (p === '/api/resources') state.resourceFetches++;
    if (serveDialect(p, res, dialect)) return;
    if (p === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, sessions: [] }));
    }
    if (/^\/api\/sessions\/[^/]+\/attach(\?|$)/.test(p)) {
      state.attaches++;
      if (dialect !== 'current') return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      return state.streams.push(res);
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      return state.streams.push(res);
    }
    res.writeHead(404).end();
  });
  return { server, state };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

function waitFor(label, pred, ms = 5000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v; try { v = pred(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error(`timed out waiting for: ${label}`));
      setTimeout(tick, 15);
    };
    tick();
  });
}

function connect(port, helloIntervalMs = 10000) {
  return new PeerConnection({
    id: 'box', label: 'boxy', url: `http://127.0.0.1:${port}`, emit: () => {}, helloIntervalMs,
  });
}

function teardown(conn, server, state) {
  conn.stop();
  for (const s of state.streams) { try { s.end(); } catch {} }
  try { server.closeAllConnections(); } catch {}
  server.close();
}

test('needsUpgrade is false against a node whose document carries sessions/attach', async () => {
  const { server, state } = box('current');
  const port = await listen(server);
  const conn = connect(port);
  conn.start();
  try {
    await waitFor('the resources document to be fetched', () => state.resourceFetches >= 1);
    await waitFor('needsUpgrade to settle false', () => conn.online && conn.needsUpgrade === false);
    assert.strictEqual(conn.status().needsUpgrade, false, 'status() carries the flag');
  } finally { teardown(conn, server, state); }
});

test('needsUpgrade is true against a node whose document lacks sessions/attach', async () => {
  const { server, state } = box('old');
  const port = await listen(server);
  const conn = connect(port);
  conn.start();
  try {
    await waitFor('needsUpgrade to go true', () => conn.needsUpgrade === true);
    assert.strictEqual(conn.online, true, 'the node is ONLINE — needsUpgrade is not an offline state');
    assert.strictEqual(conn.status().needsUpgrade, true);
  } finally { teardown(conn, server, state); }
});

test('needsUpgrade is true, with no document fetch, when the hello carries no resources cap', async () => {
  const { server, state } = box('none');
  const port = await listen(server);
  const conn = connect(port);
  conn.start();
  try {
    await waitFor('needsUpgrade to go true', () => conn.needsUpgrade === true);
    assert.strictEqual(state.resourceFetches, 0,
      'a node with no resources cap has no document — classifying it must cost no round trip');
  } finally { teardown(conn, server, state); }
});

test('_openAttach opens NO stream while needsUpgrade is true — the 404 is never hammered', async () => {
  const { server, state } = box('old');
  const port = await listen(server);
  const conn = connect(port);
  conn.start();
  try {
    await waitFor('needsUpgrade to go true', () => conn.needsUpgrade === true);
    conn.attach('alpha');
    await new Promise((r) => setTimeout(r, 300));
    conn._openAttach('alpha', conn._attachments.get('alpha'));
    assert.strictEqual(state.attaches, 0, 'an attach request reached an old node');
    const att = conn._attachments.get('alpha');
    assert.strictEqual(att.req, null, 'no stream is held');
    assert.match(att.error || '', /older Clodex|sessions\/attach/, 'the attach entry names the upgrade');
  } finally { teardown(conn, server, state); }
});

test('the document is fetched once per hello identity, not once per hello tick', async () => {
  const { server, state } = box('current');
  const port = await listen(server);
  const conn = connect(port, 30);
  conn.start();
  try {
    await waitFor('several hello ticks against one unchanging identity', () => state.helloTicks >= 6);
    assert.strictEqual(state.resourceFetches, 1,
      `the document was fetched ${state.resourceFetches}x across ${state.helloTicks} hello ticks`);
  } finally { teardown(conn, server, state); }
});
