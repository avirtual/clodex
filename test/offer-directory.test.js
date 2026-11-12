'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  createOfferDirectory, createRuntimeProbe, parsePlatforms, hostFacts, OFFER_TTL_MS,
} = require('../offer-directory');

const ENTRY = {
  scope: 'discovery', boxes: 2, open: true, kinds: ['container'],
  facts: { os: 'linux', arch: 'x64', cpus: 8, memMb: 16384, runtime: { platforms: ['linux/amd64'] } },
};

function fixture() {
  let t = 1000;
  let n = 0;
  const dir = createOfferDirectory({ now: () => t, ttlMs: OFFER_TTL_MS, newRoute: () => `r${++n}` });
  return { dir, advance: (ms) => { t += ms; } };
}

test('an announce is stored with its provenance and a generated route handle', () => {
  const { dir } = fixture();
  assert.strictEqual(dir.set({ provenance: 'announce', source: 'laptop', name: 'laptop', offer: ENTRY }), true);
  assert.deepStrictEqual(dir.list(), [{ route: 'r1', provenance: 'announce', name: 'laptop', offer: ENTRY, at: 1000 }]);
});

test('a refresh from the same source keeps its route; a null offer removes the row', () => {
  const { dir, advance } = fixture();
  dir.set({ provenance: 'announce', source: 'laptop', offer: ENTRY });
  advance(5000);
  dir.set({ provenance: 'announce', source: 'laptop', offer: { ...ENTRY, boxes: 3 } });
  assert.deepStrictEqual(dir.list(), [{ route: 'r1', provenance: 'announce', name: 'laptop', offer: { ...ENTRY, boxes: 3 }, at: 6000 }]);
  dir.set({ provenance: 'announce', source: 'laptop', offer: null });
  assert.deepStrictEqual(dir.list(), []);
});

test('a row named constructor is stored and read back', () => {
  const { dir } = fixture();
  dir.set({ provenance: 'announce', source: 'constructor', name: 'constructor', offer: ENTRY });
  dir.set({ provenance: 'announce', source: '__proto__', name: '__proto__', offer: ENTRY });
  assert.deepStrictEqual(dir.list().map((r) => r.name), ['constructor', '__proto__']);
});

test('two routes with the same reported facts stay two rows, and nothing is summed', () => {
  const { dir } = fixture();
  dir.set({ provenance: 'announce', source: 'laptop', offer: ENTRY });
  dir.set({ provenance: 'hello', source: 'peer-7', name: 'laptop', offer: ENTRY });
  assert.deepStrictEqual(dir.list(), [
    { route: 'r1', provenance: 'announce', name: 'laptop', offer: ENTRY, at: 1000 },
    { route: 'r2', provenance: 'hello', name: 'laptop', offer: ENTRY, at: 1000 },
  ]);
});

test('an unknown provenance or an empty source is refused', () => {
  const { dir } = fixture();
  assert.strictEqual(dir.set({ provenance: 'relayed', source: 'laptop', offer: ENTRY }), false);
  assert.strictEqual(dir.set({ provenance: 'announce', source: '', offer: ENTRY }), false);
  assert.deepStrictEqual(dir.list(), []);
});

test('a row expires after the TTL with a fake clock', () => {
  const { dir, advance } = fixture();
  dir.set({ provenance: 'announce', source: 'laptop', offer: ENTRY });
  advance(OFFER_TTL_MS - 1);
  assert.strictEqual(dir.list().length, 1, 'ENTER: the row is present before it expires');
  advance(1);
  assert.deepStrictEqual(dir.list(), []);
});

test('parsePlatforms keeps platform-shaped tokens once each', () => {
  assert.deepStrictEqual(parsePlatforms('linux/arm64\n'), ['linux/arm64']);
  assert.deepStrictEqual(parsePlatforms('linux/arm64, linux/amd64, linux/arm64, junk'), ['linux/arm64', 'linux/amd64']);
  assert.deepStrictEqual(parsePlatforms(''), []);
});

function manualTimers() {
  const pending = [];
  return {
    setTimer: (fn) => { pending.push(fn); return pending.length; },
    clearTimer: () => {},
    fire: () => { for (const fn of pending.splice(0)) fn(); },
  };
}

test('the runtime probe: a fake returning two platforms lists both', async () => {
  const timers = manualTimers();
  const probe = createRuntimeProbe({ run: async () => 'linux/arm64,linux/amd64', ...timers });
  assert.deepStrictEqual(await probe.refresh(), { platforms: ['linux/arm64', 'linux/amd64'] });
  assert.deepStrictEqual(probe.current(), { platforms: ['linux/arm64', 'linux/amd64'] });
});

test('the runtime probe: a timeout reports runtime null', async () => {
  const timers = manualTimers();
  const probe = createRuntimeProbe({ run: () => new Promise(() => {}), ...timers });
  const pending = probe.refresh();
  timers.fire();
  assert.strictEqual(await pending, null);
  assert.strictEqual(probe.current(), null);
});

test('the runtime probe: a failing run reports null and a disabled probe never runs', async () => {
  const timers = manualTimers();
  const failing = createRuntimeProbe({ run: async () => { throw new Error('ENOENT'); }, ...timers });
  assert.strictEqual(await failing.refresh(), null);
  let calls = 0;
  const off = createRuntimeProbe({ enabled: false, run: async () => { calls++; return 'linux/arm64'; }, ...timers });
  assert.strictEqual(off.current(), null);
  assert.strictEqual(await off.refresh(), null);
  assert.strictEqual(calls, 0);
});

test('the runtime probe caches for its interval', async () => {
  const timers = manualTimers();
  let t = 0;
  let calls = 0;
  const probe = createRuntimeProbe({ run: async () => { calls++; return 'linux/arm64'; }, now: () => t, ttlMs: 15000, ...timers });
  await probe.refresh();
  probe.current();
  t = 14999;
  probe.current();
  assert.strictEqual(calls, 1);
  t = 15000;
  probe.current();
  await probe.refresh();
  assert.strictEqual(calls, 2);
});

test('hostFacts reads os, arch, cores and memory', () => {
  const osModule = { cpus: () => [{}, {}, {}, {}], totalmem: () => 8 * 1048576 * 1024 };
  assert.deepStrictEqual(hostFacts({ osModule, platform: 'linux', arch: 'x64', runtime: null }), {
    os: 'linux', arch: 'x64', cpus: 4, memMb: 8192, runtime: null,
  });
});
