'use strict';

const test = require('node:test');
const assert = require('node:assert');
process.env.TZ = 'UTC';
const { menuRows, activityView, fmtSpan, fmtClock } = require('../suite-activity-view');

const job = (over) => ({ id: 'j', team: 'avh', ticket: 't1579', kind: 'verify', origin: null, isolation: 'container', image: 'bbbbbbbbbbbb', definition: null, phase: 'run', queuedAt: 0, startedAt: 0, ...over });
const AT = Date.UTC(2026, 10, 13, 10, 45, 52);
const RUNNING = job({ startedAt: AT - 192000, queuedAt: AT - 200000 });
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
  const late = menuRows(state, AT + 7 * 60000, 'clock');
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
