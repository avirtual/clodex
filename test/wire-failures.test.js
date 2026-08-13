'use strict';

// Failure-injection matrix for the wire tee (CLODEUX-PLAN.md W1 step 5).
// Every scenario asserts the same invariant from two sides: the CLIENT
// path stays byte-transparent (or fails with a bounded, defined status),
// and the OBSERVER degrades to silence — never to a crash or a hang.
// App-lifecycle scenarios (relaunch, sleep/wake) are covered by design in
// shadow mode: the tee dies and restarts with the app, PTYs are app
// children, and JSONL remains the live intent path.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const { WireProxy } = require('../wire/proxy');

function request(port, path, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' }, ...opts },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function collect(emitter, names) {
  const events = {};
  for (const n of names) {
    events[n] = [];
    emitter.on(n, (p) => events[n].push(p));
  }
  return events;
}

function serveOnce(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Wait for the observer to FINISH this response, not for a wall clock to pass.
// The client's bytes and the observer's receipt are two different moments:
// proxy.js writes `res.end()` first and only then calls `tee.close()`, whose
// completion runs through Decompressor.end — synchronous only in passthrough,
// and on zlib's own ticks otherwise. So `await request(...)` resolves with the
// events below still unemitted, and every fixed sleep here was betting that the
// gap stays under a constant. Measured with the tee-close completion delayed:
// each test failed exactly when the delay passed its own sleep value (30ms
// sleeps at 40, 50ms at 70, 80ms at 100) — the signature of a wall-clock race.
//
// ABSENCE assertions below (`turn.completed.length === 0`, `tee-failure === 0`)
// are the reason this matters: they are true before the observer has run at
// all, so gating them on a positive terminal event is what makes them mean
// "the observer finished and produced nothing" instead of "we asked too early".
const whenEvent = (events, name, n = 1, ms = 10000) => new Promise((resolve) => {
  const deadline = Date.now() + ms;
  const tick = () => {
    if (events[name].length >= n) return resolve(true);
    if (Date.now() > deadline) return resolve(false);
    setTimeout(tick, 2);
  };
  tick();
});

test('upstream 5xx passes through verbatim; error receipt, not a turn', async () => {
  const { server, port } = await serveOnce((req, res) => {
    res.writeHead(529, { 'content-type': 'application/json' });
    res.end('{"error":{"type":"overloaded_error"}}');
  });
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${port}` } });
  await proxy.listen();
  const events = collect(proxy, ['turn.completed', 'tee-failure', 'proxy-error']);

  const res = await request(proxy.port, '/agent/t/v1/messages', '{}');
  assert.equal(res.status, 529);
  assert.equal(res.body.toString('utf8'), '{"error":{"type":"overloaded_error"}}');
  assert.ok(await whenEvent(events, 'turn.completed'), 'receipt emitted');
  // proxylab finalizes every messages response: the error body still gets
  // a receipt (request counted, $0, not a user turn) — W2 step 4.
  assert.equal(events['turn.completed'].length, 1);
  const t = events['turn.completed'][0];
  assert.equal(t.status, 529);
  assert.equal(t.text, '');
  assert.equal(t.usage, null);
  assert.equal(t.stop.is_turn, false);
  assert.equal(t.billing.est_usd, null); // '{}' body: no model → nothing priced
  assert.equal(t.sessionTotals.requests, 1);
  assert.equal(t.sessionTotals.turns, 0);
  assert.equal(events['tee-failure'].length, 0);

  await proxy.close();
  server.close();
});

test('upstream dies mid-stream: bounded error, stream-end fires, no hang', async () => {
  const { server, port } = await serveOnce((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":5}}}\n\n');
    setTimeout(() => res.destroy(), 20); // hard kill mid-stream
  });
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${port}` } });
  await proxy.listen();
  const events = collect(proxy, ['stream-start', 'stream-end', 'proxy-error', 'tee-failure']);

  // The client either sees a truncated-but-clean end or a connection error —
  // both bounded; a hang is the only failure.
  await request(proxy.port, '/agent/t/v1/messages', '{}').catch(() => null);
  assert.ok(await whenEvent(events, 'stream-end'), 'stream-end fired (no hang)');

  assert.equal(events['stream-start'].length, 1);
  assert.equal(events['stream-end'].length, 1);
  assert.equal(events['tee-failure'].length, 0);

  await proxy.close();
  server.close();
});

test('client aborts mid-stream: upstream released, stream-end fires', async () => {
  let upstreamClosed = false;
  const { server, port } = await serveOnce((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const iv = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 10);
    res.on('close', () => { upstreamClosed = true; clearInterval(iv); });
  });
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${port}` } });
  await proxy.listen();
  const events = collect(proxy, ['stream-start', 'stream-end', 'tee-failure']);

  await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxy.port, path: '/agent/t/v1/messages', method: 'POST' },
      (res) => {
        res.once('data', () => req.destroy()); // first chunk, then walk away
        res.on('error', () => {});
      },
    );
    req.on('error', () => {});
    req.on('close', resolve);
    req.end('{}');
  });
  assert.ok(await whenEvent(events, 'stream-end'), 'stream-end fired after client abort');

  assert.equal(upstreamClosed, true);
  assert.equal(events['stream-start'].length, 1);
  assert.equal(events['stream-end'].length, 1);
  assert.equal(events['tee-failure'].length, 0);

  await proxy.close();
  server.close();
});

test('corrupt gzip: observer dies quietly, client gets exact bytes', async () => {
  const GARBAGE = Buffer.from('this is definitely not gzip', 'utf8');
  const { server, port } = await serveOnce((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    res.end(GARBAGE);
  });
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${port}` } });
  await proxy.listen();
  const events = collect(proxy, ['turn.completed', 'stream-end', 'tee-failure']);

  const res = await request(proxy.port, '/agent/t/v1/messages', '{}');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, GARBAGE); // raw bytes, still "compressed"
  // stream-end is this test's terminal event; the receipt absence below is only
  // meaningful once the observer has actually finished with the corrupt body.
  assert.ok(await whenEvent(events, 'stream-end'), 'observer finished');
  assert.equal(events['turn.completed'].length, 0);
  assert.equal(events['stream-end'].length, 1);

  await proxy.close();
  server.close();
});

test('valid gzip SSE: observer decodes, client gets the compressed bytes', async () => {
  const SSE = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"gz ok"}}\n\n';
  const gz = zlib.gzipSync(Buffer.from(SSE, 'utf8'));
  const { server, port } = await serveOnce((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    res.end(gz);
  });
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${port}` } });
  await proxy.listen();
  const events = collect(proxy, ['turn.completed']);

  const res = await request(proxy.port, '/agent/t/v1/messages', '{}');
  assert.deepEqual(res.body, gz);
  assert.ok(await whenEvent(events, 'turn.completed'), 'gzip receipt emitted');
  assert.equal(events['turn.completed'].length, 1);
  assert.equal(events['turn.completed'][0].text, 'gz ok');

  await proxy.close();
  server.close();
});

test('tee-internal exception: forwarding untouched, tee-failure + stream-end fire', async () => {
  const SSE_BODY = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n';
  const { server, port } = await serveOnce((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(SSE_BODY);
  });
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${port}` } });
  // Sabotage the whole tee: entry points throw on every call.
  proxy._buildTee = () => ({
    feed: () => { throw new Error('injected feed failure'); },
    close: () => { throw new Error('injected close failure'); },
  });
  await proxy.listen();
  const events = collect(proxy, ['turn.completed', 'tee-failure', 'stream-start', 'stream-end']);

  const res = await request(proxy.port, '/agent/t/v1/messages', '{}');
  assert.equal(res.status, 200);
  assert.equal(res.body.toString('utf8'), SSE_BODY); // byte-exact despite the dead tee
  assert.ok(await whenEvent(events, 'stream-end'), 'stream-end fired despite the dead tee');

  assert.equal(events['tee-failure'].length, 1);
  assert.match(events['tee-failure'][0].error, /injected/);
  assert.equal(events['turn.completed'].length, 0);
  assert.equal(events['stream-start'].length, 1);
  assert.equal(events['stream-end'].length, 1); // activity can't wedge on thinking

  await proxy.close();
  server.close();
});

test('tee construction throws: same containment', async () => {
  const { server, port } = await serveOnce((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {}\n\n');
  });
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${port}` } });
  proxy._buildTee = () => { throw new Error('injected construction failure'); };
  await proxy.listen();
  const events = collect(proxy, ['tee-failure', 'stream-end']);

  const res = await request(proxy.port, '/agent/t/v1/messages', '{}');
  assert.equal(res.status, 200);
  assert.equal(res.body.toString('utf8'), 'data: {}\n\n');
  assert.ok(await whenEvent(events, 'stream-end'), 'stream-end fired after a failed tee construction');
  assert.equal(events['tee-failure'].length, 1);
  assert.equal(events['stream-end'].length, 1);

  await proxy.close();
  server.close();
});

test('port collision: listen rejects instead of hijacking', async () => {
  const p1 = new WireProxy({});
  await p1.listen();
  const p2 = new WireProxy({ port: p1.port });
  await assert.rejects(() => p2.listen(), /EADDRINUSE/);
  await p1.close();
});
