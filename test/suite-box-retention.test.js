'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { imagesDocker } = require('./lib/box-images');
const { snapshotTree, releaseSnapshot } = require('../suite-snapshot');
const { createSuiteRunner, noneIsolation, statePaths, boxPrunePlan } = require('../suite-runner');
const { boxIsolation } = require('../suite-box');

const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' };
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false'];
const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...IDENT, ...args], { env: ENV, encoding: 'utf8' });

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);
const H4 = '4'.repeat(64);
const img = (hash, n) => ({ hash, id: `sha256:${String(n).repeat(64)}`, labels: [`clodex.box=${hash}`], tags: [`clodex-box:${hash.slice(0, 12)}`], size: n * 1024 ** 3 });

async function fixture(t, { images, cache = {}, fail = {}, refuse = new Set(), extraIds = [] }) {
  const root = mkTmpRoot('suite-box-retention-');
  const workRaw = path.join(root, 'work');
  fs.mkdirSync(workRaw);
  const work = fs.realpathSync(workRaw);
  let clock = T0;
  const logs = [];
  const base = imagesDocker(images, { fail });
  const rms = [];
  const docker = {
    call: async (args, o) => {
      if (args[0] === 'image' && args[1] === 'rm') {
        rms.push(args.slice(2));
        if (refuse.has(args[2])) return { ok: false, code: 1, stdout: '', stderr: `Error response from daemon: conflict: unable to delete ${args[2].slice(7, 19)} (cannot be forced) - image is being used by running container 0123abcd\n`, notFound: false, timedOut: false, error: null };
        const i = images.findIndex((im) => im.id === args[2]);
        if (i >= 0) images.splice(i, 1);
      }
      const r = await base.call(args, o);
      if (args[0] === 'image' && args[1] === 'ls' && args[args.length - 1] === 'label=clodex.box' && r.ok) r.stdout += extraIds.map((id) => `${id}\n`).join('');
      return r;
    },
  };
  const state = statePaths(root);
  fs.mkdirSync(state.dir, { recursive: true });
  fs.writeFileSync(state.cache, JSON.stringify(cache));
  const box = boxIsolation({
    image: null, work, stateDir: state.dir, docker, kill: () => {}, uid: 501, gid: 20, env: {},
    procs: async () => [], statfs: () => ({ bavail: 1e9, bsize: 4096 }), version: '9.9.9',
    timers: { setTimeout: (fn) => setImmediate(fn), clearTimeout: () => {} },
  });
  const runner = createSuiteRunner({
    root, work, isolation: noneIsolation({ user: 'suite-test', kill: () => {} }), now: () => clock, log: (s) => logs.push(s),
    timers: { setTimeout: () => ({}), clearTimeout: () => {}, setInterval: () => ({}), clearInterval: () => {} },
    platform: 'linux', arch: 'x64', box,
  });
  t.after(() => { runner.close(); spawnSync('chmod', ['-R', 'u+w', root]); });
  const pass = async () => {
    for (let i = 0; i < 2000; i++) {
      const r = await runner.tick();
      if (r.ran || runner.busy()) return r;
      await new Promise((res) => setImmediate(res));
    }
    throw new Error('maintenance never ran');
  };
  return {
    root, work, runner, rms, logs, images, pass,
    cache: () => JSON.parse(fs.readFileSync(state.cache, 'utf8')),
    at: (ms) => { clock = ms; },
  };
}

test('t2413: a box image idle past 14 days is removed and one idle 13 days is kept, with a log line naming tag and size', async (t) => {
  const old = img(H1, 1);
  const recent = img(H2, 2);
  const f = await fixture(t, { images: [old, recent], cache: { [`box:${H1}`]: T0, [`box:${H2}`]: T0 + 2 * DAY } });
  f.at(T0 + 15 * DAY);
  const r = await f.pass();
  assert.deepStrictEqual(r.images, [`clodex-box:${H1.slice(0, 12)}`]);
  assert.deepStrictEqual(f.rms, [[old.id]], 'plain image rm, no -f');
  assert.deepStrictEqual(f.cache(), { [`box:${H2}`]: T0 + 2 * DAY });
  assert.deepStrictEqual(f.logs.filter((l) => l.includes('box image')), [`suite-runner: removed box image clodex-box:${H1.slice(0, 12)} (1.00 GiB)`]);
});

test('t2413: an image with no record is stamped on first sight and kept; the next pass after 14 days removes it', async (t) => {
  const first = img(H1, 1);
  const f = await fixture(t, { images: [first] });
  f.at(T0 + 100 * DAY);
  const r1 = await f.pass();
  assert.deepStrictEqual([r1.images, f.rms, f.cache()], [[], [], { [`box:${H1}`]: T0 + 100 * DAY }]);
  f.at(T0 + 113 * DAY);
  assert.deepStrictEqual([(await f.pass()).images, f.rms], [[], []], 'idle 13 days after the stamp: kept');
  f.at(T0 + 115 * DAY);
  assert.deepStrictEqual([(await f.pass()).images, f.rms], [[`clodex-box:${H1.slice(0, 12)}`], [[first.id]]]);
  assert.deepStrictEqual(f.cache(), {});
});

test('t2413: the box image usedAt record survives the restart reconcile, which drops only missing paths', async (t) => {
  const f = await fixture(t, { images: [], cache: { [`box:${H1}`]: T0, 'mirrors/gone.git': T0 } });
  await f.pass();
  assert.deepStrictEqual(f.cache(), { [`box:${H1}`]: T0 });
});

test('t2413: an image a live job or a build in progress names is kept, and the idle one beside it is removed', () => {
  const idle = img(H4, 4);
  const cache = { [`box:${H1}`]: T0, [`box:${H2}`]: T0, [`box:${H3}`]: T0, [`box:${H4}`]: T0 };
  const rows = [
    { why: 'queued job', named: img(H1, 1), jobs: [{ state: 'queued', isolation: 'container', identity: { box: { definitionHash: H1 } } }], building: null },
    { why: 'building job', named: img(H2, 2), jobs: [{ state: 'build', isolation: 'container', build: { definitionHash: H2 } }], building: null },
    { why: 'running job', named: img(H3, 3), jobs: [{ state: 'running', isolation: 'container', identity: { box: { definitionHash: H3 } } }], building: null },
    { why: 'build in progress', named: img(H2, 2), jobs: [], building: { hash: H2 } },
  ];
  for (const row of rows) {
    const plan = boxPrunePlan({ images: [row.named, idle], cache, jobs: row.jobs, building: row.building, at: T0 + 15 * DAY, idleMs: 14 * DAY });
    assert.deepStrictEqual(plan, { stamp: [], remove: [idle] }, row.why);
  }
  const done = boxPrunePlan({ images: [img(H1, 1), idle], cache, jobs: [{ state: 'done', isolation: 'container', identity: { box: { definitionHash: H1 } } }], at: T0 + 15 * DAY, idleMs: 14 * DAY });
  assert.deepStrictEqual(done.remove.map((im) => im.hash), [H1, H4], 'a done job protects nothing');
});

test('t2413: an image without the clodex.box label in the listing is never passed to image rm', async (t) => {
  const stray = { id: `sha256:${'9'.repeat(64)}`, labels: ['org.example=1'], tags: ['someone:else'], size: 5 };
  const labelled = img(H1, 1);
  const f = await fixture(t, { images: [stray, labelled], cache: { [`box:${H1}`]: T0 }, extraIds: [stray.id] });
  f.at(T0 + 15 * DAY);
  await f.pass();
  assert.deepStrictEqual(f.rms, [[labelled.id]], 'ENTER: the labelled idle image is removed');
  assert.ok(f.images.includes(stray));
});

test('t2413: an image rm Docker refuses is logged, does not throw, and keeps the usedAt record', async (t) => {
  const used = img(H1, 1);
  const f = await fixture(t, { images: [used], cache: { [`box:${H1}`]: T0 }, refuse: new Set([used.id]) });
  f.at(T0 + 15 * DAY);
  const r = await f.pass();
  assert.deepStrictEqual([r.ran, r.images, f.rms], [true, [], [[used.id]]]);
  assert.deepStrictEqual(f.cache(), { [`box:${H1}`]: T0 });
  assert.strictEqual(f.logs.filter((l) => l.startsWith(`suite-runner: box image clodex-box:${H1.slice(0, 12)} not removed: `)).length, 1);
});

test('t2413: a failed docker image ls removes nothing and stamps nothing', async (t) => {
  const f = await fixture(t, { images: [img(H1, 1)], cache: { [`box:${H1}`]: T0 }, fail: { 'image ls': { ok: false, code: 1, stderr: 'Cannot connect to the Docker daemon' } } });
  f.at(T0 + 15 * DAY);
  const r = await f.pass();
  assert.deepStrictEqual([r.ran, r.images, f.rms, f.cache()], [true, [], [], { [`box:${H1}`]: T0 }]);
});

test('t2413: no box image is removed while a job is live', async (t) => {
  const repo = path.join(mkTmpRoot('suite-box-retention-repo-'), 'near');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'one');
  const snap = await snapshotTree(repo);
  t.after(() => releaseSnapshot(snap));
  const f = await fixture(t, { images: [img(H1, 1)], cache: { [`box:${H1}`]: T0 } });
  f.at(T0 + 13 * DAY);
  assert.deepStrictEqual((await f.pass()).images, [], 'ENTER: maintenance runs once recovery is over');
  f.at(T0 + 15 * DAY);
  const sub = await f.runner.submit({
    id: 'live', attempt: 1, repoKey: snap.repoKey, kind: 'hand', scope: 'full', snap: snap.snap, treeHash: snap.treeHash,
    indexTree: snap.indexTree, sha: snap.head, branch: snap.branch, trunk: snap.trunk, refs: snap.refs, candidates: snap.candidates, files: [], flags: {},
  }, { origin: 'peer-a' });
  assert.strictEqual(sub.state, 'awaiting-pack', 'ENTER: the job is live');
  assert.deepStrictEqual(await f.runner.tick(), { ran: false });
  assert.deepStrictEqual(f.rms, []);
});
