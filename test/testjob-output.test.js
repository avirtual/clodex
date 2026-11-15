'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../renderer/lib/testjob-output');

test('sanitizeOutput leaves hyperlinks, colours, title sets, markup and bare carriage returns inert', () => {
  const rows = [
    ['osc 8 hyperlink', '\x1b]8;;https://evil.example/\x1b\\click\x1b]8;;\x1b\\ done', 'click done'],
    ['osc 8 bel-terminated', '\x1b]8;;file:///etc/passwd\x07x\x1b]8;;\x07', 'x'],
    ['csi colour run', '\x1b[1;31mFAIL\x1b[0m test/a.js', 'FAIL test/a.js'],
    ['osc title set', '\x1b]0;pwned title\x07after', 'after'],
    ['script payload', '<script>alert(1)</script>', '<script>alert(1)</script>'],
    ['bare carriage return', '50%\r60%\r\nnext', '50%\n60%\nnext'],
    ['c0 and c1 controls', 'a\x00b\x07c\x08d\x9ae\x85f\tg', 'abcdef\tg'],
    ['c1 csi', 'x\x9b31my', 'xy'],
    ['two-char escape', 'a\x1b(Bb\x1bcc', 'abc'],
  ];
  for (const [name, input, want] of rows) assert.strictEqual(T.sanitizeOutput(input), want, name);
});

test('the pane buffer holds an escape split across two reads and strips it whole', () => {
  const b = T.createOutputBuffer();
  b.append('ok \x1b[3');
  assert.strictEqual(b.render(), 'ok ');
  b.append('1mred\x1b]8;;http://x');
  assert.strictEqual(b.render(), 'ok red');
  b.append('\x1b\\link\n');
  assert.strictEqual(b.render(), 'ok redlink\n');
});

test('a 5 MB newline-free line is truncated to the cap, not accumulated, under a visible marker', () => {
  const b = T.createOutputBuffer();
  assert.strictEqual(T.PANE_CAP_CHARS, 262144);
  const chunk = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 5; i++) b.append(chunk);
  assert.strictEqual(b.length, 262144);
  assert.strictEqual(b.dropped, true);
  const shown = b.render();
  assert.strictEqual(shown, `… earlier output not shown …\n${'x'.repeat(262144)}`);
});

test('dropping from the top cuts at a line start', () => {
  const b = T.createOutputBuffer({ cap: 10 });
  b.append('aaaa\nbbbb\n');
  assert.strictEqual(b.render(), 'aaaa\nbbbb\n');
  b.append('cccc\n');
  assert.deepStrictEqual([b.dropped, b.render()], [true, '… earlier output not shown …\nbbbb\ncccc\n']);
});

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
    fire: async () => { const h = pending.shift(); assert.ok(h, 'a timer is armed'); await h.fn(); return h.ms; },
  };
}

const page = (over) => ({
  ok: true, id: 'j1', stream: 'stdout', phase: 'run', live: true, at: 100000, queuedAt: 1000, startedAt: 10000,
  endedAt: null, lastOutputAt: 95000, expired: false, total: 0, offset: 0, next: 0, text: '', ...over,
});

test('the follower tails on open, follows from the last byte offset and shows a split character once and whole', async () => {
  const timers = fakeTimers();
  const asked = [];
  const answers = [
    page({ total: 3, offset: 0, next: 1, text: 'a' }),
    page({ total: 3, offset: 1, next: 3, text: 'é' }),
    page({ total: 3, offset: 3, next: 3, text: '' }),
  ];
  let view = null;
  const f = T.createOutputFollower({ read: async (q) => { asked.push(q); return answers.shift(); }, onUpdate: (v) => { view = v; }, timers });
  f.start();
  assert.strictEqual(await timers.fire(), 0);
  assert.strictEqual(await timers.fire(), 0);
  assert.strictEqual(await timers.fire(), 2000);
  assert.deepStrictEqual(asked, [{ offset: null, length: 262144 }, { offset: 1, length: 262144 }, { offset: 3, length: 262144 }]);
  assert.deepStrictEqual(view, {
    text: 'aé', header: 'run · age 1m30s · last output 5s ago', status: '', live: true, follow: true, stopped: false,
  });
  assert.strictEqual(timers.pending.length, 1);
});

test('a file shorter than the last offset restarts from zero under a marker line', async () => {
  const timers = fakeTimers();
  const asked = [];
  const answers = [
    page({ total: 6, offset: 0, next: 6, text: 'first\n' }),
    page({ total: 2, offset: 2, next: 2, text: '' }),
    page({ total: 2, offset: 0, next: 2, text: 'b\n' }),
  ];
  let view = null;
  const f = T.createOutputFollower({ read: async (q) => { asked.push(q.offset); return answers.shift(); }, onUpdate: (v) => { view = v; }, timers });
  f.start();
  await timers.fire();
  await timers.fire();
  await timers.fire();
  assert.deepStrictEqual(asked, [null, 6, 0]);
  assert.strictEqual(view.text, 'first\n— output restarted from the beginning —\nb\n');
});

test('close stops the timer, an error doubles the delay, two ticks never overlap', async () => {
  const timers = fakeTimers();
  let calls = 0;
  let release = null;
  const reads = [
    () => Promise.reject(new Error('socket hang up')),
    () => Promise.resolve({ ok: false, status: 500, error: 'boom' }),
    () => new Promise((r) => { release = r; }),
  ];
  let view = null;
  const f = T.createOutputFollower({ read: () => { calls++; return reads.shift()(); }, onUpdate: (v) => { view = v; }, timers });
  f.start();
  await timers.fire();
  assert.deepStrictEqual([timers.pending.map((h) => h.ms), view.status], [[4000], 'read failed: socket hang up']);
  await timers.fire();
  assert.deepStrictEqual(timers.pending.map((h) => h.ms), [8000]);
  const first = timers.fire();
  assert.strictEqual(f.inFlight, true);
  f.setFollow(true);
  assert.strictEqual(timers.pending.length, 1, 'ENTER: a second tick is armed while the read is in flight');
  await timers.fire();
  assert.strictEqual(calls, 3, 'the overlapping tick did not read');
  release(page({ total: 1, next: 1, text: 'x' }));
  await first;
  assert.deepStrictEqual(timers.pending.map((h) => h.ms), [2000]);
  f.close();
  assert.deepStrictEqual(timers.pending, []);
  assert.strictEqual(calls, 3);
});

test('a job that ends gets one final read and then stops; a paused follow does not poll', async () => {
  const timers = fakeTimers();
  const answers = [page({ total: 2, next: 2, text: 'a\n' }), page({ phase: 'done', live: false, endedAt: 99000, total: 4, offset: 2, next: 4, text: 'b\n' })];
  let view = null;
  const f = T.createOutputFollower({ read: async () => answers.shift(), onUpdate: (v) => { view = v; }, timers });
  f.start();
  await timers.fire();
  f.setFollow(false);
  assert.deepStrictEqual(timers.pending, []);
  f.setFollow(true);
  await timers.fire();
  assert.deepStrictEqual(timers.pending, []);
  assert.deepStrictEqual(view, {
    text: 'a\nb\n', header: 'done · age 1m29s · last output 5s ago', status: '', live: false, follow: true, stopped: true,
  });
});

test('expired, no output yet, no output and an unknown job each say so', async () => {
  const rows = [
    ['expired', { ok: true, ...page({ phase: 'done', live: false, expired: true, lastOutputAt: null }) }, 'output expired'],
    ['running, empty files', page({}), 'no output yet'],
    ['ended, never wrote', page({ phase: 'done', live: false, lastOutputAt: null }), 'no output'],
    ['unknown job', { ok: false, status: 404, error: 'no such job' }, 'job not found'],
  ];
  for (const [name, answer, want] of rows) {
    const timers = fakeTimers();
    let view = null;
    const f = T.createOutputFollower({ read: async () => answer, onUpdate: (v) => { view = v; }, timers });
    f.start();
    await timers.fire();
    assert.strictEqual(view.status, want, name);
  }
});
