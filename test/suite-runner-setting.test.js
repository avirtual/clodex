'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { initStores, sanitizeSuiteRunner } = require('../stores.js');
const { suiteRunnerOptions, createRemoteWiring, startSuiteRunner } = require('../remote-wiring');
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

function ipcFixture({ busy = false, initial = null, ...over } = {}) {
  const handlers = new Map();
  const store = over.store || { suiteRunner: initial, terminalReports: 'on' };
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
    suiteRunnerState: () => ({ setting: store.suiteRunner, forced: [], remoteEnabled: true, status: 'off', error: null, pending: busy }),
    applySuiteRunner: () => {
      if (busy) return { pending: true, running: 1 };
      calls.reload += 1;
      return { pending: false, running: 0 };
    },
    wirescope: { autoStartWanted: () => false, stop() {} },
    log: { info() {}, warn() {}, error() {} },
    ...(over.deps || {}),
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

test('suiteRunner:set while a job runs stores the record and answers pending', () => {
  const { set, store, calls } = ipcFixture({ initial: VALID, busy: true });
  const off = { enabled: false, isolation: 'user', work: null };
  const res = set({}, off);
  assert.deepStrictEqual({ ok: res.ok, pending: res.pending }, { ok: true, pending: true });
  assert.strictEqual(res.state.pending, true);
  assert.deepStrictEqual(store.suiteRunner, off);
  assert.deepStrictEqual(calls.set, [{ suiteRunner: off }]);
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

test('suiteRunner:output hands the job id and read options to the wired source', async () => {
  const handlers = new Map();
  const calls = [];
  const target = {
    handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, enableDrawerServices: false, enableTestBoxes: true, enableLocalTerminal: true, enableCtl: true,
    suiteOutput: async (id, opts) => { calls.push([id, opts]); return { ok: true, text: 'hi' }; },
  };
  require('../ipc-handlers').registerIpcHandlers(new Proxy(target, {
    get(t, prop) { return prop in t ? t[prop] : () => {}; },
    has(t, prop) { return prop in t; },
  }));
  const read = handlers.get('suiteRunner:output');
  assert.strictEqual(typeof read, 'function', 'ENTER: suiteRunner:output is registered');
  assert.deepStrictEqual(await read({}, 'j1', { stream: 'stderr', offset: 5, length: 10 }), { ok: true, text: 'hi' });
  assert.deepStrictEqual(calls, [['j1', { stream: 'stderr', offset: 5, length: 10 }]]);
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
  assert.deepStrictEqual([...capture(true)].filter((ch) => ch.startsWith('suiteRunner:')).sort(), ['suiteRunner:activity', 'suiteRunner:get', 'suiteRunner:output', 'suiteRunner:set']);
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

function wiringFixture(t, settings, over = {}) {
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
    ...over,
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
    remoteEnabled: true, status: 'running', error: null, pending: false, runningJobs: 0,
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
    remoteEnabled: false, status, error: null, pending: false, runningJobs: 0,
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
  process.env.CLODEX_SUITE_BOX_IMAGE = IMG;
  assert.deepStrictEqual(wiring.suiteRunnerState(), {
    setting: { enabled: true, isolation: 'user', work: null },
    forced: ['isolation', 'work', 'boxImage'], effective: { isolation: 'none', work: '/x', boxImage: IMG }, defaultWork: platformDefault(tmp),
    remoteEnabled: true, status: 'starting', error: null, pending: false, runningJobs: 0,
  });
});

test('suiteRunner:set with the stored record answers ok without reloading the wire', () => {
  const { set, calls } = ipcFixture({ initial: VALID });
  const res = set({}, { enabled: true, isolation: 'none', work: '/srv/suite-work' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(calls.set, []);
  assert.strictEqual(calls.reload, 0);
});

test('startSuiteRunner builds the box adapter with or without boxImage', () => {
  const IMAGE = `sha256:${'a'.repeat(64)}`;
  const SWEEP = async () => {};
  const rows = [['with', IMAGE], ['without', undefined]].map(([label, boxImage]) => {
    const made = [];
    const built = [];
    const load = () => ({
      createSuiteRunner: (o) => { made.push(o); return { start() {} }; },
      noneIsolation: () => 'none-iso',
      userIsolation: () => 'user-iso',
      statePaths: (root) => ({ dir: `${root}/suite-runner` }),
    });
    const loadBox = () => ({ boxIsolation: (o) => { built.push(o); return { sweep: SWEEP, image: o.image }; } });
    const opts = { root: '/home/c', work: '/srv/w', isolation: 'none', limits: {}, forced: [], ...(boxImage ? { boxImage } : {}) };
    const started = startSuiteRunner(opts, { log: { warn() {}, error() {} }, load, loadBox });
    const { log, ...rest } = made[0];
    return [label, started.error, typeof log, rest, built];
  });
  assert.deepStrictEqual(rows, [
    ['with', null, 'function', { root: '/home/c', work: '/srv/w', isolation: 'none-iso', limits: {}, box: { sweep: SWEEP, image: IMAGE } }, [{ image: IMAGE, work: '/srv/w', stateDir: '/home/c/suite-runner' }]],
    ['without', null, 'function', { root: '/home/c', work: '/srv/w', isolation: 'none-iso', limits: {}, box: { sweep: SWEEP, image: null } }, [{ image: null, work: '/srv/w', stateDir: '/home/c/suite-runner' }]],
  ]);
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
    remoteEnabled: false, status: 'pull-only', error: null, pending: false, runningJobs: 0,
  });
});

const SLOT_ROWS = [
  ['absent', { enabled: true, isolation: 'user', work: null }, { enabled: true, isolation: 'user', work: null }],
  ['1', { enabled: true, isolation: 'user', work: null, slots: 1 }, { enabled: true, isolation: 'user', work: null }],
  ['3', { enabled: true, isolation: 'user', work: null, slots: 3 }, { enabled: true, isolation: 'user', work: null, slots: 3 }],
  ['9', { enabled: true, isolation: 'user', work: null, slots: 9 }, { enabled: true, isolation: 'user', work: null, slots: 4 }],
  ['0', { enabled: true, isolation: 'user', work: null, slots: 0 }, { enabled: true, isolation: 'user', work: null }],
  ["the string '3'", { enabled: true, isolation: 'user', work: null, slots: '3' }, { enabled: true, isolation: 'user', work: null }],
  ['2.5', { enabled: true, isolation: 'user', work: null, slots: 2.5 }, { enabled: true, isolation: 'user', work: null }],
];

for (const [label, raw, want] of SLOT_ROWS) {
  test(`sanitiser slots ${label}`, () => {
    assert.deepStrictEqual(sanitizeSuiteRunner(raw), want);
  });
}

test('suiteRunnerOptions hands a stored slot count above 1 to the runner', () => {
  assert.deepStrictEqual(suiteRunnerOptions({}, '/h', { platform: 'linux', setting: { enabled: true, isolation: 'user', work: '/w', slots: 3 } }), {
    root: '/h', work: '/w', isolation: 'user', boxImage: null, limits: {}, slots: 3, forced: [],
  });
});

test('startSuiteRunner passes the slot count to createSuiteRunner', () => {
  const made = [];
  const load = () => ({
    createSuiteRunner: (o) => { made.push(o); return { start() {} }; },
    noneIsolation: () => 'none-iso', userIsolation: () => 'user-iso', statePaths: (root) => ({ dir: `${root}/suite-runner` }),
  });
  const loadBox = () => ({ boxIsolation: () => 'box' });
  startSuiteRunner({ root: '/r', work: '/w', isolation: 'none', limits: {}, forced: [], slots: 3 }, { log: { warn() {}, error() {} }, load, loadBox });
  const { log, ...rest } = made[0];
  assert.deepStrictEqual(rest, { root: '/r', work: '/w', isolation: 'none-iso', limits: {}, slots: 3, box: 'box' });
});

test('the runner form saves the slot count it shows, and keeps the stored one when the form has none', () => {
  const { suiteRunnerRecordFromForm } = require('../renderer/lib/offer-view');
  const shown = { setting: { enabled: true, isolation: 'user', work: null, slots: 3 }, forced: [] };
  const form = { enabled: true, isolation: 'user', work: '', boxImage: '' };
  assert.deepStrictEqual([
    suiteRunnerRecordFromForm(shown, { ...form, slots: '2' }),
    suiteRunnerRecordFromForm(shown, { ...form, slots: '1' }),
    suiteRunnerRecordFromForm(shown, form),
  ], [
    { enabled: true, isolation: 'user', work: null, slots: 2 },
    { enabled: true, isolation: 'user', work: null },
    { enabled: true, isolation: 'user', work: null, slots: 3 },
  ]);
});

const SHARED = { enabled: true, isolation: 'user', work: '/srv/suite-work', slots: 2, shares: [{ name: 'assets', path: '/srv/assets', version: 'v1' }, { name: 'models.3d', path: '/Volumes/big/models', version: '2026.11-a_b' }] };

test('t2363: a valid shares list round-trips through the sanitiser', () => {
  assert.deepStrictEqual(sanitizeSuiteRunner(SHARED), {
    enabled: true, isolation: 'user', work: '/srv/suite-work', slots: 2,
    shares: [{ name: 'assets', path: '/srv/assets', version: 'v1' }, { name: 'models.3d', path: '/Volumes/big/models', version: '2026.11-a_b' }],
  });
});

const ROW = (i) => ({ name: `s${i}`, path: `/srv/s${i}`, version: 'v1' });
const BAD_SHARES = [
  ['a ninth row', Array.from({ length: 9 }, (_, i) => ROW(i))],
  ['a duplicate name', [ROW(1), { ...ROW(2), name: 's1' }]],
  ['a relative path', [{ name: 'a', path: 'srv/a', version: 'v1' }]],
  ['a bad version', [{ name: 'a', path: '/srv/a', version: 'v 1' }]],
];

for (const [label, shares] of BAD_SHARES) {
  test(`t2363: ${label} drops only shares`, () => {
    assert.deepStrictEqual(sanitizeSuiteRunner({ enabled: true, isolation: 'user', work: '/srv/suite-work', slots: 2, shares }), { enabled: true, isolation: 'user', work: '/srv/suite-work', slots: 2 });
  });
}

test('t2363: suiteRunner:set refuses a record whose shares would be dropped and keeps the stored one', () => {
  const { set, store, calls } = ipcFixture({ initial: VALID });
  const res = set({}, { ...VALID, shares: [{ name: 'a', path: 'rel', version: 'v1' }] });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /^invalid shared folders/);
  assert.deepStrictEqual([store.suiteRunner, calls.reload], [VALID, 0]);
  assert.strictEqual(set({}, { ...VALID, shares: [ROW(1)] }).ok, true, 'ENTER: a valid list is stored');
  assert.deepStrictEqual(store.suiteRunner, { ...VALID, shares: [ROW(1)] });
});

test('t2363: suiteRunnerOptions hands the stored shares to the runner', () => {
  assert.deepStrictEqual(suiteRunnerOptions({}, '/h', { platform: 'linux', setting: { enabled: true, isolation: 'none', work: '/w', shares: [ROW(1)] } }).shares, [ROW(1)]);
});

test('t2363: the share editor adds and removes rows, Apply sends the list, and the hint is present', () => {
  const { suiteRunnerRecordFromForm, shareEditor } = require('../renderer/lib/offer-view');
  const { fakeDocument } = require('./lib/fake-dom');
  const doc = fakeDocument();
  const host = doc.createElement('div');
  const editor = shareEditor(doc, host, [{ name: 'assets', path: '/srv/assets', version: 'v1' }]);
  const [list, add] = host.childNodes;
  assert.strictEqual(add.textContent, 'Add folder');
  add.listeners.click();
  const [, fresh] = list.childNodes;
  const [n, p, v] = fresh.childNodes;
  n.value = 'models';
  p.value = ' /srv/models ';
  v.value = 'v2';
  add.listeners.click();
  const shown = { setting: { enabled: true, isolation: 'user', work: null, shares: [{ name: 'old', path: '/o', version: 'v0' }] }, forced: [] };
  const form = { enabled: true, isolation: 'user', work: '', boxImage: '' };
  assert.deepStrictEqual(suiteRunnerRecordFromForm(shown, { ...form, shares: editor.read() }), {
    enabled: true, isolation: 'user', work: null,
    shares: [{ name: 'assets', path: '/srv/assets', version: 'v1' }, { name: 'models', path: '/srv/models', version: 'v2' }],
  });
  list.childNodes[0].childNodes[3].listeners.click();
  list.childNodes[0].childNodes[3].listeners.click();
  assert.deepStrictEqual(suiteRunnerRecordFromForm(shown, { ...form, shares: editor.read() }), { enabled: true, isolation: 'user', work: null });
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(html.includes("A shared folder is readable, read-only, by test jobs from every peer you allow to run jobs here. Change the version whenever the folder's contents change: a job asks for a version, and this machine refuses one it does not hold."));
});

function fakeRunner(opts) {
  const r = {
    opts, active: 0, closed: false, onDrained: null, drains: [],
    start() {}, close() { r.closed = true; },
    busy: () => r.active > 0, activeCount: () => r.active,
    drain(done) {
      r.drains.push(typeof done === 'function' ? 'hold' : 'release');
      if (typeof done !== 'function') { r.onDrained = null; return r.active; }
      if (!r.active) return 0;
      r.onDrained = done;
      return r.active;
    },
    finishOne() {
      r.active -= 1;
      if (!r.active && r.onDrained) { const done = r.onDrained; r.onDrained = null; done(); }
    },
  };
  return r;
}

function liveFixture(t, initial) {
  const settings = { remoteEnabled: false, remotePort: 0, peers: [], suiteRunner: initial };
  const runners = [];
  const lines = [];
  const log = { info: (tag, m) => lines.push([tag, m]), warn() {}, error() {} };
  const startRunner = (opts) => { const r = fakeRunner(opts); runners.push(r); return { runner: r, error: null }; };
  const { wiring } = wiringFixture(t, settings, { startRunner, log });
  const ipc = ipcFixture({ store: settings, deps: { suiteRunnerState: wiring.suiteRunnerState, applySuiteRunner: wiring.applySuiteRunner, log } });
  const first = wiring.getSuiteEngine();
  assert.strictEqual(first, runners[0], 'ENTER: the live runner came from the seam');
  return { wiring, set: ipc.set, settings, runners, lines, reloads: () => runners.filter((r) => r.closed).length };
}

const THREE = { enabled: true, isolation: 'none', work: '/srv/suite-work', slots: 3 };
const TWO = { enabled: true, isolation: 'none', work: '/srv/suite-work', slots: 2 };

test('a save with a job running is stored, drains the runner, and reloads once when the job ends', (t) => {
  const f = liveFixture(t, THREE);
  f.runners[0].active = 1;
  const res = f.set({}, TWO);
  assert.deepStrictEqual({ ok: res.ok, pending: res.pending }, { ok: true, pending: true });
  assert.deepStrictEqual([res.state.pending, res.state.runningJobs, res.state.setting], [true, 1, TWO]);
  assert.deepStrictEqual(f.settings.suiteRunner, TWO);
  assert.deepStrictEqual([f.runners[0].closed, f.runners[0].drains, f.reloads()], [false, ['hold'], 0]);
  f.runners[0].finishOne();
  assert.strictEqual(f.reloads(), 1);
  assert.strictEqual(f.wiring.suiteRunnerState().pending, false);
  assert.strictEqual(f.wiring.getSuiteEngine().opts.slots, 2);
  assert.deepStrictEqual(f.lines.filter(([, m]) => m.startsWith('test runner setting')), [
    ['remote', 'test runner setting saved, applies when 1 running job(s) finish'],
    ['remote', 'test runner setting applied after drain'],
  ]);
});

test('a second save while pending replaces the first, and saving the live record ends the drain without a reload', (t) => {
  const f = liveFixture(t, THREE);
  f.runners[0].active = 1;
  f.set({}, TWO);
  const other = { ...TWO, slots: 4 };
  assert.strictEqual(f.set({}, other).pending, true);
  assert.deepStrictEqual(f.settings.suiteRunner, other);
  const back = f.set({}, THREE);
  assert.deepStrictEqual([back.ok, back.pending, back.state.pending], [true, undefined, false]);
  assert.deepStrictEqual(f.runners[0].drains, ['hold', 'hold', 'release']);
  f.runners[0].finishOne();
  assert.strictEqual(f.reloads(), 0);
  assert.strictEqual(f.wiring.getSuiteEngine(), f.runners[0]);
});

test('a second save while pending is the record applied after the drain', (t) => {
  const f = liveFixture(t, THREE);
  f.runners[0].active = 1;
  f.set({}, TWO);
  f.set({}, { ...TWO, slots: 4 });
  f.runners[0].finishOne();
  assert.strictEqual(f.reloads(), 1);
  assert.strictEqual(f.wiring.getSuiteEngine().opts.slots, 4);
});

test('switching the runner off while a job runs lets it finish, then the runner is off', (t) => {
  const f = liveFixture(t, THREE);
  f.runners[0].active = 1;
  assert.strictEqual(f.set({}, null).pending, true);
  assert.deepStrictEqual([f.runners[0].closed, f.wiring.suiteRunnerState().status], [false, 'running']);
  f.runners[0].finishOne();
  assert.deepStrictEqual([f.runners[0].closed, f.wiring.getSuiteEngine(), f.wiring.suiteRunnerState().status], [true, null, 'off']);
});

test('an idle save reloads at once and is not pending', (t) => {
  const f = liveFixture(t, THREE);
  const res = f.set({}, TWO);
  assert.deepStrictEqual([res.ok, 'pending' in res, res.state.pending], [true, false, false]);
  assert.strictEqual(f.reloads(), 1);
  assert.strictEqual(f.wiring.getSuiteEngine().opts.slots, 2);
});
