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
const { createSuiteRunner, noneIsolation, resolveFs, userIsolation, envIdentity, jobPaths, jobPath, jobLang } = require('../suite-runner');

const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' };
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false'];
const HELPER = path.join(__dirname, '..', 'docker', 'web', 'clodex-suite-exec');
const SOURCE = path.join(__dirname, '..', 'suite-runner.js');

function g(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...IDENT, ...args], { env: ENV, encoding: 'utf8' });
}

const SLOTS = new Map();
const jobOf = (dir) => SLOTS.get(path.basename(dir)) || path.basename(dir);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function fixture(t, { onSpawn, now, limits, kill, wrap, runnerOver } = {}) {
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
    const call = { cmd, args, opts, child, job: jobOf(opts.cwd ? path.dirname(opts.cwd) : args[3]), parentEnv: { ...process.env } };
    calls.push(call);
    (onSpawn || ((c) => { c.child.stdout.write('TOTALS: 1 pass, 0 fail, 1 tests\n'); c.child.finish(0); }))(call);
    return child;
  };
  const base = noneIsolation({ user: 'suite-test', kill: kill || ((pid, sig) => kills.push([pid, sig])) });
  const isolation = wrap ? wrap(base) : base;
  const make = (over = {}) => createSuiteRunner({ root, work, isolation, limits, spawn, now, timers, platform: 'linux', arch: 'x64', ...over });
  const runner = make(runnerOver);
  t.after(() => {
    runner.close();
    releaseSnapshot(snap);
    spawnSync('chmod', ['-R', 'u+w', root]);
  });
  const body = (id, kind = 'hand', extra = {}) => (SLOTS.set(path.basename(jobPaths(work, id).dir), id), {
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

test('a long-poll on a finished or unknown job answers at once and arms no wait', async (t) => {
  const f = await fixture(t);
  assert.strictEqual((await f.upload(f.body('j1'))).state, 'queued');
  await waitState(f.runner, 'j1', 'done');
  const armed = f.pending.length;
  const rows = [[['j1'], ['done']], [['nope'], ['gone']], [['j1', 'nope'], ['done', 'gone']]];
  const got = [];
  for (const [ids] of rows) got.push([ids, (await f.runner.poll(ids, { wait: 25000 })).jobs.map((j) => j.state)]);
  assert.deepStrictEqual(got, rows);
  assert.strictEqual(f.pending.length, armed);
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

test('cancelling a queued job reaps and kills nothing while another job runs', async (t) => {
  const seen = [];
  let blocker = null;
  const f = await fixture(t, {
    onSpawn: (c) => { if (c.job === 'blocker') blocker = c.child; else c.child.finish(0); },
    wrap: (base) => ({
      ...base,
      kill: (child, jobDir) => { seen.push(['kill', jobOf(jobDir)]); return base.kill(child, jobDir); },
      reap: (jobDir) => { seen.push(['reap', jobOf(jobDir)]); return base.reap(jobDir); },
    }),
  });
  await f.upload(f.body('blocker', 'hand'));
  await waitState(f.runner, 'blocker', 'running');
  assert.strictEqual((await f.runner.submit(f.body('waiting', 'hand'))).state, 'queued');
  await f.runner.cancel('waiting');
  const states = (await f.runner.poll(['blocker', 'waiting'])).jobs.map((j) => [j.id, j.state, j.reason]);
  assert.deepStrictEqual(states, [['blocker', 'running', null], ['waiting', 'done', 'cancelled']]);
  assert.deepStrictEqual(seen, []);
  blocker.finish(0);
  await waitState(f.runner, 'blocker', 'done');
});

test('a cancel that lands while submit or commit keeps the mirror refs leaves the job cancelled and unrun', async (t) => {
  let armed = null;
  let runner = null;
  const f = await fixture(t, {
    now: () => {
      if (armed && /\bat keep \(/.test(new Error().stack)) { const id = armed; armed = null; runner.cancel(id); }
      return Date.now();
    },
  });
  runner = f.runner;
  const viaCommit = await f.runner.submit(f.body('via-commit'));
  assert.strictEqual(viaCommit.state, 'awaiting-pack', 'ENTER: the first job needs a pack');
  const pack = await buildPack(f.snap, { have: viaCommit.have });
  assert.strictEqual((await f.runner.putPack('via-commit', 0, pack)).ok, true);
  armed = 'via-commit';
  const committed = await f.runner.commit('via-commit', { bytes: pack.length, sha256: sha256(pack) });
  armed = 'via-submit';
  const submitted = await f.runner.submit(f.body('via-submit'));
  assert.deepStrictEqual([committed, submitted], [
    { ok: false, status: 409, error: 'job is done', state: 'done' },
    { ok: false, status: 409, error: 'job is done', state: 'done' },
  ]);
  const states = (await f.runner.poll(['via-commit', 'via-submit'])).jobs.map((j) => [j.id, j.state, j.reason]);
  assert.deepStrictEqual(states, [['via-commit', 'done', 'cancelled'], ['via-submit', 'done', 'cancelled']]);
  assert.deepStrictEqual(f.calls.map((c) => c.job), []);
});

test('start() runs nothing until the restart reaps have finished', async (t) => {
  const reaps = [];
  let gate = null;
  const f = await fixture(t, {
    wrap: (base) => ({ ...base, reap: (jobDir) => { reaps.push(jobOf(jobDir)); return gate ? gate.then(() => base.reap(jobDir)) : base.reap(jobDir); } }),
  });
  await f.upload(f.body('first'));
  await waitState(f.runner, 'first', 'done');
  f.runner.close();
  const store = path.join(f.root, 'suite-runner', 'jobs');
  const stored = (id, state, seq) => {
    fs.mkdirSync(path.join(store, id), { recursive: true });
    fs.writeFileSync(path.join(store, id, 'job.json'), JSON.stringify({ ...f.body(id), state, reason: null, exit: null, seq, queuedAt: 1, startedAt: state === 'running' ? 2 : null, endedAt: null, lastSeen: Date.now(), out: { stdoutBytes: 0, stderrBytes: 0, truncated: false } }));
  };
  stored('was-running', 'running', 50);
  stored('next', 'queued', 51);
  let release;
  gate = new Promise((r) => { release = r; });
  reaps.length = 0;
  const runner = f.make();
  t.after(() => runner.close());
  runner.start();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(reaps, ['was-running'], 'ENTER: the restart reap is in flight');
  const held = (await runner.poll(['was-running', 'next'])).jobs.map((j) => [j.id, j.state, j.reason]);
  assert.deepStrictEqual(held, [['was-running', 'done', 'runner-restart'], ['next', 'queued', null]]);
  release();
  await waitState(runner, 'next', 'done');
  assert.deepStrictEqual(f.calls.map((c) => c.job), ['first', 'next']);
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

test('a cancel kill still in flight holds the next job until it lands', async (t) => {
  const seen = [];
  const children = {};
  let release = null;
  const f = await fixture(t, {
    onSpawn: (c) => { seen.push(['spawn', c.job]); children[c.job] = c.child; if (c.job !== 'first') c.child.finish(0); },
    wrap: (base) => ({
      ...base,
      kill: (child, jobDir) => {
        seen.push(['kill', jobOf(jobDir)]);
        return new Promise((resolve) => { release = () => { seen.push(['kill-landed', jobOf(jobDir)]); resolve(); }; });
      },
      reap: (jobDir) => { seen.push(['reap', jobOf(jobDir)]); return base.reap(jobDir); },
    }),
  });
  await f.upload(f.body('first', 'hand'));
  await waitState(f.runner, 'first', 'running');
  assert.strictEqual((await f.runner.submit(f.body('next', 'hand'))).state, 'queued');
  await f.runner.cancel('first');
  children.first.finish(null, 'SIGKILL');
  const first = await waitState(f.runner, 'first', 'done');
  assert.strictEqual(first.reason, 'cancelled', 'ENTER: the first job ended cancelled');
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(seen, [['spawn', 'first'], ['kill', 'first']]);
  assert.strictEqual((await f.runner.poll(['next'])).jobs[0].state, 'queued');
  release();
  await waitState(f.runner, 'next', 'done');
  assert.deepStrictEqual(seen, [['spawn', 'first'], ['kill', 'first'], ['kill-landed', 'first'], ['reap', 'first'], ['spawn', 'next'], ['reap', 'next']]);
});

test('a cancel after the timeout kill sends no second kill and the next job waits for the first one to land', async (t) => {
  const seen = [];
  const children = {};
  let release = null;
  const f = await fixture(t, {
    onSpawn: (c) => { seen.push(['spawn', c.job]); children[c.job] = c.child; if (c.job !== 'first') c.child.finish(0); },
    wrap: (base) => ({
      ...base,
      kill: (child, jobDir) => {
        const n = seen.filter((s) => s[0] === 'kill').length + 1;
        seen.push(['kill', jobOf(jobDir)]);
        return new Promise((resolve) => { if (n === 1) release = () => { seen.push(['kill-landed', jobOf(jobDir)]); resolve(); }; else resolve(); });
      },
      reap: (jobDir) => { seen.push(['reap', jobOf(jobDir)]); return base.reap(jobDir); },
    }),
  });
  await f.upload(f.body('first', 'hand', { timeoutMs: 5000 }));
  await waitState(f.runner, 'first', 'running');
  assert.strictEqual((await f.runner.submit(f.body('next', 'hand'))).state, 'queued');
  const timer = f.pending.find((h) => h.ms === 5000);
  assert.ok(timer, 'ENTER: the run armed its 5000 ms timer');
  timer.fn();
  await f.runner.cancel('first');
  children.first.finish(null, 'SIGKILL');
  await waitState(f.runner, 'first', 'done');
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(seen, [['spawn', 'first'], ['kill', 'first']]);
  release();
  await waitState(f.runner, 'next', 'done');
  assert.deepStrictEqual(seen, [['spawn', 'first'], ['kill', 'first'], ['kill-landed', 'first'], ['reap', 'first'], ['spawn', 'next'], ['reap', 'next']]);
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
  const jobDir = jobPaths(f.work, 'envjob').dir;
  assert.deepStrictEqual(call.opts.env, {
    TEAM_VAR: 'team value',
    CLODEX_TEST_LOCK: '0',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: path.join(jobDir, 'home'),
    TMPDIR: path.join(jobDir, 'tmp'),
    GIT_CEILING_DIRECTORIES: jobDir,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    USER: 'suite-test',
    LOGNAME: 'suite-test',
    SHELL: '/bin/sh',
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  });
  assert.deepStrictEqual([call.cmd, ...call.args], [process.execPath, 'scripts/run-tests.js', '--reporter=dot', 'test/a.test.js']);
});

test('the job PATH and LANG are fixed per platform and arch', () => {
  assert.deepStrictEqual([
    ['linux', 'x64', jobPath('linux', 'x64'), jobLang('linux')],
    ['linux', 'arm64', jobPath('linux', 'arm64'), jobLang('linux')],
    ['darwin', 'arm64', jobPath('darwin', 'arm64'), jobLang('darwin')],
    ['darwin', 'x64', jobPath('darwin', 'x64'), jobLang('darwin')],
  ], [
    ['linux', 'x64', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'C.UTF-8'],
    ['linux', 'arm64', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'C.UTF-8'],
    ['darwin', 'arm64', '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'en_US.UTF-8'],
    ['darwin', 'x64', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'en_US.UTF-8'],
  ]);
});

test('a darwin arm64 runner hands the test process the Homebrew PATH and en_US.UTF-8', async (t) => {
  const f = await fixture(t, { runnerOver: { platform: 'darwin', arch: 'arm64' } });
  await f.upload(f.body('macjob', 'hand', { files: ['test/a.test.js'] }));
  await waitState(f.runner, 'macjob', 'done');
  const call = f.calls.find((c) => c.job === 'macjob');
  assert.ok(call, 'ENTER: the job spawned');
  assert.deepStrictEqual([call.opts.env.PATH, call.opts.env.LANG], [
    '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'en_US.UTF-8',
  ]);
});

function gitProbe(jobDir, env, tag) {
  const run = (rel, ...args) => {
    const r = spawnSync('git', ['-C', path.join(jobDir, rel), ...args], { env: { ...env, PATH: ENV.PATH }, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : `fail: ${/not a git repository/.test(r.stderr) ? 'not a git repository' : r.stderr.trim()}`;
  };
  for (const d of [`fresh-${tag}`, `sub-${tag}`]) fs.mkdirSync(path.join(jobDir, 'tmp', d));
  return {
    tmp: run('tmp', 'rev-parse', '--show-toplevel'),
    fresh: run(path.join('tmp', `fresh-${tag}`), 'rev-parse', '--show-toplevel'),
    tree: run('tree', 'rev-parse', '--show-toplevel'),
    init: run(path.join('tmp', `sub-${tag}`), 'init', '-q'),
    subRepo: fs.existsSync(path.join(jobDir, 'tmp', `sub-${tag}`, '.git')),
  };
}

test('with the job env git finds the job tree but no repository above the job dir, even when the work root parent is a repository; without the ceiling it walks up', async (t) => {
  const seen = {};
  const f = await fixture(t, {
    onSpawn: (c) => {
      const jobDir = path.dirname(c.opts.cwd);
      const { GIT_CEILING_DIRECTORIES, ...bare } = c.opts.env;
      seen.jobDir = jobDir;
      seen.ceiling = GIT_CEILING_DIRECTORIES;
      seen.without = gitProbe(jobDir, bare, 'without');
      seen.withJobEnv = gitProbe(jobDir, c.opts.env, 'with');
      c.child.finish(0);
    },
  });
  g(f.root, 'init', '-q', '-b', 'master');
  g(f.root, 'commit', '-q', '--allow-empty', '-m', 'outer');
  const refs = () => g(f.root, 'for-each-ref') + g(f.root, 'worktree', 'list', '--porcelain');
  const before = refs();
  await f.upload(f.body('ceil', 'hand'));
  await waitState(f.runner, 'ceil', 'done');
  const outer = fs.realpathSync(f.root);
  const jobDir = jobPaths(f.work, 'ceil').dir;
  assert.strictEqual(seen.jobDir, jobDir, 'ENTER: the job spawned in its job dir');
  assert.deepStrictEqual(seen.without, {
    tmp: outer, fresh: outer, tree: path.join(jobDir, 'tree'), init: '', subRepo: true,
  });
  assert.deepStrictEqual(seen.withJobEnv, {
    tmp: 'fail: not a git repository', fresh: 'fail: not a git repository', tree: path.join(jobDir, 'tree'), init: '', subRepo: true,
  });
  assert.strictEqual(refs(), before);
  assert.strictEqual(seen.ceiling, jobDir);
});

test('the setup step env carries GIT_CEILING_DIRECTORIES set to the job dir under both isolation modes', async (t) => {
  const seen = {};
  const want = {};
  for (const mode of ['none', 'user']) {
    const f = await fixture(t, {
      onSpawn: (c) => c.child.finish(1),
      wrap: mode === 'user' ? (base) => ({ ...base, mode: 'user', spawn: userIsolation({ user: 'suite-test' }).spawn }) : undefined,
    });
    const id = `ceil-setup-${mode}`;
    await f.upload(f.body(id, 'hand', { setup: { run: 'npm ci', key: ['package.json'], paths: ['node_modules'] } }));
    await waitState(f.runner, id, 'done');
    assert.strictEqual(f.calls.length, 1, 'ENTER: only the setup step ran');
    const c = f.calls[0];
    const env = mode === 'user'
      ? Object.fromEntries(c.args.slice(4, c.args.indexOf('--')).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))
      : c.opts.env;
    seen[mode] = [mode === 'user' ? c.args[c.args.indexOf('--') + 1] : c.cmd, Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('GIT_')))];
    want[mode] = ['/bin/sh', { GIT_CEILING_DIRECTORIES: jobPaths(f.work, id).dir }];
  }
  assert.deepStrictEqual(seen, want);
});

test('a submit may not set GIT_CEILING_DIRECTORIES', async (t) => {
  const f = await fixture(t);
  const r = await f.runner.submit(f.body('ceil-env', 'hand', { env: { GIT_CEILING_DIRECTORIES: '/' } }));
  assert.deepStrictEqual([r.ok, r.error], [false, 'env key not allowed: GIT_CEILING_DIRECTORIES']);
});

test('envIdentity stamps the job locale of the platform, not the node process LANG', async () => {
  const env = { LANG: 'de_DE.ISO8859-1' };
  const ids = {};
  for (const platform of ['linux', 'darwin']) ids[platform] = await envIdentity({ isolation: 'user', env, imageFile: '/nonexistent/image.json', platform });
  assert.deepStrictEqual([ids.linux.lang, ids.darwin.lang], ['C.UTF-8', 'en_US.UTF-8']);
  assert.notStrictEqual(ids.linux.envKey, ids.darwin.envKey);
});

const LONG_ID = 't2267-runner-fixes-from-the-first-real-run-hand-attempt-0001-abc';
const LONG_ID_2 = 't2267-runner-fixes-from-the-first-real-run-hand-attempt-0002-abc';

test('under the default work root a 64-character job id gets a tree, home and temp dir of at most 40 bytes each, distinct per id', () => {
  assert.strictEqual(LONG_ID.length, 64);
  const a = jobPaths('/var/lib/clodex-suite', LONG_ID);
  const b = jobPaths('/var/lib/clodex-suite', LONG_ID_2);
  const lengths = [a.tree, a.home, a.tmp, b.tree, b.home, b.tmp].map((p) => Buffer.byteLength(p));
  assert.deepStrictEqual(lengths.map((n) => n <= 40), [true, true, true, true, true, true], `lengths ${lengths}`);
  assert.strictEqual(new Set([a.tree, a.home, a.tmp, b.tree, b.home, b.tmp]).size, 6);
  for (const p of [a.tree, a.home, a.tmp]) assert.ok(p.startsWith('/var/lib/clodex-suite/jobs/'), p);
});

test('a job runs in its short paths, the record keeps the full id, and prepare opens only its own mirror', async (t) => {
  const prepared = [];
  const f = await fixture(t, { wrap: (base) => ({ ...base, async prepare(jobDir, mirror) { prepared.push([jobDir, mirror]); } }) });
  await f.upload(f.body(LONG_ID));
  const done = await waitState(f.runner, LONG_ID, 'done');
  const short = jobPaths(f.work, LONG_ID);
  const call = f.calls.find((c) => c.job === LONG_ID);
  assert.ok(call, 'ENTER: the long-id job spawned');
  assert.deepStrictEqual([call.opts.cwd, call.opts.env.HOME, call.opts.env.TMPDIR], [short.tree, short.home, short.tmp]);
  assert.strictEqual(done.record.id, LONG_ID);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'suite-runner', 'jobs', LONG_ID, 'job.json'), 'utf8')).id, LONG_ID);
  const mirror = path.join(f.work, 'mirrors', `${f.snap.repoKey}.git`);
  assert.deepStrictEqual(prepared, [[short.dir, mirror]]);
  const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
  assert.deepStrictEqual([mode(path.join(f.work, 'mirrors')), mode(mirror), mode(path.join(f.work, 'deps'))], ['711', '700', '711']);
  await f.runner.tick();
  assert.deepStrictEqual([fs.existsSync(path.join(f.root, 'suite-runner', 'cache.json')), fs.existsSync(path.join(f.work, 'cache.json'))], [true, false], 'the cache index names every repo\'s deps, so it stays out of the work root');
});

test('a runner moves a cache index left in the work root into its data root', async (t) => {
  const f = await fixture(t);
  f.runner.close();
  fs.writeFileSync(path.join(f.work, 'cache.json'), JSON.stringify({ 'deps/x/y': 7 }));
  fs.mkdirSync(path.join(f.work, 'deps', 'x', 'y'), { recursive: true });
  fs.writeFileSync(path.join(f.work, 'deps', 'x', 'y.json'), '{}');
  const runner = f.make();
  t.after(() => runner.close());
  assert.strictEqual(fs.existsSync(path.join(f.work, 'cache.json')), false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'suite-runner', 'cache.json'), 'utf8')), { 'deps/x/y': 7 });
});

test('a runner chmods every mirror it finds at start to 0700', async (t) => {
  const f = await fixture(t);
  f.runner.close();
  const stale = path.join(f.work, 'mirrors', `${'c'.repeat(40)}.git`);
  fs.mkdirSync(stale, { mode: 0o755 });
  fs.chmodSync(stale, 0o755);
  const runner = f.make();
  t.after(() => runner.close());
  assert.strictEqual((fs.statSync(stale).mode & 0o777).toString(8), '700');
});

test('the environment key changes with the image version and with the image revision', async (t) => {
  const root = mkTmpRoot('suite-image-');
  const keyOf = async (image) => {
    const file = path.join(root, `${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify(image));
    return envIdentity({ isolation: 'user', env: {}, imageFile: file });
  };
  const base = await keyOf({ version: '5.175.0', rev: '924a9e23d4a1f0c2b3e4f5a6b7c8d9e0f1a2b3c4' });
  const rev = await keyOf({ version: '5.175.0', rev: '0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c' });
  const ver = await keyOf({ version: '5.176.0', rev: '924a9e23d4a1f0c2b3e4f5a6b7c8d9e0f1a2b3c4' });
  assert.deepStrictEqual([base.imageVersion, base.imageRev], ['5.175.0', '924a9e23d4a1f0c2b3e4f5a6b7c8d9e0f1a2b3c4']);
  assert.strictEqual(new Set([base.envKey, rev.envKey, ver.envKey]).size, 3);
  assert.ok(fs.readFileSync(SOURCE, 'utf8').includes("imageFile = '/etc/clodex/image.json'"), 'the default is the file the Dockerfile writes');
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
  const iso = [];
  const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
  const f = await fixture(t, {
    wrap: (base) => ({
      ...base,
      async prepare(jobDir, mirror, ...rest) {
        const entry = rest[0];
        iso.push(['prepare', jobOf(jobDir), rest, [path.dirname(path.dirname(entry)), path.dirname(entry), entry].map(mode)]);
        fs.chmodSync(entry, 0o750);
      },
      reap: (jobDir, ...rest) => { iso.push(['reap', jobOf(jobDir), rest]); return base.reap(jobDir); },
    }),
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
  assert.strictEqual((fs.statSync(repoDeps).mode & 0o777).toString(8), '711', 'a job cannot list the repo\'s deps entries');
  assert.strictEqual(entries.length, 1);
  const entry = path.join(repoDeps, entries[0]);
  assert.deepStrictEqual(listing(entry), {
    node_modules: { type: 'dir', mode: 0o555 },
    'node_modules/x.txt': { type: 'file', mode: 0o444, text: 'built\n' },
  });
  const target = path.join(entry, 'node_modules');
  assert.deepStrictEqual(links, [['d1', true, target], ['d2', true, target]]);
  assert.deepStrictEqual(iso, [
    ['prepare', 'd1', [entry], ['711', '711', '700']],
    ['reap', 'd1', [entry]],
    ['prepare', 'd2', [entry], ['711', '711', '700']],
    ['reap', 'd2', [entry]],
  ]);
  assert.strictEqual(mode(`${entry}.json`), '600');
});

test('a runner closes every deps entry and marker it finds at start', async (t) => {
  const f = await fixture(t);
  f.runner.close();
  const repo = path.join(f.work, 'deps', 'c'.repeat(40));
  const entry = path.join(repo, 'e'.repeat(64));
  fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(`${entry}.json`, '{}');
  for (const [p, m] of [[path.join(f.work, 'deps'), 0o755], [repo, 0o755], [entry, 0o755], [`${entry}.json`, 0o644]]) fs.chmodSync(p, m);
  const runner = f.make();
  t.after(() => runner.close());
  const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
  assert.deepStrictEqual([path.join(f.work, 'deps'), repo, entry, `${entry}.json`].map(mode), ['711', '711', '700', '600']);
});

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

test('a runner chmods its work root to 0711 at start', async (t) => {
  const f = await fixture(t);
  f.runner.close();
  fs.chmodSync(f.work, 0o755);
  const runner = f.make();
  t.after(() => runner.close());
  assert.strictEqual((fs.statSync(f.work).mode & 0o777).toString(8), '711');
});

test('at start the runner reconciles the cache index with the disk as the table says', async (t) => {
  const f = await fixture(t);
  f.runner.close();
  const repo = 'c'.repeat(40);
  const rows = [
    { name: 'a'.repeat(64), index: 11, dir: true, marker: true, want: 'kept' },
    { name: 'b'.repeat(64), index: 12, dir: false, marker: false, want: 'dropped' },
    { name: 'd'.repeat(64), index: null, dir: true, marker: true, want: 'removed' },
    { name: 'e'.repeat(64), index: 13, dir: true, marker: false, want: 'removed' },
  ];
  const cache = {};
  for (const row of rows) {
    const entry = path.join(f.work, 'deps', repo, row.name);
    if (row.dir) fs.mkdirSync(path.join(entry, 'node_modules'), { recursive: true });
    if (row.marker) fs.writeFileSync(`${entry}.json`, '{}');
    if (row.index != null) cache[path.join('deps', repo, row.name)] = row.index;
  }
  fs.mkdirSync(path.join(f.work, 'mirrors', `${'f'.repeat(40)}.git`));
  cache[path.join('mirrors', `${'9'.repeat(40)}.git`)] = 14;
  const cacheFile = path.join(f.root, 'suite-runner', 'cache.json');
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const runner = f.make();
  t.after(() => runner.close());
  await settle();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')), { [`deps/${repo}/${'a'.repeat(64)}`]: 11 });
  assert.deepStrictEqual(listing(path.join(f.work, 'deps')), {
    [repo]: { type: 'dir', mode: 0o711 },
    [`${repo}/${'a'.repeat(64)}`]: { type: 'dir', mode: 0o700 },
    [`${repo}/${'a'.repeat(64)}/node_modules`]: { type: 'dir', mode: 0o755 },
    [`${repo}/${'a'.repeat(64)}.json`]: { type: 'file', mode: 0o600, text: '{}' },
  }, 'ENTER: the kept row survives on disk');
  assert.deepStrictEqual(fs.readdirSync(path.join(f.work, 'mirrors')), [`${'f'.repeat(40)}.git`]);
});

test('reconciliation finishes before the first job runs, and a later start with a live job does not run it', async (t) => {
  let gate = null;
  const seen = [];
  const repo = 'c'.repeat(40);
  const orphan = (name) => { const p = path.join(f.work, 'deps', repo, name); fs.mkdirSync(p, { recursive: true }); return p; };
  let f = null;
  f = await fixture(t, {
    now: () => 1000,
    wrap: (base) => ({
      ...base,
      reap: (jobDir, ...rest) => (gate ? gate.then(() => base.reap(jobDir, ...rest)) : base.reap(jobDir, ...rest)),
      prepare: (jobDir, ...rest) => { seen.push([jobOf(jobDir), fs.existsSync(path.join(f.work, 'deps', repo, 'a'.repeat(64)))]); return base.prepare(jobDir, ...rest); },
    }),
    onSpawn: (c) => { if (c.job !== 'held') { c.child.stdout.write('TOTALS: 1 pass, 0 fail, 1 tests\n'); c.child.finish(0); } },
  });
  await f.upload(f.body('first'));
  await waitState(f.runner, 'first', 'done');
  f.runner.close();
  const store = path.join(f.root, 'suite-runner', 'jobs');
  const stored = (id, state, seq) => {
    fs.mkdirSync(path.join(store, id), { recursive: true });
    fs.writeFileSync(path.join(store, id, 'job.json'), JSON.stringify({ ...f.body(id), state, reason: null, exit: null, seq, queuedAt: 1, startedAt: state === 'running' ? 2 : null, endedAt: null, lastSeen: Date.now(), out: { stdoutBytes: 0, stderrBytes: 0, truncated: false } }));
  };
  stored('was-running', 'running', 50);
  stored('next', 'queued', 51);
  const stale = orphan('a'.repeat(64));
  let release;
  gate = new Promise((r) => { release = r; });
  seen.length = 0;
  const runner = f.make();
  t.after(() => runner.close());
  runner.start();
  await settle();
  assert.deepStrictEqual((await runner.poll(['next'])).jobs.map((j) => [j.id, j.state]), [['next', 'queued']]);
  assert.deepStrictEqual([seen, fs.existsSync(stale)], [[], true], 'ENTER: reconciliation is held and no job has started');
  release();
  gate = null;
  await waitState(runner, 'next', 'done');
  assert.deepStrictEqual(seen, [['next', false]]);
  await runner.submit(f.body('held'));
  await waitState(runner, 'held', 'running');
  const later = orphan('b'.repeat(64));
  runner.start();
  await settle();
  assert.strictEqual(fs.existsSync(later), true);
});

test('a job whose cache entry was dropped at start is a plain miss: setup runs once and the job passes', async (t) => {
  const onSpawn = (c) => {
    if (c.cmd === '/bin/sh') {
      fs.mkdirSync(path.join(c.opts.cwd, 'node_modules'));
      fs.writeFileSync(path.join(c.opts.cwd, 'node_modules', 'x.txt'), 'built\n');
    } else c.child.stdout.write('TOTALS: 1 pass, 0 fail, 1 tests\n');
    c.child.finish(0);
  };
  const f = await fixture(t, { onSpawn });
  const setup = { run: 'npm ci', key: ['package.json'], paths: ['node_modules'], timeoutMs: 60000 };
  await f.upload(f.body('d1', 'hand', { setup }));
  await waitState(f.runner, 'd1', 'done');
  f.runner.close();
  const repoDeps = path.join(f.work, 'deps', f.snap.repoKey);
  const [name] = fs.readdirSync(repoDeps).filter((n) => !n.endsWith('.json'));
  fs.chmodSync(path.join(repoDeps, name), 0o700);
  spawnSync('chmod', ['-R', 'u+w', path.join(repoDeps, name)]);
  fs.rmSync(path.join(repoDeps, name), { recursive: true });
  assert.strictEqual(fs.existsSync(path.join(repoDeps, `${name}.json`)), true, 'ENTER: the marker outlived its entry');
  f.calls.length = 0;
  const runner = f.make();
  t.after(() => runner.close());
  await runner.submit(f.body('d2', 'hand', { setup }));
  const done = await waitState(runner, 'd2', 'done');
  assert.deepStrictEqual(f.calls.map((c) => [c.job, c.cmd === '/bin/sh' ? 'setup' : 'test']), [['d2', 'setup'], ['d2', 'test']]);
  assert.deepStrictEqual([done.reason, done.exit], [null, { code: 0, signal: null }]);
  assert.deepStrictEqual(listing(path.join(repoDeps, name)), {
    node_modules: { type: 'dir', mode: 0o555 },
    'node_modules/x.txt': { type: 'file', mode: 0o444, text: 'built\n' },
  });
});

test('a runner moves its state from the old root into its data root, and a fresh start leaves the old root empty', async (t) => {
  const f = await fixture(t);
  f.runner.close();
  const data = path.join(f.root, 'data');
  const old = path.join(f.root, 'home');
  const oldState = path.join(old, 'suite-runner');
  fs.mkdirSync(path.join(oldState, 'jobs', 'm1'), { recursive: true });
  fs.writeFileSync(path.join(oldState, 'jobs', 'm1', 'job.json'), JSON.stringify({ ...f.body('m1'), state: 'done', reason: null, exit: null, seq: 4, queuedAt: 1, endedAt: Date.now(), out: { stdoutBytes: 0, stderrBytes: 0, truncated: false } }));
  fs.writeFileSync(path.join(oldState, 'cache.json'), '{"deps/x/y":7}');
  fs.mkdirSync(path.join(f.work, 'deps', 'x', 'y'), { recursive: true });
  fs.writeFileSync(path.join(f.work, 'deps', 'x', 'y.json'), '{}');
  fs.writeFileSync(path.join(oldState, 'ledger.jsonl'), '{"id":"m1"}\n');
  const moved = f.make({ root: data, oldRoot: old });
  t.after(() => moved.close());
  assert.deepStrictEqual((await moved.poll(['m1'])).jobs.map((j) => [j.id, j.state]), [['m1', 'done']]);
  assert.deepStrictEqual([
    fs.readFileSync(path.join(data, 'suite-runner', 'cache.json'), 'utf8'),
    fs.readFileSync(path.join(data, 'suite-runner', 'ledger.jsonl'), 'utf8'),
    (fs.statSync(path.join(data, 'suite-runner')).mode & 0o777).toString(8),
    fs.readdirSync(old),
  ], ['{"deps/x/y":7}', '{"id":"m1"}\n', '700', []]);
  const freshOld = path.join(f.root, 'fresh-home');
  fs.mkdirSync(freshOld);
  const fresh = f.make({ root: path.join(f.root, 'fresh-data'), oldRoot: freshOld });
  t.after(() => fresh.close());
  assert.deepStrictEqual([fs.readdirSync(freshOld), fs.existsSync(path.join(f.root, 'fresh-data', 'suite-runner', 'jobs'))], [[], true]);
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
  fs.writeFileSync(path.join(f.root, 'suite-runner', 'cache.json'), JSON.stringify({ [rel]: 0 }));
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
  const linked = path.join(work, 'jobs', 'job2');
  const entry = path.join(work, 'deps', 'a'.repeat(40), 'b'.repeat(64));
  for (const d of ['tree', 'home', 'tmp']) fs.mkdirSync(path.join(inside, d), { recursive: true });
  fs.mkdirSync(linked, { recursive: true });
  fs.mkdirSync(entry, { recursive: true });
  const outside = path.join(fs.realpathSync(root), 'elsewhere');
  fs.mkdirSync(path.join(outside, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'node_modules', 'keep.txt'), 'kept\n');
  fs.symlinkSync(outside, path.join(linked, 'tree'));
  const mirrors = path.join(work, 'mirrors');
  const own = path.join(mirrors, `${'a'.repeat(40)}.git`);
  const other = path.join(mirrors, `${'b'.repeat(64)}.git`);
  for (const m of [own, other]) { fs.mkdirSync(m, { recursive: true }); fs.chmodSync(m, 0o750); }
  fs.symlinkSync(outside, path.join(mirrors, `${'d'.repeat(40)}.git`));
  fs.mkdirSync(path.join(mirrors, 'not-a-mirror.git'));
  const env = { PATH: process.env.PATH, CLODEX_SUITE_WORK: work, CLODEX_SUITE_USER: 'clodex-suite-test-nouser' };
  const run = (...args) => spawnSync('bash', [HELPER, ...args], { env, encoding: 'utf8' });
  const rows = [
    ['prepare', outside],
    ['prepare', `${work}/jobs/../../elsewhere`],
    ['prepare', inside],
    ['prepare', inside, outside],
    ['prepare', inside, `${mirrors}/../elsewhere`],
    ['prepare', inside, path.join(mirrors, 'not-a-mirror.git')],
    ['prepare', inside, path.join(mirrors, `${'d'.repeat(40)}.git`)],
    ['run', outside, '--', '/bin/echo', 'hi'],
    ['seal', outside, entry, 'node_modules'],
    ['seal', inside, outside, 'node_modules'],
    ['seal', inside, entry, '../escape'],
    ['seal', linked, entry, 'node_modules'],
    ['reap', outside],
    ['reap', path.join(work, 'jobs')],
    ['prepare', inside, own, outside],
    ['prepare', inside, own, path.join(work, 'deps', 'a'.repeat(40))],
    ['prepare', inside, own, `${work}/deps/../elsewhere`],
    ['reap', inside, outside],
    ['reap', inside, path.join(work, 'deps', 'a'.repeat(40))],
  ];
  const got = rows.map((args) => { const r = run(...args); return [args[0], r.status, /refusing/.test(r.stderr)]; });
  assert.deepStrictEqual(got, rows.map((args) => [args[0], 2, true]));
  assert.strictEqual(fs.existsSync(outside), true);
  assert.strictEqual(fs.lstatSync(path.join(outside, 'node_modules')).isDirectory(), true);
  assert.deepStrictEqual(fs.readdirSync(entry), []);
  assert.strictEqual(fs.existsSync(inside), true, 'a refused reap removes nothing');
  const sibling = path.join(work, 'deps', 'a'.repeat(40), 'c'.repeat(64));
  fs.mkdirSync(sibling);
  for (const e of [entry, sibling]) fs.chmodSync(e, 0o750);
  const enter = run('reap', inside, entry);
  assert.strictEqual(enter.status, 0, `ENTER: an inside job is reaped (${enter.stderr})`);
  assert.strictEqual(fs.existsSync(inside), false);
  assert.deepStrictEqual([own, other].map((m) => (fs.statSync(m).mode & 0o777).toString(8)), ['700', '700'], 'reap closes every mirror');
  assert.deepStrictEqual([entry, sibling].map((e) => (fs.statSync(e).mode & 0o777).toString(8)), ['700', '750'], 'reap closes exactly the named deps entry');
});

test('clodex-suite-exec seal and reap kill the suite user with one kill -1 issued as that user, never pkill', () => {
  const src = fs.readFileSync(HELPER, 'utf8');
  const fn = /^kill_suite\(\) \{\n([^}]*)\n\}$/m.exec(src);
  assert.ok(fn, 'ENTER: the helper defines kill_suite');
  assert.strictEqual(fn[1].trim(), 'setpriv --reuid="$SUITE_USER" --regid="$SUITE_USER" --clear-groups kill -KILL -1 || true');
  const arm = (verb) => new RegExp(`^  ${verb}\\)\\n([\\s\\S]*?)\\n    ;;$`, 'm').exec(src)[1];
  const kills = ['seal', 'reap'].map((verb) => [verb, arm(verb).split('\n').map((l) => l.trim()).filter((l) => /kill/.test(l))]);
  assert.deepStrictEqual(kills, [['seal', ['kill_suite']], ['reap', ['kill_suite']]]);
  assert.strictEqual(/\bpkill\b/.test(src), false);
});

test('clodex-suite-exec prepare closes every mirror before it opens the job\'s own one to the suite group, read-only', () => {
  const src = fs.readFileSync(HELPER, 'utf8');
  const arm = /^ {2}prepare\)\n([\s\S]*?)\n {4};;$/m.exec(src);
  assert.ok(arm, 'ENTER: the helper has a prepare arm');
  const lines = arm[1].split('\n').map((l) => l.trim()).filter((l) => /mirror/.test(l));
  assert.deepStrictEqual(lines, [
    '[ $# -ge 1 ] || die "refusing prepare without the job\'s mirror"',
    'mirror="$(mirror_path "$1")"',
    'close_mirrors',
    'chgrp "$SUITE_USER" "$mirror"',
    'chmod 0750 "$mirror"',
  ]);
});

test('clodex-suite-exec prepare closes every deps entry before it opens only the named one, and seal leaves the sealed entry open to the suite group alone', () => {
  const src = fs.readFileSync(HELPER, 'utf8');
  const arm = (verb) => new RegExp(`^  ${verb}\\)\\n([\\s\\S]*?)\\n    ;;$`, 'm').exec(src)[1].split('\n').map((l) => l.trim());
  assert.deepStrictEqual(arm('prepare').filter((l) => /entry|deps/.test(l)), [
    'entry=""',
    'if [ $# -ge 1 ]; then entry="$(entry_path "$1")"; fi',
    'close_deps',
    'if [ -n "$entry" ]; then',
    'chgrp "$SUITE_USER" "$entry"',
    'chmod 0750 "$entry"',
  ]);
  assert.deepStrictEqual(arm('seal').slice(-4), [
    'chown -R "$owner" "$entry"',
    'chmod -R a-w,a+rX "$entry"',
    'chgrp "$SUITE_USER" "$entry"',
    'chmod 0750 "$entry"',
  ]);
  const fn = /^close_deps\(\) \{\n([^}]*)\n\}$/m.exec(src);
  assert.ok(fn, 'ENTER: the helper defines close_deps');
  assert.deepStrictEqual(fn[1].split('\n').map((l) => l.trim()), [
    'local e',
    'for e in "$WORK"/deps/*/*; do',
    '[ -d "$e" ] && [ ! -L "$e" ] || continue',
    'chmod 0700 "$e"',
    'done',
  ]);
});

test('suite-runner.js takes its fs only through resolveFs', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');
  assert.match(src, /^const fs = resolveFs\(\);$/m);
  assert.deepStrictEqual(src.match(/require\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/g), null);
  assert.deepStrictEqual(src.match(/load\(\s*['"][^'"]+['"]\s*\)/g), ["load('original-fs')", "load('fs')"]);
});

test('resolveFs falls back to fs when original-fs does not resolve', () => {
  const plain = { name: 'fs' };
  const load = (id) => { if (id === 'fs') return plain; throw Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' }); };
  assert.strictEqual(resolveFs(load), plain);
});

test('sealing deps holding an Electron archive chmods the archive itself, not its members', async (t) => {
  const realFs = resolveFs();
  const root = mkTmpRoot('suite-asar-');
  t.after(() => { spawnSync('chmod', ['-R', 'u+w', root]); realFs.rmSync(root, { recursive: true, force: true }); });
  const jobDir = path.join(root, 'job');
  const entry = path.join(root, 'entry');
  const app = path.join(jobDir, 'tree', 'node_modules', 'electron');
  realFs.mkdirSync(app, { recursive: true });
  realFs.writeFileSync(path.join(app, 'default_app.asar'), 'archive');
  const isArchive = (p) => p.endsWith('.asar');
  const inArchive = (p) => p.includes('.asar/');
  const electronFs = {
    ...realFs,
    lstatSync: (p) => {
      if (inArchive(p)) return { mode: 0o644, isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true };
      if (isArchive(p)) return { mode: realFs.lstatSync(p).mode, isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false };
      return realFs.lstatSync(p);
    },
    readdirSync: (p, ...rest) => (isArchive(p) ? ['default_app.js'] : realFs.readdirSync(p, ...rest)),
    chmodSync: (p, mode) => {
      if (inArchive(p)) throw Object.assign(new Error(`ENOTDIR: not a directory, chmod '${p}'`), { code: 'ENOTDIR' });
      realFs.chmodSync(p, mode);
    },
  };
  const chmods = [];
  const originalFs = { ...realFs, chmodSync: (p, mode) => { chmods.push(p); realFs.chmodSync(p, mode); } };
  const io = resolveFs((id) => ({ 'original-fs': originalFs, fs: electronFs })[id]);
  await noneIsolation({ user: 'suite-test', fs: io }).seal(jobDir, entry, ['node_modules']);
  const archive = path.join(entry, 'node_modules', 'electron', 'default_app.asar');
  assert.ok(chmods.includes(archive), `ENTER: ${chmods.join(', ')}`);
  assert.deepStrictEqual(chmods.filter(inArchive), []);
  assert.strictEqual(realFs.statSync(archive).mode & 0o222, 0);
  assert.strictEqual(realFs.readlinkSync(path.join(jobDir, 'tree', 'node_modules')), path.join(entry, 'node_modules'));
});
