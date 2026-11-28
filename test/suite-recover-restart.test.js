'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { createSuiteClient, LOST_AFTER_MS, ledgerPicks } = require('../suite-client');
const { createIdleWaiter, suiteWaitClause, restartDetail, pendingDetail, giveUpBody, quitGiveUpBody, createQuitGuard } = require('../restart-waiter');

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
  return { client, calls, logs, rows, ledgerFile, written: () => rows().slice(lines.length) };
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

test('t2475: a recovered pool-picked run reads as ended in the picks view, with its pick and moves kept', async (t) => {
  const pick = { chosen: 'work', ranks: [{ member: 'work', score: 1 }] };
  const moved = [{ from: 'rig', to: 'work', at: '2026-11-28T09:50:30.000Z' }];
  const h = harness(t, [start('r-pick', { pick, moved })], { 'peer-work': jobs({ id: 'r-pick-job', state: 'gone' }) });
  await h.client.recoverOpenRuns();
  const [row] = h.written();
  assert.deepStrictEqual([row.pick, row.moved], [pick, moved]);
  const shown = ledgerPicks(h.ledgerFile).find((p) => p.id === 'r-pick');
  assert.deepStrictEqual([shown.phase, shown.outcome, shown.endedAt], ['end', 'lost', '2026-11-28T10:01:00.000Z']);
});

test('t2475: the pending-restart dialog names an outbound run apart from the local runner\'s jobs', () => {
  assert.strictEqual(pendingDetail([{ id: 'x', team: 'avh', ticket: 't2108', kind: 'verify', runner: 'work' }]),
    'Clodex will restart once every session and the keyboard are idle and 1 run on work (avh t2108 verify) finishes. Restart now anyway, cancel the pending restart, or keep waiting?');
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
  assert.deepStrictEqual(events, [['gave-up', { suiteJobs: run.client.outboundRuns(), sessionsBusy: false }]]);
  assert.strictEqual(events[0][1].suiteJobs.length, 1);
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

const TREE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const START_1 = '{"id":"run-1","phase":"start","where":"runner-1","runner":"p1","wire":"push","jobId":"run-1","attempt":1,"kind":"hand","scope":"full","team":null,"ticket":null,"seat":null,'
  + `"tree":"/w","sha":"${HEAD}","treeHash":"${TREE}","dirty":false,"pid":null,"route":null,"override":null,`
  + '"queuedAt":"1970-01-01T00:00:01.000Z","startedAt":"1970-01-01T00:00:01.000Z","env":{"envKey":"k"}}';
const startOf = (jobId, attempt) => START_1.replace('"jobId":"run-1","attempt":1', `"jobId":"${jobId}","attempt":${attempt}`);

function liveRun(t, { states, packAt = 0 }) {
  const root = mkTmpRoot('suite-resubmit-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledgerFile = path.join(root, 'suite-runs.jsonl');
  const packFile = path.join(root, 'pack');
  const polls = {};
  const deletes = [];
  let posts = 0;
  const conn = {
    suiteAsk: async (method, p) => {
      if (p === '/api/suite/info') return { status: 200, body: { ok: true, limits: {}, env: { envKey: 'k' } } };
      if (method === 'DELETE') { deletes.push(p); return { status: 200, body: { ok: true } }; }
      if (method === 'POST' && p === '/api/suite/jobs') {
        posts += 1;
        return { status: 200, body: { ok: true, state: posts === packAt ? 'awaiting-pack' : 'queued' } };
      }
      if (method === 'POST' && p.endsWith('/commit')) return { status: 409, body: { ok: false, incomplete: true } };
      if (p.includes('/output?')) {
        const text = p.includes('stream=stdout') ? 'TOTALS: 1 pass, 0 fail, 1 tests\n' : '';
        return { status: 200, body: { ok: true, text, offset: 0, total: Buffer.byteLength(text) } };
      }
      const id = decodeURIComponent(/ids=([^&]+)/.exec(p)[1]);
      polls[id] = (polls[id] || 0) + 1;
      const state = (states[id] || [])[polls[id] - 1] || 'gone';
      if (state === 'hang') return new Promise(() => {});
      return { status: 200, body: { ok: true, jobs: [{ id, state, treeHash: TREE, exit: { code: 0, signal: null }, reason: null, queueMs: 0, setupMs: 1, runMs: 2, out: {} }] } };
    },
    suitePut: async (p, chunk) => ({ status: 200, body: { ok: true, size: chunk.length } }),
  };
  const snapshot = {
    snapshotTree: async () => ({ treeHash: TREE, head: HEAD, headTree: TREE, tmpDir: null }),
    releaseSnapshot: () => {},
    buildPack: async () => { fs.writeFileSync(packFile, 'pack'); return { file: packFile, bytes: 4, sha256: 'x', over: false }; },
  };
  const client = createSuiteClient({
    getPeerManager: () => ({ get: (id) => (id === 'p1' ? conn : null) }),
    snapshot, randomUUID: () => 'run-1', sleep: async () => {}, ledgerFile, now: () => 1000,
  });
  const done = client.run({ peer: 'p1', name: 'runner-1', tree: '/w' });
  const lines = () => (fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean) : []);
  const until = async (n) => { for (let i = 0; i < 200 && lines().length < n; i += 1) await new Promise((r) => setImmediate(r)); return lines(); };
  const recover = async (answer) => {
    const calls = [];
    const later = createSuiteClient({
      getPeerManager: () => ({ get: (id) => (id === 'p1' ? { suiteAsk: async (m, p, b, ms) => { calls.push([m, p, ms]); return m === 'DELETE' ? { status: 200, body: { ok: true } } : answer(p); } } : null) }),
      ledgerFile, now: () => 61000,
    });
    const written = await later.recoverOpenRuns();
    return { written, calls };
  };
  return { done, lines, until, recover, deletes };
}

test('t2478: a run that never retried writes the start row it always did, and no second one', async (t) => {
  const r = liveRun(t, { states: { 'run-1': ['running', 'done'] } });
  const out = await r.done;
  assert.strictEqual(out.unknown, null, 'ENTER: the run concluded');
  const lines = r.lines();
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0], START_1);
  assert.strictEqual(JSON.parse(lines[1]).phase, 'end');
});

test('t2478: a run retried once after it started names attempt 2\'s job on the ledger, and recovery asks the runner about that job only', async (t) => {
  const r = liveRun(t, { states: { 'run-1': ['running', 'gone'], 'run-1-2': ['hang'] } });
  assert.deepStrictEqual(await r.until(2), [START_1, startOf('run-1-2', 2)]);
  const { written, calls } = await r.recover(() => jobs({ id: 'run-1-2', state: 'running' }));
  assert.deepStrictEqual(calls, [['GET', '/api/suite/jobs?ids=run-1-2&wait=0', LOST_AFTER_MS], ['DELETE', '/api/suite/jobs/run-1-2', undefined]]);
  assert.deepStrictEqual(written.map((w) => [w.id, w.jobId, w.attempt, w.outcome, w.reason]),
    [['run-1', 'run-1-2', 2, 'lost', 'host restarted while the job was in flight; cancelled on the runner']]);
});

test('t2478: a run retried twice after it started names attempt 3\'s job, and recovery closes it with that job\'s result', async (t) => {
  const r = liveRun(t, { states: { 'run-1': ['running', 'gone'], 'run-1-3': ['hang'] }, packAt: 2 });
  assert.deepStrictEqual(await r.until(3), [START_1, startOf('run-1-2', 2), startOf('run-1-3', 3)]);
  assert.deepStrictEqual(r.deletes, ['/api/suite/jobs/run-1-2'], 'ENTER: attempt 2 was submitted and then cancelled for the incomplete pack');
  const { written, calls } = await r.recover(() => jobs({ id: 'run-1-3', state: 'done', reason: null, record: { outcome: 'pass', pass: 4, fail: 0, tests: 4 } }));
  assert.deepStrictEqual(calls, [['GET', '/api/suite/jobs?ids=run-1-3&wait=0', LOST_AFTER_MS]]);
  assert.deepStrictEqual(written.map((w) => [w.id, w.jobId, w.attempt, w.outcome, w.pass]), [['run-1', 'run-1-3', 3, 'pass', 4]]);
});

test('t2478: a run retried after it started and then ended normally is not open after a restart', async (t) => {
  const r = liveRun(t, { states: { 'run-1': ['running', 'gone'], 'run-1-2': ['done'] } });
  const out = await r.done;
  assert.strictEqual(out.unknown, null, 'ENTER: attempt 2 concluded');
  const lines = r.lines();
  assert.deepStrictEqual(lines.slice(0, 2), [START_1, startOf('run-1-2', 2)]);
  assert.deepStrictEqual([lines.length, JSON.parse(lines[2]).phase, JSON.parse(lines[2]).jobId], [3, 'end', 'run-1-2']);
  assert.deepStrictEqual(await r.recover(() => jobs({ id: 'run-1-2', state: 'done' })), { written: [], calls: [] });
});

test('t2478: literal rows, a start row then a resubmit row for the same run recover as one run on the latest job id', async (t) => {
  const h = harness(t, [start('r-retry'), start('r-retry', { jobId: 'r-retry-2', attempt: 2 }), start('r-twice'), start('r-twice', { jobId: 'r-twice-2', attempt: 2 }), start('r-twice', { jobId: 'r-twice-3', attempt: 3 })], {
    'peer-work': () => ({ status: 200, body: { ok: true, jobs: [{ id: 'r-retry-2', state: 'gone' }, { id: 'r-twice-3', state: 'gone' }] } }),
  });
  const written = await h.client.recoverOpenRuns();
  assert.deepStrictEqual(written.map((w) => [w.id, w.jobId, w.attempt, w.outcome]), [['r-retry', 'r-retry-2', 2, 'lost'], ['r-twice', 'r-twice-3', 3, 'lost']]);
  assert.deepStrictEqual(h.calls, [['peer-work', 'GET', '/api/suite/jobs?ids=r-retry-2,r-twice-3&wait=0', LOST_AFTER_MS]]);
});

test('t2478: three open runs on two runners make two polls, one per runner, and cancels stay one per job', async (t) => {
  const h = harness(t, [start('g-a'), start('g-c', { runner: 'peer-rig', where: 'rig' }), start('g-b')], {
    'peer-work': () => ({ status: 200, body: { ok: true, jobs: [
      { id: 'g-a-job', state: 'done', reason: null, record: { outcome: 'pass', pass: 2, fail: 0, tests: 2 } },
      { id: 'g-b-job', state: 'running' },
    ] } }),
    'peer-rig': () => jobs({ id: 'g-c-job', state: 'queued' }),
  });
  const written = await h.client.recoverOpenRuns();
  assert.deepStrictEqual(h.calls, [
    ['peer-work', 'GET', '/api/suite/jobs?ids=g-a-job,g-b-job&wait=0', LOST_AFTER_MS],
    ['peer-work', 'DELETE', '/api/suite/jobs/g-b-job', undefined],
    ['peer-rig', 'GET', '/api/suite/jobs?ids=g-c-job&wait=0', LOST_AFTER_MS],
    ['peer-rig', 'DELETE', '/api/suite/jobs/g-c-job', undefined],
  ]);
  assert.deepStrictEqual(written.map((w) => [w.id, w.outcome]), [['g-a', 'pass'], ['g-b', 'lost'], ['g-c', 'lost']]);
});

test('t2478: the same runner on two wires is asked once per wire', async (t) => {
  const h = harness(t, [start('w-a'), start('w-b', { wire: 'pull' })], {
    'peer-work': (url) => jobs({ id: url.includes('w-a') ? 'w-a-job' : 'w-b-job', state: 'gone' }),
  });
  await h.client.recoverOpenRuns();
  assert.deepStrictEqual(h.calls.map((c) => c[2]), ['/api/suite/jobs?ids=w-a-job&wait=0', '/api/suite/jobs?ids=w-b-job&wait=0']);
});

test('t2478: an unreachable runner marks all its open runs lost in one go', async (t) => {
  const h = harness(t, [start('u-a', { runner: 'peer-away' }), start('u-b', { runner: 'peer-away' })], {});
  const written = await h.client.recoverOpenRuns();
  assert.deepStrictEqual(written.map((w) => [w.id, w.outcome, w.reason]), [
    ['u-a', 'lost', 'host restarted while the job was in flight; runner unreachable (no peer peer-away)'],
    ['u-b', 'lost', 'host restarted while the job was in flight; runner unreachable (no peer peer-away)'],
  ]);
  assert.deepStrictEqual(h.calls, []);
});

test('t2478: recovery asks for at most 20 job ids per poll and splits above it', async (t) => {
  const ids = Array.from({ length: 21 }, (_, i) => `b-${String(i).padStart(2, '0')}`);
  const h = harness(t, ids.map((id) => start(id)), { 'peer-work': () => ({ status: 200, body: { ok: true, jobs: [] } }) });
  const written = await h.client.recoverOpenRuns();
  assert.strictEqual(written.length, 21);
  const asked = h.calls.map((c) => /ids=([^&]+)/.exec(c[2])[1].split(','));
  assert.deepStrictEqual(asked.map((a) => a.length), [20, 1]);
  assert.deepStrictEqual(asked[1], ['b-20-job']);
});

const AWAY = { id: 'x', team: 'avh', ticket: 't2108', kind: 'verify', runner: 'work' };
const HOME = { id: 'j1', team: 'alpha' };

test('t2478: the restart give-up notice names local and outbound jobs apart', () => {
  assert.strictEqual(giveUpBody([], { suiteJobs: [HOME], sessionsBusy: false }),
    '1 suite job this machine is running for other teams did not finish — the pending restart was dropped. Try again when work settles.');
  assert.strictEqual(giveUpBody([], { suiteJobs: [AWAY], sessionsBusy: false }),
    '1 run on work (avh t2108 verify) did not finish — the pending restart was dropped. Try again when work settles.');
  assert.strictEqual(giveUpBody([], { suiteJobs: [HOME, AWAY], sessionsBusy: true }),
    'Sessions stayed busy and 1 suite job this machine is running for other teams and 1 run on work (avh t2108 verify) did not finish — the pending restart was dropped. Try again when work settles.');
});

test('t2478: the quit give-up notice names local and outbound jobs apart', () => {
  assert.strictEqual(quitGiveUpBody([HOME]),
    '1 suite job this machine is running for other teams did not finish within 30 minutes — the quit was dropped. Quit again to choose.');
  assert.strictEqual(quitGiveUpBody([AWAY]),
    '1 run on work (avh t2108 verify) did not finish within 30 minutes — the quit was dropped. Quit again to choose.');
  assert.strictEqual(quitGiveUpBody([HOME, AWAY]),
    '1 suite job this machine is running for other teams and 1 run on work (avh t2108 verify) did not finish within 30 minutes — the quit was dropped. Quit again to choose.');
});

test('t2478: the quit guard hands the give-up notice the live job list', async () => {
  const notices = [];
  let timer = null;
  let clock = 0;
  const guard = createQuitGuard({
    suiteJobs: () => [AWAY], quit: () => {}, ask: async () => ({ response: 0 }), notify: (jobs) => notices.push(quitGiveUpBody(jobs)),
    now: () => clock, setTimer: (fn) => { timer = fn; return 1; }, clearTimer: () => { timer = null; },
  });
  guard.beforeQuit({ preventDefault() {} });
  await new Promise((r) => setImmediate(r));
  clock = 30 * 60_000;
  timer();
  assert.deepStrictEqual(notices, ['1 run on work (avh t2108 verify) did not finish within 30 minutes — the quit was dropped. Quit again to choose.']);
});
