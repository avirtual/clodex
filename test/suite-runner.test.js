'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { snapshotTree, releaseSnapshot, buildPack } = require('../suite-snapshot');
const { createSuiteRunner, noneIsolation } = require('../suite-runner');

const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' };
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false'];
const HELPER = path.join(__dirname, '..', 'docker', 'web', 'clodex-suite-exec');
const SOURCE = path.join(__dirname, '..', 'suite-runner.js');

function g(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...IDENT, ...args], { env: ENV, encoding: 'utf8' });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function fixture(t, { onSpawn, now, limits, kill } = {}) {
  const root = mkTmpRoot('suite-runner-');
  const repo = path.join(root, 'near');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"x"}\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'one');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha dirty\n');
  const snap = await snapshotTree(repo);
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const calls = [];
  const kills = [];
  const pending = [];
  const timers = {
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
    setInterval: () => ({}),
    clearInterval: () => {},
  };
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4000 + calls.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.finish = (code, signal = null) => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, signal));
    };
    const call = { cmd, args, opts, child, job: path.basename(path.dirname(opts.cwd)), parentEnv: { ...process.env } };
    calls.push(call);
    (onSpawn || ((c) => { c.child.stdout.write('TOTALS: 1 pass, 0 fail, 1 tests\n'); c.child.finish(0); }))(call);
    return child;
  };
  const isolation = noneIsolation({ user: 'suite-test', kill: kill || ((pid, sig) => kills.push([pid, sig])) });
  const make = () => createSuiteRunner({ root, work, isolation, limits, spawn, now, timers });
  const runner = make();
  t.after(() => {
    runner.close();
    releaseSnapshot(snap);
    spawnSync('chmod', ['-R', 'u+w', root]);
  });
  const body = (id, kind = 'hand', extra = {}) => ({
    id, attempt: 1, repoKey: snap.repoKey, kind, scope: 'full', snap: snap.snap, treeHash: snap.treeHash,
    indexTree: snap.indexTree, sha: snap.head, branch: snap.branch, trunk: snap.trunk, refs: snap.refs,
    candidates: snap.candidates, files: [], flags: {}, ...extra,
  });
  const upload = async (b) => {
    const r = await runner.submit(b);
    if (r.state !== 'awaiting-pack') return r;
    const pack = await buildPack(snap, { have: r.have });
    assert.strictEqual((await runner.putPack(b.id, 0, pack)).ok, true);
    return runner.commit(b.id, { bytes: pack.length, sha256: sha256(pack) });
  };
  return { root, repo, work: fs.realpathSync(work), snap, runner, calls, kills, pending, body, upload, make, timers };
}

async function waitState(runner, id, state) {
  for (;;) {
    const r = await runner.poll([id], { wait: 1 });
    if (r.jobs[0].state === state) return r.jobs[0];
  }
}

test('the queue runs post-merge, then verify, then hand, whatever the submit order', async (t) => {
  const order = [];
  let blocker = null;
  const f = await fixture(t, {
    onSpawn: (c) => {
      order.push(c.job);
      if (c.job === 'blocker') blocker = c.child;
      else c.child.finish(0);
    },
  });
  assert.strictEqual((await f.upload(f.body('blocker', 'hand'))).state, 'queued');
  await waitState(f.runner, 'blocker', 'running');
  for (const [id, kind] of [['a-hand', 'hand'], ['b-verify', 'verify'], ['c-post', 'post-merge']]) {
    assert.strictEqual((await f.runner.submit(f.body(id, kind))).state, 'queued');
  }
  const positions = (await f.runner.poll(['a-hand', 'b-verify', 'c-post'])).jobs.map((j) => [j.id, j.position]);
  assert.deepStrictEqual(positions, [['a-hand', 3], ['b-verify', 2], ['c-post', 1]]);
  blocker.finish(0);
  await waitState(f.runner, 'a-hand', 'done');
  assert.deepStrictEqual(order, ['blocker', 'c-post', 'b-verify', 'a-hand']);
});

test('submit is idempotent on id and refuses the same id with another treeHash', async (t) => {
  const f = await fixture(t);
  const first = await f.runner.submit(f.body('j1'));
  assert.strictEqual(first.state, 'awaiting-pack');
  const again = await f.runner.submit(f.body('j1'));
  assert.deepStrictEqual(again, { ok: true, id: 'j1', state: 'awaiting-pack', position: null, have: first.have });
  const other = await f.runner.submit(f.body('j1', 'hand', { treeHash: 'e'.repeat(40) }));
  assert.deepStrictEqual(other, { ok: false, status: 409, error: 'job id already submitted with a different treeHash' });
});

test('a pack upload at the wrong offset answers 409 with the size held', async (t) => {
  const f = await fixture(t);
  await f.runner.submit(f.body('j1'));
  assert.deepStrictEqual(await f.runner.putPack('j1', 5, Buffer.from('abc')), { ok: false, status: 409, error: 'offset is not the current size', have: 0 });
  assert.deepStrictEqual(await f.runner.putPack('j1', 0, Buffer.from('abc')), { ok: true, size: 3 });
  assert.deepStrictEqual(await f.runner.putPack('j1', 0, Buffer.from('abc')), { ok: false, status: 409, error: 'offset is not the current size', have: 3 });
});

test('a commit whose sha256 does not match the uploaded pack is refused', async (t) => {
  const f = await fixture(t);
  await f.runner.submit(f.body('j1'));
  await f.runner.putPack('j1', 0, Buffer.from('abc'));
  assert.deepStrictEqual(await f.runner.commit('j1', { bytes: 3, sha256: sha256(Buffer.from('abd')) }), { ok: false, status: 400, error: 'pack hash mismatch' });
  assert.strictEqual((await f.runner.poll(['j1'])).jobs[0].state, 'awaiting-pack');
});

test('a job not polled for longer than the lease is cancelled as lease-expired', async (t) => {
  let clock = 1000;
  const f = await fixture(t, { now: () => clock });
  await f.runner.submit(f.body('j1'));
  const rows = [];
  for (const at of [121000, 121001]) {
    clock = at;
    await f.runner.tick();
    const snapshot = JSON.parse(fs.readFileSync(path.join(f.root, 'suite-runner', 'jobs', 'j1', 'job.json'), 'utf8'));
    rows.push([at, snapshot.state, snapshot.reason]);
  }
  assert.deepStrictEqual(rows, [[121000, 'awaiting-pack', null], [121001, 'done', 'lease-expired']]);
});

test('a restarted runner recovers each state as the table says', async (t) => {
  const f = await fixture(t);
  f.runner.close();
  const store = path.join(f.root, 'suite-runner', 'jobs');
  const rows = [
    { id: 'r-await', state: 'awaiting-pack', want: ['gone', undefined] },
    { id: 'r-queued', state: 'queued', want: ['queued', null] },
    { id: 'r-setup', state: 'setup', want: ['done', 'runner-restart'] },
    { id: 'r-running', state: 'running', want: ['done', 'runner-restart'] },
    { id: 'r-done', state: 'done', want: ['done', null] },
  ];
  rows.forEach((row, i) => {
    fs.mkdirSync(path.join(store, row.id), { recursive: true });
    const job = { ...f.body(row.id), state: row.state, reason: null, exit: null, seq: i + 1, queuedAt: 1, startedAt: null, endedAt: Date.now(), out: { stdoutBytes: 0, stderrBytes: 0, truncated: false } };
    fs.writeFileSync(path.join(store, row.id, 'job.json'), JSON.stringify(job));
  });
  const runner = f.make();
  t.after(() => runner.close());
  const got = (await runner.poll(rows.map((r) => r.id))).jobs.map((j) => [j.id, j.state, j.reason]);
  assert.deepStrictEqual(got, rows.map((r) => [r.id, ...r.want]));
  assert.strictEqual(fs.existsSync(path.join(store, 'r-await')), false);
});

test('a job past its timeout has its process group killed and ends as timeout', async (t) => {
  let child = null;
  const f = await fixture(t, {
    onSpawn: (c) => { child = c.child; },
    kill: (pid, sig) => { f.kills.push([pid, sig]); child.finish(null, 'SIGKILL'); },
  });
  await f.upload(f.body('slow', 'hand', { timeoutMs: 5000 }));
  await waitState(f.runner, 'slow', 'running');
  const timer = f.pending.find((h) => h.ms === 5000);
  assert.ok(timer, 'ENTER: the run armed its 5000 ms timer');
  assert.deepStrictEqual(f.kills, []);
  timer.fn();
  assert.deepStrictEqual(f.kills, [[-4000, 'SIGKILL']]);
  const done = await waitState(f.runner, 'slow', 'done');
  assert.deepStrictEqual([done.reason, done.exit, done.record.outcome], ['timeout', { code: null, signal: 'SIGKILL' }, 'unknown']);
});

test('the test process gets an environment built from empty: no parent token reaches it', async (t) => {
  const planted = { CLODEX_SUITE_TOKEN: 'planted-suite', CLAUDE_CODE_OAUTH_TOKEN: 'planted-oauth', CLODEX_REMOTE_TOKEN: 'planted-remote' };
  const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
  Object.assign(process.env, planted);
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const f = await fixture(t);
  await f.upload(f.body('envjob', 'hand', { flags: { CLODEX_TEST_LOCK: '0' }, env: { TEAM_VAR: 'team value' }, files: ['test/a.test.js'] }));
  await waitState(f.runner, 'envjob', 'done');
  const call = f.calls.find((c) => c.job === 'envjob');
  assert.strictEqual(call.parentEnv.CLODEX_SUITE_TOKEN, 'planted-suite', 'ENTER: the token was in the parent env at spawn');
  const jobDir = path.join(f.work, 'jobs', 'envjob');
  assert.deepStrictEqual(call.opts.env, {
    TEAM_VAR: 'team value',
    CLODEX_TEST_LOCK: '0',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: path.join(jobDir, 'home'),
    TMPDIR: path.join(jobDir, 'tmp'),
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    USER: 'suite-test',
    LOGNAME: 'suite-test',
    SHELL: '/bin/sh',
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  });
  assert.deepStrictEqual([call.cmd, ...call.args], [process.execPath, 'scripts/run-tests.js', '--reporter=dot', 'test/a.test.js']);
});

function listing(dir) {
  const out = {};
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isDirectory()) { out[r] = { type: 'dir', mode: st.mode & 0o777 }; walk(r); } else out[r] = { type: 'file', mode: st.mode & 0o777, text: fs.readFileSync(path.join(dir, r), 'utf8') };
    }
  };
  walk('');
  return out;
}

test('deps cache: a miss runs setup once and seals the entry, a hit links it and runs no setup', async (t) => {
  const links = [];
  const f = await fixture(t, {
    onSpawn: (c) => {
      if (c.cmd === '/bin/sh') {
        fs.mkdirSync(path.join(c.opts.cwd, 'node_modules'));
        fs.writeFileSync(path.join(c.opts.cwd, 'node_modules', 'x.txt'), 'built\n');
      } else {
        const p = path.join(c.opts.cwd, 'node_modules');
        links.push([c.job, fs.lstatSync(p).isSymbolicLink(), fs.readlinkSync(p)]);
      }
      c.child.finish(0);
    },
  });
  const setup = { run: 'npm ci', key: ['package.json'], paths: ['node_modules'], timeoutMs: 60000 };
  await f.upload(f.body('d1', 'hand', { setup }));
  await waitState(f.runner, 'd1', 'done');
  await f.runner.submit(f.body('d2', 'hand', { setup }));
  await waitState(f.runner, 'd2', 'done');
  const setupRuns = f.calls.map((c) => [c.job, c.cmd === '/bin/sh' ? 'setup' : 'test']);
  assert.deepStrictEqual(setupRuns, [['d1', 'setup'], ['d1', 'test'], ['d2', 'test']]);
  const repoDeps = path.join(f.work, 'deps', f.snap.repoKey);
  const entries = fs.readdirSync(repoDeps).filter((n) => !n.endsWith('.json'));
  assert.strictEqual(entries.length, 1);
  const entry = path.join(repoDeps, entries[0]);
  assert.deepStrictEqual(listing(entry), {
    node_modules: { type: 'dir', mode: 0o555 },
    'node_modules/x.txt': { type: 'file', mode: 0o444, text: 'built\n' },
  });
  const target = path.join(entry, 'node_modules');
  assert.deepStrictEqual(links, [['d1', true, target], ['d2', true, target]]);
});

test('a failing setup ends the job setup-failed with the setup output and runs no tests', async (t) => {
  const f = await fixture(t, {
    onSpawn: (c) => { c.child.stderr.write('npm ERR! boom\n'); c.child.finish(1); },
  });
  await f.upload(f.body('sf', 'hand', { setup: { run: 'npm ci', key: ['package.json'], paths: ['node_modules'] } }));
  const done = await waitState(f.runner, 'sf', 'done');
  assert.deepStrictEqual([done.reason, done.exit], ['setup-failed', { code: 1, signal: null }]);
  assert.strictEqual((await f.runner.output('sf', { stream: 'stderr' })).text, 'npm ERR! boom\n');
  assert.deepStrictEqual(f.calls.map((c) => c.cmd), ['/bin/sh']);
});

test('cache eviction never runs while a job is live', async (t) => {
  const clock = 30 * 24 * 3600 * 1000;
  const f = await fixture(t, { now: () => clock });
  const rel = path.join('deps', f.snap.repoKey, 'a'.repeat(64));
  fs.mkdirSync(path.join(f.work, rel), { recursive: true });
  fs.writeFileSync(path.join(f.work, `${rel}.json`), '{}');
  fs.writeFileSync(path.join(f.work, 'cache.json'), JSON.stringify({ [rel]: 0 }));
  await f.runner.submit(f.body('live'));
  assert.strictEqual((await f.runner.poll(['live'])).jobs[0].state, 'awaiting-pack', 'ENTER: a live job');
  await f.runner.tick();
  assert.strictEqual(fs.existsSync(path.join(f.work, rel)), true);
  await f.runner.cancel('live');
  await f.runner.tick();
  assert.strictEqual(fs.existsSync(path.join(f.work, rel)), false);
});

test('runJob makes no git call after isolation.prepare', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('async function runJob(');
  const end = src.indexOf('\n  }\n', start);
  const body = src.slice(start, end);
  const cut = body.indexOf('await isolation.prepare(');
  assert.ok(start >= 0 && cut > 0, 'ENTER: runJob calls isolation.prepare');
  assert.match(body.slice(0, cut), /snapshot\.materialize\(/);
  assert.doesNotMatch(body.slice(cut), /snapshot\.|\bgit\(|treeHashOf|materialize/);
});

test('clodex-suite-exec refuses every path outside its work root', (t) => {
  const root = mkTmpRoot('suite-exec-');
  const work = path.join(fs.realpathSync(root), 'work');
  const inside = path.join(work, 'jobs', 'job1');
  const entry = path.join(work, 'deps', 'a'.repeat(40), 'b'.repeat(64));
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(entry, { recursive: true });
  const outside = path.join(fs.realpathSync(root), 'elsewhere');
  fs.mkdirSync(outside);
  const env = { PATH: process.env.PATH, CLODEX_SUITE_WORK: work, CLODEX_SUITE_USER: 'clodex-suite-test-nouser' };
  const run = (...args) => spawnSync('bash', [HELPER, ...args], { env, encoding: 'utf8' });
  const rows = [
    ['prepare', outside],
    ['prepare', path.join(work, 'jobs', '..', '..', 'elsewhere')],
    ['run', outside, '--', '/bin/echo', 'hi'],
    ['seal', outside, entry, 'node_modules'],
    ['seal', inside, outside, 'node_modules'],
    ['seal', inside, entry, '../escape'],
    ['reap', outside],
    ['reap', path.join(work, 'jobs')],
  ];
  const got = rows.map((args) => { const r = run(...args); return [args[0], r.status, /refusing/.test(r.stderr)]; });
  assert.deepStrictEqual(got, rows.map((args) => [args[0], 2, true]));
  assert.strictEqual(fs.existsSync(outside), true);
  const enter = run('reap', inside);
  assert.strictEqual(enter.status, 0, `ENTER: an inside job is reaped (${enter.stderr})`);
  assert.strictEqual(fs.existsSync(inside), false);
});
