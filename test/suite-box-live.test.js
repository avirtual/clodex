'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { snapshotTree, releaseSnapshot, buildPack } = require('../suite-snapshot');
const { createSuiteRunner, noneIsolation, jobPaths, statePaths } = require('../suite-runner');
const { boxIsolation, createDocker } = require('../suite-box');

const IMAGE_NAME = process.env.CLODEX_TEST_BOX_IMAGE || '';
const CHILD_FLAG = '--suite-box-live-child';
const GIT_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' };
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false'];
const DOCKER_MS = 30000;
const JOB_MS = 120000;
const WAIT_MS = 180000;

const FIXTURE_RUNNER = `'use strict';
const { spawnSync } = require('child_process');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const list = files.length ? files : ['test/a.test.js', 'test/b.test.js'];
let pass = 0;
let fail = 0;
for (const f of list) {
  const r = spawnSync(process.execPath, [f], { stdio: 'inherit', timeout: 600000 });
  if (r.status === 0) pass += 1; else fail += 1;
}
console.log('TOTALS: ' + pass + ' pass, ' + fail + ' fail, ' + list.length + ' tests');
process.exit(fail ? 1 : 0);
`;

const gitTest = (tag) => `'use strict';
const { execFileSync } = require('child_process');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const status = git('status', '--porcelain');
const log = git('log', '-1', '--format=%s');
const count = git('rev-list', '--count', 'HEAD');
console.log('${tag} STATUS=' + JSON.stringify(status) + ' LOG=' + log + ' COUNT=' + count);
`;

const WAIT_TEST = `'use strict';
const fs = require('fs');
console.log('WAIT-STARTED');
const until = Date.now() + 300000;
const t = setInterval(() => {
  if (fs.existsSync('release')) { clearInterval(t); console.log('WAIT-RELEASED'); process.exit(0); }
  if (Date.now() > until) { clearInterval(t); process.exit(1); }
}, 100);
`;

function g(dir, ...args) {
  return childProcess.execFileSync('git', ['-C', dir, ...IDENT, ...args], { env: GIT_ENV, encoding: 'utf8' });
}

function docker(...args) {
  const r = childProcess.spawnSync('docker', args, { encoding: 'utf8', timeout: DOCKER_MS, killSignal: 'SIGKILL' });
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${(r.stderr || '').trim() || r.error || r.status}`);
  return r.stdout.trim();
}

const idsOf = (label) => docker('ps', '-aq', '--filter', `label=${label}`).split('\n').filter(Boolean);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function until(what, fn, ms = WAIT_MS) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function makeRepo(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'test'));
  g(repo, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"box-live"}\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'one');
  fs.writeFileSync(path.join(repo, 'scripts', 'run-tests.js'), FIXTURE_RUNNER);
  fs.writeFileSync(path.join(repo, 'test', 'a.test.js'), gitTest('A'));
  fs.writeFileSync(path.join(repo, 'test', 'b.test.js'), gitTest('B'));
  fs.writeFileSync(path.join(repo, 'test', 'red.test.js'), "'use strict';\nconsole.log('RED');\nprocess.exit(1);\n");
  fs.writeFileSync(path.join(repo, 'test', 'wait.test.js'), WAIT_TEST);
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'fixture tests');
  return repo;
}

function bodyOf(snap, id, extra = {}) {
  return {
    id, attempt: 1, repoKey: snap.repoKey, kind: 'hand', scope: 'full', snap: snap.snap, treeHash: snap.treeHash,
    indexTree: snap.indexTree, sha: snap.head, branch: snap.branch, trunk: snap.trunk, refs: snap.refs,
    candidates: snap.candidates, files: [], flags: {}, timeoutMs: JOB_MS, ...extra,
  };
}

async function upload(runner, snap, body) {
  const r = await runner.submit(body);
  if (r.state !== 'awaiting-pack') return r;
  const pack = fs.readFileSync((await buildPack(snap, { have: r.have })).file);
  const put = await runner.putPack(body.id, 0, pack);
  if (!put.ok) return put;
  return runner.commit(body.id, { bytes: pack.length, sha256: sha256(pack) });
}

async function viewOf(runner, id) {
  return (await runner.poll([id])).jobs[0];
}

async function settled(runner, id, ms = WAIT_MS) {
  return until(`job ${id} done and reaped`, async () => {
    const v = await viewOf(runner, id);
    if (v.state !== 'done') return null;
    const i = await runner.info();
    return i.queue.running === id ? null : v;
  }, ms);
}

async function stdoutOf(runner, id) {
  return (await runner.output(id, { stream: 'stdout', offset: 0, length: 1 << 20 })).text;
}

const lastTotals = (text) => text.split('\n').filter((l) => l.startsWith('TOTALS:')).pop() || null;

function imageId() {
  return docker('image', 'inspect', '--format', '{{.Id}}', IMAGE_NAME);
}

function instrumentedSpawn(events) {
  return (cmd, args, opts) => {
    const child = childProcess.spawn(cmd, args, opts);
    if (cmd !== 'docker') return child;
    const rec = { args, early: [], writes: 0, exit: null };
    events.push({ at: 'spawn', rec });
    if (child.stdin) {
      for (const m of ['end', 'destroy']) {
        const orig = child.stdin[m].bind(child.stdin);
        child.stdin[m] = (...a) => {
          if (child.exitCode === null && child.signalCode === null) rec.early.push(m);
          return orig(...a);
        };
      }
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (...a) => { rec.writes += 1; return write(...a); };
    }
    child.on('exit', (code, signal) => { rec.exit = { code, signal }; });
    return child;
  };
}

function makeRoots(mkTmpRoot) {
  const root = mkTmpRoot('suite-box-live-');
  fs.mkdirSync(path.join(root, 'work'));
  const work = fs.realpathSync(path.join(root, 'work'));
  const stateDir = statePaths(root).dir;
  return { root, work, stateDir };
}

async function childMain() {
  const { root, work, repo, image, id } = JSON.parse(process.env.SUITE_BOX_LIVE_CHILD);
  const box = boxIsolation({ image, work, stateDir: statePaths(root).dir });
  const runner = createSuiteRunner({ root, work, isolation: noneIsolation(), box });
  const snap = await snapshotTree(repo);
  const r = await upload(runner, snap, bodyOf(snap, id, { isolation: 'container', files: ['test/wait.test.js'] }));
  if (r.state !== 'queued') throw new Error(`child submit: ${JSON.stringify(r)}`);
  await until('child job running with its marker', async () => (await stdoutOf(runner, id)).includes('WAIT-STARTED'), WAIT_MS);
  process.stdout.write(`RUNNING ${id}\n`);
  setInterval(() => {}, 1000);
}

if (process.argv.includes(CHILD_FLAG)) {
  childMain().catch((e) => { process.stderr.write(`child failed: ${e.stack}\n`); process.exit(2); });
} else {
  const { test, after } = require('node:test');
  const assert = require('node:assert');

  if (!IMAGE_NAME) {
    test('suite box live: needs CLODEX_TEST_BOX_IMAGE naming a local image with node and git', { skip: 'CLODEX_TEST_BOX_IMAGE is not set' }, () => {});
  } else {
    const cleanups = [];
    const scopes = new Set();
    const snaps = [];
    const children = [];
    const runners = [];

    after(async () => {
      for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
      for (const r of runners) {
        const q = (await r.info()).queue;
        for (const id of [q.running, ...q.queued].filter(Boolean)) await r.cancel(id);
        r.close();
      }
      for (const label of scopes) {
        try { const ids = idsOf(label); if (ids.length) docker('rm', '-f', ...ids); } catch {}
      }
      await until('every engine idle after teardown', async () => {
        for (const r of runners) if ((await r.info()).queue.running) return false;
        return true;
      }, 30000).catch(() => {});
      for (const s of snaps) releaseSnapshot(s);
      for (const fn of cleanups) { try { fn(); } catch {} }
    });
    const { mkTmpRoot } = require('./lib/tmp-roots');

    async function fixture({ box: withBox = true, dockerOver = null } = {}) {
      const r = makeRoots(mkTmpRoot);
      cleanups.push(() => childProcess.spawnSync('chmod', ['-R', 'u+w', r.root]));
      const image = imageId();
      const events = [];
      const logs = [];
      const dockerCalls = createDocker();
      const call = dockerOver ? dockerOver(dockerCalls.call, events) : dockerCalls.call;
      const box = boxIsolation({ image, work: r.work, stateDir: r.stateDir, docker: { call } });
      scopes.add(`clodex.suite.runner=${box.runnerKey}`);
      const repo = makeRepo(r.root);
      const snap = await snapshotTree(repo);
      snaps.push(snap);
      const make = (over = {}) => {
        const runner = createSuiteRunner({
          root: r.root, work: r.work, isolation: noneIsolation(), box: withBox ? box : null,
          spawn: instrumentedSpawn(events), log: (m) => logs.push(m), ...over,
        });
        runners.push(runner);
        return runner;
      };
      return { ...r, image, events, logs, box, repo, snap, make, runnerLabel: `clodex.suite.runner=${box.runnerKey}` };
    }

    let shared = null;
    async function sharedEngine() {
      if (!shared) {
        const f = await fixture();
        shared = { ...f, runner: f.make() };
      }
      return shared;
    }

    async function runJob(f, runner, id, extra) {
      const r = await upload(runner, f.snap, bodyOf(f.snap, id, extra));
      assert.strictEqual(r.state, 'queued', `submit ${id}: ${JSON.stringify(r)}`);
      return settled(runner, id);
    }

    function startChildEngine(f, id) {
      const env = { ...process.env, SUITE_BOX_LIVE_CHILD: JSON.stringify({ root: f.root, work: f.work, repo: f.repo, image: f.image, id }) };
      delete env.NODE_TEST_CONTEXT;
      const child = childProcess.spawn(process.execPath, [__filename, CHILD_FLAG], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
      return { child, exited, out: () => out, err: () => err };
    }

    async function killedChildEngine(f, id) {
      const c = startChildEngine(f, id);
      await until(`child engine reports ${id} running (stderr: ${c.err().slice(-400)})`, () => c.out().includes(`RUNNING ${id}`) || c.child.exitCode !== null);
      assert.ok(c.out().includes(`RUNNING ${id}`), `child engine died before the job ran: ${c.err().slice(-800)}`);
      assert.ok(idsOf(`clodex.suite.job=${id}`).length > 0, `ENTER: a container carries the job label ${id} before the kill`);
      c.child.kill('SIGKILL');
      await c.exited;
      return c;
    }

    test('a green box job ends by itself under -i: done, exit 0, its TOTALS, stamped container', async () => {
      const f = await sharedEngine();
      const info = await f.runner.info();
      assert.strictEqual(info.box && info.box.state, 'ready', `box not ready: ${JSON.stringify(info.box)} logs: ${f.logs.join(' | ')}`);
      const v = await runJob(f, f.runner, 'live-green', { isolation: 'container' });
      const out = await stdoutOf(f.runner, 'live-green');
      const runs = f.events.filter((e) => e.at === 'spawn' && e.rec.args.includes('clodex.suite.job=live-green'));
      assert.strictEqual(runs.length, 1, 'ENTER: one docker run for the green job');
      const rec = runs[0].rec;
      assert.deepStrictEqual({ reason: v.reason, exit: v.exit, cli: rec.exit, early: rec.early, writes: rec.writes },
        { reason: null, exit: { code: 0, signal: null }, cli: { code: 0, signal: null }, early: [], writes: 0 },
        `the docker CLI did not exit by itself with stdin held open; stdout: ${out.slice(-800)}`);
      assert.strictEqual(lastTotals(out), 'TOTALS: 2 pass, 0 fail, 2 tests');
      assert.ok(out.includes('A STATUS="" LOG=fixture tests COUNT=2\nB STATUS="" LOG=fixture tests COUNT=2\n'), `git in the detached box tree: ${out.slice(-800)}`);
      assert.strictEqual(v.state, 'done');
      assert.strictEqual(v.env.isolation, 'container');
      assert.strictEqual(v.env.box.imageId, f.image);
    });

    test('a red box job ends exit 1 with its TOTALS', async () => {
      const f = await sharedEngine();
      const v = await runJob(f, f.runner, 'live-red', { isolation: 'container', files: ['test/a.test.js', 'test/red.test.js'] });
      const out = await stdoutOf(f.runner, 'live-red');
      assert.deepStrictEqual({ reason: v.reason, exit: v.exit, totals: lastTotals(out), isolation: v.env.isolation },
        { reason: null, exit: { code: 1, signal: null }, totals: 'TOTALS: 1 pass, 1 fail, 2 tests', isolation: 'container' });
    });

    test('a native job on the same engine passes and is stamped native', async () => {
      const f = await sharedEngine();
      const v = await runJob(f, f.runner, 'live-native', {});
      const out = await stdoutOf(f.runner, 'live-native');
      assert.deepStrictEqual({ reason: v.reason, exit: v.exit, totals: lastTotals(out), isolation: v.env.isolation },
        { reason: null, exit: { code: 0, signal: null }, totals: 'TOTALS: 2 pass, 0 fail, 2 tests', isolation: 'none' });
      const boxOut = await stdoutOf(f.runner, 'live-green');
      const gitLines = (s) => s.split('\n').filter((l) => /^[AB] STATUS=/.test(l));
      assert.strictEqual(gitLines(out).length, 2, 'ENTER: both fixture tests printed their git line');
      assert.deepStrictEqual(gitLines(boxOut), gitLines(out));
    });

    test('a box job cancelled mid-run leaves no container with its label and no job dir', async () => {
      const f = await sharedEngine();
      const id = 'live-cancel';
      const r = await upload(f.runner, f.snap, bodyOf(f.snap, id, { isolation: 'container', files: ['test/wait.test.js'] }));
      assert.strictEqual(r.state, 'queued');
      await until(`${id} printing WAIT-STARTED`, async () => (await stdoutOf(f.runner, id)).includes('WAIT-STARTED'));
      assert.ok(idsOf(`clodex.suite.job=${id}`).length > 0, 'ENTER: the container is up before the cancel');
      await f.runner.cancel(id);
      const v = await settled(f.runner, id);
      assert.strictEqual(v.reason, 'cancelled');
      assert.deepStrictEqual(idsOf(`clodex.suite.job=${id}`), []);
      assert.strictEqual(fs.existsSync(jobPaths(f.work, id).dir), false, 'the job dir survived the cancel');
    });

    test('an engine SIGKILLed mid-job leaves no container with the job label within 5 s', async () => {
      const f = await fixture();
      const id = 'live-sigkill';
      await killedChildEngine(f, id);
      await until(`no container with label clodex.suite.job=${id}`, () => idsOf(`clodex.suite.job=${id}`).length === 0, 5000);
    });

    test('a labelled container is swept before a new engine on the same root starts its first job', async () => {
      const f = await fixture();
      const tag = `clodex.test.live=${crypto.randomUUID()}`;
      scopes.add(tag);
      const sleeper = docker('run', '-d', '--rm', '--label', 'clodex.suite=1', '--label', f.runnerLabel, '--label', tag, '--entrypoint', 'sleep', f.image, '300');
      assert.deepStrictEqual(idsOf(tag), [sleeper.slice(0, 12)], 'ENTER: the sleeper is up');
      const alive = [];
      const runner = f.make({
        spawn: (cmd, args, opts) => {
          alive.push(idsOf(tag).length > 0);
          return instrumentedSpawn(f.events)(cmd, args, opts);
        },
      });
      const v = await runJob(f, runner, 'live-swept', { isolation: 'container' });
      assert.deepStrictEqual({ alive, exit: v.exit }, { alive: [false], exit: { code: 0, signal: null } });
    });

    test('restart with no box image while a labelled container survives: the mount stays, native runs, cleanup waits for Docker', async () => {
      let psDown = true;
      const f = await fixture({
        dockerOver: (call) => (args, o) => (psDown && args[0] === 'ps' ? Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'injected: docker ps down', notFound: false, timedOut: false, error: 'docker ps exited 1' }) : call(args, o)),
      });
      const id = 'live-orphan';
      psDown = false;
      await killedChildEngine(f, id);
      const jobDir = jobPaths(f.work, id).dir;
      const tag = `clodex.test.live=${crypto.randomUUID()}`;
      scopes.add(tag);
      docker('run', '-d', '--rm', '--label', 'clodex.suite=1', '--label', f.runnerLabel, '--label', `clodex.suite.job=${id}`, '--label', tag,
        '--mount', `type=bind,src=${jobDir},dst=/job`, '--entrypoint', 'sleep', f.image, '300');
      psDown = true;
      const runner = f.make({ box: null, boxSweep: f.box.sweep });
      const native = await runJob(f, runner, 'live-orphan-native', {});
      assert.deepStrictEqual(native.exit, { code: 0, signal: null });
      const orphan = await viewOf(runner, id);
      assert.deepStrictEqual({ state: orphan.state, reason: orphan.reason }, { state: 'done', reason: 'runner-restart' });
      assert.strictEqual(idsOf(tag).length, 1, 'the labelled container is still up');
      assert.strictEqual(fs.existsSync(path.join(jobDir, 'tree', 'package.json')), true, 'the mounted job dir was removed under a live container');
      const hold = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'box-hold.json'), 'utf8'));
      assert.deepStrictEqual(hold.dirs, [jobDir]);
      psDown = false;
      await runner.tick();
      assert.deepStrictEqual({ containers: idsOf(tag), dir: fs.existsSync(jobDir), hold: fs.existsSync(path.join(f.stateDir, 'box-hold.json')) },
        { containers: [], dir: false, hold: false });
    });

    test('a docker ps failure during reap holds box jobs queued while native runs; cleanup precedes the next box admission', async () => {
      let failJobPs = false;
      const f = await fixture({
        dockerOver: (call, events) => (args, o) => {
          if (failJobPs && args[0] === 'ps' && String(args[3]).startsWith('label=clodex.suite.job=')) {
            return Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'injected: docker ps failed', notFound: false, timedOut: false, error: 'docker ps exited 1' });
          }
          return call(args, o).then((r) => { events.push({ at: 'call', args, ok: r.ok }); return r; });
        },
      });
      const first = 'live-held';
      const second = 'live-after';
      const firstDir = jobPaths(f.work, first).dir;
      const atAdmit = [];
      const runner = f.make({
        spawn: (cmd, args, opts) => {
          if (args.includes(`clodex.suite.job=${second}`)) atAdmit.push({ dir: fs.existsSync(firstDir), hold: fs.existsSync(path.join(f.stateDir, 'box-hold.json')) });
          return instrumentedSpawn(f.events)(cmd, args, opts);
        },
      });
      assert.strictEqual((await upload(runner, f.snap, bodyOf(f.snap, first, { isolation: 'container', files: ['test/wait.test.js'] }))).state, 'queued');
      await until(`${first} printing WAIT-STARTED`, async () => (await stdoutOf(runner, first)).includes('WAIT-STARTED'));
      assert.strictEqual((await upload(runner, f.snap, bodyOf(f.snap, second, { isolation: 'container' }))).state, 'queued');
      failJobPs = true;
      fs.writeFileSync(path.join(firstDir, 'tree', 'release'), '');
      await settled(runner, first);
      assert.match(f.logs.join('\n'), /box cleanup held: box cleanup not confirmed: docker ps failed: injected/);
      assert.strictEqual(fs.existsSync(firstDir), true, 'the held job dir was removed without a confirmed cleanup');
      const native = await runJob(f, runner, 'live-held-native', {});
      assert.deepStrictEqual(native.exit, { code: 0, signal: null });
      assert.strictEqual((await viewOf(runner, second)).state, 'queued');
      const info = await runner.info();
      assert.match(info.box.why, /^cleanup not confirmed: /);
      failJobPs = false;
      const mark = f.events.length;
      await runner.tick();
      const v = await settled(runner, second);
      assert.deepStrictEqual(v.exit, { code: 0, signal: null });
      const tail = f.events.slice(mark);
      const sweep = tail.findIndex((e) => e.at === 'call' && e.ok && e.args[0] === 'ps' && e.args[3] === `label=${f.runnerLabel}`);
      const admit = tail.findIndex((e) => e.at === 'spawn' && e.rec.args.includes(`clodex.suite.job=${second}`));
      assert.ok(sweep >= 0 && admit > sweep, `the sweep (${sweep}) must precede the box admission (${admit})`);
      assert.deepStrictEqual(atAdmit, [{ dir: false, hold: false }]);
    });
  }
}
