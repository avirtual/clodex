'use strict';

const { test, after } = require('node:test');
require('./lib/engine-isolation');
const assert = require('node:assert');
const path = require('path');
const { mkTmpRoot } = require('./lib/tmp-roots');

const { readScrollback, TAIL_DEFAULT, TAIL_MAX, READ_CAP, PATTERN_MAX } = require('../term-read');
const { createDrawerPtys } = require('../drawer-pty');
const registry = require('../intent-registry');

const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);

const numbered = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const body = (text) => text.split('\n').slice(1);

test('bare read is tail 50 and tail N clamps to 1..400', () => {
  const raw = numbered(1000);
  const bare = readScrollback(raw, '');
  assert.ok(bare.ok);
  assert.strictEqual(TAIL_DEFAULT, 50);
  assert.deepStrictEqual(body(bare.text), Array.from({ length: 50 }, (_, i) => `line ${951 + i}`));
  assert.match(bare.text, /^tail 50: last 50 of 1000 lines\n/);
  assert.strictEqual(body(readScrollback(raw, 'tail').text).length, 50);
  const big = readScrollback(raw, 'tail 9999');
  assert.strictEqual(TAIL_MAX, 400);
  assert.strictEqual(body(big.text).length, 400);
  assert.strictEqual(body(big.text)[0], 'line 601');
  assert.deepStrictEqual(body(readScrollback(raw, 'tail 0').text), ['line 1000']);
  assert.deepStrictEqual(body(readScrollback(raw, 'tail 3').text), ['line 998', 'line 999', 'line 1000']);
  assert.strictEqual(readScrollback(raw, 'tail many').ok, false);
});

test('grep numbers matches from the end of the buffer, L1 the most recent, and keeps the last 50', () => {
  const raw = 'ok a\nERR one\nok b\nERR two\nok c\n';
  const r = readScrollback(raw, 'grep ^ERR');
  assert.ok(r.ok);
  assert.deepStrictEqual(body(r.text), ['L4: ERR one', 'L2: ERR two']);
  const many = readScrollback(numbered(200), 'grep line');
  const rows = body(many.text);
  assert.strictEqual(rows.length, 50);
  assert.strictEqual(rows[49], 'L1: line 200');
  assert.strictEqual(rows[0], 'L50: line 151');
  assert.match(many.text, /last 50 of 200 matching/);
  assert.match(readScrollback(raw, 'grep nomatch').text, /no line matches/);
});

test('ANSI escapes and carriage returns are stripped before tail and grep', () => {
  const raw = `${ESC}[31mred${ESC}[0m text${CR}\n${ESC}]0;title\u0007plain${CR}\n`;
  const r = readScrollback(raw, 'tail 5');
  assert.deepStrictEqual(body(r.text), ['red text', 'plain']);
  assert.ok(!r.text.includes(ESC) && !r.text.includes(CR));
  assert.deepStrictEqual(body(readScrollback(raw, 'grep red text$').text), ['L2: red text']);
});

test('the answer is capped at 16 KB from the head and the truncation is stated', () => {
  const raw = Array.from({ length: 400 }, (_, i) => `${String(i).padStart(4, '0')} ${'x'.repeat(95)}`).join('\n');
  const r = readScrollback(raw, 'tail 400');
  assert.ok(r.ok);
  const [head, note, ...rest] = r.text.split('\n');
  assert.match(head, /^tail 400/);
  assert.strictEqual(note, `(truncated: only the last ${READ_CAP} characters are shown)`);
  assert.strictEqual(rest[0], '…');
  assert.strictEqual(rest.slice(1).join('\n').length, READ_CAP);
  assert.ok(r.text.endsWith(`0399 ${'x'.repeat(95)}`));
  assert.ok(!readScrollback(numbered(10), 'tail 10').text.includes('truncated'));
});

test('a bad or oversized pattern is refused, and a runaway one is cut off by the budget', () => {
  const bad = readScrollback('a\n', 'grep (unclosed');
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /^bad pattern: Invalid regular expression/);
  const long = readScrollback('a\n', `grep ${'a'.repeat(PATTERN_MAX + 1)}`);
  assert.strictEqual(long.ok, false);
  assert.match(long.error, /limit is 200/);
  assert.strictEqual(readScrollback('a\n', 'grep').ok, false);
  const slow = readScrollback(`${'a'.repeat(40)}\n`, 'grep (a+)+b', { timeoutMs: 20 });
  assert.strictEqual(slow.ok, false);
  assert.match(slow.error, /took longer than 20 ms/);
});

function fakeSpawn() {
  const procs = [];
  const spawn = () => {
    const p = { pid: 4242, onData(fn) { p.data = fn; }, onExit() {}, write() {}, resize() {}, kill() {} };
    procs.push(p);
    return p;
  };
  spawn.procs = procs;
  return spawn;
}

test('drawer-pty read returns the seat record\'s raw scrollback and an empty string with no record', () => {
  const spawn = fakeSpawn();
  const w = createDrawerPtys({ spawn, send() {}, shell: '/bin/sh', cwdFor: () => '/tmp', env: {}, log: { info() {}, warn() {}, error() {} }, withUtf8Charset: (e) => e });
  assert.strictEqual(w.read('ws', 'alice'), '');
  w.spawn('ws', 'alice', {});
  spawn.procs[0].data(`${ESC}[1mhi${ESC}[0m\r\n`);
  assert.strictEqual(w.read('ws', 'alice'), `${ESC}[1mhi${ESC}[0m\r\n`);
  assert.strictEqual(w.read('ws', 'bob'), '');
});

const engines = [];
function boot(seams, stub) {
  const dp = require('../drawer-pty');
  const orig = dp.createDrawerPtys;
  if (stub) dp.createDrawerPtys = () => stub;
  const tmp = mkTmpRoot('clx-term-read-');
  let engine;
  try {
    engine = require('./lib/engine-isolation').createEngine({
      userDataPath: tmp,
      seams: { noSeed: true, registryDir: path.join(tmp, 'clodex-home'), ...seams },
      log: { info() {}, warn() {}, error() {} },
    });
  } finally { dp.createDrawerPtys = orig; }
  engine.manager._broadcast = () => {};
  engines.push(engine);
  return engine;
}
after(() => {
  for (const e of engines) { try { e.shutdown(); } catch {} }
  setImmediate(() => process.exit(0));
});

function ask(engine, sub, text) {
  const injected = [];
  engine.manager._injectText = (s, t) => injected.push(t);
  engine.manager._handleTermIntent({ name: 'alice', type: 'claude', agentType: 'claude', workspaceId: 'ws-1' }, sub, text);
  assert.strictEqual(injected.length, 1, 'ENTER: the agent was answered once');
  return injected[0];
}

test('term read through the manager answers in-turn from the seat\'s own record, and refuses with no record or no terminals', () => {
  const reads = [];
  const stub = { scrollback: '', read: (ws, seat) => { reads.push([ws, seat]); return stub.scrollback; }, exec() { throw new Error('read must not exec'); }, dispose() {} };
  const engine = boot({}, stub);
  assert.strictEqual(ask(engine, 'read', 'tail 3'), '[agent:term] no terminal: open your terminal tab first');
  stub.scrollback = `$ make\r\n${ESC}[32mbuilt${ESC}[0m\r\nall good\r\n`;
  assert.strictEqual(ask(engine, 'read', 'tail 3'), '[term read] tail 3: last 3 of 3 lines\n$ make\nbuilt\nall good');
  assert.deepStrictEqual(reads, [['ws-1', 'alice'], ['ws-1', 'alice']]);
  assert.match(ask(engine, 'read', 'grep ('), /^\[agent:term\] bad pattern: /);
  assert.strictEqual(registry.classifyReplyLine('term', '[term read] tail 3: last 3 of 3 lines'), 'ok');
  const headless = boot({ enableLocalTerminal: false });
  assert.strictEqual(ask(headless, 'read', ''), '[agent:term] no terminal on this host');
});

test('a successful term read broadcasts a term ipc-message carrying the reply\'s first line; a refused one does not', () => {
  const stub = { scrollback: '', read: () => stub.scrollback, exec() { throw new Error('read must not exec'); }, dispose() {} };
  const engine = boot({}, stub);
  const sent = [];
  engine.manager._broadcast = (ch, msg) => sent.push([ch, msg]);
  ask(engine, 'read', 'tail 3');
  assert.deepStrictEqual(sent, [], 'ENTER: a refused read is not broadcast');
  stub.scrollback = 'one\r\ntwo\r\n';
  ask(engine, 'read', 'tail 2');
  assert.deepStrictEqual(sent, [['ipc-message', { type: 'term', from: 'alice', to: 'alice', body: '[term read] tail 2: last 2 of 2 lines' }]]);
});

test('term_read tool: owned by the term row, closed schema, tail and grep map to the verb and are exclusive', () => {
  const { TERM_READ_TOOL } = registry;
  assert.strictEqual(registry.toolRowFor('term_read'), registry.rowFor('term'));
  assert.deepStrictEqual(TERM_READ_TOOL.inputSchema, { type: 'object', properties: { tail: { type: 'number' }, grep: { type: 'string' } }, additionalProperties: false });
  assert.strictEqual(TERM_READ_TOOL.subagentOk, undefined);
  assert.deepStrictEqual(TERM_READ_TOOL.logKeys, []);
  assert.strictEqual(TERM_READ_TOOL.toIntent({}), '[agent:term read]');
  assert.strictEqual(TERM_READ_TOOL.toIntent({ tail: 3 }), '[agent:term read] tail 3');
  assert.strictEqual(TERM_READ_TOOL.toIntent({ grep: ' ERR ' }), '[agent:term read] grep ERR');
  assert.throws(() => TERM_READ_TOOL.toIntent({ tail: 3, grep: 'x' }), { message: 'give tail or grep, not both' });
  assert.throws(() => TERM_READ_TOOL.toIntent({ tail: 1.5 }), { message: 'tail must be a whole number' });
  assert.throws(() => TERM_READ_TOOL.toIntent({ command: 'ls' }), /unknown argument: command/);
  const out = registry.toolIntentFor('term_read', { grep: 'a]b' });
  const { scanIntentLines } = require('../intent-segments');
  const parsed = scanIntentLines([out.text], {}).filter((s) => s.kind === 'intent').map((s) => s.intent);
  assert.deepStrictEqual(parsed.map((i) => [i.type, i.sub, i.body]), [['term', 'read', 'grep a]b']]);
});
