'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { createSuiteClient, localHalf } = require('../suite-client');

const TREE = 'a'.repeat(40);
const TREE2 = 'd'.repeat(40);
const HEAD = 'b'.repeat(40);

const GREEN = 'TOTALS: 5 pass, 0 fail, 5 tests\n';
const RED_A = ' ✖ alpha (1.5ms)\nTOTALS: 4 pass, 1 fail, 5 tests\n';
const RED_B = ' ✖ beta (2ms)\nTOTALS: 4 pass, 1 fail, 5 tests\n';
const COUNT_OFF = 'TOTALS: 6 pass, 0 fail, 6 tests\n';

const turns = async (n = 50) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

function remoteConn({ stdout = GREEN, stderr = '', code = 0, refuse = false, holds = {} } = {}) {
  const calls = [];
  const conn = {
    suiteAsk: async (method, p) => {
      calls.push(`${method} ${p.split('?')[0]}`);
      if (p === '/api/suite/info') return { status: 200, body: { ok: true, limits: {}, env: { envKey: 'k1' } } };
      if (method === 'POST') return refuse ? { status: 200, body: { ok: false, error: 'nope' } } : { status: 200, body: { ok: true, state: 'queued' } };
      if (method === 'DELETE') return { status: 200, body: { ok: true } };
      if (p.includes('/output?')) {
        const text = p.includes('stream=stdout') ? stdout : p.includes('stream=stderr') ? stderr : '';
        return { status: 200, body: { ok: true, text, offset: 0, total: Buffer.byteLength(text) } };
      }
      const id = decodeURIComponent(/ids=([^&]+)/.exec(p)[1]);
      if (holds[id]) await holds[id];
      return { status: 200, body: { ok: true, jobs: [{ id, state: 'done', treeHash: holds.tree ? holds.tree(id) : TREE, exit: { code, signal: null }, reason: null, queueMs: 3, setupMs: 1, runMs: 40, out: {} }] } };
    },
  };
  return { calls, conn };
}

function shadowClient(conn, { trees = [TREE] } = {}) {
  const compareFile = path.join(mkTmpRoot('suite-shadow-'), 'logs', 'suite-compare.jsonl');
  let n = 0;
  let snaps = 0;
  const client = createSuiteClient({
    getPeerManager: () => ({ get: (id) => (id === 'p1' ? conn : null) }),
    compareFile,
    now: () => 1000,
    randomUUID: () => `run-${(n += 1)}`,
    snapshot: {
      snapshotTree: async () => ({ treeHash: trees[Math.min((snaps += 1) - 1, trees.length - 1)], head: HEAD, headTree: TREE }),
      releaseSnapshot: () => {},
    },
    sleep: async () => {},
  });
  const records = () => (fs.existsSync(compareFile) ? fs.readFileSync(compareFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { client, compareFile, records };
}

const OPTS = { peer: 'p1', name: 'runner-1', tree: '/w', kind: 'verify', team: 'tm', ticket: 't1' };

const REMOTE = (over) => ({ outcome: 'pass', reason: null, pass: 5, fail: 0, tests: 5, failing: [], slow: [], jobId: 'run-1', queueMs: 3, runMs: 40, ...over });
const LOCAL = (over) => ({ outcome: 'pass', pass: 5, fail: 0, tests: 5, failing: [], slow: [], durationMs: 70, ...over });
const RECORD = (local, remote, agree) => ({
  at: '1970-01-01T00:00:01.000Z', team: 'tm', kind: 'verify', ticket: 't1', treeHash: TREE, sha: HEAD, envKey: 'k1', wire: 'push', local, remote, agree,
});

const RECORD_ROWS = [
  ['an agreeing pair', { stdout: GREEN }, { code: 0, stdout: GREEN },
    RECORD(LOCAL(), REMOTE(), true)],
  ['a count mismatch', { stdout: COUNT_OFF }, { code: 0, stdout: GREEN },
    RECORD(LOCAL(), REMOTE({ pass: 6, tests: 6 }), false)],
  ['a failing-name mismatch', { stdout: RED_B, code: 1 }, { code: 1, stdout: RED_A },
    RECORD(LOCAL({ outcome: 'fail', pass: 4, fail: 1, failing: ['alpha'] }), REMOTE({ outcome: 'fail', pass: 4, fail: 1, failing: ['beta'] }), false)],
  ['a remote unknown', { refuse: true }, { code: 0, stdout: GREEN },
    RECORD(LOCAL(), REMOTE({ outcome: 'unknown', reason: 'runner refused the job: nope', pass: null, fail: null, tests: null, queueMs: null, runMs: null }), false)],
];

for (const [name, remote, local, want] of RECORD_ROWS) {
  test(`shadow: the comparison record for ${name}`, async () => {
    const { conn } = remoteConn(remote);
    const f = shadowClient(conn);
    const h = await f.client.shadow(OPTS);
    await turns();
    assert.deepStrictEqual(f.records(), [], 'nothing is written before the local half lands');
    h.local(localHalf({ ...local, stderr: '', durationMs: 70 }));
    assert.deepStrictEqual(f.records(), [want]);
  });
}

const SLOW_RED_STDOUT = [
  '..X..X..',
  'Failed tests:',
  '',
  '✖ alpha (1.5ms)',
  '  AssertionError: red',
  '✖ beta (2ms)',
  '  AssertionError: red',
  '',
  'TOTALS: 6 pass, 2 fail, 8 tests',
  'SLOW: 8691ms gamma',
  'SLOW: 19409ms delta',
  'SLOW: 11858ms epsilon',
  'SLOW: inject the clock or constant through a seam, or list the test in test/slow-tests.json with the mechanism it waits on',
  '',
].join('\n');
const SLOW_RED_STDERR = ' ✖ gamma (8691ms)\n ✖ delta (19409ms)\n ✖ epsilon (11858ms)\n';
const TWO_RED_STDOUT = 'Failed tests:\n\n✖ alpha (1ms)\n✖ beta (3ms)\n\nTOTALS: 6 pass, 2 fail, 8 tests\n';

test('localHalf: failing takes only real failures; the slow-gate names land in slow', () => {
  const half = localHalf({ code: 1, stdout: SLOW_RED_STDOUT, stderr: SLOW_RED_STDERR, durationMs: 70 });
  assert.deepStrictEqual(half, LOCAL({ outcome: 'fail', pass: 6, fail: 2, tests: 8, failing: ['alpha', 'beta'], slow: ['gamma', 'delta', 'epsilon'] }));
});

test('shadow: a remote half whose slow gate fired agrees with a local half carrying the same two failures and no slow lines', async () => {
  const { conn } = remoteConn({ stdout: SLOW_RED_STDOUT, stderr: SLOW_RED_STDERR, code: 1 });
  const f = shadowClient(conn);
  const h = await f.client.shadow(OPTS);
  await turns();
  h.local(localHalf({ code: 1, stdout: TWO_RED_STDOUT, stderr: '', durationMs: 70 }));
  assert.deepStrictEqual(f.records(), [RECORD(
    LOCAL({ outcome: 'fail', pass: 6, fail: 2, tests: 8, failing: ['alpha', 'beta'] }),
    REMOTE({ outcome: 'fail', pass: 6, fail: 2, tests: 8, failing: ['alpha', 'beta'], slow: ['gamma', 'delta', 'epsilon'] }),
    true,
  )]);
});

test('shadow: a late result for a job superseded by a newer tree writes no record and cancels the stale job', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const { conn, calls } = remoteConn({ holds: { 'run-1': held, tree: (id) => (id === 'run-1' ? TREE : TREE2) } });
  const f = shadowClient(conn, { trees: [TREE, TREE2] });
  const first = await f.client.shadow(OPTS);
  first.local(localHalf({ code: 0, stdout: GREEN, durationMs: 70 }));
  await turns();
  const second = await f.client.shadow(OPTS);
  second.local(localHalf({ code: 0, stdout: GREEN, durationMs: 70 }));
  await turns();
  assert.deepStrictEqual(f.records().map((r) => [r.treeHash, r.remote.jobId]), [[TREE2, 'run-2']], 'ENTER: the newer job wrote its record');
  release();
  await turns();
  assert.deepStrictEqual(f.records().map((r) => [r.treeHash, r.remote.jobId]), [[TREE2, 'run-2']]);
  assert.ok(calls.includes('DELETE /api/suite/jobs/run-1'), calls.join('\n'));
});

test('shadow: a comparison write failure changes nothing else', async () => {
  const { conn } = remoteConn();
  const f = shadowClient(conn);
  fs.mkdirSync(f.compareFile, { recursive: true });
  const h = await f.client.shadow(OPTS);
  await turns();
  assert.doesNotThrow(() => h.local(localHalf({ code: 0, stdout: GREEN, durationMs: 70 })));
});

function tallyFile(lines) {
  const file = path.join(mkTmpRoot('suite-tally-'), 'suite-compare.jsonl');
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return createSuiteClient({ getPeerManager: () => null, compareFile: file });
}

const rec = (envKey, agree, localFailing, remoteFailing, team = 'tm') => ({
  team, envKey, agree,
  local: { outcome: localFailing.length ? 'fail' : 'pass', failing: localFailing },
  remote: { outcome: remoteFailing.length ? 'fail' : 'pass', failing: remoteFailing },
});

test('tally: counts agreements and one-sided failing names under one env key; another key or team is not counted', () => {
  const client = tallyFile([
    rec('k1', true, [], []),
    rec('k1', false, [], ['net test']),
    rec('k1', false, ['x'], ['net test', 'x']),
    rec('k0', false, [], ['old']),
    rec('k1', false, [], ['other team'], 'tm2'),
  ]);
  assert.deepStrictEqual(client.tally({ team: 'tm', envKey: 'k1' }), {
    envKey: 'k1', agree: 1, disagree: 2, oneSided: [{ side: 'remote', name: 'net test', count: 2 }],
  });
  assert.deepStrictEqual(client.tally({ team: 'tm', envKey: 'k2' }), { envKey: 'k2', agree: 0, disagree: 0, oneSided: [] });
});

test('t2303: a detached skip row is written as its own kind and is counted as neither agreement nor disagreement', () => {
  const file = path.join(mkTmpRoot('suite-skip-'), 'suite-compare.jsonl');
  const client = createSuiteClient({ getPeerManager: () => null, compareFile: file, now: () => 1000 });
  fs.writeFileSync(file, `${JSON.stringify(rec('k1', true, [], []))}\n`);
  client.shadowSkip({ team: 'tm', kind: 'post-merge', ticket: 't1', runner: 'laptop', skipped: 'detached' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines[1], {
    at: '1970-01-01T00:00:01.000Z', team: 'tm', kind: 'post-merge', ticket: 't1', wire: 'pull', runner: 'laptop', skipped: 'detached', agree: null,
  });
  assert.deepStrictEqual(client.tally({ team: 'tm' }), { envKey: 'k1', agree: 1, disagree: 0, oneSided: [] });
  assert.deepStrictEqual(client.tally({ team: 'tm', envKey: 'k1' }), { envKey: 'k1', agree: 1, disagree: 0, oneSided: [] });
});

function runPair(conn, wire) {
  let n = 0;
  return createSuiteClient({
    getPeerManager: () => ({ get: (id) => (wire === 'push' && id === 'p1' ? conn : null) }),
    getSuiteDesk: () => ({ conn: (origin) => (wire === 'pull' && origin === 'laptop' ? conn : null) }),
    now: () => 1000,
    randomUUID: () => `run-${(n += 1)}`,
    snapshot: { snapshotTree: async () => ({ treeHash: TREE, head: HEAD, headTree: TREE }), releaseSnapshot: () => {} },
    sleep: async () => {},
  });
}

test('t2303: run over a desk conn returns what the push arm returns for the same answers, apart from wire and runner', async () => {
  const RUN = { tree: '/w', kind: 'verify', team: 'tm', ticket: 't1', name: 'runner' };
  const push = remoteConn({ stdout: RED_A, code: 1 });
  const pull = remoteConn({ stdout: RED_A, code: 1 });
  const a = await runPair(push.conn, 'push').run({ ...RUN, peer: 'p1' });
  const b = await runPair(pull.conn, 'pull').run({ ...RUN, peer: 'laptop', wire: 'pull' });
  assert.strictEqual(a.record.outcome, 'fail', 'ENTER: the push arm measured a red run');
  assert.deepStrictEqual([a.record.wire, a.record.runner, b.record.wire, b.record.runner], ['push', 'p1', 'pull', 'laptop']);
  assert.deepStrictEqual(pull.calls, push.calls);
  const strip = (out) => ({ ...out, record: { ...out.record, wire: '-', runner: '-' } });
  assert.deepStrictEqual(strip(b), strip(a));
});

const RESTART = { status: 404, body: { ok: false, error: 'runner session replaced', reason: 'runner-restart' }, error: null };

function restartConn(where, times) {
  const base = remoteConn();
  let left = times;
  const conn = {
    suiteAsk: async (method, p, ...rest) => {
      const hit = (where === 'info' && p === '/api/suite/info') || (where === 'submit' && method === 'POST')
        || (where === 'output' && p.includes('/output?'));
      if (hit && left > 0) {
        left -= 1;
        base.calls.push(`${method} ${p.split('?')[0]} -> restart`);
        return RESTART;
      }
      return base.conn.suiteAsk(method, p, ...rest);
    },
  };
  return { conn, calls: base.calls };
}

const RESTART_ROWS = [
  ['info, once', 'info', 1, { outcome: 'pass', reason: null, attempt: 2 }],
  ['info, twice', 'info', 2, { outcome: 'unknown', reason: 'runner restarted', attempt: 2 }],
  ['submit, once', 'submit', 1, { outcome: 'pass', reason: null, attempt: 2 }],
  ['submit, twice', 'submit', 2, { outcome: 'unknown', reason: 'runner restarted', attempt: 2 }],
  ['output read, once', 'output', 1, { outcome: 'pass', reason: null, attempt: 2 }],
  ['output read, twice', 'output', 2, { outcome: 'unknown', reason: 'runner restarted', attempt: 2 }],
];

for (const [name, where, times, want] of RESTART_ROWS) {
  test(`t2303: a runner-restart answer on ${name} is retried once against the new session, then the run ends unknown`, async () => {
    const { conn, calls } = restartConn(where, times);
    const out = await runPair(conn, 'pull').run({ tree: '/w', kind: 'verify', team: 'tm', ticket: 't1', peer: 'laptop', wire: 'pull' });
    assert.ok(calls.some((c) => c.endsWith('-> restart')), 'ENTER: the desk answered runner-restart');
    assert.deepStrictEqual({ outcome: out.record.outcome, reason: out.record.reason, attempt: out.record.attempt }, want);
  });
}
