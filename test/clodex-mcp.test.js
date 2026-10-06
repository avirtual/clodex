'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { mkTmpRoot } = require('./lib/tmp-roots');
const mcp = require('../cli/bin/clodex-mcp.js');
const { TOOL } = require('../plugins/browser-pane/mcp-tool');

const SERVER = path.join(__dirname, '..', 'cli', 'bin', 'clodex-mcp.js');
const CRED = 'k1';
const SUBAGENT_NO_CONFIRM = 'a subagent cannot confirm a consequential action — ask the main agent';
const LISTED = JSON.parse(JSON.stringify({ name: TOOL.name, description: TOOL.description, inputSchema: TOOL.inputSchema }));
const catalog = (rev, tools = [TOOL], extra = {}) => JSON.stringify({ v: 1, rev, tools, briefs: [], ...extra });

async function fakeSeat(answer, root = mkTmpRoot('verb-'), cat = catalog('r1')) {
  const sockPath = path.join(root, 'i.sock');
  if (cat !== null) fs.writeFileSync(path.join(root, 'mcp-tools.json'), cat);
  const got = [];
  const conns = new Set();
  const srv = net.createServer((c) => {
    conns.add(c);
    c.on('close', () => conns.delete(c));
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      const r = JSON.parse(buf.split('\n')[0]);
      got.push(r);
      const a = answer(r, c, got.length - 1);
      if (a === 'hang') return;
      if (a === 'destroy') { c.destroy(); return; }
      if (a !== undefined) c.end(JSON.stringify(a) + '\n');
    });
  });
  await new Promise((r) => srv.listen(sockPath, r));
  return {
    root, sockPath, got,
    catalogPath: path.join(root, 'mcp-tools.json'),
    close: () => { for (const c of conns) c.destroy(); return new Promise((r) => srv.close(r)); },
  };
}

function sink() {
  const s = { buf: '', write: (t) => { s.buf += t; } };
  return s;
}

function server(seat, opts = {}) {
  const env = seat ? { CLODEX_INTENT_SOCK: seat.sockPath, CLODEX_INTENT_CRED: CRED, ...(opts.env || {}) } : (opts.env || {});
  const output = sink();
  const errOut = sink();
  const s = mcp.createServer({ input: null, output, errOut, setInterval: () => null, clearInterval: () => {}, ...opts, env });
  return { ...s, output, errOut };
}

const call = (id, args, name = 'browser') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const list = async (s, id = 1) => {
  const r = await s.handle({ jsonrpc: '2.0', id, method: 'tools/list' });
  assert.strictEqual(r.error, undefined);
  return r.result.tools;
};

test('tools/list is the catalog file\'s tools, name/description/inputSchema only', async () => {
  const other = { name: 'other', description: 'd', inputSchema: { type: 'object' }, extra: 'x' };
  const seat = await fakeSeat(() => undefined, undefined, catalog('r1', [TOOL, other], { briefs: ['secret brief'] }));
  try {
    const s = server(seat);
    const tools = await list(s);
    assert.strictEqual(tools.length, 2);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(tools[0])), LISTED);
    assert.deepStrictEqual(tools[1], { name: 'other', description: 'd', inputSchema: { type: 'object' } });
    assert.ok(!JSON.stringify(tools).includes('secret brief'));
    assert.ok(!JSON.stringify(tools).includes('briefs'));
  } finally { await seat.close(); }
});

test('an absent, torn or malformed catalog lists no tools and never errors', async () => {
  const seat = await fakeSeat(() => undefined, undefined, null);
  try {
    const s = server(seat);
    assert.deepStrictEqual(await list(s), []);
    for (const body of ['{"v":1,"re', JSON.stringify({ v: 2, tools: [TOOL] }), JSON.stringify({ v: 1, tools: 'x' }), 'null']) {
      fs.writeFileSync(seat.catalogPath, body);
      assert.deepStrictEqual(await list(s), [], body);
    }
    assert.deepStrictEqual(mcp.readCatalog({}), { rev: null, tools: [] });
  } finally { await seat.close(); }
});

test('the catalog path is derived from CLODEX_INTENT_SOCK\'s directory', () => {
  const src = fs.readFileSync(SERVER, 'utf8');
  assert.ok(src.includes("path.join(path.dirname(env.CLODEX_INTENT_SOCK), 'mcp-tools.json')"));
  const paths = fs.readFileSync(path.join(__dirname, '..', 'clodex-paths.js'), 'utf8');
  assert.match(paths, /intentSocket: 'intent\.sock'/);
  assert.match(paths, /mcpCatalog: 'mcp-tools\.json'/);
});

test('tools/call forwards {cred, tool, args} as received; the socket decides an unknown tool', async () => {
  const answers = [{ ok: true, status: 'ok', reply: 'x' }, { ok: true, status: 'ok', reply: 'y' }, { ok: true, status: 'ok', reply: 'z' }, { ok: false, status: 'refused', error: 'unknown tool: "nope"' }];
  const seat = await fakeSeat((r, c, i) => answers[i]);
  try {
    const s = server(seat);
    const a = { verb: 'read', service: 'svc', bracket: ['--text'], anything: 'kept' };
    await s.handle(call(1, a));
    assert.deepStrictEqual(seat.got[0], { cred: CRED, tool: 'browser', args: a });
    assert.deepStrictEqual(Object.keys(seat.got[0]), ['cred', 'tool', 'args']);
    await s.handle(call(2, undefined));
    await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser', arguments: null } });
    assert.deepStrictEqual(seat.got[1], { cred: CRED, tool: 'browser', args: {} });
    assert.deepStrictEqual(seat.got[2], { cred: CRED, tool: 'browser', args: {} });
    const r = await s.handle(call(4, { x: 1 }, 'nope'));
    assert.strictEqual(seat.got[3].tool, 'nope');
    assert.deepStrictEqual(r.result, { content: [{ type: 'text', text: 'unknown tool: "nope"' }] });
  } finally { await seat.close(); }
});

test('the socket\'s answers render as plain text results', async () => {
  const rows = [
    [{ ok: false, status: 'invalid', error: "release is for the seat's main agent" }, "invalid: release is for the seat's main agent"],
    [{ ok: false, status: 'invalid', error: 'body must be one line' }, 'invalid: body must be one line'],
    [{ ok: false, status: 'refused', error: SUBAGENT_NO_CONFIRM }, SUBAGENT_NO_CONFIRM],
    [{ ok: false, error: 'tool browser emitted a foreign intent' }, 'tool browser emitted a foreign intent'],
    [{ ok: false, error: 'tool calls are not available' }, 'tool calls are not available'],
    [{ ok: true, status: 'ok', reply: 'x' }, 'x'],
    [{ ok: true, status: 'error', reply: 'e' }, 'e'],
  ];
  const seat = await fakeSeat((r, c, i) => rows[i][0]);
  try {
    const s = server(seat);
    for (const [i, [, text]] of rows.entries()) {
      const r = await s.handle(call(i, { verb: 'read', n: i }));
      assert.strictEqual(r.error, undefined);
      assert.strictEqual('isError' in r.result, false);
      assert.deepStrictEqual(r.result, { content: [{ type: 'text', text }] });
    }
    assert.strictEqual(seat.got.length, rows.length);
  } finally { await seat.close(); }
});

const SUBAGENT_NO_RELEASE = "release is for the seat's main agent";

test('the release refusal is the browser plugin\'s NO_RELEASE literal', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'browser-pane', 'subagent.js'), 'utf8');
  assert.ok(src.includes(`const NO_RELEASE = ${JSON.stringify(SUBAGENT_NO_RELEASE)};`));
});

test('a malformed tools/call answers -32602, logs nothing and never touches the socket', async () => {
  const seat = await fakeSeat(() => ({ ok: true, status: 'ok', reply: 'x' }));
  try {
    const s = server(seat);
    const bad = [
      [call(8, { verb: 'read' }, 7), 'tool name must be a string'],
      [{ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { arguments: {} } }, 'tool name must be a string'],
      [{ jsonrpc: '2.0', id: 10, method: 'tools/call' }, 'tool name must be a string'],
      [{ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'browser', arguments: 'x' } }, 'arguments must be an object'],
      [{ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'browser', arguments: [] } }, 'arguments must be an object'],
    ];
    for (const [m, message] of bad) {
      const r = await s.handle(m);
      assert.strictEqual(r.id, m.id);
      assert.deepStrictEqual(r.error, { code: -32602, message }, JSON.stringify(m.params));
      assert.strictEqual(r.result, undefined);
    }
    assert.strictEqual(seat.got.length, 0);
    assert.ok(!fs.existsSync(path.join(seat.root, 'mcp.log')));
  } finally { await seat.close(); }
});

test('only a non-string tool name or non-object arguments raise the protocol error', () => {
  const own = fs.readFileSync(SERVER, 'utf8');
  assert.ok(own.includes('class InvalidRequest extends Error {}'));
  assert.ok(own.includes('if (e instanceof InvalidRequest) return { error: { code: -32602, message: e.message } };'));
  assert.strictEqual(own.split('new InvalidRequest(').length, 3);
});

test('the server carries no tool-specific knowledge', () => {
  const src = fs.readFileSync(SERVER, 'utf8');
  assert.ok(!/browser|release|confirm|agent:/.test(src));
});

test('an unset seat channel answers -32603 on call while tools/list answers an empty list', async () => {
  const s = server(null);
  assert.deepStrictEqual(await list(s), []);
  const r = await s.handle(call(2, { verb: 'services' }));
  assert.strictEqual(r.error.code, -32603);
  assert.match(r.error.message, /CLODEX_INTENT_SOCK \/ CLODEX_INTENT_CRED unset/);
});

test('JSON-RPC: initialize, tools/list, ping, unknown method, parse error, notification', async () => {
  const seat = await fakeSeat(() => undefined);
  const input = new PassThrough();
  try {
    const s = server(seat, { input });
    const r1 = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
    assert.strictEqual(r1.result.protocolVersion, '2025-06-18');
    assert.deepStrictEqual(r1.result.capabilities, { tools: { listChanged: true } });
    assert.strictEqual(r1.result.serverInfo.name, 'clodex');
    const r0 = await s.handle({ jsonrpc: '2.0', id: 0, method: 'initialize' });
    assert.strictEqual(r0.result.protocolVersion, '2025-06-18');
    for (const v of ['2025-03-26', '2024-11-05', '2025-06-18']) {
      const r = await s.handle({ jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: v } });
      assert.strictEqual(r.result.protocolVersion, v);
    }
    assert.strictEqual(mcp.PROTOCOLS[0], '2025-06-18');
    const tools = await list(s, 2);
    assert.strictEqual(tools.length, 1);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(tools[0])), LISTED);
    assert.deepStrictEqual(await s.handle({ jsonrpc: '2.0', id: 3, method: 'ping' }), { id: 3, result: {} });
    assert.strictEqual((await s.handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).error.code, -32601);
    assert.strictEqual(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.strictEqual(await s.handle({ jsonrpc: '2.0', method: 'resources/list' }), null);
    input.write('not json\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write('{"jsonrpc":"2.0","id":9,"method":"ping"}\n');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const lines = s.output.buf.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(lines, [
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
      { jsonrpc: '2.0', id: 9, result: {} },
    ]);
  } finally { input.end(); await seat.close(); }
});

test('a timed-out or dropped call answers completion unknown and is never retried', async () => {
  const hang = await fakeSeat(() => 'hang');
  try {
    const s = server(hang, { timeoutMs: 50 });
    const r = await s.handle(call(1, { verb: 'click', service: 'svc', bracket: ['3'] }));
    assert.strictEqual('isError' in r.result, false);
    assert.ok(r.result.content[0].text.startsWith('completion unknown — do not retry:'), r.result.content[0].text);
    assert.strictEqual(hang.got.length, 1);
  } finally { await hang.close(); }
  const drop = await fakeSeat(() => 'destroy');
  try {
    const s = server(drop);
    const r = await s.handle(call(1, { verb: 'click', service: 'svc', bracket: ['3'] }));
    assert.strictEqual('isError' in r.result, false);
    assert.ok(r.result.content[0].text.startsWith('completion unknown — do not retry:'), r.result.content[0].text);
    assert.strictEqual(drop.got.length, 1);
  } finally { await drop.close(); }
});

test('concurrent calls each answer under their own id', async () => {
  const held = [];
  const answer = ([req, conn]) => conn.end(JSON.stringify({ ok: true, status: 'ok', reply: `re ${req.args.service}` }) + '\n');
  const seat = await fakeSeat((r, c) => {
    held.push([r, c]);
    if (held.length === 2) answer(held.find(([q]) => q.args.service === 'two'));
    return 'hang';
  });
  try {
    const s = server(seat);
    const order = [];
    const p1 = s.handle(call('a', { verb: 'read', service: 'one' })).then((r) => { order.push(r.id); return r; });
    const p2 = s.handle(call('b', { verb: 'read', service: 'two' })).then((r) => { order.push(r.id); return r; });
    const r2 = await p2;
    assert.deepStrictEqual(order, ['b']);
    answer(held.find(([q]) => q.args.service === 'one'));
    const r1 = await p1;
    assert.strictEqual(r1.id, 'a');
    assert.strictEqual(r1.result.content[0].text, 're one');
    assert.strictEqual(r2.id, 'b');
    assert.strictEqual(r2.result.content[0].text, 're two');
    assert.deepStrictEqual(order, ['b', 'a']);
  } finally { await seat.close(); }
});

test('mcp.log carries metadata only', async () => {
  const answers = [
    { ok: true, status: 'error', reply: 'page SENTINEL3', error: 'oops SENTINEL4' },
    { ok: false, status: 'invalid', error: 'service must match SENTINEL6' },
    { ok: false, error: 'nope SENTINEL7' },
    null,
    { ok: false, status: 'refused', error: 'unknown tool: "../x"' },
  ];
  const seat = await fakeSeat((r, c, i) => answers[i]);
  try {
    const s = server(seat, { env: { CLODEX_INTENT_CRED: 'SENTINEL5' } });
    const r = await s.handle(call(1, { verb: 'read', service: 'svc', bracket: ['--filter=SENTINEL1'], body: 'SENTINEL2' }));
    assert.strictEqual(r.result.content[0].text, 'page SENTINEL3');
    assert.strictEqual(seat.got[0].cred, 'SENTINEL5');
    const log = fs.readFileSync(path.join(seat.root, 'mcp.log'), 'utf8');
    const lines = log.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\S+ browser (ok|error) \d+ms$/);
    const r2 = await s.handle(call(2, { verb: 'services', service: 'SENTINEL6 x' }));
    assert.strictEqual(r2.result.content[0].text, 'invalid: service must match SENTINEL6');
    const inv = fs.readFileSync(path.join(seat.root, 'mcp.log'), 'utf8').split('\n').filter(Boolean)[1];
    assert.match(inv, /^\S+ browser invalid \d+ms$/);
    const r3 = await s.handle(call(3, { verb: 'read', service: 'svc' }));
    assert.strictEqual(r3.result.content[0].text, 'nope SENTINEL7');
    const r4 = await s.handle(call(4, { verb: 'read', service: 'svc' }));
    assert.strictEqual(r4.result.content[0].text, 'completion unknown — do not retry: unreadable reply from the seat socket');
    assert.ok(!('isError' in r4.result));
    await s.handle(call(5, {}, '../x'));
    const all = fs.readFileSync(path.join(seat.root, 'mcp.log'), 'utf8');
    const rows = all.split('\n').filter(Boolean);
    assert.deepStrictEqual(rows.slice(2, 4).map((l) => l.split(' ')[2]), ['error', 'bad-reply']);
    assert.match(rows[4], /^\S+ - refused \d+ms$/);
    for (const k of [1, 2, 3, 4, 5, 6, 7]) assert.ok(!all.includes(`SENTINEL${k}`), `SENTINEL${k}`);
  } finally { await seat.close(); }
});

test('the log\'s tool-name pattern is the registry\'s TOOL_NAME_RE', () => {
  const lit = (src, name) => new RegExp(`const ${name} = (/.+/);`).exec(src)[1];
  const own = lit(fs.readFileSync(SERVER, 'utf8'), 'TOOL_RE');
  const reg = lit(fs.readFileSync(path.join(__dirname, '..', 'intent-registry.js'), 'utf8'), 'TOOL_NAME_RE');
  assert.strictEqual(own, reg);
});

test('no tools/call answer is a tool error: the server never names isError', () => {
  assert.ok(!fs.readFileSync(SERVER, 'utf8').includes('isError'));
});

test('the same failing call is stopped at the third try within a minute; a success clears it', async () => {
  const own = fs.readFileSync(SERVER, 'utf8');
  assert.ok(own.includes('const LOOP_MAX = 3;'));
  assert.ok(own.includes('const LOOP_WINDOW_MS = 60 * 1000;'));
  assert.ok(own.includes("if (st === 'ok') fails.delete(key); else if (st !== 'invalid') failed(key, toolResult(r).content[0].text);"));
  let t = 1000;
  const seat = await fakeSeat(() => ({ ok: false, status: 'refused', error: SUBAGENT_NO_CONFIRM }));
  try {
    const s = server(seat, { now: () => t });
    const a = { verb: 'click', service: 'svc', bracket: ['17', '--confirm'] };
    const r1 = await s.handle(call(1, a));
    assert.strictEqual(r1.result.content[0].text, SUBAGENT_NO_CONFIRM);
    await s.handle(call(2, a));
    assert.strictEqual(seat.got.length, 2);
    const r3 = await s.handle(call(3, a));
    assert.strictEqual(seat.got.length, 2);
    assert.deepStrictEqual(r3.result, { content: [{ type: 'text', text: `the same call failed 3 times — stop retrying: ${SUBAGENT_NO_CONFIRM}` }] });
    const r4 = await s.handle(call(4, a));
    assert.strictEqual(seat.got.length, 2);
    assert.strictEqual(r4.result.content[0].text, r3.result.content[0].text);
    await s.handle(call(5, { verb: 'click', service: 'svc', bracket: ['18', '--confirm'] }));
    assert.strictEqual(seat.got.length, 3);
    t += 61000;
    await s.handle(call(6, a));
    assert.strictEqual(seat.got.length, 4);
    const lines = fs.readFileSync(path.join(seat.root, 'mcp.log'), 'utf8').split('\n').filter(Boolean);
    assert.match(lines[2], /^\S+ browser looped \d+ms$/);
    assert.match(lines[3], /^\S+ browser looped \d+ms$/);
  } finally { await seat.close(); }
  const answers = [{ ok: false, status: 'refused', error: 'no' }, { ok: true, status: 'ok', reply: 'yes' }];
  const ok = await fakeSeat((r, c, i) => answers[i === 1 ? 1 : 0]);
  try {
    const s = server(ok, { now: () => t });
    const a = { verb: 'read', service: 'svc' };
    await s.handle(call(1, a));
    assert.strictEqual((await s.handle(call(2, a))).result.content[0].text, 'yes');
    await s.handle(call(3, a));
    await s.handle(call(4, a));
    assert.strictEqual(ok.got.length, 4);
    const r5 = await s.handle(call(5, a));
    assert.strictEqual(ok.got.length, 4);
    assert.strictEqual(r5.result.content[0].text, 'the same call failed 3 times — stop retrying: no');
  } finally { await ok.close(); }
});

test('the loop key canonicalises key order but not absent-vs-empty values', async () => {
  const seat = await fakeSeat(() => ({ ok: false, status: 'refused', error: 'no' }));
  try {
    const s = server(seat, { now: () => 5000 });
    await s.handle(call(1, { verb: 'read', service: 'svc' }));
    await s.handle(call(2, { service: 'svc', verb: 'read' }));
    const r3 = await s.handle(call(3, { verb: 'read', service: 'svc' }));
    assert.strictEqual(seat.got.length, 2);
    assert.strictEqual(r3.result.content[0].text, 'the same call failed 3 times — stop retrying: no');
    await s.handle(call(4, { verb: 'read', service: 'svc', bracket: [] }));
    assert.strictEqual(seat.got.length, 3);
  } finally { await seat.close(); }
});

test('an invalid answer is not counted by the loop breaker', async () => {
  const seat = await fakeSeat(() => ({ ok: false, status: 'invalid', error: 'body must be one line' }));
  try {
    const s = server(seat, { now: () => 5000 });
    const a = { verb: 'note', service: 'svc', body: 'x\ny' };
    for (let i = 0; i < 3; i++) {
      const r = await s.handle(call(i, a));
      assert.strictEqual(r.result.content[0].text, 'invalid: body must be one line');
    }
    assert.strictEqual(seat.got.length, 3);
  } finally { await seat.close(); }
});

test('the server exits when its parent changes, polled every 5 s; the catalog is polled every 2 s', () => {
  const ticks = [];
  let exited = null;
  const s = server(null, { setInterval: (fn, ms) => { ticks.push([fn, ms]); return null; }, onExit: (c) => { exited = c; } });
  assert.deepStrictEqual(ticks.map(([, ms]) => ms), [5000, 2000]);
  assert.strictEqual(ticks[1][0], s.pollCatalog);
  ticks[0][0]();
  assert.strictEqual(exited, null);
  const d = Object.getOwnPropertyDescriptor(process, 'ppid');
  Object.defineProperty(process, 'ppid', { ...d, value: d.value + 1 });
  try { ticks[0][0](); } finally { Object.defineProperty(process, 'ppid', d); }
  assert.strictEqual(exited, 0);
  s.stop();
  const src = fs.readFileSync(SERVER, 'utf8');
  assert.ok(src.includes('process.ppid'));
  assert.match(src, /setInterval\(\(\) => \{ if \(process\.ppid !== parent\) stop\(\); \}, PPID_POLL_MS\)/);
  assert.match(src, /const PPID_POLL_MS = 5000;/);
  assert.match(src, /const CATALOG_POLL_MS = 2000;/);
});

test('stop clears both intervals', () => {
  const cleared = [];
  let n = 0;
  const s = server(null, { setInterval: () => ++n, clearInterval: (h) => cleared.push(h) });
  s.stop();
  assert.deepStrictEqual(cleared, [1, 2]);
});

test('list_changed is announced on a rev change, only after initialize', async () => {
  const seat = await fakeSeat(() => undefined);
  const other = { name: 'other', description: 'd', inputSchema: { type: 'object' } };
  const NOTE = '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n';
  try {
    const s = server(seat);
    s.pollCatalog();
    assert.strictEqual(s.output.buf, '');
    fs.writeFileSync(seat.catalogPath, catalog('r2', [other]));
    s.pollCatalog();
    assert.strictEqual(s.output.buf, '');
    assert.deepStrictEqual(await list(s), [other]);
    await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    fs.writeFileSync(seat.catalogPath, catalog('r3'));
    s.pollCatalog();
    assert.strictEqual(s.output.buf, NOTE);
    const later = new Date(Date.now() + 10000);
    fs.writeFileSync(seat.catalogPath, catalog('r3'));
    fs.utimesSync(seat.catalogPath, later, later);
    s.pollCatalog();
    s.pollCatalog();
    assert.strictEqual(s.output.buf, NOTE);
    fs.unlinkSync(seat.catalogPath);
    s.pollCatalog();
    assert.strictEqual(s.output.buf, NOTE + NOTE);
    assert.deepStrictEqual(await list(s), []);
    fs.writeFileSync(seat.catalogPath, catalog('r3'));
    s.pollCatalog();
    assert.strictEqual(s.output.buf, NOTE + NOTE + NOTE);
    const fresh = server(seat);
    await fresh.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    fresh.pollCatalog();
    assert.strictEqual(fresh.output.buf, '');
  } finally { await seat.close(); }
});

test('spawned: answers on stdout with protocol only and exits 0 on stdin end with a call still pending', { timeout: 6000 }, async () => {
  const seat = await fakeSeat(() => 'hang');
  try {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, CLODEX_INTENT_SOCK: seat.sockPath, CLODEX_INTENT_CRED: CRED },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const exited = new Promise((r) => child.on('exit', (code) => r(code)));
    const lines = () => out.split('\n').filter(Boolean);
    const twoLines = new Promise((r) => child.stdout.on('data', (d) => { out += d; if (lines().length >= 2) r(); }));
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    await twoLines;
    child.stdin.write(JSON.stringify(call(3, { verb: 'read', service: 'svc' })) + '\n');
    while (seat.got.length < 1) await new Promise((r) => setImmediate(r));
    child.stdin.end();
    assert.strictEqual(await exited, 0);
    const parsed = lines().map((l) => JSON.parse(l));
    assert.ok(parsed.every((m) => m.jsonrpc === '2.0'));
    assert.deepStrictEqual(parsed.map((m) => m.id), [1, 2]);
    assert.strictEqual(parsed[1].result.tools[0].name, 'browser');
    assert.strictEqual(seat.got.length, 1);
  } finally { await seat.close(); }
});

test('spawned: a catalog rev change reaches stdout as list_changed within the real poll', { timeout: 10000 }, async () => {
  const seat = await fakeSeat(() => ({ ok: true, status: 'ok', reply: 'done' }));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CLODEX_INTENT_SOCK: seat.sockPath, CLODEX_INTENT_CRED: CRED },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise((r) => child.on('exit', r));
  try {
    let out = '';
    const waiters = [];
    const lines = () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let closed = false;
    const wake = () => { for (const w of waiters.splice(0)) w(); };
    child.stdout.on('data', (d) => { out += d; wake(); });
    child.stdout.on('close', () => { closed = true; wake(); });
    const until = async (pred) => { while (!pred(lines()) && !closed) await new Promise((r) => waiters.push(r)); assert.ok(pred(lines()), out); };
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    child.stdin.write(JSON.stringify(call(3, { verb: 'read', service: 'svc' })) + '\n');
    await until((ls) => ls.length >= 3);
    const [init, listed] = lines();
    assert.strictEqual(init.result.protocolVersion, '2025-03-26');
    assert.deepStrictEqual(init.result.capabilities, { tools: { listChanged: true } });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(listed.result.tools)), [LISTED]);
    assert.deepStrictEqual(seat.got, [{ cred: CRED, tool: 'browser', args: { verb: 'read', service: 'svc' } }]);
    fs.writeFileSync(seat.catalogPath, catalog('r2', []));
    const bound = setTimeout(() => child.kill(), 4000);
    try {
      await until((ls) => ls.some((m) => m.method === 'notifications/tools/list_changed'));
    } finally { clearTimeout(bound); }
    const note = lines().find((m) => m.method === 'notifications/tools/list_changed');
    assert.deepStrictEqual(note, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  } finally {
    child.stdin.end();
    await exited;
    await seat.close();
  }
});

test('the server requires nothing above cli/bin', () => {
  const src = fs.readFileSync(SERVER, 'utf8');
  const reqs = [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.deepStrictEqual(reqs.sort(), ['./clodex.js', 'fs', 'path', 'readline']);
  assert.ok(!src.includes("require('../"));
});

test('cli/package.json ships clodex-mcp as a bin', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cli', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.bin['clodex-mcp'], 'bin/clodex-mcp.js');
  assert.ok(fs.statSync(SERVER).mode & 0o111);
});

test('a stdout error (EPIPE after the parent died) stops the server quietly', async () => {
  const { Writable } = require('node:stream');
  const output = new Writable({ write: (chunk, enc, cb) => cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })) });
  const input = new PassThrough();
  let exited = null;
  mcp.createServer({ env: {}, input, output, errOut: sink(), setInterval: () => null, onExit: (c) => { exited = c; } });
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  for (let i = 0; i < 200 && exited === null; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(exited, 0);
  input.end();
});
