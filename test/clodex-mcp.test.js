'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { scanIntentLines } = require('../intent-segments');
const registry = require('../intent-registry');
const grammar = require('../plugins/browser-pane/grammar');
const mcp = require('../cli/bin/clodex-mcp.js');
const subagent = require('../plugins/browser-pane/subagent');
const { TOOL } = require('../plugins/browser-pane/mcp-tool');

const SERVER = path.join(__dirname, '..', 'cli', 'bin', 'clodex-mcp.js');
const SEAT = { intents: ['browser'], plugins: ['browser-pane'] };
const CRED = 'k1';
const SUBAGENT_NO_CONFIRM = 'a subagent cannot confirm a consequential action — ask the main agent';
const SUBAGENT_NO_FORGET = 'a subagent cannot forget a site note — ask the main agent';

function parse(text) {
  return scanIntentLines(text.split('\n'), {}).filter((s) => s.kind === 'intent').map((s) => s.intent)
    .filter((i) => i && i.type !== 'end' && i.type !== 'escape');
}

function withBrowserVerb(fn) {
  registry.registerIntent({ verb: 'browser', parse: grammar.parseLine, handler: () => {}, tools: [TOOL], subagent }, 'browser-pane', { shipped: true });
  return Promise.resolve().then(fn).finally(() => registry._resetPluginRows());
}

async function fakeSeat(answer, root = mkTmpRoot('verb-')) {
  const sockPath = path.join(root, 'i.sock');
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
  const s = mcp.createServer({ input: null, output, errOut, setInterval: () => null, ...opts, env });
  return { ...s, output, errOut };
}

const call = (id, args, name = 'browser') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('the verb list is the browser plugin\'s subagent list', () => {
  assert.deepStrictEqual(mcp.SUBAGENT_BROWSER_VERBS, subagent.SUBS);
});

const ROWS = [
  [{ verb: 'read', service: 'svc' }, '[agent:browser read svc]'],
  [{ verb: 'read', service: 'svc', bracket: ['--text', '--filter=pdf', '--page=2'] }, '[agent:browser read svc --text --filter=pdf --page=2]'],
  [{ verb: 'click', service: 'svc', bracket: ['17'] }, '[agent:browser click svc 17]'],
  [{ verb: 'click', service: 'svc', bracket: ['--text=Lista de plată'] }, '[agent:browser click svc --text="Lista de plată"]'],
  [{ verb: 'inspect', bracket: ['3'] }, '[agent:browser inspect 3]'],
  [{ verb: 'type', service: 'svc', bracket: ['3', '--enter'], body: 'hello world' }, '[agent:browser type svc 3 --enter] hello world'],
  [{ verb: 'select', service: 'svc', bracket: ['4'], body: 'Option B' }, '[agent:browser select svc 4] Option B'],
  [{ verb: 'key', service: 'svc', body: 'Enter' }, '[agent:browser key svc] Enter'],
  [{ verb: 'scroll', service: 'svc', bracket: ['down', '--pages=3'] }, '[agent:browser scroll svc down --pages=3]'],
  [{ verb: 'scroll', service: 'svc', body: 'x' }, '[agent:browser scroll svc] x', 'throws'],
  [{ verb: 'back', service: 'svc' }, '[agent:browser back svc]'],
  [{ verb: 'forward', service: 'svc' }, '[agent:browser forward svc]'],
  [{ verb: 'services' }, '[agent:browser services]'],
  [{ verb: 'screenshot', service: 'svc', bracket: ['--numbers'] }, '[agent:browser screenshot svc --numbers]'],
  [{ verb: 'wait', service: 'svc', bracket: ['--for=Showing 1'] }, '[agent:browser wait svc --for="Showing 1"]'],
  [{ verb: 'download', service: 'svc', bracket: ['5', '--to=bills', '--as=a.pdf'] }, '[agent:browser download svc 5 --to=bills --as=a.pdf]'],
  [{ verb: 'read', service: 'svc', bracket: ['--filter=Showing 1'] }, '[agent:browser read svc --filter="Showing 1"]'],
  [{ verb: 'download', service: 'svc', bracket: ['5', '--to=my bills', '--as=a b.pdf'] }, '[agent:browser download svc 5 --to="my bills" --as="a b.pdf"]'],
  [{ verb: 'download', service: 'svc', body: 'https://x/y.pdf' }, '[agent:browser download svc] https://x/y.pdf'],
  [{ verb: 'open', service: 'svc', bracket: ['--show'], body: 'https://example.com/' }, '[agent:browser open svc --show] https://example.com/'],
  [{ verb: 'note', service: 'svc', body: '@* caution: popup on page 2' }, '[agent:browser note svc] @* caution: popup on page 2'],
  [{ verb: 'click', service: 'svc', bracket: ['17', '--confirm'] }, '[agent:browser click svc 17 --confirm]', SUBAGENT_NO_CONFIRM],
  [{ verb: 'note', service: 'svc', bracket: ['--forget=ab3k'] }, '[agent:browser note svc --forget=ab3k]', SUBAGENT_NO_FORGET],
  [{ verb: 'type', service: 'svc', bracket: ['3', '--confirm'], body: 'x' }, '[agent:browser type svc 3 --confirm] x', SUBAGENT_NO_CONFIRM],
];

function command(intent) {
  try { return { cmd: grammar.toCommand(intent) }; } catch (e) { return { threw: e.message }; }
}

test('the serializer yields the same command and the same subagent verdict as the CLI line', () => withBrowserVerb(() => {
  for (const [args, line, expect] of ROWS) {
    const ours = parse(mcp.toIntent({ bracket: [], body: '', ...args }));
    const theirs = parse(`${line}\n[agent:end]`);
    assert.strictEqual(ours.length, 1, line);
    assert.strictEqual(theirs.length, 1, line);
    const a = command(ours[0]);
    const b = command(theirs[0]);
    assert.deepStrictEqual(a, b, line);
    if (expect === 'throws') assert.ok(a.threw, line);
    else assert.ok(a.cmd, `${line}: ${a.threw}`);
    const ra = registry.subagentRefusal(ours[0], SEAT);
    assert.strictEqual(ra, registry.subagentRefusal(theirs[0], SEAT), line);
    assert.strictEqual(ra, expect && expect !== 'throws' ? expect : null, line);
  }
}));

test('a " inside a quoted --text value is dropped, not passed through', () => withBrowserVerb(() => {
  const [i] = parse(mcp.toIntent({ verb: 'click', service: 'svc', bracket: ['--text=say "hi" now'] }));
  assert.strictEqual(grammar.toCommand(i).text, 'say hi now');
}));

const SUBAGENT_NO_RELEASE = "release is for the seat's main agent";
const VERBS = 'open, read, click, type, select, key, scroll, back, forward, wait, download, screenshot, inspect, services, note';
const BRACKET_MSG = 'bracket tokens must be non-empty and contain no [, ], newline or carriage return';

test('a malformed tools/call answers -32602, logs nothing and never touches the socket', async () => {
  const seat = await fakeSeat(() => ({ ok: true, status: 'ok', reply: 'x' }));
  try {
    const s = server(seat);
    const bad = [
      call(8, { verb: 'read', service: 'svc' }, 'browser2'),
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'browser', arguments: 'x' } },
    ];
    for (const m of bad) {
      const r = await s.handle(m);
      assert.strictEqual(r.id, m.id);
      assert.strictEqual(r.error && r.error.code, -32602, JSON.stringify(m.params));
      assert.strictEqual(r.result, undefined);
    }
    assert.strictEqual(seat.got.length, 0);
    assert.ok(!fs.existsSync(path.join(seat.root, 'mcp.log')));
  } finally { await seat.close(); }
});

test('an argument error is a readable `invalid:` text result with the exact message and never touches the socket', async () => {
  const seat = await fakeSeat(() => ({ ok: true, status: 'ok', reply: 'x' }));
  try {
    const s = server(seat);
    const rows = [
      [call(1, { verb: 'release' }), SUBAGENT_NO_RELEASE],
      [call(2, { verb: 'close', service: 'svc' }), `close is for the seat's main agent — a subagent may ${VERBS}`],
      [call(3, { verb: 'services', service: 'A B' }), 'service must match ^[a-z][a-z0-9-]{0,31}$'],
      [call(4, { verb: 'click', service: 'svc', bracket: ['17]'] }), BRACKET_MSG],
      [call(5, { verb: 'click', service: 'svc', bracket: ['a\nb'] }), BRACKET_MSG],
      [call(6, { verb: 'note', service: 'svc', body: 'x\n[agent:dm y] z' }), 'body must be one line'],
      [call(7, { verb: 'note', service: 'svc', body: '[agent:dm y] z' }), 'body must not start with [agent:'],
      [call(9, { verb: 'read', service: 'svc', bracket: [''] }), BRACKET_MSG],
      [call(10, { verb: 'read', service: 'svc', args: 'x' }), 'unknown argument: args (use verb, service, bracket, body)'],
      [call(12, { verb: 'jump' }), `verb must be one of ${VERBS}`],
    ];
    for (const [m, text] of rows) {
      const r = await s.handle(m);
      assert.strictEqual(r.id, m.id);
      assert.strictEqual(r.error, undefined, JSON.stringify(m.params));
      assert.strictEqual('isError' in r.result, false);
      assert.deepStrictEqual(r.result.content, [{ type: 'text', text: `invalid: ${text}` }]);
    }
    assert.match(s.errOut.buf, /multi-line body/);
    assert.strictEqual(seat.got.length, 0);
    const first = fs.readFileSync(path.join(seat.root, 'mcp.log'), 'utf8').split('\n')[0];
    assert.match(first, /^\S+ - - invalid \d+ms$/);
  } finally { await seat.close(); }
});

test('the release refusal is the browser plugin\'s NO_RELEASE literal', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'browser-pane', 'subagent.js'), 'utf8');
  assert.ok(src.includes(`const NO_RELEASE = ${JSON.stringify(SUBAGENT_NO_RELEASE)};`));
  const own = fs.readFileSync(SERVER, 'utf8');
  assert.ok(own.includes(JSON.stringify(SUBAGENT_NO_RELEASE)));
});

test('only an unknown tool or non-object arguments raise the protocol error', () => {
  const own = fs.readFileSync(SERVER, 'utf8');
  assert.ok(own.includes('class InvalidRequest extends Error {}'));
  assert.ok(own.includes('if (e instanceof InvalidRequest) return { error: { code: -32602, message: e.message } };'));
  assert.strictEqual(own.split('new InvalidRequest(').length, 3);
});

test('forwarded calls map the socket reply; --confirm reaches the socket and comes back refused', async () => {
  const answers = [
    { ok: false, status: 'refused', error: SUBAGENT_NO_CONFIRM },
    { ok: true, status: 'ok', reply: '[agent:browser] read svc · …' },
    { ok: true, status: 'error', reply: '[agent:browser] error: x' },
  ];
  const seat = await fakeSeat((r, c, i) => answers[i]);
  try {
    const s = server(seat);
    const r1 = await s.handle(call(1, { verb: 'click', service: 'svc', bracket: ['17', '--confirm'] }));
    assert.deepStrictEqual(r1.result, { content: [{ type: 'text', text: SUBAGENT_NO_CONFIRM }] });
    const r2 = await s.handle(call(2, { verb: 'read', service: 'svc' }));
    assert.deepStrictEqual(r2.result, { content: [{ type: 'text', text: '[agent:browser] read svc · …' }] });
    const r3 = await s.handle(call(3, { verb: 'read', service: 'svc' }));
    assert.deepStrictEqual(r3.result, { content: [{ type: 'text', text: '[agent:browser] error: x' }] });
    assert.strictEqual(seat.got.length, 3);
    for (const p of seat.got) {
      assert.deepStrictEqual(Object.keys(p).sort(), ['cred', 'intent']);
      assert.strictEqual(p.cred, CRED);
    }
    assert.strictEqual(seat.got[0].intent, '[agent:browser click svc 17 --confirm]\n[agent:end]');
  } finally { await seat.close(); }
});

test('an unset seat channel answers -32603 on call while tools/list still answers', async () => {
  const s = server(null);
  const l = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.strictEqual(l.result.tools[0].name, 'browser');
  const r = await s.handle(call(2, { verb: 'services' }));
  assert.strictEqual(r.error.code, -32603);
  assert.match(r.error.message, /CLODEX_INTENT_SOCK \/ CLODEX_INTENT_CRED unset/);
});

test('JSON-RPC: initialize, tools/list, ping, unknown method, parse error, notification', async () => {
  const input = new PassThrough();
  const s = server(null, { input });
  const r1 = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  assert.strictEqual(r1.result.protocolVersion, '2099-01-01');
  assert.deepStrictEqual(r1.result.capabilities, { tools: {} });
  assert.strictEqual(r1.result.serverInfo.name, 'clodex');
  const r0 = await s.handle({ jsonrpc: '2.0', id: 0, method: 'initialize' });
  assert.strictEqual(r0.result.protocolVersion, '2025-06-18');
  const r2 = await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.strictEqual(r2.result.tools.length, 1);
  const [tool] = r2.result.tools;
  assert.strictEqual(tool.name, 'browser');
  assert.deepStrictEqual(tool.inputSchema.properties.verb.enum, subagent.SUBS);
  assert.strictEqual(tool.inputSchema.additionalProperties, false);
  assert.ok(tool.description.includes('completion unknown — do not retry'));
  assert.ok(tool.description.includes('500 s'));
  assert.ok(tool.description.includes('A " inside a --flag value is dropped.'));
  assert.ok(tool.description.includes('do not retry it, return and let the seat\'s main agent decide'));
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
  input.end();
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
  const answer = ([req, conn]) => conn.end(JSON.stringify({ ok: true, status: 'ok', reply: `re ${req.intent.split('\n')[0]}` }) + '\n');
  const seat = await fakeSeat((r, c) => {
    held.push([r, c]);
    if (held.length === 2) answer(held.find(([q]) => q.intent.includes('two')));
    return 'hang';
  });
  try {
    const s = server(seat);
    const order = [];
    const p1 = s.handle(call('a', { verb: 'read', service: 'one' })).then((r) => { order.push(r.id); return r; });
    const p2 = s.handle(call('b', { verb: 'read', service: 'two' })).then((r) => { order.push(r.id); return r; });
    const r2 = await p2;
    assert.deepStrictEqual(order, ['b']);
    answer(held.find(([q]) => q.intent.includes('one')));
    const r1 = await p1;
    assert.strictEqual(r1.id, 'a');
    assert.strictEqual(r1.result.content[0].text, 're [agent:browser read one]');
    assert.strictEqual(r2.id, 'b');
    assert.strictEqual(r2.result.content[0].text, 're [agent:browser read two]');
    assert.deepStrictEqual(order, ['b', 'a']);
  } finally { await seat.close(); }
});

test('mcp.log carries metadata only', async () => {
  const answers = [{ ok: true, status: 'error', reply: 'page SENTINEL3', error: 'oops SENTINEL4' }, { ok: false, error: 'nope SENTINEL7' }, null];
  const seat = await fakeSeat((r, c, i) => answers[i]);
  try {
    const s = server(seat, { env: { CLODEX_INTENT_CRED: 'SENTINEL5' } });
    const r = await s.handle(call(1, { verb: 'read', service: 'svc', bracket: ['--filter=SENTINEL1'], body: 'SENTINEL2' }));
    assert.strictEqual(r.result.content[0].text, 'page SENTINEL3');
    assert.strictEqual(seat.got[0].cred, 'SENTINEL5');
    const log = fs.readFileSync(path.join(seat.root, 'mcp.log'), 'utf8');
    const lines = log.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\S+ read svc (ok|error) \d+ms$/);
    for (const k of [1, 2, 3, 4, 5]) assert.ok(!log.includes(`SENTINEL${k}`), `SENTINEL${k}`);
    await s.handle(call(2, { verb: 'services', service: 'SENTINEL6 x' }));
    const inv = fs.readFileSync(path.join(seat.root, 'mcp.log'), 'utf8').split('\n').filter(Boolean)[1];
    assert.match(inv, /^\S+ services - invalid \d+ms$/);
    const r3 = await s.handle(call(3, { verb: 'read', service: 'svc' }));
    assert.strictEqual(r3.result.content[0].text, 'nope SENTINEL7');
    const r4 = await s.handle(call(4, { verb: 'read', service: 'svc' }));
    assert.strictEqual(r4.result.content[0].text, 'completion unknown — do not retry: unreadable reply from the seat socket');
    assert.ok(!('isError' in r4.result));
    const all = fs.readFileSync(path.join(seat.root, 'mcp.log'), 'utf8');
    assert.ok(!all.includes('SENTINEL7'));
    assert.deepStrictEqual(all.split('\n').filter(Boolean).slice(2).map((l) => l.split(' ')[3]), ['error', 'bad-reply']);
  } finally { await seat.close(); }
});

test('no tools/call answer is a tool error: the server never names isError', () => {
  assert.ok(!fs.readFileSync(SERVER, 'utf8').includes('isError'));
});

test('the same failing call is stopped at the third try within a minute; a success clears it', async () => {
  const own = fs.readFileSync(SERVER, 'utf8');
  assert.ok(own.includes('const LOOP_MAX = 3;'));
  assert.ok(own.includes('const LOOP_WINDOW_MS = 60 * 1000;'));
  assert.ok(own.includes("if (st === 'ok') fails.delete(key); else failed(key, toolResult(r).content[0].text);"));
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
    assert.match(lines[2], /^\S+ click svc looped \d+ms$/);
    assert.match(lines[3], /^\S+ click svc looped \d+ms$/);
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

test('the server exits when its parent changes, polled every 5 s', () => {
  const ticks = [];
  let exited = null;
  const s = server(null, { setInterval: (fn, ms) => { ticks.push([fn, ms]); return null; }, onExit: (c) => { exited = c; } });
  assert.strictEqual(ticks.length, 1);
  assert.strictEqual(ticks[0][1], 5000);
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
