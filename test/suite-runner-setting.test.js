'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { initStores, sanitizeSuiteRunner } = require('../stores.js');
const { suiteRunnerOptions, createRemoteWiring } = require('../remote-wiring');
const { mkTmpRoot } = require('./lib/tmp-roots');

const VALID = { enabled: true, isolation: 'none', work: '/srv/suite-work' };

test('a full valid record passes the sanitiser whole', () => {
  assert.deepStrictEqual(sanitizeSuiteRunner(VALID), { enabled: true, isolation: 'none', work: '/srv/suite-work' });
  assert.deepStrictEqual(sanitizeSuiteRunner({ enabled: false, isolation: 'user', work: null }), { enabled: false, isolation: 'user', work: null });
});

const REFUSALS = [
  ["isolation: 'root'", { enabled: true, isolation: 'root', work: null }],
  ["work: 'relative/dir'", { enabled: true, isolation: 'user', work: 'relative/dir' }],
  ["work: '/a/../b'", { enabled: true, isolation: 'user', work: '/a/../b' }],
  ['an unknown key', { enabled: true, isolation: 'user', work: null, host: 'murmur' }],
  ["enabled: 'yes'", { enabled: 'yes', isolation: 'user', work: null }],
  ['a missing work key', { enabled: true, isolation: 'user' }],
  ['an array', [true, 'user', null]],
];

for (const [label, raw] of REFUSALS) {
  test(`sanitiser refuses ${label} with a whole-record null`, () => {
    assert.strictEqual(sanitizeSuiteRunner(raw), null);
  });
}

test('suiteRunnerOptions: setting on and no env takes every field from the setting', () => {
  assert.deepStrictEqual(suiteRunnerOptions({}, '/h', { platform: 'linux', setting: { enabled: true, isolation: 'none', work: '/w' } }), {
    root: '/h', work: '/w', isolation: 'none', boxImage: null, limits: {}, forced: [],
  });
});

test('suiteRunnerOptions: CLODEX_SUITE_RUNNER=1 turns on a node whose setting is off, and names enabled as forced', () => {
  assert.deepStrictEqual(suiteRunnerOptions({ CLODEX_SUITE_RUNNER: '1' }, '/h', { platform: 'linux', setting: null }), {
    root: '/h', work: '/var/lib/clodex-suite', isolation: 'user', boxImage: null, limits: {}, forced: ['enabled'],
  });
});

test('suiteRunnerOptions: CLODEX_SUITE_ISOLATION wins over the stored isolation', () => {
  assert.deepStrictEqual(suiteRunnerOptions({ CLODEX_SUITE_ISOLATION: 'none' }, '/h', { platform: 'linux', setting: { enabled: true, isolation: 'user', work: null } }), {
    root: '/h', work: '/var/lib/clodex-suite', isolation: 'none', boxImage: null, limits: {}, forced: ['isolation'],
  });
});

test('suiteRunnerOptions: setting off and no env is off', () => {
  assert.deepStrictEqual(suiteRunnerOptions({}, '/h', { platform: 'linux', setting: { enabled: false, isolation: 'none', work: '/w' } }), null);
  assert.deepStrictEqual(suiteRunnerOptions({}, '/h', { platform: 'linux', setting: null }), null);
});

test('suiteRunnerOptions: CLODEX_SUITE_RUNNER other than 1 cannot force a stored setting off', () => {
  assert.deepStrictEqual(suiteRunnerOptions({ CLODEX_SUITE_RUNNER: '0' }, '/h', { platform: 'linux', setting: { enabled: true, isolation: 'user', work: '/w' } }), {
    root: '/h', work: '/w', isolation: 'user', boxImage: null, limits: {}, forced: [],
  });
});

function openStores(dir) {
  return initStores(dir, {
    log: { info: () => {}, error: () => {} },
    registryDir: path.join(dir, 'registry'),
    resourcesDir: path.join(dir, '__no_seed__'),
  });
}

test('a settings file without suiteRunner loads as off', () => {
  const dir = mkTmpRoot('clodex-suite-setting-');
  fs.writeFileSync(path.join(dir, 'ui-settings.json'), JSON.stringify({ remotePort: 7311 }));
  const s = openStores(dir).uiSettings.get();
  assert.strictEqual(s.remotePort, 7311, 'ENTER: the file was read');
  assert.strictEqual(s.suiteRunner, null);
});

test('an invalid stored record loads as off', () => {
  const dir = mkTmpRoot('clodex-suite-setting-');
  fs.writeFileSync(path.join(dir, 'ui-settings.json'), JSON.stringify({ suiteRunner: { enabled: true, isolation: 'root', work: null } }));
  assert.strictEqual(openStores(dir).uiSettings.get().suiteRunner, null);
});

test('set stores a valid record, keeps it across an invalid set, and clears on null', () => {
  const dir = mkTmpRoot('clodex-suite-setting-');
  const ui = openStores(dir).uiSettings;
  ui.set({ suiteRunner: VALID });
  assert.deepStrictEqual(openStores(dir).uiSettings.get().suiteRunner, VALID);
  ui.set({ suiteRunner: { ...VALID, work: 'relative/dir' } });
  assert.deepStrictEqual(openStores(dir).uiSettings.get().suiteRunner, VALID);
  ui.set({ theme: 'dark' });
  assert.deepStrictEqual(openStores(dir).uiSettings.get().suiteRunner, VALID);
  ui.set({ suiteRunner: null });
  assert.strictEqual(openStores(dir).uiSettings.get().suiteRunner, null);
});

function ipcFixture({ busy = false, initial = null } = {}) {
  const handlers = new Map();
  const store = { suiteRunner: initial, terminalReports: 'on' };
  const calls = { reload: 0, set: [] };
  const { registerIpcHandlers } = require('../ipc-handlers');
  const deps = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    enableTestBoxes: true,
    uiSettings: {
      get: () => store,
      set: (patch) => { calls.set.push(patch); Object.assign(store, patch); return store; },
    },
    suiteRunnerState: () => ({ setting: store.suiteRunner, forced: [], remoteEnabled: true, status: 'off', error: null }),
    suiteRunnerBusy: () => busy,
    reloadSuiteRunner: () => { calls.reload += 1; },
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
  return { set: handlers.get('suiteRunner:set'), handlers, store, calls };
}

test('suiteRunner:set stores a valid record and reloads the runner', () => {
  const { set, store, calls } = ipcFixture();
  assert.strictEqual(typeof set, 'function', 'ENTER: suiteRunner:set is registered on the desktop surface');
  const res = set({}, VALID);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(store.suiteRunner, VALID);
  assert.strictEqual(calls.reload, 1);
});

test('suiteRunner:set rejects an invalid record and leaves the stored one', () => {
  const { set, store, calls } = ipcFixture({ initial: VALID });
  const res = set({}, { enabled: true, isolation: 'root', work: null });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'invalid test runner setting');
  assert.deepStrictEqual(store.suiteRunner, VALID);
  assert.deepStrictEqual(calls.set, []);
  assert.strictEqual(calls.reload, 0);
});

test('suiteRunner:set refuses while a job runs and leaves the stored one', () => {
  const { set, store, calls } = ipcFixture({ initial: VALID, busy: true });
  const res = set({}, { enabled: false, isolation: 'user', work: null });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /a test job is running/);
  assert.deepStrictEqual(store.suiteRunner, VALID);
  assert.deepStrictEqual(calls.set, []);
  assert.strictEqual(calls.reload, 0);
});

test('settings:set cannot write the test runner setting', () => {
  const { handlers, store, calls } = ipcFixture({ initial: null });
  const save = handlers.get('settings:set');
  assert.strictEqual(typeof save, 'function', 'ENTER: settings:set is registered');
  save({}, { suiteRunner: VALID, theme: 'dark' });
  assert.deepStrictEqual(calls.set, [{ theme: 'dark' }]);
  assert.strictEqual(store.suiteRunner, null);
});

test('the suiteRunner channels follow enableTestBoxes, not enableDrawerServices', () => {
  const capture = (enableTestBoxes) => {
    const registered = new Set();
    const target = { handle: (ch) => registered.add(ch), on: (ch) => registered.add(ch), enableDrawerServices: false, enableTestBoxes, enableLocalTerminal: true, enableCtl: true };
    require('../ipc-handlers').registerIpcHandlers(new Proxy(target, {
      get(t, prop) { return prop in t ? t[prop] : () => {}; },
      has(t, prop) { return prop in t; },
    }));
    return registered;
  };
  const off = capture(false);
  assert.ok(off.has('session:list'), 'ENTER: the registrar ran');
  assert.deepStrictEqual([...off].filter((ch) => ch.startsWith('suiteRunner:')), []);
  assert.deepStrictEqual([...capture(true)].filter((ch) => ch.startsWith('suiteRunner:')).sort(), ['suiteRunner:get', 'suiteRunner:set']);
});

test('no module but ipc-handlers writes the test runner setting', () => {
  const root = path.join(__dirname, '..');
  const dirs = ['.', 'cli', 'renderer', 'renderer/lib'];
  const writers = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(root, d))) {
      if (!f.endsWith('.js')) continue;
      const rel = path.join(d, f);
      if (/\.set\([^;]*\bsuiteRunner\b/.test(fs.readFileSync(path.join(root, rel), 'utf8'))) writers.push(path.normalize(rel));
    }
  }
  assert.deepStrictEqual(writers, ['ipc-handlers.js']);
});

const SUITE_ENV = ['CLODEX_SUITE_RUNNER', 'CLODEX_SUITE_ISOLATION', 'CLODEX_SUITE_WORK', 'CLODEX_SUITE_BOX_IMAGE', 'CLODEX_DATA_DIR', 'CLODEX_REMOTE_ENABLE'];

function wiringFixture(t, settings) {
  const saved = Object.fromEntries(SUITE_ENV.map((k) => [k, process.env[k]]));
  for (const k of SUITE_ENV) delete process.env[k];
  const tmp = mkTmpRoot('suite-setting-wiring-');
  let srv = null;
  const built = [];
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  remoteMod.RemoteServer = function (opts) {
    const fake = {
      running: false, port: 0, basePath: '', suiteRunner: opts.suiteRunner,
      start() { fake.running = true; return Promise.resolve(); },
      stop() { fake.running = false; fake.stopped = true; },
      notifySessions() {}, setWtermCallbacks() {},
    };
    built.push(fake);
    return fake;
  };
  const wiring = createRemoteWiring({
    path, fs, os,
    log: { info() {}, warn() {}, error() {} },
    DEFAULT_WORKSPACE_ID: 'default', AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: tmp, OUTBOX_DIR: path.join(tmp, 'outbox'), SELF_LABEL: 'testbox',
    parseCtxFile: () => null, jsonlToMessages: () => [], ensureDir: () => {}, homeRelativize: (x) => x,
    claimOutbox: () => [], listOutboxOrigins: () => [],
    manager: { sessions: new Map(), windowForWorkspace: () => null, _broadcast() {} },
    proxyPoller: { snapshot: () => null },
    restartClodex: () => {}, restartSession: () => {}, peerProxyView: () => null,
    readSessionArgs: () => ({ ok: false }), applySessionArgs: () => ({ ok: true }),
    readSkillCatalog: () => ({ ok: false }), applySessionSkills: () => ({ ok: false }),
    fetchProxyContext: () => {}, fetchProxyReport: () => {}, fetchProxyBust: () => {},
    fetchSessionFiles: () => {}, fetchFilePeek: () => {}, fetchFileDiff: () => {},
    CLAUDE_TOOLS: ['Bash'],
    getPromptLibrary: () => ({ list: () => [] }), getAgentLibrary: () => ({ list: () => [] }), getSkillLibrary: () => ({ list: () => [] }),
    getPersistence: () => ({ get: () => undefined }),
    getUiSettings: () => ({ get: () => settings }),
    getWorkspaces: () => ({ get: () => ({}) }),
    getDrawerPtys: () => null,
    getRemoteServer: () => srv, setRemoteServer: (v) => { srv = v; }, setRemoteError: () => {},
    readRemoteEnvToken: () => null, resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '9.9.9', isPackaged: () => false,
  });
  t.after(() => {
    wiring.shutdownRemoteServer();
    remoteMod.RemoteServer = orig;
    for (const k of SUITE_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
  return { wiring, built, tmp };
}

const settle = () => new Promise((r) => setImmediate(r));
const platformDefault = (home) => (process.platform === 'darwin' ? path.join(home, 'suite-work') : '/var/lib/clodex-suite');

test('saving the setting rebuilds the wire with the new runner, no restart', async (t) => {
  const settings = { remoteEnabled: true, remotePort: 0, peerShellEnabled: false, peers: [], suiteRunner: null };
  const { wiring, built, tmp } = wiringFixture(t, settings);
  wiring.syncRemoteServer();
  await settle();
  assert.strictEqual(built.length, 1, 'ENTER: the wire was built');
  assert.strictEqual(built[0].suiteRunner, null);
  assert.strictEqual(wiring.suiteRunnerState().status, 'off');

  settings.suiteRunner = { enabled: true, isolation: 'none', work: path.join(tmp, 'work') };
  wiring.reloadSuiteRunner();
  await settle();
  assert.strictEqual(built.length, 2);
  assert.strictEqual(built[0].stopped, true, 'the old wire stopped, so hello caps are re-read');
  assert.strictEqual(typeof (built[1].suiteRunner && built[1].suiteRunner.submit), 'function', 'the new wire carries a runner');
  assert.deepStrictEqual(wiring.suiteRunnerState(), {
    setting: { enabled: true, isolation: 'none', work: path.join(tmp, 'work') },
    forced: [], effective: { isolation: 'none', work: path.join(tmp, 'work'), boxImage: null }, defaultWork: platformDefault(tmp),
    remoteEnabled: true, status: 'running', error: null,
  });
  assert.strictEqual(wiring.suiteRunnerBusy(), false);

  settings.suiteRunner = { enabled: false, isolation: 'none', work: null };
  wiring.reloadSuiteRunner();
  await settle();
  assert.strictEqual(built.length, 3);
  assert.strictEqual(built[2].suiteRunner, null);
  assert.strictEqual(wiring.suiteRunnerState().status, 'off');
});

test('a stored runner on a node with remote access off is pull-only, then running once the claimer builds it', async (t) => {
  const settings = { remoteEnabled: false, remotePort: 0, peers: [], suiteRunner: { enabled: true, isolation: 'none', work: null } };
  const { wiring, tmp } = wiringFixture(t, settings);
  const state = (status) => ({
    setting: { enabled: true, isolation: 'none', work: null },
    forced: [], effective: { isolation: 'none', work: platformDefault(tmp), boxImage: null }, defaultWork: platformDefault(tmp),
    remoteEnabled: false, status, error: null,
  });
  assert.deepStrictEqual(wiring.suiteRunnerState(), state('pull-only'));
  assert.ok(wiring.getSuiteEngine(), 'the engine is built with remote access off');
  assert.deepStrictEqual(wiring.suiteRunnerState(), state('running'));
  wiring.shutdownRemoteServer();
  assert.strictEqual(wiring.getSuiteEngine(), null);
});

test('a field forced by env reports the value in effect, not the stored one', async (t) => {
  const settings = { remoteEnabled: true, remotePort: 0, peers: [], suiteRunner: { enabled: true, isolation: 'user', work: null } };
  const { wiring, tmp } = wiringFixture(t, settings);
  process.env.CLODEX_SUITE_ISOLATION = 'none';
  process.env.CLODEX_SUITE_WORK = '/x';
  assert.deepStrictEqual(wiring.suiteRunnerState(), {
    setting: { enabled: true, isolation: 'user', work: null },
    forced: ['isolation', 'work'], effective: { isolation: 'none', work: '/x' }, defaultWork: platformDefault(tmp),
    remoteEnabled: true, status: 'starting', error: null,
  });
});

test('suiteRunner:set with the stored record answers ok without reloading the wire', () => {
  const { set, calls } = ipcFixture({ initial: VALID });
  const res = set({}, { enabled: true, isolation: 'none', work: '/srv/suite-work' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(calls.set, []);
  assert.strictEqual(calls.reload, 0);
});

const IMG = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const BOX_IMAGE_ROWS = [
  ['absent', { enabled: true, isolation: 'user', work: null }, { enabled: true, isolation: 'user', work: null }],
  ['null', { enabled: true, isolation: 'user', work: null, boxImage: null }, { enabled: true, isolation: 'user', work: null }],
  ['a valid id', { enabled: true, isolation: 'user', work: null, boxImage: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
    { enabled: true, isolation: 'user', work: null, boxImage: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }],
  ["a tag 'node:24'", { enabled: true, isolation: 'user', work: null, boxImage: 'node:24' }, null],
  ['a short hash', { enabled: true, isolation: 'user', work: null, boxImage: 'sha256:0123456789abcdef' }, null],
  ['uppercase hex', { enabled: true, isolation: 'user', work: null, boxImage: 'sha256:0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef' }, null],
];

for (const [label, raw, want] of BOX_IMAGE_ROWS) {
  test(`sanitiser boxImage ${label}`, () => {
    assert.deepStrictEqual(sanitizeSuiteRunner(raw), want);
  });
}

test('suiteRunnerOptions: a stored boxImage is returned, and CLODEX_SUITE_BOX_IMAGE wins over it and is named as forced', () => {
  const setting = { enabled: true, isolation: 'user', work: '/w', boxImage: IMG };
  assert.deepStrictEqual(suiteRunnerOptions({}, '/h', { platform: 'linux', setting }), {
    root: '/h', work: '/w', isolation: 'user', boxImage: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', limits: {}, forced: [],
  });
  const other = 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  assert.deepStrictEqual(suiteRunnerOptions({ CLODEX_SUITE_BOX_IMAGE: other }, '/h', { platform: 'linux', setting }), {
    root: '/h', work: '/w', isolation: 'user', boxImage: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', limits: {}, forced: ['boxImage'],
  });
  assert.deepStrictEqual(suiteRunnerOptions({ CLODEX_SUITE_BOX_IMAGE: 'node:24' }, '/h', { platform: 'linux', setting }), {
    root: '/h', work: '/w', isolation: 'user', boxImage: null, limits: {}, forced: ['boxImage'],
  });
});

test('a stored boxImage survives an Apply that changes only isolation', () => {
  const { suiteRunnerRecordFromForm } = require('../renderer/lib/offer-view');
  const stored = { enabled: true, isolation: 'user', work: '/srv/suite-work', boxImage: IMG };
  const { set, store } = ipcFixture({ initial: stored });
  const shown = { setting: stored, forced: [] };
  const rec = suiteRunnerRecordFromForm(shown, { enabled: true, isolation: 'none', work: '/srv/suite-work', boxImage: IMG });
  assert.strictEqual(set({}, rec).ok, true);
  assert.deepStrictEqual(store.suiteRunner, { enabled: true, isolation: 'none', work: '/srv/suite-work', boxImage: IMG });
});

test('a forced boxImage keeps the stored one on Apply, and an emptied field drops the key', () => {
  const { suiteRunnerRecordFromForm } = require('../renderer/lib/offer-view');
  const stored = { enabled: true, isolation: 'user', work: null, boxImage: IMG };
  assert.deepStrictEqual(suiteRunnerRecordFromForm({ setting: stored, forced: ['boxImage'] }, { enabled: true, isolation: 'none', work: '', boxImage: 'sha256:ffff' }),
    { enabled: true, isolation: 'none', work: null, boxImage: IMG });
  assert.deepStrictEqual(suiteRunnerRecordFromForm({ setting: stored, forced: [] }, { enabled: true, isolation: 'user', work: '', boxImage: '  ' }),
    { enabled: true, isolation: 'user', work: null });
});

test('the runner state reports a stored boxImage under setting and effective', (t) => {
  const settings = { remoteEnabled: false, remotePort: 0, peers: [], suiteRunner: { enabled: true, isolation: 'none', work: null, boxImage: IMG } };
  const { wiring, tmp } = wiringFixture(t, settings);
  assert.deepStrictEqual(wiring.suiteRunnerState(), {
    setting: { enabled: true, isolation: 'none', work: null, boxImage: IMG },
    forced: [], effective: { isolation: 'none', work: platformDefault(tmp), boxImage: IMG }, defaultWork: platformDefault(tmp),
    remoteEnabled: false, status: 'pull-only', error: null,
  });
});
