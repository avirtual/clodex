'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { imagesDocker } = require('./lib/box-images');
const { createSuiteRunner, noneIsolation, statePaths } = require('../suite-runner');
const { boxIsolation } = require('../suite-box');
const { pickRunner, pickRecord, pickLine, createSuiteClient } = require('../suite-client');

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const IMG1 = `sha256:${'a'.repeat(64)}`;
const DOCKER_CALL_MS = 6000;

function fakeClock() {
  let t = 0;
  const q = [];
  const timers = {
    setTimeout: (fn, ms) => { const h = { at: t + ms, fn }; q.push(h); return h; },
    clearTimeout: (h) => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
    setInterval: () => ({}),
    clearInterval: () => {},
  };
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      await flush();
      q.sort((a, b) => a.at - b.at);
      if (!q.length || q[0].at > end) break;
      const h = q.shift();
      t = h.at;
      h.fn();
    }
    t = end;
    await flush();
  }
  return { timers, now: () => t, advance, flush };
}

async function fixture(t, { images = [{ id: IMG1, labels: [`clodex.box=${H1}`] }] } = {}) {
  const root = mkTmpRoot('suite-named-info-');
  const workRaw = path.join(root, 'work');
  fs.mkdirSync(workRaw);
  const work = fs.realpathSync(workRaw);
  const clock = fakeClock();
  const base = imagesDocker(images);
  const started = [];
  const docker = {
    call: (args, o) => new Promise((resolve) => {
      started.push(args.slice(0, 2).join(' '));
      clock.timers.setTimeout(() => resolve(base.call(args, o)), DOCKER_CALL_MS);
    }),
  };
  const state = statePaths(root);
  fs.mkdirSync(state.dir, { recursive: true });
  const box = boxIsolation({
    image: null, work, stateDir: state.dir, docker, kill: () => {}, uid: 501, gid: 20, env: {},
    procs: async () => [], statfs: () => ({ bavail: 1e9, bsize: 4096 }), version: '9.9.9', timers: clock.timers, now: clock.now,
  });
  const runner = createSuiteRunner({
    root, work, isolation: noneIsolation({ user: 'suite-test', kill: () => {} }), now: clock.now, timers: clock.timers,
    platform: 'linux', arch: 'x64', box,
  });
  t.after(() => { runner.close(); spawnSync('chmod', ['-R', 'u+w', root]); });
  await runner.info();
  const timed = (p) => p.then((r) => ({ r, at: clock.now() }));
  return { runner, clock, images, calls: () => [...started], timed };
}

const want = (definitionHash, rev = 1) => ({ definitionHash, rev });
const PROBING_H1 = { state: 'probing', definitionHash: H1, why: 'box 111111111111 not known yet: its docker probe is still running' };

test('t2449: with docker calls of 6 s a first named info answers probing at 2.5 s, and after the probe one answers ready with no docker call', async (t) => {
  const f = await fixture(t);
  const first = f.timed(f.runner.info(want(H1)));
  await f.clock.advance(2500);
  const { r, at } = await first;
  assert.deepStrictEqual([r.box, at], [PROBING_H1, 2500]);
  assert.deepStrictEqual([r.slots, r.pending], [{ total: 1, inUse: 0 }, 0]);
  await f.clock.advance(3 * DOCKER_CALL_MS);
  assert.deepStrictEqual(f.calls(), ['info --format', 'image ls', 'image inspect']);
  const again = f.timed(f.runner.info(want(H1)));
  await f.clock.flush();
  const second = await again;
  assert.deepStrictEqual([second.r.box.state, second.r.box.env.box.imageId, second.at], ['ready', IMG1, 20500]);
  assert.strictEqual(f.calls().length, 3, 'the cached answer made no docker call');
});

test('t2449: two concurrent named info calls share one probe', async (t) => {
  const f = await fixture(t);
  const a = f.runner.info(want(H1));
  const b = f.runner.info(want(H1));
  await f.clock.advance(2500);
  assert.deepStrictEqual([(await a).box, (await b).box], [PROBING_H1, PROBING_H1]);
  await f.clock.advance(3 * DOCKER_CALL_MS);
  assert.deepStrictEqual(f.calls(), ['info --format', 'image ls', 'image inspect']);
});

test('t2449: a cached named box state expires after 30 s and the next call probes again', async (t) => {
  const f = await fixture(t);
  const first = f.runner.info(want(H1));
  await f.clock.advance(20000);
  assert.deepStrictEqual((await first).box, PROBING_H1);
  assert.strictEqual(f.calls().length, 3, 'ENTER: the first probe finished');
  await f.clock.advance(27999);
  const fresh = f.runner.info(want(H1));
  await f.clock.flush();
  assert.strictEqual((await fresh).box.state, 'ready');
  assert.strictEqual(f.calls().length, 3, 'at 29.999 s the entry is still fresh');
  await f.clock.advance(1);
  const stale = f.runner.info(want(H1));
  await f.clock.advance(2500);
  assert.deepStrictEqual((await stale).box, PROBING_H1);
  assert.strictEqual(f.calls().length, 4, 'past 30 s the call probes again');
});

test('t2449: the cache keeps at most 32 names and evicts the oldest', async (t) => {
  const f = await fixture(t);
  const hashes = Array.from({ length: 33 }, (_, i) => i.toString(16).padStart(64, '0'));
  for (const h of hashes.slice(0, 32)) f.runner.info(want(h));
  await f.clock.advance(3 * DOCKER_CALL_MS);
  assert.strictEqual(f.calls().length, 64, 'ENTER: 32 named probes ran');
  const kept = f.runner.info(want(hashes[1]));
  await f.clock.flush();
  assert.strictEqual((await kept).box.state, 'no-image');
  assert.strictEqual(f.calls().length, 64, 'the 32nd name still answers from the cache');
  f.runner.info(want(hashes[32]));
  await f.clock.flush();
  const evicted = f.runner.info(want(hashes[0]));
  await f.clock.flush();
  assert.strictEqual(f.calls().length, 66, 'the 33rd name evicted the oldest, which probes again');
  await f.clock.advance(3 * DOCKER_CALL_MS);
  await evicted;
});

test('t2449: slots and pending are read live even when the box state comes from the cache', async (t) => {
  const f = await fixture(t);
  const first = f.runner.info(want(H1));
  await f.clock.advance(3 * DOCKER_CALL_MS);
  assert.strictEqual((await first).box.state, 'ready');
  f.runner.fence(true);
  const fenced = f.runner.info(want(H1));
  await f.clock.flush();
  const r = await fenced;
  assert.deepStrictEqual([r.box.state, r.slots], ['ready', { total: 1, inUse: 1 }]);
  assert.strictEqual(f.calls().length, 3);
});

const INFO = (box, inUse = 0) => ({ box, slots: { total: 1, inUse }, queue: { queued: [] }, pending: 0 });
const READY_H1 = { state: 'ready', env: { box: { imageId: IMG1, definitionHash: H1, rev: 1 } } };
const BOX_H1 = want(H1);

test('t2449: the source keeps a member whose box state is not known yet, ranks it as can-build, and the pick record names it', () => {
  const members = [
    { peer: 'busy-ready', live: true, info: INFO(READY_H1, 1) },
    { peer: 'idle-probing', live: true, info: INFO(PROBING_H1) },
    { peer: 'slow', live: true, info: null, why: 'timeout' },
    { peer: 'locked', live: true, info: null, why: 'refused' },
  ];
  const pick = pickRunner(members, { box: BOX_H1 });
  assert.strictEqual(pick.member.peer, 'busy-ready', 'a known ready tier beats an unknown one');
  assert.deepStrictEqual(pickRecord(pick), {
    chosen: 'busy-ready',
    skipped: [{ member: 'slow', reason: 'timeout' }, { member: 'locked', reason: 'refused' }],
    boxUnknown: ['idle-probing'],
  });
  assert.match(pickLine('j1', pick), /idle-probing slots 0\/1, pending 0, queue 0, box tier 2 \(box state not known yet\), exclusive rank 0/);
  const lone = pickRunner([members[1], members[2]], { box: BOX_H1 });
  assert.deepStrictEqual([lone.chosen, lone.member.peer, pickRecord(lone).boxUnknown], [true, 'idle-probing', ['idle-probing']]);
});

test('t2449: a not-known-yet member ties with can-build and load decides between them', () => {
  const canBuild = { state: 'can-build', definitionHash: H1, why: 'x' };
  const rows = [
    ['idle probing beats busy can-build', [{ peer: 'cb', live: true, info: INFO(canBuild, 1) }, { peer: 'pr', live: true, info: INFO(PROBING_H1, 0) }], 'pr'],
    ['idle can-build beats busy probing', [{ peer: 'cb', live: true, info: INFO(canBuild, 0) }, { peer: 'pr', live: true, info: INFO(PROBING_H1, 1) }], 'cb'],
    ['building beats idle probing', [{ peer: 'pr', live: true, info: INFO(PROBING_H1, 0) }, { peer: 'bd', live: true, info: INFO({ state: 'building', definitionHash: H1 }, 1) }], 'bd'],
  ];
  for (const [name, members, chosen] of rows) assert.strictEqual(pickRunner(members, { box: BOX_H1 }).member.peer, chosen, name);
});

function boxTier5208(info, box) {
  const b = info && info.box;
  const wantDef = box && typeof box === 'object' ? box : null;
  if (b && b.state === 'ready') {
    if (!wantDef) return 0;
    const stamped = b.env && b.env.box;
    if (stamped && stamped.definitionHash === wantDef.definitionHash) return 0;
  }
  if (!wantDef || !b || b.definitionHash !== wantDef.definitionHash) return null;
  return { building: 1, 'can-build': 2 }[b.state] || null;
}

test('t2449: wire rows across 5.208 — an old source skips a probing answer as no box, as it skipped the timeout before; a new source reads an old runner unchanged', () => {
  assert.strictEqual(boxTier5208(INFO(PROBING_H1), BOX_H1), null, 'old source: probing is not a tier, the member is skipped');
  assert.strictEqual(boxTier5208(INFO(READY_H1), BOX_H1), 0, 'old source: a cached ready answer has the 5.208 shape');
  const oldRunner = [
    ['ready', READY_H1, 0],
    ['can-build', { state: 'can-build', definitionHash: H1, why: 'x' }, 2],
    ['building', { state: 'building', definitionHash: H1, why: 'x' }, 1],
    ['no-image', { state: 'no-image', why: 'x' }, null],
  ];
  for (const [name, box, tier] of oldRunner) {
    const pick = pickRunner([{ peer: 'old', live: true, info: INFO(box) }], { box: BOX_H1 });
    const row = pick.ranks[0];
    assert.deepStrictEqual([row.tier === undefined ? null : row.tier, 'boxUnknown' in row, pickRecord(pick).boxUnknown], [tier, false, undefined], name);
  }
  const slow = pickRunner([{ peer: 'old', live: true, info: null, why: 'timeout' }, { peer: 'new', live: true, info: INFO(READY_H1) }], { box: BOX_H1 });
  assert.deepStrictEqual(pickRecord(slow), { chosen: 'new', skipped: [{ member: 'old', reason: 'timeout' }] });
});

test('t2449: reachable marks a timed-out info call, on the push wire and the pull wire, and nothing else', async () => {
  const rows = [
    ['push timeout', 'push', { status: 0, body: null, error: 'timeout' }, { ok: false, why: 'timeout', timedOut: true }],
    ['pull expiry', 'pull', { status: 0, body: null, error: 'runner did not answer in time' }, { ok: false, why: 'runner did not answer in time', timedOut: true }],
    ['refused', 'push', { status: 401, body: null, error: 'unauthorized' }, { ok: false, why: 'runner refused the token (status 401)' }],
    ['connection reset', 'push', { status: 0, body: null, error: 'socket hang up' }, { ok: false, why: 'socket hang up' }],
  ];
  for (const [name, wire, answer, expected] of rows) {
    const conn = { suiteAsk: async () => answer };
    const client = createSuiteClient({ getPeerManager: () => ({ get: () => conn }), getSuiteDesk: () => ({ conn: () => conn }) });
    assert.deepStrictEqual(await client.reachable('r1', wire), expected, name);
  }
});
