'use strict';

const { test } = require('node:test');
require('./lib/engine-isolation');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { initStores } = require('../stores.js');
const { mkTmpRoot } = require('./lib/tmp-roots');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

function openStores() {
  const dir = mkTmpRoot('clodex-peers-save-');
  return initStores(dir, {
    log: { info() {}, warn() {}, error() {} },
    registryDir: path.join(dir, 'registry'),
    resourcesDir: path.join(dir, '__no_seed__'),
    skillsResourcesDir: path.join(dir, '__no_seed_skills__'),
    envDefaultsFile: path.join(dir, '__no_env_defaults__.json'),
  });
}

function carriedSrc() {
  const start = src.indexOf('const PEER_SAVE_CARRIED = ');
  assert.ok(start > 0, 'ENTER: PEER_SAVE_CARRIED was located');
  return src.slice(start, src.indexOf('\n', start) + 1);
}

function saveHandler(ctx) {
  const anchor = "document.getElementById('btn-peers-save').addEventListener('click', ";
  const start = src.indexOf(anchor);
  assert.ok(start > 0, 'ENTER: the handler text was located by btn-peers-save');
  const body = src.slice(start + anchor.length, src.indexOf('\n});\n', start) + 2);
  vm.createContext(ctx);
  vm.runInContext(carriedSrc(), ctx);
  return vm.runInContext(`(${body})`, ctx);
}

function dialogFor(stores, boxIds, collected) {
  return saveHandler({
    collectPeers: () => ({ ok: true, peers: collected }),
    boxPeerIds: async () => new Set(boxIds),
    closePeersDialog() {},
    window: { api: {
      getSettings: async () => ({
        peers: stores.uiSettings.get().peers.map(({ token, ...rest }) => ({ ...rest, hasToken: !!token })),
      }),
      setSettings: async (partial) => stores.uiSettings.set(partial),
    } },
  });
}

const GEN = {
  id: 'gen-1', label: 'desktop', url: null, sshHost: 'desk.local', remotePort: 7900, deployFolder: null,
  disabled: true, relayAllowed: true, shareAgents: false, inbox: 'claim', token: 'gen-secret',
};
const PLAIN = { id: 'plain-1', label: 'work', url: null, sshHost: 'work.local', remotePort: 7901, deployFolder: '/opt/c' };
const BOX = {
  id: 'box-1', label: 'avh', url: 'http://127.0.0.1:7950', sshHost: null, remotePort: 7900, deployFolder: null,
  relayAllowed: true, inbox: 'claim', token: 'box-secret',
};

function collectedOf(p) {
  return { id: p.id, label: p.label, sshHost: p.sshHost, remotePort: p.remotePort, ...(p.deployFolder ? { deployFolder: p.deployFolder } : {}) };
}

test('a Save with no edits keeps relay, paused and inbox settings on every peer', async () => {
  const stores = openStores();
  stores.uiSettings.set({ peers: [GEN, PLAIN, BOX] });
  assert.deepStrictEqual(stores.uiSettings.get().peers, [GEN, PLAIN, BOX], 'ENTER: the seeded peers are stored whole');
  const handler = dialogFor(stores, ['box-1'], [collectedOf(GEN), collectedOf(PLAIN)]);
  await handler();
  assert.deepStrictEqual(stores.uiSettings.get().peers, [GEN, PLAIN, BOX]);
});

test('an edited row keeps its settings and a new row gets none', async () => {
  const stores = openStores();
  stores.uiSettings.set({ peers: [GEN, BOX] });
  const fresh = { id: 'new-1', label: 'fresh', sshHost: 'fresh.local', remotePort: 7902 };
  const handler = dialogFor(stores, ['box-1'], [{ ...collectedOf(GEN), label: 'renamed' }, fresh]);
  await handler();
  assert.deepStrictEqual(stores.uiSettings.get().peers, [
    { ...GEN, label: 'renamed' },
    { id: 'new-1', label: 'fresh', url: null, sshHost: 'fresh.local', remotePort: 7902, deployFolder: null },
    BOX,
  ]);
});

const PEER_KEYS = [
  'az', 'deployFolder', 'disabled', 'gcloud', 'id', 'inbox', 'kubectl', 'label',
  'relayAllowed', 'remotePort', 'shareAgents', 'sshHost', 'ssm', 'token', 'url',
];

test('every key sanitizePeers reads or outputs is collected by the dialog, carried by Save, or listed here', () => {
  const stores = openStores();
  const reads = new Set();
  const spy = (rec) => new Proxy(rec, { get(t, k) { if (typeof k === 'string') reads.add(k); return t[k]; } });
  const raw = [
    { ...GEN, deployFolder: '/opt/x' },
    { id: 'ssm', ssm: { target: 'i-1' } },
    { id: 'kube', kubectl: { target: 'pod/x' } },
    { id: 'gc', gcloud: { instance: 'vm-1' } },
    { id: 'az', az: { bastion: 'b', resourceGroup: 'rg', target: 't' } },
    { id: 'tokenless', sshHost: 'bare.local' },
  ];
  stores.uiSettings.set({ peers: raw.map(spy) });
  assert.ok(reads.has('relayAllowed'), 'ENTER: the proxied records reached sanitizePeers');
  assert.deepStrictEqual([...reads].sort(), PEER_KEYS);
  const output = new Set();
  for (const p of stores.uiSettings.get().peers) for (const k of Object.keys(p)) output.add(k);
  assert.deepStrictEqual([...output].sort(), PEER_KEYS);
  const dialogCollected = ['id', 'label', 'url', 'sshHost', 'ssm', 'kubectl', 'gcloud', 'az', 'remotePort', 'deployFolder', 'token'];
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(carriedSrc(), ctx);
  const carried = vm.runInContext('Object.keys(PEER_SAVE_CARRIED)', ctx);
  const otherwiseKept = [];
  assert.deepStrictEqual([...dialogCollected, ...carried, ...otherwiseKept].sort(), PEER_KEYS);
});

test('settings:set logs exactly the keys the Peers dialog Save carries', () => {
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'ipc-handlers.js'), 'utf8');
  const start = ipcSrc.indexOf('const PEER_FLAG_KEYS = ');
  assert.ok(start > 0, 'ENTER: PEER_FLAG_KEYS was located');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(carriedSrc(), ctx);
  vm.runInContext(ipcSrc.slice(start, ipcSrc.indexOf('\n', start) + 1), ctx);
  assert.deepStrictEqual(JSON.parse(vm.runInContext('JSON.stringify([PEER_FLAG_KEYS, Object.keys(PEER_SAVE_CARRIED)])', ctx)), [['relayAllowed', 'shareAgents', 'disabled', 'inbox'], ['relayAllowed', 'shareAgents', 'disabled', 'inbox']]);
});

function settingsSetFixture() {
  const stores = openStores();
  const lines = [];
  const handlers = new Map();
  const deps = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    uiSettings: stores.uiSettings,
    manager: { _broadcast() {} },
    wirescope: { autoStartWanted: () => false, stop() {} },
    log: { info: (tag, msg) => lines.push(`[${tag}] ${msg}`), warn() {}, error() {} },
  };
  const { registerIpcHandlers } = require('../ipc-handlers');
  registerIpcHandlers(new Proxy(deps, {
    get(target, prop) {
      if (typeof prop === 'string' && prop.startsWith('enable')) return target[prop];
      return prop in target ? target[prop] : () => {};
    },
    has(target, prop) { return prop in target; },
  }));
  const set = handlers.get('settings:set');
  assert.strictEqual(typeof set, 'function', 'ENTER: settings:set is registered');
  return { stores, set, handlers, peerLines: () => lines.filter((l) => l.startsWith('[peer] ')) };
}

test('settings:set logs one [peer] line per changed flag and none on an unchanged write', () => {
  const { stores, set, peerLines } = settingsSetFixture();
  stores.uiSettings.set({ peers: [GEN, PLAIN] });
  set({}, { peers: [GEN, PLAIN] });
  assert.deepStrictEqual(peerLines(), []);
  set({}, { peers: [{ ...GEN, relayAllowed: undefined, disabled: undefined, inbox: undefined }, { ...PLAIN, relayAllowed: true }] });
  assert.deepStrictEqual(stores.uiSettings.get().peers[1].relayAllowed, true, 'ENTER: the write landed');
  assert.deepStrictEqual(peerLines(), [
    '[peer] settings:set gen-1 relayAllowed true → undefined',
    '[peer] settings:set gen-1 disabled true → undefined',
    '[peer] settings:set gen-1 inbox claim → undefined',
    '[peer] settings:set plain-1 relayAllowed undefined → true',
  ]);
  for (const l of peerLines()) assert.doesNotMatch(l, /secret/);
});

test('a new row saves its share tick explicitly, off as well as on', async () => {
  const stores = openStores();
  stores.uiSettings.set({ peers: [PLAIN] });
  const on = { id: 'new-on', label: 'on', sshHost: 'on.local', remotePort: 7900, shareAgents: true };
  const off = { id: 'new-off', label: 'off', sshHost: 'off.local', remotePort: 7900, shareAgents: false };
  await dialogFor(stores, [], [collectedOf(PLAIN), on, off])();
  assert.deepStrictEqual(stores.uiSettings.get().peers, [
    PLAIN,
    { id: 'new-on', label: 'on', url: null, sshHost: 'on.local', remotePort: 7900, deployFolder: null, shareAgents: true },
    { id: 'new-off', label: 'off', url: null, sshHost: 'off.local', remotePort: 7900, deployFolder: null, shareAgents: false },
  ]);
});

test('peer:setRelayAllowed pins the prior share value on a row without the key, and leaves an explicit one', () => {
  const { stores, handlers } = settingsSetFixture();
  const relayed = { id: 'r-1', label: 'r', url: null, sshHost: 'r.local', remotePort: 7900, deployFolder: null, relayAllowed: true };
  const keyed = { ...PLAIN, shareAgents: false };
  stores.uiSettings.set({ peers: [relayed, PLAIN, keyed] });
  const setRelay = handlers.get('peer:setRelayAllowed');
  setRelay({}, 'r-1', false);
  setRelay({}, 'plain-1', true);
  assert.deepStrictEqual(stores.uiSettings.get().peers.slice(0, 2), [
    { id: 'r-1', label: 'r', url: null, sshHost: 'r.local', remotePort: 7900, deployFolder: null, shareAgents: true },
    { ...PLAIN, url: null, relayAllowed: true, shareAgents: false },
  ]);
  stores.uiSettings.set({ peers: [keyed] });
  setRelay({}, 'plain-1', true);
  assert.deepStrictEqual(stores.uiSettings.get().peers, [{ ...keyed, url: null, relayAllowed: true }]);
});

test('peer:setShareAgents writes the key as a boolean and leaves relay alone', () => {
  const { stores, handlers } = settingsSetFixture();
  stores.uiSettings.set({ peers: [GEN] });
  const setShare = handlers.get('peer:setShareAgents');
  assert.deepStrictEqual(setShare({}, 'gen-1', true), { ok: true });
  assert.deepStrictEqual(stores.uiSettings.get().peers, [{ ...GEN, shareAgents: true }]);
  setShare({}, 'gen-1', false);
  assert.deepStrictEqual(stores.uiSettings.get().peers, [GEN]);
  assert.deepStrictEqual(setShare({}, 'nope', true), { ok: false, error: 'no such peer' });
});

function collectPeersWith(row) {
  const start = src.indexOf('function collectPeers() {');
  assert.ok(start > 0, 'ENTER: collectPeers was located');
  const ctx = {
    peersListBox: { querySelectorAll: () => [row] },
    classifyPeerDest: () => ({ kind: 'ssh', sshHost: 'fresh.local' }),
    peerRowDest: () => 'fresh.local',
    validatePeerRowInputs: () => ({ ok: true, port: 7900, folder: null }),
    PEER_CLOUD_UI: {},
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, src.indexOf('\n}\n', start) + 2), ctx);
  return vm.runInContext('collectPeers()', ctx);
}

function fakeRow(fields) {
  return { dataset: { peerId: 'new-1' }, querySelector: (sel) => fields[sel] || null };
}

test('the dialog collects the new-row share tick, and an existing row carries none', () => {
  const label = { value: 'fresh' };
  for (const checked of [true, false]) {
    const got = collectPeersWith(fakeRow({ '.peer-row-label': label, '.peer-row-share-check': { checked } }));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(got)), {
      ok: true, peers: [{ id: 'new-1', label: 'fresh', sshHost: 'fresh.local', remotePort: 7900, shareAgents: checked }],
    });
  }
  const existing = collectPeersWith(fakeRow({ '.peer-row-label': label }));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(existing)), {
    ok: true, peers: [{ id: 'new-1', label: 'fresh', sshHost: 'fresh.local', remotePort: 7900 }],
  });
});

test('only a new row draws the share tick, and it starts ticked', () => {
  const line = src.split('\n').find((l) => l.includes('peer-row-share-check'));
  assert.ok(line, 'ENTER: the add-peer template draws a share tick');
  assert.match(line, /\$\{peer\.id \? '' : `<label class="peer-row-share"/);
  assert.match(line, /class="peer-row-share-check" checked>/);
});
