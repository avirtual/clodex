'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawnStreamSeat, parseLstart, groupKill } = require('../stream-seat');

function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.written = [];
  child.stdin = new Writable({
    write(chunk, _enc, cb) { child.written.push(String(chunk)); cb(); },
  });
  return child;
}

function start(extra = {}) {
  const child = fakeChild(extra);
  const lines = [];
  const events = [];
  const spawned = [];
  const seat = spawnStreamSeat({
    cmd: 'claude',
    args: ['-p'],
    cwd: '/tmp',
    env: { A: '1' },
    spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return child; },
    startTimeOf: () => 1790000000000,
    now: () => 1790000000123,
    onLine: (obj) => { lines.push(obj); events.push(['line', obj.type]); },
    onExit: (code, signal) => events.push(['exit', code, signal]),
    onClose: (code, signal) => events.push(['close', code, signal]),
    ...extra.opts,
  });
  return { child, seat, lines, events, spawned };
}

const tick = () => new Promise((r) => setImmediate(r));

test('ENTER: spawns detached with three pipes and records both start times', () => {
  const { seat, spawned } = start();
  assert.deepStrictEqual(spawned, [{
    cmd: 'claude',
    args: ['-p'],
    opts: { cwd: '/tmp', env: { A: '1' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true },
  }]);
  assert.deepStrictEqual({ pid: seat.pid, startedAt: seat.startedAt, startTime: seat.startTime },
    { pid: 4242, startedAt: 1790000000123, startTime: 1790000000000 });
});

test('(a) a JSON line split across three chunks parses once', async () => {
  const { child, lines } = start();
  child.stdout.write('{"type":"sys');
  child.stdout.write('tem","subtype":"in');
  child.stdout.write('it","session_id":"abc"}\n');
  await tick();
  assert.deepStrictEqual(lines, [{ type: 'system', subtype: 'init', session_id: 'abc' }]);
});

test('(a2) a multi-byte character split between chunks survives', async () => {
  const { child, lines } = start();
  const buf = Buffer.from('{"type":"x","t":"é"}\n', 'utf8');
  const cut = buf.indexOf(0xc3) + 1;
  child.stdout.write(buf.subarray(0, cut));
  child.stdout.write(buf.subarray(cut));
  await tick();
  assert.deepStrictEqual(lines, [{ type: 'x', t: 'é' }]);
});

test('(b) a 500 KB single line parses as one line', async () => {
  const { child, lines } = start();
  const big = 'z'.repeat(500 * 1024);
  const text = `${JSON.stringify({ type: 'user', blob: big })}\n`;
  for (let i = 0; i < text.length; i += 65536) child.stdout.write(text.slice(i, i + 65536));
  await tick();
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(lines[0], { type: 'user', blob: big });
});

test('unparsable lines are skipped and counted, parsing continues', async () => {
  const warned = [];
  const { child, lines, seat } = start({ opts: { log: { warn: (tag, msg) => warned.push([tag, msg]) } } });
  child.stdout.write('not json\n{"type":"ok"}\n');
  await tick();
  assert.deepStrictEqual(lines, [{ type: 'ok' }]);
  assert.strictEqual(seat.skipped, 1);
  assert.deepStrictEqual(warned, [['stream-seat', 'pid 4242: skipped unparsable stdout line (8 chars, 1 so far)']]);
});

test('send writes one JSON line terminated by a newline', async () => {
  const { child, seat } = start();
  await seat.send({ type: 'user', message: { role: 'user', content: 'hi' } });
  assert.deepStrictEqual(child.written, ['{"type":"user","message":{"role":"user","content":"hi"}}\n']);
});

test('(c) send after exit rejects with EPIPE and does not throw', async () => {
  const { child, seat } = start();
  child.emit('exit', 0, null);
  let p;
  assert.doesNotThrow(() => { p = seat.send({ type: 'user' }); });
  await assert.rejects(p, (err) => err.code === 'EPIPE');
  assert.deepStrictEqual(child.written, []);
});

test('(d) onClose fires only after both exit and close, after a trailing result line', async () => {
  const { child, events } = start();
  child.stdout.write('{"type":"result"}');
  await tick();
  child.emit('exit', 0, null);
  assert.deepStrictEqual(events, [['exit', 0, null]]);
  child.stdout.end();
  await tick();
  child.emit('close', 0, null);
  assert.deepStrictEqual(events, [['exit', 0, null], ['line', 'result'], ['close', 0, null]]);
});

test('(d2) close before exit still waits for exit', async () => {
  const { child, events } = start();
  child.stdout.write('{"type":"result"}\n');
  await tick();
  child.emit('close', 1, null);
  assert.deepStrictEqual(events, [['line', 'result'], ['exit', 1, null], ['close', 1, null]]);
  child.emit('exit', 1, null);
  assert.deepStrictEqual(events, [['line', 'result'], ['exit', 1, null], ['close', 1, null]]);
});

test('(e) kill signals the process group with SIGTERM, then SIGKILL after 5s', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const realKill = process.kill;
  const calls = [];
  process.kill = (pid, sig) => { calls.push({ pid, sig }); };
  try {
    const { seat } = start();
    seat.kill();
    assert.deepStrictEqual(calls, [{ pid: -4242, sig: 'SIGTERM' }]);
    mock.timers.tick(4999);
    assert.deepStrictEqual(calls, [{ pid: -4242, sig: 'SIGTERM' }]);
    mock.timers.tick(1);
    assert.deepStrictEqual(calls, [{ pid: -4242, sig: 'SIGTERM' }, { pid: -4242, sig: 'SIGKILL' }]);
  } finally {
    process.kill = realKill;
    mock.timers.reset();
  }
});

test('groupKill refuses a non-positive pid', () => {
  const realKill = process.kill;
  const calls = [];
  process.kill = (pid, sig) => { calls.push({ pid, sig }); };
  try {
    assert.deepStrictEqual([groupKill(0, 'SIGTERM'), groupKill(-1, 'SIGTERM'), groupKill(undefined, 'SIGKILL')],
      [false, false, false]);
    assert.deepStrictEqual(calls, []);
  } finally {
    process.kill = realKill;
  }
});

test('parseLstart reads ps -o lstart= output, padded day included', () => {
  assert.deepStrictEqual(
    [parseLstart('Thu Sep 24 17:41:33 2026\n'), parseLstart('Thu Sep  4 07:01:03 2026'), parseLstart('')],
    [new Date(2026, 8, 24, 17, 41, 33).getTime(), new Date(2026, 8, 4, 7, 1, 3).getTime(), null]);
});
