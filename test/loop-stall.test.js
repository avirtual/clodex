'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createLoopStall } = require('../loop-stall');

const WALL0 = Date.parse('2026-11-23T04:00:00.000Z');

function rig() {
  const lines = [];
  const timers = new Map();
  let nextId = 1;
  let unrefs = 0;
  let mono = 1000;
  const ls = createLoopStall({
    log: { warn: (tag, msg) => lines.push(`${tag}: ${msg}`) },
    now: () => mono,
    wallNow: () => WALL0 + mono,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return { id, unref() { unrefs++; } };
    },
    clearTimer: (h) => { timers.delete(h.id); },
  });
  const fn = () => [...timers.values()][0].fn;
  return {
    ls, lines, timers,
    unrefs: () => unrefs,
    tick(lateMs) { const f = fn(); mono += 500 + lateMs; f(); },
    tickWith(f, lateMs) { mono += 500 + lateMs; f(); },
    fn,
  };
}

test('ticks on time: no line and zero stats; the timer is armed at 500 ms and unref\'d', () => {
  const r = rig();
  r.ls.start();
  assert.strictEqual(r.timers.size, 1);
  assert.strictEqual([...r.timers.values()][0].ms, 500);
  assert.strictEqual(r.unrefs(), 1);
  for (let i = 0; i < 5; i++) r.tick(0);
  r.tick(12);
  assert.deepStrictEqual(r.lines, []);
  assert.deepStrictEqual(r.ls.stats(), { stalls: 0, longestMs: 0, lastAt: null });
});

test('one tick 2300 ms late logs the literal line and counts it', () => {
  const r = rig();
  r.ls.start();
  r.tick(2300);
  assert.deepStrictEqual(r.lines, ['loop: main process blocked for 2300 ms (ended 2026-11-23T04:00:03.800Z)']);
  assert.deepStrictEqual(r.ls.stats(), { stalls: 1, longestMs: 2300, lastAt: WALL0 + 3800 });
});

test('999 ms late is quiet, 1000 ms late logs', () => {
  const r = rig();
  r.ls.start();
  r.tick(999);
  assert.deepStrictEqual(r.lines, []);
  r.tick(1000);
  assert.strictEqual(r.lines.length, 1);
  assert.match(r.lines[0], /^loop: main process blocked for 1000 ms \(ended /);
});

test('stalls inside 10 s are held and carried on the next line after the window', () => {
  const r = rig();
  r.ls.start();
  r.tick(1200);
  assert.deepStrictEqual(r.lines, ['loop: main process blocked for 1200 ms (ended 2026-11-23T04:00:02.700Z)']);
  r.tick(4000);
  r.tick(1500);
  assert.strictEqual(r.lines.length, 1);
  assert.deepStrictEqual(r.ls.stats(), { stalls: 3, longestMs: 4000, lastAt: WALL0 + 9200 });
  for (let i = 0; i < 4; i++) r.tick(0);
  r.tick(1100);
  assert.strictEqual(r.lines.length, 2);
  assert.strictEqual(r.lines[1], 'loop: main process blocked for 1100 ms (ended 2026-11-23T04:00:12.800Z) +2 more, longest 4000 ms');
  assert.deepStrictEqual(r.ls.stats(), { stalls: 4, longestMs: 4000, lastAt: WALL0 + 12800 });
});

test('a gap over 60 s is reported as blocked or suspended', () => {
  const r = rig();
  r.ls.start();
  r.tick(90000);
  assert.deepStrictEqual(r.lines, ['loop: main process blocked or suspended for 90000 ms (ended 2026-11-23T04:01:31.500Z)']);
  r.tick(60000);
  assert.strictEqual(r.lines[1], 'loop: main process blocked for 60000 ms (ended 2026-11-23T04:02:32.000Z)');
});

test('stop() clears the timer and a later late tick prints nothing', () => {
  const r = rig();
  r.ls.start();
  const f = r.fn();
  r.ls.stop();
  assert.strictEqual(r.timers.size, 0);
  r.tickWith(f, 5000);
  assert.deepStrictEqual(r.lines, []);
  assert.deepStrictEqual(r.ls.stats(), { stalls: 0, longestMs: 0, lastAt: null });
});

test('engine.js starts one loop stall after the log exists and stops it in shutdown', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  assert.strictEqual(src.split('createLoopStall({ log })').length - 1, 1);
  assert.strictEqual(src.split('loopStall.start()').length - 1, 1);
  assert.strictEqual(src.split('loopStall.stop()').length - 1, 1);
  const shutdown = src.slice(src.indexOf('  function shutdown() {'), src.indexOf('\n  }\n', src.indexOf('  function shutdown() {')));
  assert.ok(shutdown.includes('try { loopStall.stop(); } catch {}'));
  assert.ok(src.indexOf('loopStall.start()') < src.indexOf('  function shutdown() {'));
});
