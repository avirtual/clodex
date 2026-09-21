'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('zlib');

const { mkTmpRoot } = require('./lib/tmp-roots');
const { WireProxy } = require('../wire/proxy');
const { mimicKindOf, spillSize } = require('../intent-spill');

function filed(root, spill) {
  return `${spillSize(spill.bytes)}${spill.verb === 'prose' ? ' of prose' : ''} filed at ${path.join(root, 'spill', 'tester', `${spill.id}.md`)}`;
}

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
      seen.requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(opts.status || 200, opts.headers
        || { 'content-type': 'text/event-stream', 'x-upstream': 'fake' });
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      let off = 0;
      const sizes = opts.sizes || [7, 53, 211, 16, 1024];
      let i = 0;
      const tick = () => {
        if (off >= payload.length) { res.end(); return; }
        const n = sizes[i++ % sizes.length];
        res.write(payload.slice(off, off + n));
        off += n;
        if (i === 1 && opts.afterFirstWrite) opts.afterFirstWrite();
        setTimeout(tick, opts.gapMs || 1);
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
  const proxy = new WireProxy({
    upstreams: { anthropic: `http://127.0.0.1:${up.port}` },
    ...(upOpts.proxyOpts || {}),
  });
  await proxy.listen();
  try {
    return await fn(proxy, up);
  } finally {
    await proxy.close();
    up.server.close();
  }
}

test('an armed seat: the client receives the reply with the block replaced by its stub, and the intent tee reads the UNSPILLED body', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({}, async (proxy, up) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'] } });
    const events = collect(proxy, ['turn.completed', 'spill', 'stream-end']);

    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.equal(res.status, 200);
    assert.ok(await whenEvent(events, 'stream-end'), 'stream finished');

    const seen = textOf(res.body);
    assert.equal(events.spill.length, 1);
    const id = events.spill[0].id;
    assert.equal(seen, `On it.\n[agent:task add hand] ${filed(root, events.spill[0])}\n[agent:end]\ndone.\n`,
      'the body is off the wire; the head line, a clickable path and the terminator stand in for it while prose survives');
    assert.equal(fs.readFileSync(path.join(root, 'spill', 'tester', `${id}.md`), 'utf8'), BIG);

    assert.equal(events.spill[0].agent, 'tester');
    assert.equal(events.spill[0].verb, 'task.add');
    assert.equal(events.spill[0].head, 'task add hand', 'the head words ride the event as-is through wire/proxy.js');
    assert.equal(events.spill[0].bytes, 900);

    assert.equal(events['turn.completed'][0].text, `On it.\n[agent:task add hand] ${BIG}\n[agent:end]\ndone.\n`,
      'the intent tee is fed the upstream chunk, not the rewritten one: the dispatch carries the '
      + 'full body and never depends on the transcript placeholder resolving');
    assert.ok(!events['turn.completed'][0].text.includes('filed at'), 'and never sees anything the tee authored');

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
  assert.deepEqual(armed.warmth, plain.warmth,
    'warmth rides the same cache-read counters billing does, never text_delta');
  assert.equal(armed.stop, plain.stop);
  assert.match(armed.client, /^On it\.\n\[agent:task add hand\] 900 B filed at \/.*\/spill\/tester\/[0-9a-f]{16}\.md\n\[agent:end\]\ndone\.\n$/, 'the armed run really spilled');
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

test('the gate off at request time: armed seat, byte-identical, accept-encoding left alone', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({ proxyOpts: { spillEnabled: () => false } }, async (proxy, up) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'] } });
    assert.ok(proxy.spillOf('tester'), 'the seat really is armed — the gate is the only difference');
    const events = collect(proxy, ['stream-end', 'spill', 'spill-skip']);
    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    await whenEvent(events, 'stream-end');
    assert.equal(res.body.toString('utf8'), SPILL_SSE, 'byte-identical to upstream');
    assert.equal(events.spill.length, 0);
    assert.equal(events['spill-skip'].length, 0);
    assert.equal(up.seen.requests[0].headers['accept-encoding'], 'gzip, br');
    assert.ok(!fs.existsSync(path.join(root, 'spill')), 'nothing reached disk');
  });
});

test('the gate flipped on between two requests applies to the second, same registration', async () => {
  const root = mkTmpRoot('clodex-spill-');
  let on = false;
  await withProxy({ proxyOpts: { spillEnabled: () => on } }, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'] } });
    const events = collect(proxy, ['stream-end', 'spill']);

    const first = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'stream-end', 1));
    assert.equal(first.body.toString('utf8'), SPILL_SSE, 'gate off: untouched');
    assert.equal(events.spill.length, 0);

    on = true;
    const second = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'stream-end', 2));
    const seen = textOf(second.body);
    assert.equal(events.spill.length, 1);
    assert.equal(seen, `On it.\n[agent:task add hand] ${filed(root, events.spill[0])}\n[agent:end]\ndone.\n`, 'gate on: the body is off the wire without a respawn');
    assert.equal(fs.readFileSync(path.join(root, 'spill', 'tester', `${events.spill[0].id}.md`), 'utf8'), BIG);
  });
});

test('the gate flipped off mid-stream does not disarm the response already in flight', async () => {
  const root = mkTmpRoot('clodex-spill-');
  let on = true;
  await withProxy({
    gapMs: 20,
    sizes: [7, 1 << 20],
    afterFirstWrite: () => { on = false; },
    proxyOpts: { spillEnabled: () => on },
  }, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'] } });
    const events = collect(proxy, ['stream-end', 'spill']);

    const first = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'stream-end', 1));
    assert.equal(on, false, 'the upstream really flipped the gate mid-response');
    const seen = textOf(first.body);
    assert.ok(!seen.includes(BIG),
      'the decision is taken once per request, so a flip after the first chunk cannot reach it');
    assert.equal(events.spill.length, 1);

    const second = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'stream-end', 2));
    assert.equal(second.body.toString('utf8'), SPILL_SSE, 'the NEXT request sees the flip');
    assert.equal(events.spill.length, 1);
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
    'a respawn that arms nothing must not inherit the previous registration');
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


const PROSE_SSE = [
  ev('message_start', {
    type: 'message_start',
    message: { id: 'msg_prose', usage: { input_tokens: 10, cache_read_input_tokens: 5 } },
  }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  td(0, 'Ticket closed; the report is with the lead.\n'),
  td(0, 'z'.repeat(400)),
  td(0, `${'z'.repeat(499)}\n`),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('message_delta', {
    type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 },
  }),
  ev('message_stop', { type: 'message_stop' }),
].join('');

const PROSE_TEXT = `Ticket closed; the report is with the lead.\n${'z'.repeat(899)}\n`;

test('a TYPED turn is byte-identical: turnInjected false never touches the stream', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({ body: PROSE_SSE }, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'], turnInjected: () => false } });
    const events = collect(proxy, ['spill', 'stream-end']);

    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'stream-end'), 'stream finished');
    assert.equal(textOf(res.body), PROSE_TEXT, 'every byte of the conversation survives');
    assert.equal(events.spill.length, 0, 'nothing spilled');
  });
});

test('an INJECTED turn: a reply with no intent leaves as exactly the bare pointer', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({ body: PROSE_SSE }, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'], turnInjected: () => true } });
    const events = collect(proxy, ['turn.completed', 'spill', 'stream-end']);

    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'stream-end'), 'stream finished');

    const seen = textOf(res.body);
    assert.equal(events.spill.length, 1);
    const id = events.spill[0].id;
    assert.equal(seen, `${filed(root, events.spill[0])}\n`,
      'the whole reply is removed; the bare stand-in is the block, so it is never empty and no filler is needed');
    assert.equal(fs.readFileSync(path.join(root, 'spill', 'tester', `${id}.md`), 'utf8'), PROSE_TEXT,
      'and the prose is on disk, recoverable — a forgotten task done is never silently emptied');

    assert.equal(events.spill[0].verb, 'prose');
    assert.equal(events.spill[0].head, null, 'a tail has no head words');
    assert.equal(events.spill[0].bytes, Buffer.byteLength(PROSE_TEXT, 'utf8'));
    assert.equal(events['turn.completed'][0].text, PROSE_TEXT,
      'the observer reads the upstream prose, as it does for a body spill');
  });
});

const COMPACT_TEXT = `Summary:\n1. Primary Request and Intent:\n${'y'.repeat(20 * 1024)}\n`;

const COMPACT_SSE = [
  ev('message_start', {
    type: 'message_start',
    message: { id: 'msg_compact', usage: { input_tokens: 10, cache_read_input_tokens: 5 } },
  }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  td(0, COMPACT_TEXT.slice(0, 5000)),
  td(0, COMPACT_TEXT.slice(5000, 12000)),
  td(0, COMPACT_TEXT.slice(12000)),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('message_delta', {
    type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 },
  }),
  ev('message_stop', { type: 'message_stop' }),
].join('');

function compactBody() {
  return makeBody({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [
        { type: 'text', text: '<pasted_content>…</pasted_content>' },
        { type: 'text', text: '\n\nYour task is to create a detailed summary of the conversation so far, '
          + 'paying close attention to the user\'s explicit requests and your previous actions.' },
      ] },
    ],
  });
}

test('an INJECTED compact: the summarization request passes the tee untouched — byte-identical, no spill, nothing on disk, still a parent turn', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({ body: COMPACT_SSE }, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.done'], turnInjected: () => true } });
    const events = collect(proxy, ['turn.completed', 'spill', 'spill-skip', 'spill-bail', 'stream-end']);

    const res = await request(proxy.port, '/agent/tester/v1/messages', compactBody());
    assert.ok(await whenEvent(events, 'stream-end'), 'stream finished');
    assert.equal(res.body.toString('utf8'), COMPACT_SSE, 'every byte of the summary survives');
    assert.equal(events.spill.length, 0, 'nothing spilled');
    assert.equal(events['spill-skip'].length, 0, 'not even considered');
    assert.equal(events['spill-bail'].length, 0);
    assert.ok(!fs.existsSync(path.join(root, 'spill')), 'nothing reached disk');
    assert.equal(events['turn.completed'].length, 1);
    assert.equal(events['turn.completed'][0].sideCall, false, 'billed and counted as a parent turn');
    assert.equal(events['turn.completed'][0].role, 'parent');
    assert.equal(events['turn.completed'][0].compact, true, 'flagged so the dispatcher skips its intents');
  });
});

test('the wire dispatcher skips a compact turn: a quoted `[agent:…]` line in the summary is never an intent', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  const guard = src.indexOf('if (t.sideCall || t.compact || isSubagentRole(t.role)) return;');
  const extractAt = src.indexOf('const intents = this._extractIntents(t.text);', guard);
  assert.ok(guard > 0, 'the main-line guard reads the compact flag the proxy sets');
  assert.ok(extractAt > guard, 'and the intent extraction sits behind it');
});

test('turnInjected is evaluated ONCE per request: a flip mid-response cannot take effect', async () => {
  const root = mkTmpRoot('clodex-spill-');
  let flag = false;
  await withProxy({
    body: PROSE_SSE,
    afterFirstWrite: () => { flag = true; },
  }, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'], turnInjected: () => flag } });
    const events = collect(proxy, ['spill', 'stream-end']);

    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'stream-end'), 'stream finished');
    assert.equal(flag, true, 'ENTER: the flag really did flip, or this passes for the wrong reason');
    assert.equal(textOf(res.body), PROSE_TEXT,
      'flipped mid-stream, after the upstream\'s first write: under spillEnabled()\'s contract the '
      + 'response finishes on the decision it started with, so nothing can half-filter one reply');
    assert.equal(events.spill.length, 0);
  });
});

test('a seat with no turnInjected at all keeps the pre-S-G2 behaviour', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({ body: PROSE_SSE }, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'] } });
    const events = collect(proxy, ['spill', 'stream-end']);

    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'stream-end'), 'stream finished');
    assert.equal(textOf(res.body), PROSE_TEXT);
    assert.equal(events.spill.length, 0);
  });
});

test('a THROWING turnInjected reads as not-injected rather than failing the turn', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({ body: PROSE_SSE }, async (proxy) => {
    proxy.registerAgent('tester', {
      spill: { root, verbs: ['task.add'], turnInjected: () => { throw new Error('gone'); } },
    });
    const events = collect(proxy, ['spill', 'stream-end']);

    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'stream-end'), 'stream finished');
    assert.equal(textOf(res.body), PROSE_TEXT, 'doubt forwards the original, as everywhere else here');
    assert.equal(events.spill.length, 0);
  });
});

const NARRATE_TOOL_SSE = [
  ev('message_start', {
    type: 'message_start',
    message: { id: 'msg_narr', usage: { input_tokens: 10, cache_read_input_tokens: 5 } },
  }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  td(0, 'Here is the plan before I touch anything.\n'),
  td(0, 'n'.repeat(400)),
  td(0, `${'n'.repeat(499)}\n`),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('content_block_start', {
    type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} },
  }),
  ev('content_block_delta', {
    type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
  }),
  ev('content_block_stop', { type: 'content_block_stop', index: 1 }),
  ev('message_delta', {
    type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 },
  }),
  ev('message_stop', { type: 'message_stop' }),
].join('');

const NARRATION_TEXT = `Here is the plan before I touch anything.\n${'n'.repeat(899)}\n`;

test('an INJECTED turn that ends in a tool call keeps its narration', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({ body: NARRATE_TOOL_SSE }, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'], turnInjected: () => true } });
    const events = collect(proxy, ['spill', 'stream-end']);

    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'stream-end'), 'stream finished');
    assert.equal(res.body.toString('utf8'), NARRATE_TOOL_SSE,
      'the hand\'s first step on an injected ticket is plan-then-tool-call, and the plan is 900 '
      + 'bytes: the ruling protects tool narration, so this response is forwarded byte-identical');
    assert.equal(textOf(res.body), NARRATION_TEXT);
    assert.equal(events.spill.length, 0);
  });
});

const MIMIC_LINE = "(I sent dm bob in full, 900 B; Clodex kept my text at /Users/x/.clodex/spill/tester/0123456789abcdef.md.)\n";
const MIMIC_SSE = [
  ev('message_start', {
    type: 'message_start',
    message: { id: 'msg_mimic', usage: { input_tokens: 10, cache_read_input_tokens: 5 } },
  }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  td(0, 'Sent.\n'),
  td(0, MIMIC_LINE.slice(0, 30)),
  td(0, MIMIC_LINE.slice(30)),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('message_stop', { type: 'message_stop' }),
].join('');

test('a model-authored receipt line raises spill-mimic and leaves the client bytes unchanged', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({ body: MIMIC_SSE }, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add', 'dm'] } });
    const events = collect(proxy, ['spill', 'spill-mimic', 'stream-end']);
    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'stream-end'), 'stream finished');
    assert.equal(res.body.toString('utf8'), MIMIC_SSE, 'byte-identical: the detector never rewrites');
    assert.equal(events.spill.length, 0, 'nothing was filed');
    assert.equal(events['spill-mimic'].length, 1);
    assert.deepEqual(events['spill-mimic'][0], { agent: 'tester', reqId: events['spill-mimic'][0].reqId, kind: 'intent' });
    assert.ok(!fs.existsSync(path.join(root, 'spill')), 'and nothing reached disk');
  });
});

const FILLER_SSE = [
  ev('message_start', {
    type: 'message_start',
    message: { id: 'msg_filler', usage: { input_tokens: 10, cache_read_input_tokens: 5 } },
  }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  td(0, 'Sent.\n'),
  td(0, '[Runtime note: action text omitted from retained history.]\n'),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('message_stop', { type: 'message_stop' }),
].join('');

test('a model-authored `[Runtime note: action text omitted from retained history.]` line raises spill-mimic with kind filler, bytes unchanged', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({ body: FILLER_SSE }, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add', 'dm'] } });
    const events = collect(proxy, ['spill', 'spill-mimic', 'stream-end']);
    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'stream-end'), 'stream finished');
    assert.equal(res.body.toString('utf8'), FILLER_SSE, 'byte-identical: the detector never rewrites');
    assert.equal(events.spill.length, 0, 'nothing was filed');
    assert.deepEqual(events['spill-mimic'], [{ agent: 'tester', reqId: events['spill-mimic'][0].reqId, kind: 'filler' }],
      'a copied filler costs one bounce and fabricates nothing');
  });
});

const BLOCK_ONLY_SSE = [
  ev('message_start', {
    type: 'message_start',
    message: { id: 'msg_block', usage: { input_tokens: 10, cache_read_input_tokens: 5 } },
  }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  td(0, `[agent:task add hand] ${BIG}\n[agent:end]\n`),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('message_stop', { type: 'message_stop' }),
].join('');

test("the tee's own stub never trips the mimic detector: it runs on the input side only", async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({ body: BLOCK_ONLY_SSE }, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add'] } });
    const events = collect(proxy, ['spill', 'spill-mimic', 'stream-end']);
    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'stream-end'), 'stream finished');
    assert.equal(events.spill.length, 1);
    const stubText = `[agent:task add hand] ${filed(root, events.spill[0])}\n[agent:end]\n`;
    assert.equal(textOf(res.body), stubText, 'ENTER: this run really produced the stub, end to end through the proxy');
    assert.equal(mimicKindOf(stubText.split('\n')[0]), 'pointer', 'ENTER: the stub line IS the shape the detector reports when the model types it');
    assert.equal(events['spill-mimic'].length, 0);
  });
});

const POINTER_SSE = [
  ev('message_start', {
    type: 'message_start',
    message: { id: 'msg_pointer', usage: { input_tokens: 10, cache_read_input_tokens: 5 } },
  }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  td(0, 'Filed.\n'),
  td(0, '@spill:0123456789abcdef\n'),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('message_stop', { type: 'message_stop' }),
].join('');

test('T12: a model-typed bare pointer line raises spill-mimic with kind pointer, bytes unchanged', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({ body: POINTER_SSE }, async (proxy) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.add', 'dm'] } });
    const events = collect(proxy, ['spill', 'spill-mimic', 'stream-end']);
    const res = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'stream-end'), 'stream finished');
    assert.equal(res.body.toString('utf8'), POINTER_SSE, 'byte-identical: the detector never rewrites');
    assert.equal(events.spill.length, 0, 'nothing was filed');
    assert.deepEqual(events['spill-mimic'], [{ agent: 'tester', reqId: events['spill-mimic'][0].reqId, kind: 'pointer' }],
      'the model never receives a real stub, so a pointer in its output is typed from memory');
  });
});

const DM_SSE = [
  ev('message_start', {
    type: 'message_start',
    message: { id: 'msg_dm', usage: { input_tokens: 10, cache_read_input_tokens: 5 } },
  }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  td(0, '[agent:dm bob]\n'),
  td(0, `${BIG}\n`),
  td(0, '[agent:end]\n'),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('message_stop', { type: 'message_stop' }),
].join('');

test('the two halves compose: the stub the tee writes is what cutSpillStubs drops from the NEXT request', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({ body: DM_SSE }, async (proxy, up) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['dm'] } });
    const events = collect(proxy, ['spill', 'spill-cut', 'stream-end']);
    const first = await request(proxy.port, '/agent/tester/v1/messages', makeBody());
    assert.ok(await whenEvent(events, 'stream-end', 1));
    assert.equal(events.spill.length, 1);
    const id = events.spill[0].id;
    const recorded = textOf(first.body);
    assert.equal(recorded, `[agent:dm bob] ${filed(root, events.spill[0])}\n[agent:end]\n`, 'transcript side: head, stand-in, terminator');
    assert.equal(fs.readFileSync(path.join(root, 'spill', 'tester', `${id}.md`), 'utf8'), BIG);

    const next = makeBody({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: recorded }] },
        { role: 'user', content: [{ type: 'text', text: '[clodex] dm bob filed at x.md' }] },
      ],
    });
    await request(proxy.port, '/agent/tester/v1/messages', next);
    assert.ok(await whenEvent(events, 'stream-end', 2));
    assert.equal(events['spill-cut'].length, 1, 'the editor ran on the request built from the record');
    assert.equal(events['spill-cut'][0].messages, 1, 'and dropped the stub message whole');
    const upstream = JSON.parse(up.seen.requests[1].body.toString('utf8'));
    assert.deepEqual(upstream.messages.map((m) => m.role), ['user', 'user'], 'the model never sees the stub');
    assert.ok(!up.seen.requests[1].body.toString('utf8').includes('@spill:'));
  });
});

test('system-adjacent: a request whose LAST message is role:system is forwarded byte-identical, spill-skip system-adjacent, nothing filed', async () => {
  const root = mkTmpRoot('clodex-spill-');
  await withProxy({ body: DM_SSE }, async (proxy, up) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['dm'], turnInjected: () => true } });
    const events = collect(proxy, ['spill', 'spill-skip', 'stream-end']);
    const adjacent = makeBody({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: [{ type: 'text', text: 'hook context' }] },
      ],
    });
    const res = await request(proxy.port, '/agent/tester/v1/messages', adjacent);
    assert.ok(await whenEvent(events, 'stream-end', 1));
    assert.equal(res.body.toString('utf8'), DM_SSE, 'the block is forwarded unchanged: a stub here would sit uncut behind the system message on every later request');
    assert.equal(events.spill.length, 0, 'nothing filed');
    assert.deepEqual(events['spill-skip'], [{ agent: 'tester', reqId: events['spill-skip'][0].reqId, reason: 'system-adjacent' }]);
    assert.ok(!fs.existsSync(path.join(root, 'spill', 'tester')) || fs.readdirSync(path.join(root, 'spill', 'tester')).length === 0);
    assert.equal(up.seen.requests[0].headers['accept-encoding'], 'gzip, br', 'no tee, so the CLI-sent accept-encoding is left alone');

    const notAdjacent = makeBody({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'hook context' }] },
        { role: 'user', content: 'hi' },
      ],
    });
    const second = await request(proxy.port, '/agent/tester/v1/messages', notAdjacent);
    assert.ok(await whenEvent(events, 'stream-end', 2));
    assert.equal(events.spill.length, 1, 'a system message anywhere but LAST leaves the tee armed');
    assert.equal(textOf(second.body), `[agent:dm bob] ${filed(root, events.spill[0])}\n[agent:end]\n`);
    assert.equal(events['spill-skip'].length, 1);
    assert.equal(up.seen.requests[1].headers['accept-encoding'], 'identity');
  });
});
