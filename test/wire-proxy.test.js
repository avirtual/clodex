'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { WireProxy } = require('../wire/proxy');

// Synthetic Anthropic SSE turn: usage on message_start, an intent split
// across two text deltas, final output_tokens on message_delta.
//
// Block 0 is a thinking block that REASONS about sending a dm — the shape that
// must never reach turn.text, because turn.text is what session-manager.js
// feeds the intent scanner. Its own `[agent:dm]` line differs from the text
// block's, so a leak in either direction is visible in the exact-equality
// assertions rather than hiding behind a substring match.
const SSE_BODY = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_test1","usage":{"input_tokens":10,"cache_read_input_tokens":5}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"I could reply with\\n[agent:dm ali"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"ce] secret plan\\nbut I will not."}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_abc"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"On it.\\n[agent:dm bo"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"b] hello from the wire\\ndone."}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":1}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_1","name":"Edit","input":{}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"replace_all\\": false, \\"file_pa"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"th\\": \\"/tmp/wire-touched.js\\", \\"old_string\\": \\"a\\"}"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":2}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

// A mixed turn: a Read block (index 0, with offset/limit) and an Edit block
// (index 1) in one stream — the end-to-end cross-contamination pin. The Read
// must land in turn.reads and NEVER in turn.files; the Edit the reverse.
const MIXED_SSE_BODY = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_mix","usage":{"input_tokens":8}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_r","name":"Read","input":{}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\": \\"/tmp/read-me.js\\", \\"off"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"set\\": 40, \\"limit\\": 12}"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_e","name":"Edit","input":{}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\": \\"/tmp/edited.js\\", \\"old_string\\": \\"a\\"}"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":1}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_b","name":"Bash","input":{}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\": \\"npm test\\\\nsecond line\\"}"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":2}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
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
function startFakeUpstream(body = SSE_BODY) {
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
      const payload = Buffer.from(body, 'utf8');
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

// Wait for the observer to catch up, not for a wall clock. `await request(...)`
// resolves when the CLIENT has its bytes, and proxy.js calls res.end() before
// tee.close() — the turn.completed/session/usage events all fire from that
// close path. The sleeps replaced here were betting the gap stays under a
// constant; with tee-close completion delayed, six subjects in this file failed
// at 70ms, so the bet is only as good as the machine's load.
//
// Pass the COUNT the test expects: several of these drive multiple requests and
// then assert on the shape of the whole array, which is satisfiable by a
// half-arrived set. Ordering assertions (deepEqual on roles) are exactly where
// an early read produces a shorter array that no longer matches.
// `|| []` so an uncollected name fails this gate loudly instead of throwing
// from inside a timer, where an uncaught exception takes the runner down
// rather than reporting a failed test.
const whenEvent = (events, name, n = 1, ms = 10000) => new Promise((resolve) => {
  const deadline = Date.now() + ms;
  const tick = () => {
    if ((events[name] || []).length >= n) return resolve(true);
    if (Date.now() > deadline) return resolve(false);
    setTimeout(tick, 2);
  };
  tick();
});

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

  // stream-end is async after client bytes finish; wait for it, not for a clock.
  assert.ok(await whenEvent(events, 'stream-end'), 'stream-end fired');

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
  // Touched-files observer: the Edit tool_use streamed alongside the text
  // (path split across input_json_delta fragments, path key not first).
  assert.deepEqual(turn.files, [{ tool: 'Edit', path: '/tmp/wire-touched.js' }]);
  // This turn read nothing — the Edit must NOT leak into the reads channel.
  assert.deepEqual(turn.reads, []);
  // The feed's row text, and the only assertion standing between the operator
  // and `Bash Bash Read Bash`. Sourcing this from UsageCollector.toolUses (which
  // knows names only) still yields a plausible-looking ['Edit'] that both
  // normalizers downstream accept, so nothing else here would go red.
  assert.deepEqual(turn.toolUses, [{ name: 'Edit', arg: '/tmp/wire-touched.js' }]);
  // Thinking rides its OWN field, whole, and the signature_delta in the same
  // block contributes nothing to it.
  assert.equal(turn.thinking, 'I could reply with\n[agent:dm alice] secret plan\nbut I will not.');
  assert.equal(turn.thinkingTruncated, false);

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

// The reason turn text and thinking are two fields rather than one. This is
// not a display concern: session-manager.js hands `turn.text` — and ONLY
// `turn.text` — to the intent scanner, so a thinking block that reached it
// would let an agent REASONING about `[agent:dm alice]` actually send it.
// Nothing else in this file would go red: the wire would still look correct,
// the feed would still render, and the misfire would surface as a real message
// to a real peer.
//
// It runs the REAL parseIntent (a pure leaf, no electron) over the REAL text
// the tee accumulated, so it fails on any merge at any point in the chain,
// rather than restating the fixture.
test('e2e: an intent inside a thinking block never reaches the scanner', async () => {
  const { parseIntent } = require('../intent-scanner');
  const up = await startFakeUpstream();
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${up.port}` } });
  await proxy.listen();
  const events = collect(proxy, ['turn.completed']);

  await request(proxy.port, '/agent/tester/v1/messages', REQUEST_BODY);
  assert.ok(await whenEvent(events, 'turn.completed'), 'turn observed');

  const turn = events['turn.completed'][0];
  // ENTER: the fixture's thinking really did carry a well-formed dm — if the
  // block stopped being captured, or the intent grammar moved out from under
  // this line, every assertion below would pass over an empty set.
  const inThinking = turn.thinking.split('\n').map(parseIntent).filter(Boolean);
  assert.deepEqual(inThinking.map((i) => i.type), ['dm'],
    'ENTER: the thinking block must contain exactly one parseable intent');
  assert.equal(inThinking[0].target, 'alice');

  const fired = turn.text.split('\n').map(parseIntent).filter(Boolean);
  assert.deepEqual(fired.map((i) => i.target), ['bob'],
    'the thinking block\'s dm must NOT be in the text the scanner reads');
  assert.ok(!turn.text.includes('alice'), 'no thinking bytes leaked into turn text');
  assert.ok(!turn.thinking.includes('bob'), 'and no text bytes leaked the other way');

  await proxy.close();
  up.server.close();
});

test('e2e: a mixed Read+Edit turn splits cleanly into reads and files (no cross-contamination)', async () => {
  const up = await startFakeUpstream(MIXED_SSE_BODY);
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${up.port}` } });
  await proxy.listen();
  const events = collect(proxy, ['turn.completed']);

  await request(proxy.port, '/agent/tester/v1/messages', REQUEST_BODY);
  assert.ok(await whenEvent(events, 'turn.completed'), 'turn observed');

  assert.equal(events['turn.completed'].length, 1);
  const turn = events['turn.completed'][0];
  // The Read rides `reads` (offset/limit captured), the Edit rides `files` —
  // and each is ABSENT from the other channel. This is the pin a future
  // refactor of the collector's block routing would break silently.
  assert.deepEqual(turn.reads, [{ tool: 'Read', path: '/tmp/read-me.js', offset: 40, limit: 12 }]);
  assert.deepEqual(turn.files, [{ tool: 'Edit', path: '/tmp/edited.js' }]);
  // The Bash snippet is a value ONLY the FileToolCollector can produce — Bash
  // touches neither channel above, and the names-only collector has no
  // arguments at all. Its first-line clamp survives the emit, so this pins the
  // whole path from input_json_delta to turn.completed.
  assert.deepEqual(turn.toolUses, [
    { name: 'Read', arg: '/tmp/read-me.js' },
    { name: 'Edit', arg: '/tmp/edited.js' },
    { name: 'Bash', arg: 'npm test' },
  ]);
  // A tool-loop hop with no prose is the MAJORITY shape (measured: turns that
  // carry thinking have a median of 0 visible text chars), and it is the one
  // the feed was blind to. Empty text must stay empty — not become null, and
  // not absorb the absent thinking.
  assert.equal(turn.text, '');
  assert.equal(turn.thinking, null, 'no thinking_delta on this stream means null, not ""');

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

  // Four requests, so wait for four receipts: the roles deepEqual below is an
  // ordered whole-array match, which a partially arrived set fails on length.
  assert.ok(await whenEvent(events, 'turn.completed', 4), 'all four turns observed');

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

test('warmth head: a subagent turn stamps the ledger but never repoints the session head', async () => {
  const { WarmthStore } = require('../wire/warmth');
  const up = await startFakeUpstream();
  const warmth = new WarmthStore({});
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${up.port}` }, warmth });
  await proxy.listen();
  const events = collect(proxy, ['turn.completed']);

  // Main turn, then a subagent under the SAME session id (the real shape:
  // subagents share metadata.user_id.session_id with their parent).
  await request(proxy.port, '/agent/tester/v1/messages', REQUEST_BODY);
  const subBody = makeBody({
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_surface=cli cc_is_subagent=true cc_version=ffff99.1' },
      { type: 'text', text: 'You are an agent for Claude Code.' },
    ],
    messages: [{ role: 'user', content: 'subagent task' }],
  });
  await request(proxy.port, '/agent/tester/v1/messages', subBody);
  // Both turns, or the destructure below binds subT to undefined.
  assert.ok(await whenEvent(events, 'turn.completed', 2), 'main and subagent turns observed');

  const [mainT, subT] = events['turn.completed'];
  assert.equal(mainT.role, 'parent');
  assert.equal(subT.role, 'general-purpose');
  // Both lines stamped the content ledger (receipts.py parity)…
  assert.ok(mainT.warmth && subT.warmth);
  assert.notEqual(subT.warmth.hash, mainT.warmth.hash);
  assert.equal(warmth.state(subT.warmth.hash), 'warm');
  // …but the session head stayed on the main line's prefix, and the
  // subagent turn read as neither a head advance nor a cold resume.
  assert.equal(warmth.query({ session: SESSION_ID }).hash, mainT.warmth.hash);
  assert.equal(warmth.coldResumes(SESSION_ID), 0);

  await proxy.close();
  up.server.close();
  warmth.close();
});

test('registerAgent pre-binds a resumed session id', async () => {
  const up = await startFakeUpstream();
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${up.port}` } });
  await proxy.listen();
  // turn.completed is collected only as a gate for the absence assertion
  // below: it is the LAST event of a request, so observing it proves the
  // request was fully processed and a `session` event would have fired by now.
  const events = collect(proxy, ['session', 'turn.completed']);

  proxy.registerAgent('tester', { sessionId: SESSION_ID });
  assert.equal(proxy.sessionOf('tester'), SESSION_ID);

  // First request declares the SAME id → already bound, no event.
  await request(proxy.port, '/agent/tester/v1/messages', REQUEST_BODY);
  assert.ok(await whenEvent(events, 'turn.completed'), 'first request fully processed');
  assert.equal(events.session.length, 0);

  // /clear rotates the id → change fires with previous recorded.
  const rotated = makeBody({
    metadata: { user_id: JSON.stringify({ session_id: '11111111-2222-3333-4444-555555555555' }) },
  });
  await request(proxy.port, '/agent/tester/v1/messages', rotated);
  assert.ok(await whenEvent(events, 'session'), 'rotation fired a session change');
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

  assert.ok(await whenEvent(events, 'turn.completed'), 'empty receipt still finalized');
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
