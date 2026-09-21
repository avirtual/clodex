'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('node:fs');
const path = require('node:path');

const { mkTmpRoot } = require('./lib/tmp-roots');
const { cutSpillStubs } = require('../wire/spill-cut');
const { SpillFilter } = require('../wire/spill');
const { WireProxy } = require('../wire/proxy');
const { WarmthStore, prefixHash } = require('../wire/warmth');
const { HoldKeeper } = require('../wire/hold');
const { SPILL_FILLER } = require('../intent-spill');
const { spillGrammarLine } = require('../ipc-prompt');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'spill-cut', 'pair-257-258.json'), 'utf8'));
const SESSION_ID = '4a59af49-cc52-44b7-8b02-7f4196a4b486';
const BIG = 'z'.repeat(900);

function fixtureRequest() {
  return JSON.parse(JSON.stringify(FIXTURE.request));
}

function assistantIndex(obj) {
  return obj.messages.findIndex((m) => m.role === 'assistant');
}

let stubCache = null;
function stubOf() {
  if (stubCache) return stubCache;
  const root = mkTmpRoot('clodex-spill-cut-');
  const spills = [];
  const f = new SpillFilter({ agent: 'tester', root, verbs: ['dm'], onSpill: (i) => spills.push(i) });
  const wire = `[agent:dm hand] first line of the body\n${BIG}\n[agent:end]\n`;
  f.feed(wire);
  f.close();
  assert.equal(spills.length, 1, 'the synthetic intent spilled');
  const { id } = spills[0];
  assert.ok(fs.existsSync(path.join(root, 'spill', 'tester', `${id}.md`)));
  stubCache = { id, stub: `[agent:dm hand] first line of the body @spill:${id}\n[agent:end]\n`, bare: `@spill:${id}\n` };
  return stubCache;
}

function withStub(obj, text, extra = null) {
  const i = assistantIndex(obj);
  const msg = obj.messages[i];
  msg.content = [{ type: 'text', text }, ...(extra || [])];
  return obj;
}

test('T1 fixture: the CLI re-sends the response text as one byte-exact block', () => {
  const obj = fixtureRequest();
  const msg = obj.messages[assistantIndex(obj)];
  const texts = msg.content.filter((b) => b.type === 'text');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, FIXTURE.responseText);
  assert.equal(Buffer.byteLength(texts[0].text), Buffer.byteLength(FIXTURE.responseText));
  const r = cutSpillStubs(obj);
  assert.deepStrictEqual(r, { cut: false, lines: 0, blocks: 0, messages: 0, skipped: 0 }, 'ENTER: the captured pair carries no stub');
});

test('T1 stub after prose: the two stub lines go, every other byte of the block stays', () => {
  const { stub } = stubOf();
  const obj = fixtureRequest();
  const i = assistantIndex(obj);
  const before = obj.messages[i].content.map((b) => b.type);
  withStub(obj, `${FIXTURE.responseText}\n\n${stub}`, obj.messages[i].content.slice(1));
  const r = cutSpillStubs(obj);
  assert.equal(r.cut, true, 'ENTER');
  assert.deepStrictEqual(r, { cut: true, lines: 2, blocks: 0, messages: 0, skipped: 0 });
  const msg = obj.messages[i];
  assert.deepStrictEqual(msg.content.map((b) => b.type), before, 'block layout unchanged');
  assert.equal(msg.content[0].text, `${FIXTURE.responseText}\n\n`, 'prose bytes minus exactly the two lines');
  assert.ok(!JSON.stringify(obj).includes('@spill:'));
});

test('T1 stub-only message after a user turn: the whole message goes', () => {
  const { stub } = stubOf();
  const obj = fixtureRequest();
  obj.messages.splice(1, 1);
  const n = obj.messages.length;
  const i = assistantIndex(obj);
  assert.equal(obj.messages[i - 1].role, 'user');
  withStub(obj, stub);
  const r = cutSpillStubs(obj);
  assert.equal(r.cut, true, 'ENTER');
  assert.deepStrictEqual(r, { cut: true, lines: 2, blocks: 1, messages: 1, skipped: 0 });
  assert.equal(obj.messages.length, n - 1);
  assert.ok(obj.messages.every((m) => m.role !== 'assistant'));
  assert.equal(obj.messages[i - 1].role, 'user');
  assert.equal(obj.messages[i].role, 'user', 'user→user is what the API combines');
});

test('T1 stub + tool_use: the text block goes, the tool_use blocks and the message stay', () => {
  const { stub } = stubOf();
  const obj = fixtureRequest();
  const i = assistantIndex(obj);
  const tools = obj.messages[i].content.slice(1);
  assert.equal(tools.length, 2);
  withStub(obj, stub, tools);
  const r = cutSpillStubs(obj);
  assert.equal(r.cut, true, 'ENTER');
  assert.deepStrictEqual(r, { cut: true, lines: 2, blocks: 1, messages: 0, skipped: 0 });
  const msg = obj.messages[i];
  assert.deepStrictEqual(msg.content, tools);
  assert.equal(obj.messages[i + 1].content[0].tool_use_id, tools[0].id, 'tool_result pairing intact');
});

test('T1 legacy stand-ins: a bare pointer, the filler and both receipts are cut like a stub', () => {
  const { bare } = stubOf();
  const legacy = [
    bare,
    `${SPILL_FILLER}\n`,
    '(I sent task add hand — "title" in full, 1234 B; Clodex kept my text at /r/spill/x/0123456789abcdef.md.)\n',
    "(I wrote 900 B of prose after my last intent; it reached the operator's log and Clodex kept it at /r/spill/x/0123456789abcdef.md.)\n",
  ];
  for (const line of legacy) {
    const obj = fixtureRequest();
    const i = assistantIndex(obj);
    withStub(obj, `keep me\n${line}and me\n`, obj.messages[i].content.slice(1));
    const r = cutSpillStubs(obj);
    assert.equal(r.cut, true, `ENTER: ${line.trim()}`);
    assert.equal(r.lines, 1, line);
    assert.equal(obj.messages[i].content[0].text, 'keep me\nand me\n', line);
  }
  const obj = fixtureRequest();
  const i = assistantIndex(obj);
  withStub(obj, 'prose that merely mentions @spill: and [agent:end]\n[agent:end]\n', obj.messages[i].content.slice(1));
  assert.equal(cutSpillStubs(obj).cut, false, 'a mention is not a stub line; a lone terminator is not either');
});

function nPlus1(dropped) {
  const { stub } = stubOf();
  const obj = fixtureRequest();
  obj.messages.splice(1, 1);
  const tools = obj.messages[assistantIndex(obj)].content.slice(1);
  withStub(obj, dropped ? stub : `${FIXTURE.responseText}\n\n${stub}`, dropped ? null : tools);
  return obj;
}

test('T2 prefixHash: the cut prefix of N+2 equals the cut whole of N+1 — reduced and dropped', () => {
  for (const dropped of [false, true]) {
    const a = nPlus1(dropped);
    const b = JSON.parse(JSON.stringify(a));
    b.messages.push({ role: 'user', content: [{ type: 'text', text: 'next turn', cache_control: { type: 'ephemeral' } }] });
    const ra = cutSpillStubs(a);
    const rb = cutSpillStubs(b);
    assert.equal(ra.cut && rb.cut, true, 'ENTER');
    assert.equal(ra.messages, dropped ? 1 : 0);
    assert.equal(prefixHash(b, a.messages.length), prefixHash(a, a.messages.length), `dropped=${dropped}`);
  }
});

test('T3 idempotence: cut(cut(x)) deep-equals cut(x), and a second pass reports nothing', () => {
  const { stub } = stubOf();
  const once = fixtureRequest();
  const i = assistantIndex(once);
  withStub(once, `${FIXTURE.responseText}\n\n${stub}`, once.messages[i].content.slice(1));
  assert.equal(cutSpillStubs(once).cut, true, 'ENTER');
  const twice = JSON.parse(JSON.stringify(once));
  assert.deepStrictEqual(cutSpillStubs(twice), { cut: false, lines: 0, blocks: 0, messages: 0, skipped: 0 });
  assert.deepStrictEqual(twice, once);
});

test('T7 cache_control on the removed block migrates to the last surviving block of that message', () => {
  const { stub } = stubOf();
  const obj = fixtureRequest();
  const i = assistantIndex(obj);
  const tools = obj.messages[i].content.slice(1).map((b) => ({ ...b }));
  delete tools[1].cache_control;
  obj.messages[i].content = [tools[0], { type: 'text', text: stub, cache_control: { type: 'ephemeral' } }, tools[1]];
  assert.equal(cutSpillStubs(obj).cut, true, 'ENTER');
  const c = obj.messages[i].content;
  assert.equal(c.length, 2);
  assert.deepStrictEqual(c[1].cache_control, { type: 'ephemeral' }, 'marker rides on the last remaining block');
  assert.equal(c[0].cache_control, undefined, 'never duplicated');

  const kept = fixtureRequest();
  const k = assistantIndex(kept);
  kept.messages[k].content = [{ type: 'text', text: 'prose\n' }, { type: 'text', text: stub, cache_control: { type: 'ephemeral' } }];
  kept.messages.splice(1, 1);
  assert.equal(cutSpillStubs(kept).cut, true);
  assert.deepStrictEqual(kept.messages[assistantIndex(kept)].content, [{ type: 'text', text: 'prose\n', cache_control: { type: 'ephemeral' } }]);

  const gone = fixtureRequest();
  gone.messages.splice(1, 1);
  withStub(gone, stub);
  gone.messages[assistantIndex(gone)].content[0].cache_control = { type: 'ephemeral' };
  assert.equal(cutSpillStubs(gone).messages, 1);
  assert.ok(gone.messages.every((m) => m.role !== 'assistant'), 'dropped with its message');
});

test('T8 drop rules: a thinking+stub message goes whole; user/system/tool_result content is never touched', () => {
  const { stub } = stubOf();
  const obj = fixtureRequest();
  obj.messages.splice(1, 1);
  const i = assistantIndex(obj);
  obj.messages[i].content = [{ type: 'thinking', thinking: 'hmm @spill: not mine', signature: 'sig' }, { type: 'text', text: stub }];
  const users = obj.messages.filter((m) => m.role !== 'assistant').map((m) => JSON.stringify(m));
  const r = cutSpillStubs(obj);
  assert.equal(r.cut, true, 'ENTER');
  assert.deepStrictEqual(r, { cut: true, lines: 2, blocks: 1, messages: 1, skipped: 0 });
  assert.ok(!JSON.stringify(obj).includes('thinking'), 'thinking left with its message');
  assert.deepStrictEqual(obj.messages.map((m) => JSON.stringify(m)), users);

  const kept = fixtureRequest();
  const k = assistantIndex(kept);
  const tool = kept.messages[k].content[1];
  kept.messages[k].content = [{ type: 'thinking', thinking: 'plan', signature: 'sig' }, { type: 'text', text: stub }, tool];
  kept.messages[0].content[0].text = `${stub}user text is never cut`;
  assert.equal(cutSpillStubs(kept).cut, true);
  assert.deepStrictEqual(kept.messages[k].content, [{ type: 'thinking', thinking: 'plan', signature: 'sig' }, tool]);
  assert.ok(kept.messages[0].content[0].text.startsWith('[agent:dm hand]'), 'the user block still carries the pointer');
});

test('Q4 system-adjacent: a stub-only assistant message after a role:"system" message is kept uncut and counted as skipped', () => {
  const { stub } = stubOf();
  const obj = fixtureRequest();
  const i = assistantIndex(obj);
  assert.equal(obj.messages[i - 1].role, 'system', 'the captured pair has the shape the live probe rejected');
  withStub(obj, stub);
  const before = JSON.stringify(obj);
  const r = cutSpillStubs(obj);
  assert.deepStrictEqual(r, { cut: false, lines: 0, blocks: 0, messages: 0, skipped: 1 }, 'ENTER');
  assert.equal(JSON.stringify(obj), before, 'byte-identical');

  const reduced = fixtureRequest();
  withStub(reduced, `${FIXTURE.responseText}\n${stub}`, reduced.messages[i].content.slice(1));
  const rr = cutSpillStubs(reduced);
  assert.deepStrictEqual(rr, { cut: true, lines: 2, blocks: 0, messages: 0, skipped: 0 }, 'a cut that keeps the message needs no exemption');
  assert.equal(reduced.messages[i].content[0].text, `${FIXTURE.responseText}\n`);
});

function billing(sub) {
  return `x-anthropic-billing-header: cc_surface=cli cc_is_subagent=${sub} cc_version=a1b2c3.1.0.53`;
}

function proxyBody(messages) {
  return {
    model: 'claude-test',
    stream: true,
    system: [
      { type: 'text', text: billing('false') },
      { type: 'text', text: 'You are Claude Code, an agentic coding tool.', cache_control: { type: 'ephemeral' } },
    ],
    tools: [{ name: 'Bash' }],
    metadata: { user_id: JSON.stringify({ session_id: SESSION_ID }) },
    messages,
  };
}

function ev(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const REPLY_SSE = [
  ev('message_start', { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10, cache_read_input_tokens: 5 } } }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok.\n' } }),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  ev('message_stop', { type: 'message_stop' }),
].join('');

function startFakeUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(REPLY_SSE);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

function request(port, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
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

async function withProxy(proxyOpts, fn) {
  const up = await startFakeUpstream();
  const proxy = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${up.port}` }, ...proxyOpts });
  await proxy.listen();
  proxy.registerAgent('tester', {});
  try {
    return await fn(proxy, up);
  } finally {
    await proxy.close();
    up.server.close();
  }
}

function stubMessages(extraUser = 'next') {
  const { stub } = stubOf();
  return [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: `On it.\n\n${stub}` }] },
    { role: 'user', content: [{ type: 'text', text: extraUser, cache_control: { type: 'ephemeral' } }] },
  ];
}

test('T4 ordering, behaviourally: the upstream bytes, the hold entry and the warmth head all carry the cut', async () => {
  const now = () => 1_000_000;
  const warmth = new WarmthStore({ now });
  const hold = new HoldKeeper({ warmth, now, request: async () => { throw new Error('no ping here'); } });
  await withProxy({ warmth, hold }, async (proxy, up) => {
    const events = collect(proxy, ['spill-cut', 'turn.completed']);
    const raw = JSON.stringify(proxyBody(stubMessages()));
    const res = await request(proxy.port, '/agent/tester/v1/messages', raw);
    assert.equal(res.status, 200);
    assert.ok(await whenEvent(events, 'turn.completed'));
    assert.equal(events['spill-cut'].length, 1, 'ENTER');
    assert.deepStrictEqual(events['spill-cut'][0], { agent: 'tester', reqId: events['spill-cut'][0].reqId, cut: true, lines: 2, blocks: 0, messages: 0, skipped: 0 });

    const sent = up.seen[0].body.toString('utf8');
    assert.ok(!sent.includes('@spill:'), 'upstream never sees the stub');
    assert.ok(!sent.includes('[agent:end]'));
    const edited = JSON.parse(sent);
    assert.equal(edited.messages[1].content[0].text, 'On it.\n\n');
    assert.equal(up.seen[0].headers['content-length'], String(Buffer.byteLength(sent)), 'content-length recomputed for the edited bytes');

    const entry = hold.entry(SESSION_ID);
    assert.ok(entry, 'hold cached the request');
    assert.ok(!JSON.stringify(entry.obj).includes('@spill:'), 'the hold entry is the post-cut object');
    assert.deepStrictEqual(entry.obj.messages, edited.messages);

    const q = warmth.query({ session: SESSION_ID });
    assert.equal(q.found, true);
    assert.equal(q.hash, prefixHash(edited, edited.messages.length), 'the stamped head is the hash of what the server addressed');
    assert.equal(events['turn.completed'][0].role, 'parent');
  });
});

test('T4 source pin: the cut precedes bodyObj and every classifier in _forward', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'wire', 'proxy.js'), 'utf8');
  const fwd = src.indexOf('_forward(req, res, ctx) {');
  const cut = src.indexOf('cutSpillStubs(', fwd);
  const bodyObj = src.indexOf('bodyObj = obj', fwd);
  const classify = src.indexOf('this._roles.classify(', fwd);
  const sessionId = src.indexOf('sessionIdFrom(obj)', fwd);
  assert.ok(fwd > 0 && cut > fwd, 'the editor runs inside _forward');
  assert.ok(cut < bodyObj, 'before bodyObj = obj');
  assert.ok(cut < classify, 'before this._roles.classify(');
  assert.ok(cut < sessionId, 'before sessionIdFrom');
  assert.ok(src.indexOf('let body = ctx.body;', fwd) > fwd && src.indexOf('let body = ctx.body;', fwd) < cut);
  assert.ok(/'spill-cut', 'spill-cut-skip'\]/.test(src), 'both events are on the standalone re-emit list');
});

test('T3 no-op identity: a stub-free body reaches upstream as the exact original bytes, no event', async () => {
  await withProxy({}, async (proxy, up) => {
    const events = collect(proxy, ['spill-cut', 'spill-cut-skip', 'turn.completed']);
    const raw = Buffer.from(JSON.stringify(proxyBody([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'prose — ünïcode and "quotes" and \\u2014 kept as typed' }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ])), 'utf8');
    await request(proxy.port, '/agent/tester/v1/messages', raw);
    assert.ok(await whenEvent(events, 'turn.completed'));
    assert.ok(up.seen[0].body.equals(raw), 'ENTER: byte-equal Buffer');
    assert.equal(events['spill-cut'].length, 0);
    assert.equal(events['spill-cut-skip'].length, 0);
  });
});

test('T5 keepwarm replay: HoldKeeper.ping re-sends the post-cut body — no @spill: in the ping', async () => {
  const now = () => 1_000_000;
  const warmth = new WarmthStore({ now });
  const pings = [];
  const hold = new HoldKeeper({
    warmth, now,
    request: async (url, headers, body) => {
      pings.push(body.toString('utf8'));
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ usage: { cache_read_input_tokens: 5000 } })) };
    },
  });
  await withProxy({ warmth, hold }, async (proxy) => {
    const events = collect(proxy, ['turn.completed']);
    await request(proxy.port, '/agent/tester/v1/messages', JSON.stringify(proxyBody(stubMessages())));
    assert.ok(await whenEvent(events, 'turn.completed'));
    const r = await hold.ping(SESSION_ID, { force: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(pings.length, 1, 'ENTER');
    assert.ok(!pings[0].includes('@spill:'), 'the replay carries no pointer');
    assert.ok(!pings[0].includes('[agent:end]'));
  });
});

test('T6 compact request: the summarization body is cut like any other, and the tee still skips it', async () => {
  const root = mkTmpRoot('clodex-spill-cut-');
  await withProxy({}, async (proxy, up) => {
    proxy.registerAgent('tester', { spill: { root, verbs: ['task.done'], turnInjected: () => true } });
    const events = collect(proxy, ['spill-cut', 'spill', 'spill-skip', 'turn.completed']);
    const msgs = stubMessages('\n\nYour task is to create a detailed summary of the conversation so far, '
      + 'paying close attention to the user\'s explicit requests and your previous actions.');
    await request(proxy.port, '/agent/tester/v1/messages', JSON.stringify(proxyBody(msgs)));
    assert.ok(await whenEvent(events, 'turn.completed'));
    assert.equal(events['spill-cut'].length, 1, 'ENTER');
    assert.ok(!up.seen[0].body.toString('utf8').includes('@spill:'));
    assert.equal(events['turn.completed'][0].compact, true);
    assert.equal(events.spill.length, 0);
    assert.equal(events['spill-skip'].length, 0, 'not even considered by the tee');
    assert.ok(!fs.existsSync(path.join(root, 'spill')));
  });
});

test('T9 pref-independence: spillEnabled false still cuts; spillCut false stops it; CLODEX_SPILL_CUT=0 is the default switch', async () => {
  await withProxy({ spillEnabled: () => false }, async (proxy, up) => {
    const events = collect(proxy, ['spill-cut', 'turn.completed']);
    await request(proxy.port, '/agent/tester/v1/messages', JSON.stringify(proxyBody(stubMessages())));
    assert.ok(await whenEvent(events, 'turn.completed'));
    assert.equal(events['spill-cut'].length, 1, 'ENTER');
    assert.ok(!up.seen[0].body.toString('utf8').includes('@spill:'));
  });
  await withProxy({ spillCut: () => false }, async (proxy, up) => {
    const events = collect(proxy, ['spill-cut', 'turn.completed']);
    const raw = Buffer.from(JSON.stringify(proxyBody(stubMessages())), 'utf8');
    await request(proxy.port, '/agent/tester/v1/messages', raw);
    assert.ok(await whenEvent(events, 'turn.completed'));
    assert.equal(events['spill-cut'].length, 0);
    assert.ok(up.seen[0].body.equals(raw), 'switched off: original bytes through');
  });
  const saved = process.env.CLODEX_SPILL_CUT;
  try {
    process.env.CLODEX_SPILL_CUT = '0';
    assert.equal(new WireProxy({}).spillCut(), false);
    delete process.env.CLODEX_SPILL_CUT;
    assert.equal(new WireProxy({}).spillCut(), true);
  } finally {
    if (saved === undefined) delete process.env.CLODEX_SPILL_CUT; else process.env.CLODEX_SPILL_CUT = saved;
  }
});

test('Q4 on the wire: a system-adjacent stub-only message is forwarded uncut with a spill-cut-skip event', async () => {
  const { stub } = stubOf();
  await withProxy({}, async (proxy, up) => {
    const events = collect(proxy, ['spill-cut', 'spill-cut-skip', 'turn.completed']);
    const raw = Buffer.from(JSON.stringify(proxyBody([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'system', content: [{ type: 'text', text: 'hook context' }] },
      { role: 'assistant', content: [{ type: 'text', text: stub }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ])), 'utf8');
    await request(proxy.port, '/agent/tester/v1/messages', raw);
    assert.ok(await whenEvent(events, 'turn.completed'));
    assert.equal(events['spill-cut-skip'].length, 1, 'ENTER');
    assert.equal(events['spill-cut-skip'][0].reason, 'system-adjacent');
    assert.equal(events['spill-cut-skip'][0].skipped, 1);
    assert.equal(events['spill-cut'].length, 0);
    assert.ok(up.seen[0].body.equals(raw), 'nothing else to cut, so the original bytes go through');
  });
});

test('session-manager: both events land in the shadow log under their wire-* record types', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  const cut = src.indexOf("wire.on('spill-cut', ");
  const skip = src.indexOf("wire.on('spill-cut-skip', ");
  assert.ok(cut > 0 && skip > 0);
  assert.ok(src.indexOf("_shadowLog({ type: 'wire-spill-cut', ...ev })", cut) > cut);
  assert.ok(src.indexOf("_shadowLog({ type: 'wire-spill-cut-skip', ...ev })", skip) > skip);
  assert.ok(!/spill-cut[\s\S]{0,400}_injectText/.test(src.slice(cut, skip + 600)), 'no PTY injection, no notice');
});

test('T13 grammar line: byte-pinned, both wirescope anchors present', () => {
  const line = spillGrammarLine('/r');
  assert.equal(line, '- A long intent body (dm, shout, task add/respec/reject/done, context compact/clear/reload — over 800 bytes) is delivered in full and then filed under /r/spill/<your-name>/<id>.md; the whole block is removed from your transcript, and a `[clodex] … filed at …` note on your next prompt confirms the filing, so a body is never lost and never needs re-sending. Always write the body itself: a body you did not write does not exist, and the confirmation is something Clodex writes after delivery, never something you write. On a turn Clodex injected (a dm, a ticket or exec reply, a reminder), prose after your last intent — or a reply with no intent — is filed the same way once it passes 800 bytes: what the operator must know goes inside an intent, not after it — a dm from your operator counts as typed. Actions happen only by emitting the complete intent — head line, full body, terminator; describing, promising or referring to an action in prose performs nothing. Clodex may omit executed intent text from your retained history and report outcomes separately; those history edits are not a request form and never something you write.');
  assert.ok(line.includes('describing, promising or referring to an action in prose performs nothing'));
  assert.ok(line.includes('those history edits are not a request form and never something you write'));
  assert.ok(!line.includes('@spill:'), 'the pointer shape is never taught');
});
