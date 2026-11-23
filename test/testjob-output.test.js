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

test('a finished job whose file ends in a held-back partial character stops instead of re-reading at once', async () => {
  const timers = fakeTimers();
  const answers = [
    page({ phase: 'done', live: false, endedAt: 99000, total: 4, offset: 0, next: 3, text: 'abc' }),
    page({ phase: 'done', live: false, endedAt: 99000, total: 4, offset: 3, next: 3, text: '' }),
  ];
  let view = null;
  const f = T.createOutputFollower({ read: async () => answers.shift(), onUpdate: (v) => { view = v; }, timers });
  f.start();
  assert.strictEqual(await timers.fire(), 0);
  assert.strictEqual(await timers.fire(), 0);
  assert.deepStrictEqual([timers.pending, view.stopped, view.text], [[], true, 'abc']);
});

test('a live job stalled on a partial character falls back to the poll interval', async () => {
  const timers = fakeTimers();
  const answers = [page({ total: 4, offset: 0, next: 3, text: 'abc' }), page({ total: 4, offset: 3, next: 3, text: '' })];
  const f = T.createOutputFollower({ read: async () => answers.shift(), onUpdate: () => {}, timers });
  f.start();
  await timers.fire();
  await timers.fire();
  assert.deepStrictEqual(timers.pending.map((h) => h.ms), [2000]);
});

test('opening a long job shows the tail under the earlier-output line', async () => {
  const timers = fakeTimers();
  let view = null;
  const f = T.createOutputFollower({ read: async () => page({ total: 1004, offset: 1000, next: 1004, text: 'end\n' }), onUpdate: (v) => { view = v; }, timers });
  f.start();
  await timers.fire();
  assert.strictEqual(view.text, '… earlier output not shown …\nend\n');
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

const sized = (id, stdout, stderr, over = {}) => ({
  id, startedAt: 10000, queuedAt: 5000, ...over,
  streams: { stdout: { bytes: stdout, lastOutputAt: null }, stderr: { bytes: stderr, lastOutputAt: null } },
});

test('opening the activity view picks the longest-running job, else the newest finished one, else none', () => {
  const rows = [
    ['one running', { running: [sized('r1', 0, 0)], waiting: [], recent: [sized('d1', 5, 0, { endedAt: 9000 })] }, 'r1'],
    ['two running, different start times', { running: [sized('late', 0, 0, { startedAt: 30000 }), sized('early', 0, 0, { startedAt: 20000 })], waiting: [], recent: [] }, 'early'],
    ['none running, three finished', { running: [], waiting: [], recent: [sized('d-mid', 0, 0, { endedAt: 7000 }), sized('d-new', 0, 0, { endedAt: 9000 }), sized('d-old', 0, 0, { endedAt: 3000 })] }, 'd-new'],
    ['no jobs', { running: [], waiting: [], recent: [] }, null],
  ];
  for (const [name, snap, want] of rows) assert.strictEqual(T.autoOpenJob(snap), want, name);
});

test('the pane opens on stdout unless stdout is empty and stderr is not', () => {
  const rows = [
    ['stdout 0, stderr 0', sized('j', 0, 0), 'stdout'],
    ['stdout 0, stderr 10', sized('j', 0, 10), 'stderr'],
    ['stdout 5, stderr 10', sized('j', 5, 10), 'stdout'],
  ];
  for (const [name, job, want] of rows) assert.strictEqual(T.createStreamChoice().open(job.id, job), want, name);
});

test('the stream is chosen when the pane opens for a job and holds until a pick or another job', () => {
  const choice = T.createStreamChoice();
  assert.strictEqual(choice.open('j1', sized('j1', 0, 10)), 'stderr', 'opened with stdout 0, stderr 10');
  assert.strictEqual(choice.open('j1', sized('j1', 211, 5000)), 'stderr', 'refresh with stdout 211, stderr 5000');
  assert.strictEqual(choice.stream, 'stderr');
  assert.strictEqual(choice.pick('stdout'), 'stdout', 'operator picks stdout');
  assert.strictEqual(choice.open('j1', sized('j1', 0, 10)), 'stdout', 'refresh after the pick');
  assert.strictEqual(choice.stream, 'stdout');
  assert.strictEqual(choice.open('j2', sized('j2', 0, 10)), 'stderr', 'pane opened for another job');
  choice.close();
  assert.strictEqual(choice.open('j2', sized('j2', 0, 10)), 'stderr', 'reopened after close');
});

test('the stream switch shows each stream size', () => {
  const rows = [[0, 'stdout 0 B'], [6042, 'stdout 5.9 KB'], [748544, 'stdout 731 KB'], [null, 'stdout']];
  for (const [bytes, want] of rows) assert.strictEqual(T.streamLabel('stdout', bytes), want, String(bytes));
});

test('an empty shown stream names the other stream and its size, never the bare no output yet', async () => {
  const rows = [
    ['stdout empty, stderr writing', 'stdout', { otherBytes: 748544 }, page({}), 'no stdout yet; stderr has 731 KB'],
    ['stderr empty, stdout writing', 'stderr', { otherBytes: 6042 }, page({ stream: 'stderr' }), 'no stderr yet; stdout has 5.9 KB'],
    ['finished, stdout empty', 'stdout', { otherBytes: 6042 }, page({ phase: 'done', live: false }), 'no stdout; stderr has 5.9 KB'],
    ['both empty', 'stdout', { otherBytes: 0 }, page({}), 'no output yet'],
  ];
  for (const [name, stream, ctx, answer, want] of rows) {
    const timers = fakeTimers();
    let view = null;
    const f = T.createOutputFollower({ read: async () => answer, onUpdate: (v) => { view = v; }, timers, stream, context: () => ctx });
    f.start();
    await timers.fire();
    assert.strictEqual(view.status, want, name);
  }
});

test('the pane header shows the last output time of the stream on screen', async () => {
  const rows = [
    ['stdout quiet, stderr fresh', { lastOutputAt: 40000 }, 'run · age 1m30s · last stdout 1m00s ago'],
    ['stream never wrote', { lastOutputAt: null }, 'run · age 1m30s · no stdout'],
    ['job not in the snapshot', {}, 'run · age 1m30s · last output 5s ago'],
  ];
  for (const [name, ctx, want] of rows) {
    const timers = fakeTimers();
    let view = null;
    const f = T.createOutputFollower({ read: async () => page({}), onUpdate: (v) => { view = v; }, timers, stream: 'stdout', context: () => ctx });
    f.start();
    await timers.fire();
    assert.strictEqual(view.header, want, name);
  }
});

test('the finished section of the activity view ships expanded', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const tag = html.match(/<details id="test-activity-recent-wrap"[^>]*>/);
  assert.ok(tag, 'ENTER: the finished section exists');
  assert.match(tag[0], /\sopen[\s>]/);
});
