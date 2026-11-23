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
const { imagesDocker } = require('./lib/box-images');
const { snapshotTree, releaseSnapshot, buildPack } = require('../suite-snapshot');
const { createSuiteRunner, noneIsolation, jobPaths, statePaths } = require('../suite-runner');
const { boxIsolation, buildArgv, listProcs } = require('../suite-box');
const { boxFingerprint } = require('../team-box');
const { pickRunner, createSuiteClient } = require('../suite-client');
const { sanitizeSuiteRunner } = require('../stores');
const { suiteRunnerOptions } = require('../remote-wiring');

const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' };
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false'];
const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...IDENT, ...args], { env: ENV, encoding: 'utf8' });
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const DEF = 'FROM node:24-bookworm\nRUN true\n';
const HASH = boxFingerprint(DEF);
const DEF2 = 'FROM node:24-bookworm\nRUN false\n';
const HASH2 = boxFingerprint(DEF2);
const IMG_BUILT = `sha256:${'c'.repeat(64)}`;
const IMG_PARTIAL = `sha256:${'d'.repeat(64)}`;
const BOOT_TOKEN = '0123456789abcdef';
const BUILD = (definition = DEF, definitionHash = boxFingerprint(definition)) => ({ isolation: 'container', box: { definitionHash, rev: 1, definition } });
const GIB = 1024 ** 3;
const tokenOf = (c) => c.args.find((a) => a.startsWith('clodex.box.build=')).slice('clodex.box.build='.length);
const iidOf = (c) => c.args[c.args.indexOf('--iidfile') + 1];

async function fixture(t, { buildBoxes = true, slots = 1, limits = {}, freeBytes = 100 * GIB, procsFail = () => false, before = () => {} } = {}) {
  const root = mkTmpRoot('suite-box-build-');
  const repo = path.join(root, 'near');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'one');
  const snap = await snapshotTree(repo);
  const workRaw = path.join(root, 'work');
  fs.mkdirSync(workRaw);
  const work = fs.realpathSync(workRaw);
  let clock = Date.now();
  const images = [];
  const alive = new Map();
  const kills = [];
  const events = [];
  const calls = [];
  const pids = new Map();
  const names = new Map();
  const pending = [];
  const handlers = { build: null };
  const timers = {
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
    setInterval: () => ({}),
    clearInterval: () => {},
  };
  const base = imagesDocker(images);
  const docker = {
    calls: base.calls,
    call: async (args, o) => {
      if (args[0] === 'image' && args[1] === 'rm') {
        for (const id of args.slice(3)) { const i = images.findIndex((im) => im.id === id); if (i >= 0) images.splice(i, 1); }
      }
      return base.call(args, o);
    },
  };
  const kill = (pid, sig) => {
    kills.push([pid, sig]);
    events.push(`kill ${pid}`);
    const ch = pids.get(Math.abs(pid));
    if (ch) ch.finish(null, 'SIGKILL');
    alive.delete(Math.abs(pid));
  };
  const procs = async () => {
    events.push('procs');
    if (procsFail()) throw new Error('ps denied');
    return [...alive].map(([pid, command]) => ({ pid, command }));
  };
  const box = boxIsolation({
    image: null, work, stateDir: statePaths(root).dir, docker, kill, uid: 501, gid: 20, env: { CLODEX_NODE_NAME: 'box-host' },
    procs, statfs: () => ({ bavail: freeBytes / 4096, bsize: 4096 }), version: '9.9.9',
    timers: { setTimeout: (fn) => setImmediate(fn), clearTimeout: () => {} },
  });
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 5000 + calls.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.finish = (code, signal = null) => {
      if (child.ended) return;
      child.ended = true;
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, signal));
    };
    const call = { cmd, args, opts, child, stdin: '' };
    child.stdin.on('data', (d) => { call.stdin += d; });
    calls.push(call);
    pids.set(child.pid, child);
    if (cmd === 'docker' && args[0] === 'build') {
      events.push('build');
      alive.set(child.pid, `docker ${args.join(' ')}`);
      call.iidDirExists = fs.existsSync(path.dirname(iidOf(call)));
      handlers.build(call);
    } else {
      const label = args.find((a) => a.startsWith('clodex.suite.job='));
      events.push(label ? `run ${label.slice('clodex.suite.job='.length)}` : `native ${names.get(path.basename(path.dirname(opts.cwd)))}`);
      child.stdout.write('TOTALS: 1 pass, 0 fail, 1 tests\n');
      child.finish(0);
    }
    return child;
  };
  before({ root, alive, images });
  const make = (on) => createSuiteRunner({
    root, work, isolation: noneIsolation({ user: 'suite-test', kill: () => {} }), spawn, now: () => clock, timers,
    platform: 'linux', arch: 'x64', box, buildBoxes: on, slots, limits,
  });
  let runner = make(buildBoxes);
  t.after(() => {
    runner.close();
    releaseSnapshot(snap);
    spawnSync('chmod', ['-R', 'u+w', root]);
  });
  const body = (id, extra = {}) => {
    names.set(path.basename(jobPaths(work, id).dir), id);
    return {
      id, attempt: 1, repoKey: snap.repoKey, kind: 'hand', scope: 'full', snap: snap.snap, treeHash: snap.treeHash,
      indexTree: snap.indexTree, sha: snap.head, branch: snap.branch, trunk: snap.trunk, refs: snap.refs,
      candidates: snap.candidates, files: [], flags: {}, ...extra,
    };
  };
  const upload = async (b, origin = 'peer-a') => {
    const r = await runner.submit(b, { origin });
    if (r.state !== 'awaiting-pack') return r;
    const pack = fs.readFileSync((await buildPack(snap, { have: r.have })).file);
    assert.strictEqual((await runner.putPack(b.id, 0, pack)).ok, true);
    return runner.commit(b.id, { bytes: pack.length, sha256: sha256(pack) });
  };
  const builds = () => calls.filter((c) => c.cmd === 'docker' && c.args[0] === 'build');
  const succeed = (c) => {
    fs.writeFileSync(iidOf(c), IMG_BUILT);
    images.push({ id: IMG_BUILT, labels: [`clodex.box=${HASH}`, `clodex.box.build=${tokenOf(c)}`] });
    alive.delete(c.child.pid);
    c.child.finish(0);
  };
  const stderr = async (id) => (await runner.output(id, { stream: 'stderr' })).text;
  return {
    root, work, calls, images, alive, kills, events, docker, pending, handlers, body, upload, builds, succeed, stderr, box,
    get runner() { return runner; },
    restart: ({ buildBoxes: on, close }) => { if (close) runner.close(); runner = make(on); return runner; },
    tick: (ms) => { clock += ms; },
    stateFile: (name) => path.join(statePaths(root).dir, name),
  };
}

async function waitState(runner, id, state) {
  for (;;) {
    const r = await runner.poll([id], { wait: 1 });
    if (r.jobs[0].state === state) return r.jobs[0];
  }
}

async function until(fn) {
  for (let i = 0; i < 2000; i++) {
    if (await fn()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('condition never held');
}

function heldBuild(f) {
  let started;
  const started$ = new Promise((r) => { started = r; });
  f.handlers.build = (c) => started(c);
  return started$;
}

test('t2364: the build argv is the fixed line, with and without the base arg', () => {
  const iidFile = '/w/jobs/abcd1234/build/iid';
  assert.deepStrictEqual(buildArgv({ definition: DEF, definitionHash: HASH, token: BOOT_TOKEN, iidFile, version: '9.9.9' }), [
    'docker', 'build', '-t', `clodex-box:${HASH.slice(0, 12)}`, '--label', `clodex.box=${HASH}`, '--label', 'clodex.box.build=0123456789abcdef',
    '--iidfile', '/w/jobs/abcd1234/build/iid', '-',
  ]);
  const withBase = 'ARG CLODEX_BASE\nFROM ${CLODEX_BASE}\nRUN true\n';
  const h = boxFingerprint(withBase);
  assert.deepStrictEqual(buildArgv({ definition: withBase, definitionHash: h, token: BOOT_TOKEN, iidFile, version: '9.9.9' }), [
    'docker', 'build', '-t', `clodex-box:${h.slice(0, 12)}`, '--label', `clodex.box=${h}`, '--label', 'clodex.box.build=0123456789abcdef',
    '--build-arg', 'CLODEX_BASE=ghcr.io/avirtual/clodex:9.9.9', '--iidfile', '/w/jobs/abcd1234/build/iid', '-',
  ]);
});

test('t2364: the record keeps buildBoxes only when true, an invalid value drops only that key, and options pass it on', () => {
  const rec = { enabled: true, isolation: 'user', work: null };
  assert.deepStrictEqual(sanitizeSuiteRunner({ ...rec, buildBoxes: true }), { ...rec, buildBoxes: true });
  assert.deepStrictEqual(sanitizeSuiteRunner({ ...rec, buildBoxes: false }), rec);
  assert.deepStrictEqual(sanitizeSuiteRunner({ ...rec, slots: 2, buildBoxes: 'yes' }), { ...rec, slots: 2 });
  assert.strictEqual(suiteRunnerOptions({}, '/r', { setting: { ...rec, buildBoxes: true } }).buildBoxes, true);
  assert.strictEqual('buildBoxes' in suiteRunnerOptions({}, '/r', { setting: rec }), false);
});

test('t2364: with buildBoxes off a missing image answers exactly as before, whatever text the job carries', async (t) => {
  const f = await fixture(t, { buildBoxes: false });
  const today = { ok: false, status: 409, error: `no image for box ${HASH.slice(0, 12)} on this runner`, code: 'no-image' };
  assert.deepStrictEqual(await f.runner.submit(f.body('a', BUILD())), today);
  assert.deepStrictEqual(await f.runner.submit(f.body('b', BUILD(DEF2, HASH))), today);
  assert.deepStrictEqual((await f.runner.poll(['a', 'b'])).jobs.map((j) => j.state), ['gone', 'gone']);
  assert.deepStrictEqual((await f.runner.info({ definitionHash: HASH, rev: 1 })).box, { state: 'no-image', why: `no image for box ${HASH.slice(0, 12)} on this runner` });
  assert.deepStrictEqual(f.builds(), []);
});

test('t2364: a definition text that does not match its hash is refused box-failed before any Docker call', async (t) => {
  const f = await fixture(t);
  assert.deepStrictEqual(await f.runner.submit(f.body('bad', BUILD(DEF2, HASH))), { ok: true, id: 'bad', state: 'done', position: null });
  const row = (await f.runner.poll(['bad'])).jobs[0];
  assert.deepStrictEqual([row.id, row.state, row.reason], ['bad', 'done', 'box-failed'], 'ENTER: the job row exists');
  assert.strictEqual(await f.stderr('bad'), 'suite-runner: box build: definition text does not match its hash\n');
  assert.strictEqual(f.docker.calls.length, 0);
});

test('t2364: three queued jobs of one hash share one build, wait in phase build, and each runs stamped built', async (t) => {
  const f = await fixture(t);
  const started = heldBuild(f);
  assert.strictEqual((await f.upload(f.body('j1', BUILD()))).state, 'queued');
  const c = await started;
  assert.strictEqual((await f.upload(f.body('j2', BUILD()))).state, 'build');
  assert.strictEqual((await f.upload(f.body('j3', BUILD()))).state, 'build');
  assert.deepStrictEqual((await f.runner.poll(['j1', 'j2', 'j3'])).jobs.map((j) => j.state), ['build', 'build', 'build']);
  const act = await f.runner.activity();
  assert.deepStrictEqual([act.running.map((j) => [j.id, j.phase]), act.waiting.map((j) => [j.id, j.phase])],
    [[['j1', 'build']], [['j2', 'build'], ['j3', 'build']]]);
  assert.deepStrictEqual((await f.runner.info({ definitionHash: HASH, rev: 1 })).box,
    { state: 'building', definitionHash: HASH, why: `building box ${HASH.slice(0, 12)} on this runner` });
  assert.strictEqual(iidOf(c), path.join(jobPaths(f.work, 'j1').dir, 'build', 'iid'));
  assert.strictEqual(c.iidDirExists, true);
  assert.strictEqual(c.stdin, DEF);
  f.succeed(c);
  const done = [];
  for (const id of ['j1', 'j2', 'j3']) done.push(await waitState(f.runner, id, 'done'));
  assert.deepStrictEqual(done.map((j) => [j.id, j.reason, j.env.box]), ['j1', 'j2', 'j3'].map((id) => [id, null, { imageId: IMG_BUILT, definitionHash: HASH, rev: 1, built: true }]));
  assert.strictEqual(f.builds().length, 1);
  assert.deepStrictEqual(f.events, ['build', 'run j1', 'run j2', 'run j3']);
  const built = JSON.parse(fs.readFileSync(f.stateFile('box-built.json'), 'utf8'));
  assert.deepStrictEqual(built.map((r) => [r.imageId, r.definitionHash]), [[IMG_BUILT, HASH]]);
  assert.strictEqual(fs.existsSync(f.stateFile('box-build.json')), false);
});

test('t2364: a build holds a slot: with one slot a native job waits for the build and the box run', async (t) => {
  const f = await fixture(t);
  const started = heldBuild(f);
  assert.strictEqual((await f.upload(f.body('b1', BUILD()))).state, 'queued');
  const c = await started;
  assert.strictEqual((await f.upload(f.body('n1'))).state, 'queued');
  assert.deepStrictEqual((await f.runner.info()).slots, { total: 1, inUse: 1 });
  f.succeed(c);
  await waitState(f.runner, 'n1', 'done');
  assert.deepStrictEqual(f.events, ['build', 'run b1', 'native n1']);
});

test('t2364: a failed build ends every waiter box-failed with the tail, cools off, then builds again', async (t) => {
  const f = await fixture(t);
  const started = heldBuild(f);
  await f.upload(f.body('j1', BUILD()));
  const c = await started;
  await f.upload(f.body('j2', BUILD()));
  await f.upload(f.body('j3', BUILD()));
  c.child.stderr.write('#1 step one\nERROR: failed to solve: boom\n');
  f.alive.delete(c.child.pid);
  c.child.finish(1);
  const rows = [];
  for (const id of ['j1', 'j2', 'j3']) rows.push((await waitState(f.runner, id, 'done')).reason);
  assert.deepStrictEqual(rows, ['box-failed', 'box-failed', 'box-failed']);
  const line = 'suite-runner: box build: docker build exited 1: ERROR: failed to solve: boom\n';
  assert.strictEqual(await f.stderr('j2'), `#1 step one\nERROR: failed to solve: boom\n${line}`);
  assert.strictEqual(await f.stderr('j1'), `#1 step one\nERROR: failed to solve: boom\n${line}`);
  const calls = f.docker.calls.length;
  assert.deepStrictEqual(await f.runner.submit(f.body('j4', BUILD())), { ok: true, id: 'j4', state: 'done', position: null });
  assert.strictEqual(await f.stderr('j4'), `#1 step one\nERROR: failed to solve: boom\n${line}`);
  assert.strictEqual(f.docker.calls.length, calls);
  assert.strictEqual(f.builds().length, 1);
  f.tick(10 * 60 * 1000 + 1);
  const again = heldBuild(f);
  assert.strictEqual((await f.upload(f.body('j5', BUILD()))).state, 'queued');
  await again;
  assert.strictEqual(f.builds().length, 2);
});

for (const confirm of ['confirmed', 'not confirmed']) {
  for (const way of ['cancel', 'time cap']) {
    test(`t2364: a build ended by ${way} kills the client, then checks the token (${confirm})`, async (t) => {
      let failing = false;
      const f = await fixture(t, { procsFail: () => failing });
      const started = heldBuild(f);
      await f.upload(f.body('j1', BUILD()));
      const c = await started;
      const token = tokenOf(c);
      f.images.push({ id: IMG_PARTIAL, labels: [`clodex.box.build=${token}`] });
      await f.upload(f.body('j2', BUILD()));
      failing = confirm === 'not confirmed';
      f.events.length = 0;
      if (way === 'cancel') await f.runner.cancel('j1');
      else f.pending.find((h) => h.ms === 20 * 60 * 1000).fn();
      const j1 = await waitState(f.runner, 'j1', 'done');
      const j2 = await waitState(f.runner, 'j2', 'done');
      assert.deepStrictEqual([j1.reason, j2.reason], [way === 'cancel' ? 'cancelled' : 'box-failed', 'box-failed']);
      assert.deepStrictEqual(f.events.slice(0, 2), [`kill -${c.child.pid}`, 'procs']);
      const why = way === 'cancel' ? 'the build was cancelled' : 'the build did not finish within 1200000 ms (killed)';
      assert.strictEqual(await f.stderr('j2'), `suite-runner: box build: ${why}\n`);
      if (confirm === 'confirmed') {
        assert.deepStrictEqual(f.images, []);
        assert.ok(f.docker.calls.some((x) => x.args.join(' ') === `image rm -f ${IMG_PARTIAL}`));
        assert.strictEqual(fs.existsSync(f.stateFile('box-build.json')), false);
        return;
      }
      const hold = JSON.parse(fs.readFileSync(f.stateFile('box-build.json'), 'utf8'));
      assert.deepStrictEqual([hold.token, hold.why], [token, 'build cleanup not confirmed: the process list failed: ps denied']);
      assert.deepStrictEqual(await f.upload(f.body('j3', BUILD(DEF2))), { ok: true, id: 'j3', state: 'done', position: null });
      assert.strictEqual(await f.stderr('j3'), `suite-runner: box build: cleanup of build ${token.slice(0, 8)} is not confirmed: build cleanup not confirmed: the process list failed: ps denied\n`);
      assert.strictEqual((await f.upload(f.body('n1'))).state, 'queued');
      assert.strictEqual((await waitState(f.runner, 'n1', 'done')).reason, null);
      assert.strictEqual(f.builds().length, 1);
    });
  }
  test(`t2364: the boot sweep kills a build client left by a crash and removes its image (${confirm})`, async (t) => {
    const f = await fixture(t, {
      procsFail: () => confirm === 'not confirmed',
      before: ({ root, alive, images }) => {
        fs.mkdirSync(statePaths(root).dir, { recursive: true });
        fs.writeFileSync(path.join(statePaths(root).dir, 'box-build.json'), JSON.stringify({ token: BOOT_TOKEN, definitionHash: HASH, startedAt: 1 }));
        alive.set(777, `docker build -t clodex-box:x --label clodex.box.build=${BOOT_TOKEN} -`);
        images.push({ id: IMG_PARTIAL, labels: [`clodex.box.build=${BOOT_TOKEN}`] });
      },
    });
    if (confirm === 'confirmed') {
      await until(() => !fs.existsSync(f.stateFile('box-build.json')));
      assert.deepStrictEqual(f.kills, [[777, 'SIGKILL']]);
      assert.deepStrictEqual(f.images, []);
      assert.strictEqual((await f.upload(f.body('j1', BUILD()))).state, 'queued');
      return;
    }
    await until(() => /ps denied/.test(fs.readFileSync(f.stateFile('box-build.json'), 'utf8')));
    assert.deepStrictEqual(await f.upload(f.body('j1', BUILD())), { ok: true, id: 'j1', state: 'done', position: null });
    assert.match(await f.stderr('j1'), /^suite-runner: box build: cleanup of build 01234567 is not confirmed: build cleanup not confirmed: the process list failed: ps denied\n$/);
    assert.strictEqual((await f.upload(f.body('n1'))).state, 'queued');
    assert.strictEqual((await waitState(f.runner, 'n1', 'done')).reason, null);
    assert.deepStrictEqual(f.builds(), []);
  });
}

test('t2364: the 13th build in 24 h from one origin is refused whatever the team, another origin still builds', async (t) => {
  const f = await fixture(t);
  const at = Date.now() - 60 * 60 * 1000;
  fs.writeFileSync(f.stateFile('box-builds.json'), JSON.stringify(Array.from({ length: 12 }, () => ({ at, origin: 'peer-a', definitionHash: HASH2 }))));
  assert.deepStrictEqual(await f.upload(f.body('a', { ...BUILD(), team: 'team-other' }), 'peer-a'), { ok: true, id: 'a', state: 'done', position: null });
  assert.strictEqual(await f.stderr('a'), 'suite-runner: box build: 12 box builds in the last 24 h for peer-a; the cap is 12\n');
  heldBuild(f);
  assert.strictEqual((await f.upload(f.body('b', { ...BUILD(), team: 'team-other' }), 'peer-b')).state, 'queued');
});

test('t2364: a free-disk reading below the floor refuses the build', async (t) => {
  const f = await fixture(t, { freeBytes: 5 * GIB });
  assert.strictEqual((await f.upload(f.body('a', BUILD()))).state, 'done');
  assert.strictEqual(await f.stderr('a'), `suite-runner: box build: 5.0 GiB free on the work root ${f.work}; a build needs 10 GiB\n`);
  assert.deepStrictEqual((await f.runner.info({ definitionHash: HASH, rev: 1 }, { origin: 'peer-a' })).box,
    { state: 'no-image', why: `no image for box ${HASH.slice(0, 12)} on this runner; no build: 5.0 GiB free on the work root ${f.work}; a build needs 10 GiB` });
});

test('t2364: info answers can-build for a missing image when builds are allowed and open', async (t) => {
  const f = await fixture(t);
  assert.deepStrictEqual((await f.runner.info({ definitionHash: HASH, rev: 1 }, { origin: 'peer-a' })).box,
    { state: 'can-build', definitionHash: HASH, why: `no image for box ${HASH.slice(0, 12)} on this runner; it builds one on the first job` });
});

const H = 'a'.repeat(64);
const member = (peer, box, free = 1) => ({ peer, live: true, info: { box, slots: { total: 2, inUse: 2 - free }, queue: { queued: [] } } });
const READY = { state: 'ready', env: { box: { definitionHash: H } } };
const BUILDING = { state: 'building', definitionHash: H };
const CAN = { state: 'can-build', definitionHash: H };
const NONE = { state: 'no-image', why: 'x' };

for (const [name, members, picked] of [
  ['ready beats building and can-build', [member('m-can', CAN, 2), member('m-building', BUILDING, 2), member('m-ready', READY, 0)], 'm-ready'],
  ['building beats can-build', [member('m-can', CAN, 2), member('m-building', BUILDING, 0)], 'm-building'],
  ['can-build when nothing is ready or building', [member('m-none', NONE, 2), member('m-can', CAN, 0)], 'm-can'],
  ['no member without an image or a build', [member('m-none', NONE, 2)], null],
  ['a can-build for another hash is not eligible', [member('m-other', { ...CAN, definitionHash: 'b'.repeat(64) }, 2)], null],
]) {
  test(`t2364: pickRunner — ${name}`, () => {
    const pick = pickRunner(members, { box: { definitionHash: H, rev: 1 } });
    assert.strictEqual(pick.chosen ? pick.member.peer : null, picked);
  });
}

function leadClient(states, { stderr = '' } = {}) {
  let clock = 1_000_000;
  let polls = 0;
  const events = [];
  const conn = {
    suiteAsk: async (method, p) => {
      if (method === 'DELETE') { events.push('cancel'); return { status: 200, body: { ok: true } }; }
      if (p === '/api/suite/info') return { status: 200, body: { ok: true, limits: {}, env: { envKey: 'k' } } };
      if (method === 'POST') return { status: 200, body: { ok: true, state: 'queued' } };
      if (p.includes('/output?')) {
        const text = p.includes('stream=stdout') ? 'TOTALS: 5 pass, 0 fail, 5 tests\n' : stderr;
        return { status: 200, body: { ok: true, text, offset: 0, total: Buffer.byteLength(text) } };
      }
      const id = decodeURIComponent(/ids=([^&]+)/.exec(p)[1]);
      const st = states[Math.min(polls, states.length - 1)];
      polls += 1;
      return { status: 200, body: { ok: true, jobs: [{ id, treeHash: 'a'.repeat(40), ...st }] } };
    },
  };
  const client = createSuiteClient({
    getPeerManager: () => ({ get: () => conn }),
    snapshot: { snapshotTree: async () => ({ treeHash: 'a'.repeat(40), head: 'b'.repeat(40), headTree: 'a'.repeat(40) }), releaseSnapshot: () => {} },
    sleep: async () => {},
    now: () => { clock += 60_000; return clock; },
  });
  return { client, events };
}

const DONE = (over = {}) => ({
  state: 'done', env: { isolation: 'container', box: { imageId: IMG_BUILT, definitionHash: H, rev: 1, built: true } },
  exit: { code: 0, signal: null }, reason: null, queueMs: 0, setupMs: 0, runMs: 1, out: {}, ...over,
});
const RUN = { peer: 'p1', snap: { treeHash: 'a'.repeat(40), head: 'b'.repeat(40) }, box: { definitionHash: H, rev: 1, definition: 'FROM x\n' }, queueBudgetMs: 5 * 60_000 };

test('t2364: a job in phase build does not trip the queue budget and its result decides', async () => {
  const l = leadClient([...Array(8).fill({ state: 'build' }), DONE()]);
  const out = await l.client.run(RUN);
  assert.deepStrictEqual([out.unknown, out.record.outcome], [null, 'pass']);
  assert.deepStrictEqual(l.events, []);
});

test('t2364: past the build budget the lead cancels with a box build reason', async () => {
  const l = leadClient([{ state: 'build' }]);
  const out = await l.client.run(RUN);
  assert.deepStrictEqual([out.unknown, out.record.outcome], ['the box build did not finish within the 1500000ms build budget (cancelled)', 'timeout']);
  assert.deepStrictEqual(l.events, ['cancel']);
});

test('t2364: a failed build reads as unknown with the build reason, never as a red suite', async () => {
  const l = leadClient([{ state: 'build' }, DONE({ env: null, reason: 'box-failed', exit: null })], { stderr: 'ERROR: boom\nsuite-runner: box build: docker build exited 1: ERROR: boom\n' });
  const out = await l.client.run(RUN);
  assert.deepStrictEqual([out.unknown, out.record.outcome], ['box build on runner: docker build exited 1: ERROR: boom', 'unknown']);
});

test('t2364: Preferences carries the build checkbox with its hint, and Apply sends the field', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /<input type="checkbox" id="prefs-suite-runner-buildBoxes">\s*<span>Build box images that teams ask for<\/span>/);
  assert.ok(html.includes('<p class="hint-text">Lets every peer you allow to run jobs here run its Dockerfile build steps on this machine, with network access, and keeps the resulting image on disk. Off: a job whose image is missing is refused, as before. Builds can pull any image your Docker login can.</p>'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(src.includes("const prefsSuiteRunnerBuildBoxes = document.getElementById('prefs-suite-runner-buildBoxes');"));
  assert.ok(src.includes('buildBoxes: prefsSuiteRunnerBuildBoxes.checked'));
  const { suiteRunnerRecordFromForm } = require('../renderer/lib/offer-view');
  const shown = { setting: { enabled: true, isolation: 'user', work: null }, forced: [] };
  const form = { enabled: true, isolation: 'user', work: '', boxImage: '', slots: '1' };
  assert.deepStrictEqual(suiteRunnerRecordFromForm(shown, { ...form, buildBoxes: true }), { enabled: true, isolation: 'user', work: null, buildBoxes: true });
  assert.deepStrictEqual(suiteRunnerRecordFromForm(shown, { ...form, buildBoxes: false }), { enabled: true, isolation: 'user', work: null });
});

test('t2366: jobs waiting in build count against queueMax, and the next submit gets the queue-full answer', async (t) => {
  const f = await fixture(t, { limits: { queueMax: 2 } });
  const started = heldBuild(f);
  await f.upload(f.body('j1', BUILD()));
  await started;
  await f.upload(f.body('j2', BUILD()));
  assert.deepStrictEqual((await f.runner.poll(['j1', 'j2'])).jobs.map((j) => j.state), ['build', 'build']);
  assert.deepStrictEqual(await f.runner.submit(f.body('j3', BUILD()), { origin: 'peer-a' }), { ok: false, status: 429, error: 'queue full' });
});

test('t2366: a queued build job that meets a runner reloaded with builds off ends box-failed with no docker build', async (t) => {
  const f = await fixture(t);
  const started = heldBuild(f);
  await f.upload(f.body('j1', BUILD()));
  const c = await started;
  assert.strictEqual((await f.upload(f.body('j2', BUILD(DEF2)))).state, 'queued');
  const old = f.runner;
  old.close();
  f.alive.delete(c.child.pid);
  c.child.finish(1);
  await until(async () => (await old.poll(['j1'])).jobs[0].state === 'done');
  assert.strictEqual(f.builds().length, 1, 'ENTER: the first runner ran one build');
  f.handlers.build = (b) => { f.alive.delete(b.child.pid); b.child.finish(1); };
  const r = f.restart({ buildBoxes: false });
  r.start();
  const j2 = await waitState(r, 'j2', 'done');
  assert.strictEqual(j2.reason, 'box-failed');
  assert.strictEqual(await f.stderr('j2'), 'suite-runner: box build: builds are off on this runner\n');
  assert.strictEqual(f.builds().length, 1);
});

test('t2366: a build that ends on its own reaches endBuild with no pid and no process-group kill follows', async (t) => {
  const f = await fixture(t);
  const ended = [];
  const endBuild = f.box.endBuild;
  f.box.endBuild = (o) => { ended.push(o); return endBuild(o); };
  const started = heldBuild(f);
  await f.upload(f.body('j1', BUILD()));
  const c = await started;
  f.alive.delete(c.child.pid);
  c.child.finish(1);
  assert.strictEqual((await waitState(f.runner, 'j1', 'done')).reason, 'box-failed');
  assert.deepStrictEqual(ended, [{ token: tokenOf(c) }]);
  assert.deepStrictEqual(f.kills, []);
});

test('t2366: listProcs asks ps for every process untruncated and finds a token at the end of a long line', async (t) => {
  const cp = require('node:child_process');
  const seen = [];
  const long = `docker build -t clodex-box:x ${'--label clodex.x=y '.repeat(12)}--label clodex.box.build=${BOOT_TOKEN} -`;
  assert.ok(long.length > 200, 'ENTER: the line is longer than 200 characters');
  t.mock.method(cp, 'execFile', (cmd, args, opts, cb) => { seen.push([cmd, args]); cb(null, `    1 /sbin/launchd\n 4242 ${long}\n`); });
  const rows = await listProcs();
  assert.deepStrictEqual(seen, [['ps', ['-A', '-ww', '-o', 'pid=,args=']]]);
  assert.deepStrictEqual(rows.filter((r) => r.command.includes(`clodex.box.build=${BOOT_TOKEN}`)), [{ pid: 4242, command: long }]);
});

test('t2366: the lead client reports each job state change to onState', async () => {
  const l = leadClient([{ state: 'queued' }, { state: 'build' }, { state: 'build' }, DONE()]);
  const seen = [];
  const out = await l.client.run({ ...RUN, onState: (s) => seen.push(s) });
  assert.deepStrictEqual([out.record.outcome, seen], ['pass', ['queued', 'build', 'done']]);
});
