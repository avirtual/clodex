'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { createSuiteClient, LOST_AFTER_MS } = require('../suite-client');
const { createIdleWaiter, suiteWaitClause, restartDetail } = require('../restart-waiter');

const BOOT = Date.parse('2026-11-28T10:00:00.000Z');
const SWEEP = BOOT + 60000;

function start(id, extra = {}) {
  return {
    id, phase: 'start', where: 'work', runner: 'peer-work', wire: 'push', jobId: `${id}-job`, attempt: 1,
    kind: 'verify', scope: 'full', team: 'avh', ticket: 't2108', seat: 'avh-hand',
    tree: '/trees/avh', sha: 'abc123', treeHash: 'th-1', dirty: false, pid: null, route: 'pool', override: null,
    queuedAt: '2026-11-28T09:50:00.000Z', startedAt: '2026-11-28T09:51:00.000Z', env: { isolation: 'native' },
    ...extra,
  };
}

function harness(t, lines, answers) {
  const root = mkTmpRoot('suite-recover-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledgerFile = path.join(root, 'logs', 'suite-runs.jsonl');
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.writeFileSync(ledgerFile, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  const calls = [];
  const conn = (peer) => ({
    suiteAsk: async (method, url, body, timeout) => {
      calls.push([peer, method, url, timeout]);
      if (method === 'DELETE') return { status: 200, body: { ok: true } };
      const a = answers[peer];
      return typeof a === 'function' ? a(url) : a;
    },
  });
  const peers = Object.keys(answers);
  let clock = BOOT;
  const logs = [];
  const client = createSuiteClient({
    getPeerManager: () => ({ get: (p) => (peers.includes(p) ? conn(p) : null) }),
    getSuiteDesk: () => ({ conn: (p) => (peers.includes(p) ? conn(p) : null) }),
    ledgerFile, now: () => clock, log: (m) => logs.push(m),
  });
  clock = SWEEP;
  const rows = () => fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { client, calls, logs, rows, written: () => rows().slice(lines.length) };
}

const jobs = (job) => ({ status: 200, body: { ok: true, jobs: [job] } });

const CASES = [
  {
    name: 'done with a usable record',
    lines: [start('r-done')],
    answers: { 'peer-work': jobs({ id: 'r-done-job', state: 'done', reason: null, record: { outcome: 'pass', pass: 12, fail: 0, tests: 12 } }) },
    want: { outcome: 'pass', reason: 'recovered after a host restart', pass: 12, fail: 0, tests: 12 },
    deletes: 0,
  },
  {
    name: 'done without a usable record',
    lines: [start('r-norec')],
    answers: { 'peer-work': jobs({ id: 'r-norec-job', state: 'done', reason: 'lease-expired', record: { outcome: 'unknown', pass: null, fail: null, tests: null } }) },
    want: { outcome: 'unknown', reason: 'recovered after a host restart; the runner recorded no usable totals (lease-expired)', pass: null, fail: null, tests: null },
    deletes: 0,
  },
  {
    name: 'still queued',
    lines: [start('r-queued', { startedAt: null })],
    answers: { 'peer-work': jobs({ id: 'r-queued-job', state: 'queued' }) },
    want: { outcome: 'lost', reason: 'host restarted while the job was in flight; cancelled on the runner', pass: null, fail: null, tests: null },
    deletes: 1,
  },
  {
    name: 'still running, pull wire',
    lines: [start('r-running', { wire: 'pull' })],
    answers: { 'peer-work': jobs({ id: 'r-running-job', state: 'running' }) },
    want: { outcome: 'lost', reason: 'host restarted while the job was in flight; cancelled on the runner', pass: null, fail: null, tests: null },
    deletes: 1,
  },
  {
    name: 'gone on the runner',
    lines: [start('r-gone')],
    answers: { 'peer-work': jobs({ id: 'r-gone-job', state: 'gone' }) },
    want: { outcome: 'lost', reason: 'host restarted while the job was in flight; the runner no longer has the job', pass: null, fail: null, tests: null },
    deletes: 0,
  },
  {
    name: 'runner unreachable',
    lines: [start('r-unreach', { runner: 'peer-away' })],
    answers: {},
    want: { outcome: 'lost', reason: 'host restarted while the job was in flight; runner unreachable (no peer peer-away)', pass: null, fail: null, tests: null },
    deletes: 0,
  },
  {
    name: 'runner answers 502',
    lines: [start('r-502')],
    answers: { 'peer-work': { status: 502, body: null } },
    want: { outcome: 'lost', reason: 'host restarted while the job was in flight; runner unreachable (status 502)', pass: null, fail: null, tests: null },
    deletes: 0,
  },
  {
    name: 'already has an end row',
    lines: [start('r-ended'), { id: 'r-ended', phase: 'end', runner: 'peer-work', wire: 'push', outcome: 'pass' }],
    answers: { 'peer-work': jobs({ id: 'r-ended-job', state: 'done' }) },
    want: null,
  },
  {
    name: 'a local scripts/run-tests.js row and its team-tickets timeout end',
    lines: [
      { id: 'l-1', phase: 'start', kind: 'verify', scope: 'full', ticket: 't1', seat: null, tree: '/t', sha: 'a', dirty: false, pid: 42, where: 'local', route: null, override: null, queuedAt: '2026-11-28T09:50:00.000Z', startedAt: '2026-11-28T09:50:00.000Z' },
      { id: 'l-2', phase: 'start', kind: 'verify', scope: 'full', ticket: 't2', seat: null, tree: '/t', sha: 'a', dirty: false, pid: 43, where: 'local', route: null, override: null, queuedAt: '2026-11-28T09:52:00.000Z', startedAt: '2026-11-28T09:52:00.000Z' },
      { id: 'l-2', phase: 'end', outcome: 'timeout', pass: null, fail: null, tests: null, endedAt: '2026-11-28T09:59:00.000Z', durationMs: 1 },
    ],
    answers: { 'peer-work': jobs({ id: 'x', state: 'done' }) },
    want: null,
  },
  {
    name: 'a runner job record row',
    lines: [{ id: 'k-1', jobId: 'k-1', attempt: 1, kind: 'hand', team: 'avh', ticket: 't9', queuedAt: BOOT - 600000, startedAt: BOOT - 500000, endedAt: null, outcome: 'pass', reason: null, pass: 1, fail: 0, tests: 1, where: 'runner' }],
    answers: { 'peer-work': jobs({ id: 'k-1', state: 'running' }) },
    want: null,
  },
  {
    name: 'started more than 24 h before the sweep',
    lines: [start('r-old', { queuedAt: '2026-11-27T09:00:00.000Z', startedAt: '2026-11-27T09:00:30.000Z' })],
    answers: { 'peer-work': jobs({ id: 'r-old-job', state: 'gone' }) },
    want: null,
  },
  {
    name: 'started after this process booted',
    lines: [start('r-new', { queuedAt: '2026-11-28T10:00:05.000Z', startedAt: '2026-11-28T10:00:06.000Z' })],
    answers: { 'peer-work': jobs({ id: 'r-new-job', state: 'running' }) },
    want: null,
  },
];

for (const c of CASES) {
  test(`t2475: boot recovery, ${c.name}`, async (t) => {
    const h = harness(t, c.lines, c.answers);
    const out = await h.client.recoverOpenRuns();
    const written = h.written();
    assert.deepStrictEqual(out, written);
    if (!c.want) {
      assert.deepStrictEqual(written, []);
      assert.deepStrictEqual(h.calls, []);
      return;
    }
    assert.strictEqual(written.length, 1);
    const row = written[0];
    const opened = c.lines[0];
    assert.deepStrictEqual({ outcome: row.outcome, reason: row.reason, pass: row.pass, fail: row.fail, tests: row.tests }, c.want);
    assert.strictEqual(row.recovered, true);
    assert.strictEqual(row.id, opened.id);
    const asked = Object.keys(c.answers).length ? [[opened.runner, 'GET', `/api/suite/jobs?ids=${opened.id}-job&wait=0`, LOST_AFTER_MS]] : [];
    assert.deepStrictEqual(h.calls.filter((x) => x[1] === 'GET'), asked);
    assert.deepStrictEqual(h.calls.filter((x) => x[1] === 'DELETE'), c.deletes ? [[opened.runner, 'DELETE', `/api/suite/jobs/${opened.id}-job`, undefined]] : []);
  });
}

test('t2475: a recovered end row carries the start row identity, and one log line names team, ticket, kind, runner, job and outcome', async (t) => {
  const h = harness(t, [start('r-done')], CASES[0].answers);
  await h.client.recoverOpenRuns();
  assert.deepStrictEqual(h.written(), [{
    id: 'r-done', phase: 'end', where: 'work', runner: 'peer-work', wire: 'push', jobId: 'r-done-job', attempt: 1,
    kind: 'verify', scope: 'full', team: 'avh', ticket: 't2108', seat: 'avh-hand',
    tree: '/trees/avh', sha: 'abc123', treeHash: 'th-1', queuedAt: '2026-11-28T09:50:00.000Z', route: 'pool', override: null,
    outcome: 'pass', reason: 'recovered after a host restart', pass: 12, fail: 0, tests: 12,
    endedAt: '2026-11-28T10:01:00.000Z', durationMs: null, env: { isolation: 'native' }, recovered: true,
  }]);
  assert.deepStrictEqual(h.logs, ['suite-client: recovered run r-done after a host restart: team avh, ticket t2108, verify on work, job r-done-job: pass']);
});

test('t2475: running the boot step twice, or twice at once, writes one end row', async (t) => {
  const h = harness(t, [start('r-done'), start('r-run')], {
    'peer-work': (url) => (url.includes('r-done') ? jobs({ id: 'r-done-job', state: 'done', reason: null, record: { outcome: 'fail', pass: 3, fail: 1, tests: 4 } }) : jobs({ id: 'r-run-job', state: 'running' })),
  });
  const [a, b] = await Promise.all([h.client.recoverOpenRuns(), h.client.recoverOpenRuns()]);
  assert.strictEqual(a, b);
  assert.deepStrictEqual(h.written().map((r) => [r.id, r.outcome]), [['r-done', 'fail'], ['r-run', 'lost']]);
  const asked = h.calls.length;
  assert.deepStrictEqual(await h.client.recoverOpenRuns(), []);
  assert.strictEqual(h.written().length, 2);
  assert.strictEqual(h.calls.length, asked);
});

function wheel() {
  let t = 0;
  let timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimer: (h) => { timers = timers.filter((x) => x !== h); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((x, y) => x.at - y.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

function inFlight() {
  let fail;
  const snap = new Promise((resolve, reject) => { fail = reject; });
  const client = createSuiteClient({ getPeerManager: () => null, snapshot: { snapshotTree: () => snap } });
  const done = client.run({ peer: 'peer-work', name: 'work', tree: '/trees/avh', kind: 'verify', team: 'avh', ticket: 't2108' });
  return { client, end: () => { fail(new Error('stop')); return done; } };
}

function waiterOn(client) {
  const clock = wheel();
  const events = [];
  const waiter = createIdleWaiter({
    getSessions: () => [], now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    restart: () => events.push('restart'), notify: (asked, why) => events.push(['gave-up', why]), lastInputAt: () => -Infinity,
    suiteJobs: () => client.outboundRuns(),
  });
  return { clock, events, waiter };
}

test('t2475: an outbound run is listed while in flight, holds a queued restart, and releases it when it ends', async () => {
  const run = inFlight();
  const listed = run.client.outboundRuns();
  assert.deepStrictEqual(listed, [{ id: listed[0] && listed[0].id, team: 'avh', ticket: 't2108', kind: 'verify', runner: 'work' }]);
  assert.strictEqual(typeof listed[0].id, 'string');
  const { clock, events, waiter } = waiterOn(run.client);
  waiter.arm();
  clock.advance(25 * 60_000);
  assert.deepStrictEqual(events, []);
  await run.end();
  assert.deepStrictEqual(run.client.outboundRuns(), []);
  clock.advance(12_000);
  assert.deepStrictEqual(events, ['restart']);
});

test('t2475: at the cap an outbound run still in flight drops the restart, it is not forced', () => {
  const run = inFlight();
  const { clock, events, waiter } = waiterOn(run.client);
  waiter.arm();
  clock.advance(31 * 60_000);
  assert.deepStrictEqual(events, [['gave-up', { suiteJobs: 1, sessionsBusy: false }]]);
  assert.strictEqual(waiter.isArmed(), false);
  run.end().catch(() => {});
});

test('t2475: the reboot wait clause and dialog name outbound runs apart from the local runner\'s', () => {
  const away = { id: 'x', team: 'avh', ticket: 't2108', kind: 'verify', runner: 'work' };
  assert.strictEqual(suiteWaitClause([away]), ' and 1 run on work (avh t2108 verify) finishes');
  assert.strictEqual(suiteWaitClause([{ id: 'j1', team: 'alpha' }, away]),
    ' and 1 suite job this machine is running for other teams and 1 run on work (avh t2108 verify) finish');
  assert.strictEqual(suiteWaitClause(2), ' and 2 suite jobs this machine is running for other teams finish');
  assert.strictEqual(restartDetail({ busy: 0, idle: 0, jobs: [away] }),
    '1 run on work (avh t2108 verify) is in flight.\n'
    + 'Restart When Idle waits until work settles and the suite jobs finish; Restart Now interrupts and cuts the suite jobs.');
});

test('t2475: engine counts outbound runs in the restart hold behind the same seam, and defers the boot recovery off the sync path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  assert.match(src, /const restartSuiteJobs = \(\) => \[\.\.\.suiteRestartJobs\(\), \.\.\.suiteClient\.outboundRuns\(\)\];/);
  assert.match(src, /suiteRestartJobs: \(\) => \(seams\.restartWaitsForSuite \? restartSuiteJobs\(\) : \[\]\),/);
  assert.match(src, /fenceSuiteRunner, suiteRestartJobs: restartSuiteJobs,/);
  assert.match(src, /const suiteRecoverTimer = setTimeout\(\(\) => \{\s*suiteClient\.recoverOpenRuns\(\)/);
  assert.match(src, /clearTimeout\(suiteRecoverTimer\)/);
});
