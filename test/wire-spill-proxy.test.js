'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('zlib');

const { mkTmpRoot } = require('./lib/tmp-roots');
const { WireProxy } = require('../wire/proxy');

const SESSION_ID = '4a59af49-cc52-44b7-8b02-7f4196a4b486';
const BIG = 'z'.repeat(900);

function billing(sub, fp = 'a1b2c3.1.0.53') {
  return `x-anthropic-billing-header: cc_surface=cli cc_is_subagent=${sub} cc_version=${fp}`;
}

function makeBody(overrides = {}) {
  return JSON.stringify({
    model: 'claude-test',
    stream: true,
    system: [
      { type: 'text', text: billing('false') },
      { type: 'text', text: 'You are Claude Code, an agentic coding tool.' },
    ],
    tools: [{ name: 'Bash' }],
    metadata: { user_id: JSON.stringify({ session_id: SESSION_ID }) },
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  });
}

function subagentBody() {
  return JSON.stringify({
    model: 'claude-test',
    stream: true,
    system: [
      { type: 'text', text: billing('true', 'ffff99.1.0.53') },
      { type: 'text', text: 'You are an agent for Claude Code.' },
    ],
    tools: [{ name: 'Read' }],
    metadata: { user_id: JSON.stringify({ session_id: SESSION_ID }) },
    messages: [{ role: 'user', content: 'search' }],
  });
}

function ev(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function td(index, text) {
  return ev('content_block_delta', {
    type: 'content_block_delta', index, delta: { type: 'text_delta', text },
  });
}

const SPILL_SSE = [
  ev('message_start', {
    type: 'message_start',
    message: { id: 'msg_spill', usage: { input_tokens: 10, cache_read_input_tokens: 5 } },
  }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  td(0, 'On it.\n[agent:task add hand] '),
  td(0, BIG.slice(0, 400)),
  td(0, BIG.slice(400)),
  td(0, '\n[agent:end]\ndone.\n'),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('message_delta', {
    type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 },
  }),
  ev('message_stop', { type: 'message_stop' }),
].join('');

function startFakeUpstream(body = SPILL_SSE, opts = {}) {
  const seen = { requests: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.requests.push({ method: req.method, url: req.url, headers: req.headers });
      res.writeHead(opts.status || 200, opts.headers
        || { 'content-type': 'text/event-stream', 'x-upstream': 'fake' });
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
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

function request(port, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, br' } },
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

const whenEvent = (events, name, n = 1, ms = 10000) => new Promise((resolve) => {
  const deadline = Date.now() + ms;
  const tick = () => {
    if ((events[name] || []).length >= n) return resolve(true);
    if (Date.now() > deadline) return resolve(false);
    setTimeout(tick, 2);
  };
  tick();
});

function textOf(blob) {
  let s = '';
  for (const e of blob.toString('utf8').split('\n\n')) {
    for (const ln of e.split('\n')) {
      if (!ln.startsWith('data:')) continue;
      let d;
      try { d = JSON.parse(ln.slice(5)); } catch { continue; }
      if (d.type === 'content_block_delta' && d.delta && d.delta.type === 'text_delta') {
        s += d.delta.text || '';
      }
    }
  }
  return s;
}

async function withProxy(upOpts, fn) {
  const up = await startFakeUpstream(upOpts.body, upOpts);
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${up.port}` } });
  await proxy.listen();
  try {
    return await fn(proxy, up);
  } finally {
    await proxy.close();
    up.server.close();
  }
}

test('an armed seat: the client receives the pointer, and the observer reads what the client got', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({}, async (proxy, up) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'] } });
    const events = collect(proxy, ['turn.completed', 'spill', 'stream-end']);

    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.equal(res.status, 200);
    assert.ok(await whenEvent(events, 'stream-end'), 'stream finished');

    const seen = textOf(res.body);
    const id = /@spill:([0-9a-f]{16})/.exec(seen)[1];
    assert.ok(!seen.includes(BIG), 'the body is off the wire');
    assert.equal(seen, `On it.\n[agent:task add hand] @spill:${id}\ndone.\n`.replace('\ndone', '\n[agent:end]\ndone'));
    assert.equal(fs.readFileSync(path.join(root, 'spill', 'tester', `${id}.md`), 'utf8'), BIG);

    assert.equal(events.spill.length, 1);
    assert.equal(events.spill[0].agent, 'tester');
    assert.equal(events.spill[0].verb, 'task.add');
    assert.equal(events.spill[0].id, id);
    assert.equal(events.spill[0].bytes, 900);

    assert.equal(events['turn.completed'][0].text, seen,
      'the deduper and the wire-vs-jsonl shadow both assume wire text == transcript text, so an '
      + 'observer fed the pre-filter body would double-fire against its own recovery replay');

    assert.equal(up.seen.requests[0].headers['accept-encoding'], 'identity',
      'the filter needs bytes it can read, so the CLI-sent accept-encoding is overwritten');
  });
});

test('an armed run bills exactly what an unarmed one bills', async () => {
  const root = mkTmpRoot('clodex-spill-');
  const runOnce = (spill) => withProxy({}, async (proxy) => {
    proxy.registerAgent('tester', spill ? { spill: { root, verbs: ['task.add'] } } : {});
    const events = collect(proxy, ['turn.completed', 'usage', 'stream-end']);
    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    await whenEvent(events, 'stream-end');
    const t = events['turn.completed'][0];
    return {
      client: textOf(res.body),
      raw: res.body.toString('utf8'),
      usage: events.usage[0].usage,
      billing: t.billing,
      stop: t.stop.stop_reason,
      warmth: t.warmth,
    };
  });
  const armed = await runOnce(true);
  const plain = await runOnce(false);
  assert.deepEqual(armed.usage, plain.usage, 'usage rides message_start/message_delta, never text_delta');
  assert.deepEqual(armed.billing, plain.billing);
  assert.equal(armed.stop, plain.stop);
  assert.ok(armed.client.includes('@spill:') && !armed.client.includes(BIG), 'the armed run really spilled');
  assert.ok(plain.client.includes(BIG), 'the unarmed run really did not');
  assert.equal(plain.raw, SPILL_SSE, 'and the unarmed run is byte-identical to upstream');
});

test('an unarmed agent is byte-identical and its accept-encoding is left alone', async () => {
  await withProxy({}, async (proxy, up) => {
    proxy.registerAgent('tester');
    const events = collect(proxy, ['stream-end', 'spill', 'spill-skip']);
    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    await whenEvent(events, 'stream-end');
    assert.equal(res.body.toString('utf8'), SPILL_SSE, 'byte-identical to upstream');
    assert.equal(events.spill.length, 0);
    assert.equal(events['spill-skip'].length, 0);
    assert.equal(up.seen.requests[0].headers['accept-encoding'], 'gzip, br');
  });
});

test('unregisterAgent clears the arming', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({}, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'] } });
    assert.ok(proxy.spillOf('tester'));
    proxy.unregisterAgent('tester');
    assert.equal(proxy.spillOf('tester'), null);
    const events = collect(proxy, ['stream-end']);
    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    await whenEvent(events, 'stream-end');
    assert.equal(res.body.toString('utf8'), SPILL_SSE);
  });
});

test('a re-registration replaces the config rather than merging into it', async () => {
  const root = mkTmpRoot('clodex-spill-');
  const proxy = new WireProxy();
  proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'] } });
  proxy.registerAgent('tester', {});
  assert.equal(proxy.spillOf('tester'), null,
    'a respawn that reads the option as off must not inherit the previous spawn arming');
});

test('an armed agent whose upstream compresses anyway: exact bytes through, spill-skip encoding', async () => {
  const root = mkTmpRoot('clodex-spill-');
  const gz = zlib.gzipSync(Buffer.from(SPILL_SSE, 'utf8'));
  await withProxy({
    body: gz,
    headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
  }, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'] } });
    const events = collect(proxy, ['turn.completed', 'spill', 'spill-skip']);
    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'turn.completed'), 'the observer still decodes gzip');
    assert.deepEqual(res.body, gz, 'the client gets the exact compressed bytes');
    assert.equal(events.spill.length, 0);
    assert.equal(events['spill-skip'][0].reason, 'encoding');
    assert.ok(events['turn.completed'][0].text.includes(BIG), 'nothing was rewritten');
  });
});

test('an armed agent on a subagent request is never rewritten', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({}, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'] } });
    const events = collect(proxy, ['stream-end', 'spill']);
    const res = await request(proxy.port, '/agent/tester/v1/messages', subagentBody());
    await whenEvent(events, 'stream-end');
    assert.equal(res.body.toString('utf8'), SPILL_SSE,
      'a subagent\'s text is never scanned for intents, so it must never be rewritten either');
    assert.equal(events.spill.length, 0);
  });
});

test('an armed agent on a non-200 SSE error stream is never rewritten', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({
    status: 529,
    headers: { 'content-type': 'text/event-stream' },
  }, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'] } });
    const events = collect(proxy, ['stream-end', 'spill', 'spill-skip']);
    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    await whenEvent(events, 'stream-end');
    assert.equal(res.status, 529);
    assert.equal(res.body.toString('utf8'), SPILL_SSE);
    assert.equal(events.spill.length, 0);
    assert.equal(events['spill-skip'][0].reason, 'status');
  });
});

test('an armed agent on a non-SSE messages response is never rewritten', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({
    body: '{"type":"message","content":[]}',
    headers: { 'content-type': 'application/json' },
  }, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'] } });
    const events = collect(proxy, ['spill-skip']);
    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'spill-skip'));
    assert.equal(res.body.toString('utf8'), '{"type":"message","content":[]}');
    assert.equal(events['spill-skip'][0].reason, 'not-sse');
  });
});

test('a verb the seat did not arm is left inline', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({}, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['context.compact'] } });
    const events = collect(proxy, ['stream-end', 'spill']);
    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    await whenEvent(events, 'stream-end');
    assert.equal(res.body.toString('utf8'), SPILL_SSE,
      'a verb the seat cannot fire is never rewritten, so its disabled bounce still shows the body');
    assert.equal(events.spill.length, 0);
  });
});
