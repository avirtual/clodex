'use strict';

const test = require('node:test');
const assert = require('node:assert');
process.env.TZ = 'UTC';
const { menuRows, activityView, nextQuietAt, fmtSpan, fmtClock } = require('../suite-activity-view');

const job = (over) => ({ id: 'j', team: 'avh', ticket: 't1579', kind: 'verify', origin: null, isolation: 'container', image: 'bbbbbbbbbbbb', definition: null, phase: 'run', queuedAt: 0, startedAt: 0, ...over });
const AT = Date.UTC(2026, 10, 13, 10, 45, 52);
const RUNNING = job({ startedAt: AT - 192000, runStartedAt: AT - 190000, queuedAt: AT - 200000, lastOutputAt: AT - 5000 });
const WAIT_NATIVE = job({ id: 'q1', ticket: 't1580', kind: 'hand', isolation: 'native', image: null, phase: 'queued', startedAt: null, queuedAt: AT - 400000 });
const WAIT_UPLOAD = job({ id: 'q2', team: null, ticket: null, kind: 'post-merge', phase: 'upload', startedAt: null, queuedAt: AT - 5000 });
const snap = (over) => ({ at: AT, slots: { total: 1, inUse: 0 }, running: [], waiting: [], recent: [], box: { state: 'ready', image: 'bbbbbbbbbbbb' }, ...over });
const BUSY = snap({ slots: { total: 1, inUse: 1 }, running: [RUNNING], waiting: [WAIT_NATIVE, WAIT_UPLOAD] });
const OPEN = { kind: 'open', label: 'Test Box Activity…' };
const HEAD = { kind: 'head', label: 'Test Boxes' };

test('fmtSpan reads seconds, minutes and hours', () => {
  assert.deepStrictEqual([0, 999, 59000, 192000, 400000, 3600000, 3725000, -5].map(fmtSpan),
    ['0s', '0s', '59s', '3m12s', '6m40s', '1h00m', '1h02m', '0s']);
});

test('menu rows: runner off, idle, running and waiting, more than eight, held box', () => {
  const many = snap({ slots: { total: 1, inUse: 1 }, running: [RUNNING], waiting: Array.from({ length: 9 }, (_, i) => job({ id: `w${i}`, ticket: `t${i}`, phase: 'queued', startedAt: null, queuedAt: AT - 60000 })) });
  const rows = [
    ['off', menuRows({ enabled: false, snapshot: null }, AT)],
    ['no state', menuRows(null, AT)],
    ['enabled, not started', menuRows({ enabled: true, snapshot: null }, AT)],
    ['idle', menuRows({ enabled: true, snapshot: snap() }, AT)],
    ['busy', menuRows({ enabled: true, snapshot: BUSY }, AT)],
    ['many', menuRows({ enabled: true, snapshot: many }, AT)],
    ['held', menuRows({ enabled: true, snapshot: snap({ box: { state: 'held', why: 'docker ps failed: down' } }) }, AT)],
  ];
  assert.deepStrictEqual(rows, [
    ['off', []],
    ['no state', []],
    ['enabled, not started', [HEAD, { kind: 'info', label: 'idle' }, OPEN]],
    ['idle', [HEAD, { kind: 'info', label: 'idle' }, OPEN]],
    ['busy', [
      HEAD,
      { kind: 'info', label: '1 of 1 in use · 2 waiting' },
      { kind: 'info', label: 'avh · t1579 · verify · box · since 10:42' },
      { kind: 'info', label: 'avh · t1580 · own run · native · waiting since 10:39' },
      { kind: 'info', label: '— · q2 · post-merge · box · uploading since 10:45' },
      OPEN,
    ]],
    ['many', [
      HEAD,
      { kind: 'info', label: '1 of 1 in use · 9 waiting' },
      { kind: 'info', label: 'avh · t1579 · verify · box · since 10:42' },
      ...Array.from({ length: 7 }, (_, i) => ({ kind: 'info', label: `avh · t${i} · verify · box · waiting since 10:44` })),
      { kind: 'info', label: '+2 more' },
      OPEN,
    ]],
    ['held', [HEAD, { kind: 'info', label: 'idle' }, { kind: 'info', label: 'Box held: docker ps failed: down' }, OPEN]],
  ]);
});

test('fmtClock reads local 24-hour HH:MM', () => {
  assert.deepStrictEqual([Date.UTC(2026, 10, 13, 0, 5, 59), Date.UTC(2026, 10, 13, 10, 42, 0), Date.UTC(2026, 10, 13, 23, 59, 30)].map(fmtClock),
    ['00:05', '10:42', '23:59']);
});

test('desktop menu rows from one snapshot are identical at two different now values', () => {
  const state = { enabled: true, snapshot: BUSY };
  const early = menuRows(state, AT, 'clock');
  const late = menuRows(state, AT + 4 * 60000, 'clock');
  assert.ok(early.some((r) => r.label === 'avh · t1579 · verify · box · since 10:42'), 'ENTER: the running job row is present');
  assert.deepStrictEqual(late, early);
});

test('browser menu rows read durations from the same formatter', () => {
  assert.deepStrictEqual(menuRows({ enabled: true, snapshot: BUSY }, AT, 'span'), [
    HEAD,
    { kind: 'info', label: '1 of 1 in use · 2 waiting' },
    { kind: 'info', label: 'avh · t1579 · verify · box · running 3m12s' },
    { kind: 'info', label: 'avh · t1580 · own run · native · waiting 6m40s' },
    { kind: 'info', label: '— · q2 · post-merge · box · uploading 5s' },
    OPEN,
  ]);
});

test('activity view: off, empty, and busy with finished jobs', () => {
  const recent = [
    { ...job({ id: 'r1', ticket: 't1500' }), outcome: 'pass', pass: 5, fail: 0, endedAt: 1, waitMs: 3000, runMs: 60000 },
    { ...job({ id: 'r2', ticket: 't1501', isolation: 'native' }), outcome: 'cancelled', pass: null, fail: null, endedAt: 1, waitMs: 400000, runMs: null },
  ];
  assert.deepStrictEqual(activityView({ enabled: false, snapshot: null }, AT),
    { summary: 'The test runner is off on this machine.', box: null, running: [], waiting: [], empty: null, recent: [] });
  assert.deepStrictEqual(activityView({ enabled: true, snapshot: snap({ box: { state: 'labels-only' } }) }, AT), {
    summary: 'idle', box: 'No default box image: only jobs naming a box definition run in a box',
    running: [], waiting: [], empty: 'No test jobs right now', recent: [],
  });
  assert.deepStrictEqual(activityView({ enabled: true, snapshot: { ...BUSY, recent, box: { state: 'unavailable', why: 'no answer' } } }, AT), {
    summary: '1 of 1 in use · 2 waiting',
    box: 'Box unavailable: no answer',
    running: ['avh · t1579 · verify · box · running 3m12s'],
    waiting: ['avh · t1580 · own run · native · waiting 6m40s', '— · q2 · post-merge · box · uploading 5s'],
    empty: null,
    recent: [
      'avh · t1500 · verify · box · pass (5 pass, 0 fail) · waited 3s · ran 1m00s',
      'avh · t1501 · verify · native · cancelled · waited 6m40s · did not start',
    ],
  });
});

test('quiet rows: a running job silent past the threshold says so; under it, in setup, or finished it never does', () => {
  const under = job({ startedAt: AT - 192000, runStartedAt: AT - 190000, queuedAt: AT - 200000, lastOutputAt: AT - 60000 });
  const over = job({ ticket: 't1662', kind: 'post-merge', startedAt: AT - 863000, runStartedAt: AT - 860000, queuedAt: AT - 870000, lastOutputAt: AT - 430000 });
  const setupNone = job({ ticket: 't1663', phase: 'setup', startedAt: AT - 600000, queuedAt: AT - 610000, lastOutputAt: null });
  const runNoneUnder = job({ ticket: 't1665', startedAt: AT - 192000, runStartedAt: AT - 190000, queuedAt: AT - 200000, lastOutputAt: null });
  const runNoneOver = job({ ticket: 't1666', startedAt: AT - 400000, runStartedAt: AT - 400000, queuedAt: AT - 410000, lastOutputAt: null });
  const longSetup = job({ ticket: 't1667', startedAt: AT - 900000, runStartedAt: AT - 30000, queuedAt: AT - 910000, lastOutputAt: AT - 900000 });
  const olderRunner = job({ ticket: 't1668', startedAt: AT - 900000, runStartedAt: null, queuedAt: AT - 910000, lastOutputAt: AT - 800000 });
  const setupStale = job({ ticket: 't1664', phase: 'setup', startedAt: AT - 600000, queuedAt: AT - 610000, lastOutputAt: AT - 590000 });
  const finished = { ...job({ id: 'r1', ticket: 't1500' }), lastOutputAt: AT - 3600000, outcome: 'pass', pass: 5, fail: 0, endedAt: AT - 3600000, waitMs: 3000, runMs: 60000 };
  const view = (j) => activityView({ enabled: true, snapshot: snap({ slots: { total: 1, inUse: 1 }, running: [j] }) }, AT);
  const rows = [
    ['under threshold', view(under).running[0]],
    ['over threshold', view(over).running[0]],
    ['over threshold, desktop clock', menuRows({ enabled: true, snapshot: snap({ slots: { total: 1, inUse: 1 }, running: [over] }) }, AT, 'clock')[2].label],
    ['setup, no output', view(setupNone).running[0]],
    ['run, no output yet, under threshold', view(runNoneUnder).running[0]],
    ['run, no output yet, over threshold', view(runNoneOver).running[0]],
    ['long setup, fresh run phase', view(longSetup).running[0]],
    ['run phase, older runner without runStartedAt', view(olderRunner).running[0]],
    ['setup, stale output', view(setupStale).running[0]],
    ['finished', activityView({ enabled: true, snapshot: snap({ recent: [finished] }) }, AT).recent[0]],
    ['summary, one quiet', view(over).summary],
    ['summary, none quiet', view(under).summary],
  ];
  for (const [name, text] of rows) assert.ok(typeof text === 'string' && text.length, `ENTER: ${name} row exists`);
  assert.strictEqual(view(under).running[0], activityView({ enabled: true, snapshot: snap({ slots: { total: 1, inUse: 1 }, running: [RUNNING] }) }, AT).running[0]);
  assert.deepStrictEqual(rows, [
    ['under threshold', 'avh · t1579 · verify · box · running 3m12s'],
    ['over threshold', 'avh · t1662 · post-merge · box · running 14m23s · quiet 7m10s'],
    ['over threshold, desktop clock', 'avh · t1662 · post-merge · box · since 10:31 · quiet since 10:38'],
    ['setup, no output', 'avh · t1663 · verify · box · setting up 10m00s'],
    ['run, no output yet, under threshold', 'avh · t1665 · verify · box · running 3m12s'],
    ['run, no output yet, over threshold', 'avh · t1666 · verify · box · running 6m40s · quiet 6m40s'],
    ['long setup, fresh run phase', 'avh · t1667 · verify · box · running 15m00s'],
    ['run phase, older runner without runStartedAt', 'avh · t1668 · verify · box · running 15m00s'],
    ['setup, stale output', 'avh · t1664 · verify · box · setting up 10m00s'],
    ['finished', 'avh · t1500 · verify · box · pass (5 pass, 0 fail) · waited 3s · ran 1m00s'],
    ['summary, one quiet', '1 of 1 in use · 0 waiting · 1 quiet'],
    ['summary, none quiet', '1 of 1 in use · 0 waiting'],
  ]);
});

test('the CLI and the desktop rows share one quiet threshold', () => {
  assert.strictEqual(require('../cli/src/output').TESTJOB_QUIET_MS, require('../suite-activity-view').QUIET_MS);
});

test('nextQuietAt is the earliest moment a live run-phase job not yet quiet crosses the threshold', () => {
  const running = [
    job({ id: 'a', startedAt: AT - 192000, runStartedAt: AT - 190000, lastOutputAt: AT - 60000 }),
    job({ id: 'b', startedAt: AT - 192000, runStartedAt: AT - 190000, lastOutputAt: null }),
    job({ id: 'c', startedAt: AT - 863000, runStartedAt: AT - 860000, lastOutputAt: AT - 430000 }),
    job({ id: 'd', phase: 'setup', startedAt: AT - 290000, lastOutputAt: null }),
  ];
  assert.deepStrictEqual([
    nextQuietAt({ enabled: true, snapshot: snap({ running }) }, AT),
    nextQuietAt({ enabled: true, snapshot: snap({ running: [running[0]] }) }, AT),
    nextQuietAt({ enabled: true, snapshot: snap({ running: [running[2], running[3]] }) }, AT),
    nextQuietAt({ enabled: true, snapshot: snap() }, AT),
    nextQuietAt({ enabled: false, snapshot: null }, AT),
  ], [AT + 110001, AT + 240001, null, null, null]);
});
