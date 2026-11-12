'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { RemoteServer } = require('../remote');
const { PeerConnection } = require('../peer-client');
const { createSuiteRunner, noneIsolation } = require('../suite-runner');
const { createSuiteClient } = require('../suite-client');
const { suiteRunnerOptions } = require('../remote-wiring');

const SUITE_TOKEN = 'suite-token-PLANTED-7f3a9c';
const OP_TOKEN = 'operator-token-1b2c3d';
const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' };
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false'];

function g(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...IDENT, ...args], { env: ENV, encoding: 'utf8' });
}

function makeRepo(root, { bigBytes = 0 } = {}) {
  const repo = path.join(root, 'near');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n');
  if (bigBytes) fs.writeFileSync(path.join(repo, 'big.bin'), crypto.randomBytes(bigBytes));
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'one');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha dirty\n');
  return repo;
}

function req(port, pathname, { method = 'GET', token = null, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body != null) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

async function startServer(t, extra) {
  const seen = [];
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: '/nonexistent', hostLabel: 'runner-box', version: '9.9.9',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    token: OP_TOKEN, suiteToken: SUITE_TOKEN, ...extra,
  });
  const route = server._route.bind(server);
  server._route = (rq, rs) => { seen.push(`${rq.method} ${rq.url}`); return route(rq, rs); };
  await server.start();
  t.after(() => server.stop());
  return { server, port: server.port, seen };
}

function realRunner(t, root, limits) {
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 5000;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(`ran ${path.basename(opts.cwd)}\nTOTALS: 3 pass, 0 fail, 3 tests\n`);
      child.stderr.end('');
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
  const runner = createSuiteRunner({ root, work, isolation: noneIsolation({ user: 'suite-test', kill: () => {} }), limits, spawn });
  t.after(() => { runner.close(); spawnSync('chmod', ['-R', 'u+w', root]); });
  return runner;
}

function peerFor(t, port, token = SUITE_TOKEN, extra = {}) {
  const emits = [];
  const conn = new PeerConnection({
    id: 'runner-1', label: 'runner-1', url: `http://127.0.0.1:${port}`, token,
    emit: (...a) => emits.push(a), helloIntervalMs: 20, ...extra,
  });
  t.after(() => conn.stop());
  return { conn, emits };
}

function clientFor(conn, extra = {}) {
  const logs = [];
  const client = createSuiteClient({
    getPeerManager: () => ({ get: (id) => (id === 'runner-1' ? conn : null) }),
    log: (m) => logs.push(m), ...extra,
  });
  return { client, logs };
}

async function waitFor(pred, what, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function stubRunner(over = {}) {
  const calls = [];
  const base = {
    info: async () => ({ ok: true, bootId: 'boot-1', env: { envKey: 'e1' }, isolation: { mode: 'none' }, limits: { packMaxBytes: 1 << 30, chunkMax: 1 << 20, queueMax: 32 }, queue: { running: null, queued: [] } }),
    submit: async (b) => ({ ok: true, id: b.id, state: 'queued', position: 1 }),
    putPack: async (id, offset, chunk) => ({ ok: true, size: offset + chunk.length }),
    commit: async (id) => ({ ok: true, id, state: 'queued', position: 1 }),
    poll: async () => ({ ok: true, bootId: 'boot-1', jobs: [] }),
    output: async () => ({ ok: true, total: 0, offset: 0, text: '' }),
    cancel: async () => ({ ok: true }),
  };
  const runner = {};
  for (const k of Object.keys(base)) runner[k] = async (...a) => { calls.push([k, ...a.slice(0, 1)]); return (over[k] || base[k])(...a); };
  return { runner, calls };
}

function doneView(id, treeHash, extra = {}) {
  return { id, attempt: 1, state: 'done', position: null, reason: null, exit: { code: 0, signal: null }, treeHash, queueMs: 5, setupMs: 1, runMs: 9, env: { envKey: 'e1' }, out: { stdoutBytes: 0, stderrBytes: 0, truncated: false }, ...extra };
}

test('suiteRunnerOptions builds the runner deps from the environment, and nothing without runner mode', () => {
  assert.strictEqual(suiteRunnerOptions({ CLODEX_SUITE_TOKEN: 'x' }, '/h'), null);
  assert.deepStrictEqual(suiteRunnerOptions({ CLODEX_SUITE_RUNNER: '1' }, '/h'), {
    root: '/h', work: '/var/lib/clodex-suite', isolation: 'user', limits: {},
  });
  assert.deepStrictEqual(suiteRunnerOptions({ CLODEX_SUITE_RUNNER: '1', CLODEX_SUITE_WORK: '/w', CLODEX_SUITE_ISOLATION: 'none', CLODEX_SUITE_PACK_MAX_MB: '2' }, '/h'), {
    root: '/h', work: '/w', isolation: 'none', limits: { packMaxBytes: 2 * 1024 * 1024 },
  });
});

test('a scoped hello answers identity, bootId, the suite cap and scope, and nothing else', async (t) => {
  const { runner } = stubRunner();
  const { port } = await startServer(t, { suiteRunner: runner });
  const op = JSON.parse((await req(port, '/api/peer/hello', { token: OP_TOKEN })).text);
  assert.ok(op.caps.includes('suite'), 'ENTER: the operator hello advertises suite in runner mode');
  const scoped = JSON.parse((await req(port, '/api/peer/hello', { token: SUITE_TOKEN })).text);
  assert.deepStrictEqual(scoped, { ok: true, app: 'clodex', host: 'runner-box', version: '9.9.9', bootId: op.bootId, caps: ['suite'], scope: 'suite' });
});

test('without runner mode every suite route is 501 and hello carries no suite cap', async (t) => {
  const { port } = await startServer(t, {});
  const rows = [
    ['GET', '/api/suite/info', 501],
    ['POST', '/api/suite/jobs', 501],
    ['GET', '/api/suite/jobs?ids=a&wait=0', 501],
    ['PUT', '/api/suite/jobs/a/pack', 501],
    ['POST', '/api/suite/jobs/a/commit', 501],
    ['GET', '/api/suite/jobs/a/output', 501],
    ['DELETE', '/api/suite/jobs/a', 501],
  ];
  const got = [];
  for (const [method, p] of rows) got.push([method, p, (await req(port, p, { method, token: OP_TOKEN, body: method === 'POST' ? '{}' : null })).status]);
  assert.deepStrictEqual(got, rows);
  const op = JSON.parse((await req(port, '/api/peer/hello', { token: OP_TOKEN })).text);
  assert.ok(op.caps.includes('resources'), 'ENTER: hello answered with its caps');
  assert.strictEqual(op.caps.includes('suite'), false);
  const scoped = JSON.parse((await req(port, '/api/peer/hello', { token: SUITE_TOKEN })).text);
  assert.deepStrictEqual(scoped.caps, []);
});

test('a suite-scoped peer opens no event stream and never lists sessions', async (t) => {
  const { runner } = stubRunner();
  const { port, seen } = await startServer(t, { suiteRunner: runner });
  const { conn } = peerFor(t, port);
  conn.start();
  await waitFor(() => seen.filter((s) => s === 'GET /api/peer/hello').length >= 3, 'three hellos');
  assert.strictEqual(conn.online, true, 'ENTER: the scoped peer is online');
  assert.strictEqual(conn.status().scope, 'suite');
  assert.strictEqual(conn.needsUpgrade, false);
  assert.deepStrictEqual([...new Set(seen)], ['GET /api/peer/hello']);
});

test('suite long-polls ride their own pool: pinned polls do not starve the request pool', async (t) => {
  const held = [];
  const { runner } = stubRunner({
    poll: () => new Promise((resolve) => held.push(() => resolve({ ok: true, bootId: 'b', jobs: [] }))),
  });
  const { port } = await startServer(t, { suiteRunner: runner });
  const { conn } = peerFor(t, port);
  const polls = Array.from({ length: 10 }, () => conn.suiteAsk('GET', '/api/suite/jobs?ids=x&wait=25000', null, 20000));
  await waitFor(() => held.length >= 2, 'two polls on the wire');
  const hello = await Promise.race([
    new Promise((resolve) => conn._request('GET', '/api/peer/hello', null, (err, body) => resolve(err ? err.message : body.scope))),
    new Promise((resolve) => setTimeout(() => resolve('starved'), 2000)),
  ]);
  assert.strictEqual(hello, 'suite');
  assert.strictEqual(held.length, 2, 'the suite pool holds at most two sockets');
  const release = setInterval(() => { for (const r of held.splice(0)) r(); }, 5);
  t.after(() => clearInterval(release));
  const answers = await Promise.all(polls);
  assert.deepStrictEqual(answers.map((a) => a.status), Array(10).fill(200));
});

test('run drives submit, a multi-chunk pack with a refused offset, commit, poll and output end to end', async (t) => {
  const root = mkTmpRoot('suite-wire-');
  const repo = makeRepo(root, { bigBytes: 20000 });
  const runner = realRunner(t, root, { chunkMax: 4096 });
  const puts = [];
  const wrapped = {
    ...runner,
    putPack: (id, offset, chunk) => {
      puts.push([offset, chunk.length]);
      return runner.putPack(id, puts.length === 2 ? offset + 1 : offset, chunk);
    },
  };
  const { port } = await startServer(t, { suiteRunner: wrapped });
  const { conn } = peerFor(t, port);
  const ledgerFile = path.join(root, 'logs', 'suite-runs.jsonl');
  const progress = [];
  const { client, logs } = clientFor(conn, { ledgerFile, randomUUID: () => 'run-0001' });
  const out = await client.run({ peer: 'runner-1', tree: repo, kind: 'verify', ticket: 't9', onProgress: (l) => progress.push(l) });
  assert.strictEqual(out.unknown, null, `run unknown: ${out.unknown}`);
  assert.ok(puts.length >= 6, `ENTER: the pack crossed several chunks (${puts.length} PUTs)`);
  assert.deepStrictEqual(puts.slice(0, 3).map((p) => p[0]), [0, 4096, 4096]);
  assert.deepStrictEqual([out.res.status, out.res.jobId, out.res.attempt, out.res.stdout], [0, 'run-0001', 1, 'ran tree\nTOTALS: 3 pass, 0 fail, 3 tests\n']);
  const { endedAt, durationMs, queuedAt, queueMs, setupMs, runMs, env, ...rest } = out.record;
  assert.deepStrictEqual(rest, {
    id: 'run-0001', phase: 'end', where: 'runner-1', runner: 'runner-1', jobId: 'run-0001', attempt: 1,
    kind: 'verify', scope: 'full', team: null, ticket: 't9', seat: null,
    tree: path.resolve(repo), sha: g(repo, 'rev-parse', 'HEAD').trim(), treeHash: out.res.treeHash, route: null, override: null,
    outcome: 'pass', reason: null, pass: 3, fail: 0, tests: 3,
  });
  assert.strictEqual(typeof env.envKey, 'string');
  const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.map((l) => [l.phase, l.jobId, l.where]), [['start', 'run-0001', 'runner-1'], ['end', 'run-0001', 'runner-1']]);
  const said = [...logs, ...progress].join('\n');
  assert.ok(logs.length > 0 && said.includes('runner-1'), 'ENTER: the client logged the run');
  assert.strictEqual(said.includes(SUITE_TOKEN), false);
});

test('a ledger write failure never changes the result', async (t) => {
  const root = mkTmpRoot('suite-wire-');
  const repo = makeRepo(root);
  const { runner } = stubRunner({ poll: async (ids) => ({ ok: true, bootId: 'b', jobs: [doneView(ids[0], treeOf(repo))] }) });
  const { port } = await startServer(t, { suiteRunner: runner });
  const { conn } = peerFor(t, port);
  fs.writeFileSync(path.join(root, 'logs'), 'not a dir');
  const { client, logs } = clientFor(conn, { ledgerFile: path.join(root, 'logs', 'suite-runs.jsonl') });
  const out = await client.run({ peer: 'runner-1', tree: repo });
  assert.deepStrictEqual([out.unknown, out.record.outcome], [null, 'no-summary']);
  assert.ok(logs.some((l) => /ledger write failed/.test(l)), 'ENTER: the write did fail');
});

function treeOf(repo) {
  const idx = path.join(repo, '.git', 'tmp-index');
  fs.copyFileSync(path.join(repo, '.git', 'index'), idx);
  const env = { ...ENV, GIT_INDEX_FILE: idx };
  execFileSync('git', ['-C', repo, 'add', '-A'], { env });
  const out = execFileSync('git', ['-C', repo, 'write-tree'], { env, encoding: 'utf8' }).trim();
  fs.rmSync(idx);
  return out;
}

function fakeClock() {
  const c = { t: 1_000_000, slept: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.slept.push(ms); c.t += ms; };
  return c;
}

test('failure matrix: a runner down at submit waits in 15 s steps, then reports unknown', async (t) => {
  const root = mkTmpRoot('suite-wire-');
  const repo = makeRepo(root);
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  const { conn } = peerFor(t, port);
  const clock = fakeClock();
  const progress = [];
  const { client } = clientFor(conn, { now: clock.now, sleep: clock.sleep });
  const out = await client.run({ peer: 'runner-1', tree: repo, budgetMs: 50000, onProgress: (l) => progress.push(l) });
  assert.deepStrictEqual(clock.slept, [15000, 15000, 15000]);
  assert.ok(progress.includes('waiting for runner runner-1'), 'ENTER: the wait was announced');
  assert.match(out.unknown, /^runner unreachable/);
  assert.deepStrictEqual([out.res, out.record.outcome], [null, 'unknown']);
});

test('failure matrix: a runner restart mid-run resubmits once with attempt 2; a second loss is unknown', async (t) => {
  const root = mkTmpRoot('suite-wire-');
  const repo = makeRepo(root);
  const tree = treeOf(repo);
  for (const [losses, want] of [[1, [null, 2, 'run-x-2', 'pass']], [2, ['runner restarted', 2, 'run-x-2', 'unknown']]]) {
    let lost = 0;
    const { runner, calls } = stubRunner({
      poll: async (ids) => {
        if (lost < losses) { lost += 1; return { ok: true, bootId: `boot-${lost}`, jobs: [doneView(ids[0], tree, { reason: 'runner-restart', exit: null })] }; }
        return { ok: true, bootId: 'boot-x', jobs: [doneView(ids[0], tree)] };
      },
      output: async (id, o) => ({ ok: true, total: o.stream === 'stdout' ? 32 : 0, offset: 0, text: o.stream === 'stdout' ? 'TOTALS: 1 pass, 0 fail, 1 tests\n' : '' }),
    });
    const { server, port } = await startServer(t, { suiteRunner: runner });
    const { conn } = peerFor(t, port);
    const { client } = clientFor(conn, { randomUUID: () => 'run-x' });
    const out = await client.run({ peer: 'runner-1', tree: repo });
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'submit').map((c) => [c[1].id, c[1].attempt]), [['run-x', 1], ['run-x-2', 2]]);
    assert.deepStrictEqual([out.unknown, out.record.attempt, out.record.jobId, out.record.outcome], want);
    server.stop();
  }
});

test('failure matrix: a pack hash mismatch restarts the upload once, then reports upload failed', async (t) => {
  const root = mkTmpRoot('suite-wire-');
  const repo = makeRepo(root);
  const { runner, calls } = stubRunner({
    submit: async (b) => ({ ok: true, id: b.id, state: 'awaiting-pack', have: [] }),
    commit: async () => ({ ok: false, status: 400, error: 'pack hash mismatch' }),
  });
  const { port } = await startServer(t, { suiteRunner: runner });
  const { conn } = peerFor(t, port);
  const { client } = clientFor(conn, { randomUUID: () => 'run-h' });
  const out = await client.run({ peer: 'runner-1', tree: repo });
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'commit' || c[0] === 'cancel').map((c) => c.join(':')), ['commit:run-h', 'cancel:run-h', 'commit:run-h-2', 'cancel:run-h-2']);
  assert.deepStrictEqual([out.unknown, out.res, out.record.outcome], ['upload failed', null, 'unknown']);
});

test('failure matrix: a runner timeout and an exhausted caller budget are both outcome timeout, never green', async (t) => {
  const root = mkTmpRoot('suite-wire-');
  const repo = makeRepo(root);
  const tree = treeOf(repo);
  const timed = stubRunner({ poll: async (ids) => ({ ok: true, bootId: 'b', jobs: [doneView(ids[0], tree, { reason: 'timeout', exit: { code: null, signal: 'SIGKILL' } })] }) });
  const a = await startServer(t, { suiteRunner: timed.runner });
  const out = await clientFor(peerFor(t, a.port).conn).client.run({ peer: 'runner-1', tree: repo, timeoutMs: 5000 });
  assert.deepStrictEqual([out.unknown, out.record.outcome], ['the suite did not finish within 5000ms (killed)', 'timeout']);
  const clock = fakeClock();
  const slow = stubRunner({ poll: async (ids) => { clock.t += 20000; return { ok: true, bootId: 'b', jobs: [doneView(ids[0], tree, { state: 'running', exit: null })] }; } });
  const b = await startServer(t, { suiteRunner: slow.runner });
  const late = await clientFor(peerFor(t, b.port).conn, { now: clock.now, sleep: clock.sleep, randomUUID: () => 'run-b' }).client.run({ peer: 'runner-1', tree: repo, budgetMs: 50000 });
  assert.deepStrictEqual([late.unknown, late.record.outcome, late.res], ['no result within the 50000ms budget (cancelled)', 'timeout', null]);
  assert.deepStrictEqual(slow.calls.filter((c) => c[0] === 'cancel'), [['cancel', 'run-b']]);
});

test('failure matrix: a late result for another job is discarded and cancelled; another tree never satisfies the submit', async (t) => {
  const root = mkTmpRoot('suite-wire-');
  const repo = makeRepo(root);
  const tree = treeOf(repo);
  let polls = 0;
  const { runner, calls } = stubRunner({
    poll: async (ids) => {
      polls += 1;
      if (polls === 1) return { ok: true, bootId: 'b', jobs: [doneView('old-job', 'f'.repeat(40)), doneView(ids[0], tree, { state: 'running', exit: null })] };
      return { ok: true, bootId: 'b', jobs: [doneView(ids[0], tree, { exit: { code: 1, signal: null } })] };
    },
    output: async (id, o) => ({ ok: true, total: o.stream === 'stdout' ? 32 : 0, offset: 0, text: o.stream === 'stdout' ? 'TOTALS: 0 pass, 1 fail, 1 tests\n' : '' }),
  });
  const { port } = await startServer(t, { suiteRunner: runner });
  const { client } = clientFor(peerFor(t, port).conn, { randomUUID: () => 'run-l' });
  const out = await client.run({ peer: 'runner-1', tree: repo });
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'cancel'), [['cancel', 'old-job']]);
  assert.deepStrictEqual([out.unknown, out.res.status, out.record.outcome, out.record.fail], [null, 1, 'fail', 1]);
  const other = stubRunner({ poll: async (ids) => ({ ok: true, bootId: 'b', jobs: [doneView(ids[0], 'e'.repeat(40))] }) });
  const b = await startServer(t, { suiteRunner: other.runner });
  const wrong = await clientFor(peerFor(t, b.port).conn).client.run({ peer: 'runner-1', tree: repo });
  assert.deepStrictEqual([wrong.unknown, wrong.res, wrong.record.outcome], [`runner answered for tree eeeeeeee, not ${tree.slice(0, 8)}`, null, 'unknown']);
});

test('failure matrix: a duplicate submit returns the held job, another treeHash on the same id is 409, and a refused submit is unknown with no PUT', async (t) => {
  const root = mkTmpRoot('suite-wire-');
  const repo = makeRepo(root);
  const { snapshotTree, releaseSnapshot } = require('../suite-snapshot');
  const snap = await snapshotTree(repo);
  t.after(() => releaseSnapshot(snap));
  const runner = realRunner(t, root, {});
  const { port } = await startServer(t, { suiteRunner: runner });
  const body = (treeHash) => JSON.stringify({
    id: 'dup-1', attempt: 1, repoKey: snap.repoKey, kind: 'hand', scope: 'full', snap: snap.snap, treeHash,
    indexTree: snap.indexTree, sha: snap.head, branch: snap.branch, trunk: snap.trunk, refs: snap.refs,
    candidates: snap.candidates, files: [], flags: {},
  });
  const post = (b) => req(port, '/api/suite/jobs', { method: 'POST', token: SUITE_TOKEN, body: b });
  const first = await post(body(snap.treeHash));
  const again = await post(body(snap.treeHash));
  assert.strictEqual(first.status, 200, `ENTER: the first submit was accepted: ${first.text}`);
  const held = ({ ok, id, state, have }) => ({ ok, id, state, have });
  assert.deepStrictEqual([again.status, held(JSON.parse(again.text))], [200, held(JSON.parse(first.text))]);
  const clash = await post(body('f'.repeat(40)));
  const engine = await runner.submit(JSON.parse(body('f'.repeat(40))));
  assert.strictEqual(engine.status, 409);
  assert.deepStrictEqual([clash.status, JSON.parse(clash.text).error], [409, engine.error]);

  const refused = stubRunner({ submit: async () => ({ ok: false, status: 409, error: 'job dup-2 exists with another treeHash' }) });
  const b = await startServer(t, { suiteRunner: refused.runner });
  const out = await clientFor(peerFor(t, b.port).conn, { randomUUID: () => 'dup-2' }).client.run({ peer: 'runner-1', tree: repo });
  assert.deepStrictEqual([out.unknown, out.res, out.record.outcome], ['runner refused the job: job dup-2 exists with another treeHash', null, 'unknown']);
  assert.deepStrictEqual(refused.calls.map((c) => c[0]).filter((k) => k !== 'info'), ['submit']);
});

test('a client-side throw mid-upload ends unknown with an end record and cancels the job', async (t) => {
  const root = mkTmpRoot('suite-wire-');
  const repo = makeRepo(root);
  const snapshot = { ...require('../suite-snapshot'), buildPack: async () => { throw new Error('pack exceeds maxBuffer'); } };
  const { runner, calls } = stubRunner({ submit: async (b) => ({ ok: true, id: b.id, state: 'awaiting-pack', have: [] }) });
  const { port } = await startServer(t, { suiteRunner: runner });
  const { conn } = peerFor(t, port);
  const ledgerFile = path.join(root, 'logs', 'suite-runs.jsonl');
  const { client } = clientFor(conn, { ledgerFile, snapshot, randomUUID: () => 'run-t' });
  const out = await client.run({ peer: 'runner-1', tree: repo });
  assert.deepStrictEqual([out.unknown, out.res, out.record.outcome], ['client error: pack exceeds maxBuffer', null, 'unknown']);
  assert.deepStrictEqual(calls.filter((c) => c[0] !== 'info').map((c) => c.slice(0, 1).concat(c[0] === 'submit' ? [c[1].id] : c.slice(1))), [['submit', 'run-t'], ['cancel', 'run-t']]);
  const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.map((l) => [l.phase, l.jobId, l.outcome]), [['end', 'run-t', 'unknown']]);
});
