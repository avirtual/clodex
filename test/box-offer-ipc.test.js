'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createOfferDirectory, setNotifying } = require('../offer-directory');

const VALID = { scope: 'discovery', enabled: true, boxes: 2, availability: 'always', peers: [{ name: 'murmur' }] };
const FACTS = { os: 'linux', arch: 'x64', cpus: 8, memMb: 16384, runtime: null };

function ipcFixture({ initial = null, forced = false, envOffer = null, rawStored, peers = [] } = {}) {
  const handlers = new Map();
  const store = { boxOffer: initial, peers, terminalReports: 'on' };
  const calls = { set: [], broadcast: [] };
  const offerDirectory = createOfferDirectory();
  const { registerIpcHandlers } = require('../ipc-handlers');
  const deps = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    enableDrawerServices: true,
    uiSettings: {
      get: () => store,
      set: (patch) => { calls.set.push(patch); Object.assign(store, patch); return store; },
    },
    manager: { _broadcast: (ch) => calls.broadcast.push(ch) },
    getBoxOffer: () => (forced ? envOffer : store.boxOffer),
    boxOfferForced: forced,
    readStoredBoxOffer: () => (rawStored === undefined ? store.boxOffer : rawStored),
    getOfferFacts: () => FACTS,
    readOfferFacts: async () => FACTS,
    offerDirectory,
    wirescope: { autoStartWanted: () => false, stop() {} },
    log: { info() {}, warn() {}, error() {} },
  };
  const stub = () => () => {};
  registerIpcHandlers(new Proxy(deps, {
    get(target, prop) {
      if (typeof prop === 'string' && prop.startsWith('enable')) return target[prop];
      return prop in target ? target[prop] : stub();
    },
    has(target, prop) { return prop in target; },
  }));
  return { handlers, store, calls, offerDirectory };
}

test('offer:set stores a valid record and broadcasts offers-changed', async () => {
  const { handlers, store, calls } = ipcFixture();
  const set = handlers.get('offer:set');
  assert.strictEqual(typeof set, 'function', 'ENTER: offer:set is registered on the desktop surface');
  const res = await set({}, VALID);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(store.boxOffer, VALID);
  assert.deepStrictEqual(calls.broadcast, ['offers-changed']);
  assert.deepStrictEqual(res.state, { stored: VALID, effective: VALID, forced: false, warning: null, facts: FACTS, peers: [] });
});

test('offer:set rejects an invalid record and leaves the stored one', async () => {
  const { handlers, store, calls } = ipcFixture({ initial: VALID });
  const before = structuredClone(store.boxOffer);
  const res = await handlers.get('offer:set')({}, { ...VALID, scope: 'run' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'invalid box offer');
  assert.deepStrictEqual(store.boxOffer, before);
  assert.deepStrictEqual(calls.set, []);
  assert.deepStrictEqual(calls.broadcast, []);
});

test('offer:set refuses with the reason while CLODEX_BOX_OFFER forces the offer', async () => {
  const { handlers, store, calls } = ipcFixture({ initial: VALID, forced: true, envOffer: { ...VALID, boxes: 4 } });
  const res = await handlers.get('offer:set')({}, { ...VALID, boxes: 3 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'the box offer is set by CLODEX_BOX_OFFER on this machine; change it there');
  assert.deepStrictEqual(store.boxOffer, VALID);
  assert.deepStrictEqual(calls.set, []);
  assert.strictEqual(res.state.forced, true);
  assert.deepStrictEqual(res.state.effective, { ...VALID, boxes: 4 });
});

test('offer:get reports an invalid stored offer as off', async () => {
  const { handlers } = ipcFixture({ initial: null, rawStored: { ...VALID, boxes: 99 }, peers: [{ label: 'murmur' }, { label: 'bad label' }] });
  const st = await handlers.get('offer:get')({});
  assert.deepStrictEqual(st, { stored: null, effective: null, forced: false, warning: 'stored offer invalid, treated as off', facts: FACTS, peers: ['murmur'] });
  const clean = ipcFixture({ initial: VALID });
  assert.strictEqual((await clean.handlers.get('offer:get')({})).warning, null);
});

test('offer:directory lists the own entry and the directory rows', () => {
  const { handlers, offerDirectory } = ipcFixture({ initial: VALID });
  const entry = { scope: 'discovery', boxes: 1, open: true, kinds: ['container'], facts: FACTS };
  offerDirectory.set({ provenance: 'hello', source: 'p1', name: 'murmur', offer: entry });
  const d = handlers.get('offer:directory')({});
  assert.deepStrictEqual(d.own, { scope: 'discovery', boxes: 2, open: true, kinds: ['container'], facts: FACTS });
  assert.deepStrictEqual(d.offers.map(({ route, at, ...r }) => r), [{ provenance: 'hello', name: 'murmur', offer: entry }]);
});

test('settings:set drops a boxOffer key', () => {
  const { handlers, store, calls } = ipcFixture({ initial: null });
  const save = handlers.get('settings:set');
  assert.strictEqual(typeof save, 'function', 'ENTER: settings:set is registered');
  save({}, { boxOffer: VALID, theme: 'dark' });
  assert.deepStrictEqual(calls.set, [{ theme: 'dark' }]);
  assert.strictEqual(store.boxOffer, null);
});

test('the web surface registers no offer channel; the desktop surface registers all three', () => {
  const capture = (enableDrawerServices) => {
    const registered = new Set();
    const target = { handle: (ch) => registered.add(ch), on: (ch) => registered.add(ch), enableDrawerServices, enableLocalTerminal: true, enableCtl: true };
    require('../ipc-handlers').registerIpcHandlers(new Proxy(target, {
      get(t, prop) { return prop in t ? t[prop] : () => {}; },
      has(t, prop) { return prop in t; },
    }));
    return registered;
  };
  const web = capture(false);
  assert.ok(web.has('session:list'), 'ENTER: the registrar ran');
  assert.deepStrictEqual([...web].filter((ch) => ch.startsWith('offer:')), []);
  assert.deepStrictEqual([...capture(true)].filter((ch) => ch.startsWith('offer:')).sort(), ['offer:directory', 'offer:get', 'offer:set']);
});

test('no module but ipc-handlers writes the box offer setting', () => {
  const root = path.join(__dirname, '..');
  const writers = [];
  for (const d of ['.', 'cli', 'cli/src', 'renderer', 'renderer/lib']) {
    for (const f of fs.readdirSync(path.join(root, d))) {
      if (!f.endsWith('.js')) continue;
      const rel = path.join(d, f);
      if (/\.set\(\{\s*boxOffer\b/.test(fs.readFileSync(path.join(root, rel), 'utf8'))) writers.push(path.normalize(rel));
    }
  }
  assert.deepStrictEqual(writers, ['ipc-handlers.js']);
});

test('setNotifying calls back only when the listing changed', () => {
  const dir = createOfferDirectory();
  const entry = { scope: 'discovery', boxes: 1, open: true, kinds: ['container'], facts: FACTS };
  let n = 0;
  const onChange = () => { n += 1; };
  assert.strictEqual(setNotifying(dir, { provenance: 'hello', source: 'p1', name: 'murmur', offer: entry }, onChange), true);
  assert.strictEqual(n, 1);
  setNotifying(dir, { provenance: 'hello', source: 'p1', name: 'murmur', offer: entry }, onChange);
  assert.strictEqual(n, 1, 'a refresh of the same row is no change');
  setNotifying(dir, { provenance: 'hello', source: 'p1', name: 'murmur', offer: { ...entry, open: false } }, onChange);
  assert.strictEqual(n, 2);
  setNotifying(dir, { provenance: 'hello', source: 'p1', name: 'murmur', offer: null }, onChange);
  assert.strictEqual(n, 3);
});
