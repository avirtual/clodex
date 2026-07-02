'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { WireProxy } = require('../wire/proxy');

// Synthetic Anthropic SSE turn: usage on message_start, an intent split
// across two text deltas, final output_tokens on message_delta.
const SSE_BODY = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_test1","usage":{"input_tokens":10,"cache_read_input_tokens":5}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"On it.\\n[agent:dm bo"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"b] hello from the wire\\ndone."}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

const SESSION_ID = '4a59af49-cc52-44b7-8b02-7f4196a4b486';

function makeBody(overrides = {}) {
  return JSON.stringify({
    model: 'claude-test',
    stream: true,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_surface=cli cc_is_subagent=false cc_version=a1b2c3.1.0.53' },
      { type: 'text', text: 'You are Claude Code, an agentic coding tool.' },
    ],
    tools: [{ name: 'Bash' }],
    metadata: {
      user_id: JSON.stringify({
        device_id: 'd'.repeat(64),
        account_uuid: 'fa6f9261-1d7e-4998-b9b7-a0f97aa9e8d6',
        session_id: SESSION_ID,
      }),
    },
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  });
}

const REQUEST_BODY = makeBody();

// Fake upstream: records the request, streams SSE in awkward chunk sizes
// (boundaries land mid-frame) to exercise the framer's buffering.
function startFakeUpstream() {
  const seen = { requests: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'fake' });
      const payload = Buffer.from(SSE_BODY, 'utf8');
      let off = 0;
      const sizes = [7, 53, 211, 16, 1024];
      let i = 0;
      const tick = () => {
        if (off >= payload.length) { res.end(); return; }
        const n = sizes[i++ % sizes.length];
        res.write(payload.slice(off, off + n));
        off += n;
        setTimeout(tick, 1);
      };
      tick();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

function request(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
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

test('e2e: byte-exact pass-through + turn.completed/session/usage events', async () => {
  const up = await startFakeUpstream();
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${up.port}` } });
  await proxy.listen();
  const events = collect(proxy, ['turn.completed', 'session', 'usage', 'stream-start', 'stream-end']);
  const order = [];
  for (const n of ['usage', 'turn.completed', 'stream-end']) proxy.on(n, () => order.push(n));

  const res = await request(proxy.port, '/agent/tester/v1/messages', REQUEST_BODY);

  // Transparency: status, marker header, exact body bytes.
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-upstream'], 'fake');
  assert.equal(res.body.toString('utf8'), SSE_BODY);

  // Upstream saw the unprefixed path and the original body.
  assert.equal(up.seen.requests[0].url, '/v1/messages');
  assert.equal(up.seen.requests[0].body, REQUEST_BODY);

  // stream-end is async after client bytes finish; wait briefly.
  await new Promise((r) => setTimeout(r, 50));

  // The wire does not scan intents — it hands the full turn text to the
  // consumer, intact, including the intent line and surrounding prose.
  assert.equal(events['turn.completed'].length, 1);
  const turn = events['turn.completed'][0];
  assert.equal(turn.agent, 'tester');
  assert.equal(turn.sessionId, SESSION_ID);
  assert.equal(turn.text, 'On it.\n[agent:dm bob] hello from the wire\ndone.');
  assert.equal(turn.truncated, false);
  assert.equal(turn.role, 'parent');
  assert.equal(turn.sideCall, false);
  assert.equal(turn.usage.input_tokens, 10);
  assert.equal(turn.usage.output_tokens, 42);

  assert.equal(events.session[0].agent, 'tester');
  assert.equal(events.session[0].sessionId, SESSION_ID);
  assert.equal(events.session[0].previous, null);
  assert.equal(proxy.sessionOf('tester'), SESSION_ID);

  assert.equal(events.usage[0].usage.input_tokens, 10);
  assert.equal(events.usage[0].usage.output_tokens, 42);
  assert.equal(events.usage[0].usage.message_id, 'msg_test1');

  assert.equal(events['stream-start'].length, 1);
  assert.equal(events['stream-end'].length, 1);
  assert.deepEqual(order, ['usage', 'turn.completed', 'stream-end']);

  await proxy.close();
  up.server.close();
});

test('e2e: token auth closes the loop', async () => {
  const up = await startFakeUpstream();
  const proxy = new WireProxy({
    requireTokens: true,
    upstreams: { anthropic: `http://127.0.0.1:${up.port}` },
  });
  await proxy.listen();

  const baseUrl = proxy.registerAgent('tester');
  const token = baseUrl.split('/').pop();
  assert.match(token, /^[0-9a-f]{32}$/);

  // No token → 401, nothing reaches upstream.
  const denied = await request(proxy.port, '/agent/tester/v1/messages', REQUEST_BODY);
  assert.equal(denied.status, 401);
  // Wrong agent → 401 too (no token registered).
  const ghost = await request(proxy.port, '/agent/ghost/v1/messages', REQUEST_BODY);
  assert.equal(ghost.status, 401);
  assert.equal(up.seen.requests.length, 0);

  // With token → forwarded, token stripped from upstream path.
  const ok = await request(proxy.port, `/agent/tester/${token}/v1/messages`, REQUEST_BODY);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.toString('utf8'), SSE_BODY);
  assert.equal(up.seen.requests[0].url, '/v1/messages');

  await proxy.close();
  up.server.close();
});

test('non-agent paths are rejected', async () => {
  const proxy = new WireProxy({});
  await proxy.listen();
  const res = await request(proxy.port, '/v1/messages', '{}');
  assert.equal(res.status, 400);
  await proxy.close();
});

test('dead upstream yields 502, not a hang', async () => {
  const proxy = new WireProxy({ upstreams: { anthropic: 'http://127.0.0.1:1' } });
  await proxy.listen();
  const res = await request(proxy.port, '/agent/tester/v1/messages', '{}');
  assert.equal(res.status, 502);
  await proxy.close();
});

test('identity binding: main line owns it; subagents and side-calls cannot rebind', async () => {
  const up = await startFakeUpstream();
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${up.port}` } });
  await proxy.listen();
  const events = collect(proxy, ['session', 'turn.completed']);

  // Turn 1: parent — binds agent↔session, fires 'session' once.
  await request(proxy.port, '/agent/tester/v1/messages', REQUEST_BODY);
  // Turn 2: same parent, same session — no re-fire.
  await request(proxy.port, '/agent/tester/v1/messages', REQUEST_BODY);
  // Subagent turn under a DIFFERENT (bogus) session id must not rebind.
  const subBody = makeBody({
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_surface=cli cc_is_subagent=true cc_version=ffff99.1' },
      { type: 'text', text: 'You are an agent for Claude Code.' },
    ],
    metadata: { user_id: JSON.stringify({ session_id: '99999999-9999-9999-9999-999999999999' }) },
  });
  await request(proxy.port, '/agent/tester/v1/messages', subBody);
  // Title side-call must not rebind either.
  const titleBody = makeBody({
    system: 'Generate a concise, sentence-case title for this conversation.',
    tools: [],
    metadata: { user_id: JSON.stringify({ session_id: '88888888-8888-8888-8888-888888888888' }) },
  });
  await request(proxy.port, '/agent/tester/v1/messages', titleBody);

  await new Promise((r) => setTimeout(r, 60));

  assert.equal(events.session.length, 1);
  assert.equal(proxy.sessionOf('tester'), SESSION_ID);

  // All four streams produced turns, correctly labeled for the consumer.
  const roles = events['turn.completed'].map((t) => [t.role, t.sideCall]);
  assert.deepEqual(roles, [
    ['parent', false],
    ['parent', false],
    ['general-purpose', false],
    ['unknown', true],
  ]);

  await proxy.close();
  up.server.close();
});

test('registerAgent pre-binds a resumed session id', async () => {
  const up = await startFakeUpstream();
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${up.port}` } });
  await proxy.listen();
  const events = collect(proxy, ['session']);

  proxy.registerAgent('tester', { sessionId: SESSION_ID });
  assert.equal(proxy.sessionOf('tester'), SESSION_ID);

  // First request declares the SAME id → already bound, no event.
  await request(proxy.port, '/agent/tester/v1/messages', REQUEST_BODY);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(events.session.length, 0);

  // /clear rotates the id → change fires with previous recorded.
  const rotated = makeBody({
    metadata: { user_id: JSON.stringify({ session_id: '11111111-2222-3333-4444-555555555555' }) },
  });
  await request(proxy.port, '/agent/tester/v1/messages', rotated);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(events.session.length, 1);
  assert.equal(events.session[0].sessionId, '11111111-2222-3333-4444-555555555555');
  assert.equal(events.session[0].previous, SESSION_ID);

  await proxy.close();
  up.server.close();
});

test('per-agent upstream override chains through an external proxy base', async () => {
  const up = await startFakeUpstream();
  const proxy = new WireProxy({
    requireTokens: true,
    upstreams: { anthropic: 'http://127.0.0.1:1' }, // default must NOT be hit
  });
  await proxy.listen();

  const baseUrl = proxy.registerAgent('tester', {
    upstreams: { anthropic: `http://127.0.0.1:${up.port}/agent/clodex-tester-abc/anthropic` },
  });

  const token = baseUrl.split('/').pop();
  const res = await request(proxy.port, `/agent/tester/${token}/anthropic/v1/messages`, REQUEST_BODY);
  assert.equal(res.status, 200);
  assert.equal(res.body.toString('utf8'), SSE_BODY);
  // The external proxy saw its own per-agent route shape, untouched body.
  assert.equal(up.seen.requests[0].url, '/agent/clodex-tester-abc/anthropic/v1/messages');
  assert.equal(up.seen.requests[0].body, REQUEST_BODY);

  await proxy.close();
  up.server.close();
});

test('malformed SSE degrades to an empty receipt, session unbroken', async () => {
  // Upstream streams garbage that is not valid SSE JSON — the client must
  // still receive the exact bytes; the observer sees no usage/text but
  // still finalizes a receipt (proxylab bills every messages response).
  const GARBAGE = 'event: content_block_delta\ndata: {not json!!\n\nplain trash without framing';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(GARBAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${server.address().port}` } });
  await proxy.listen();
  const events = collect(proxy, ['turn.completed', 'stream-end', 'proxy-error']);

  const res = await request(proxy.port, '/agent/tester/v1/messages', REQUEST_BODY);
  assert.equal(res.status, 200);
  assert.equal(res.body.toString('utf8'), GARBAGE);

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events['turn.completed'].length, 1);
  const t = events['turn.completed'][0];
  assert.equal(t.text, '');
  assert.equal(t.usage, null);
  assert.equal(t.stop.is_turn, false);
  assert.equal(events['stream-end'].length, 1);
  assert.equal(events['proxy-error'].length, 0);

  await proxy.close();
  server.close();
});
