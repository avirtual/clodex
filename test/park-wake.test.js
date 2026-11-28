'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mk, mkPark } = require('./lib/session-fixtures');
const { mkTmpRoot, tmpHomeOs } = require('./lib/tmp-roots');
const { parkDelivery, countPending, claimParkedById } = require('../pending-store');
const { initStores } = require('../stores.js');

const T0 = Date.UTC(2026, 10, 28, 0, 0, 0);
const H = 3_600_000;
let idN = 0;
const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

function withClock(fn) {
  return async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    await fn(t);
  };
}

function rig(t, { hours = 0, home = mkTmpRoot('clodex-pw-home-'), PENDING_DIR = mkTmpRoot('clodex-pw-pend-'), settings = { parkWakeHours: hours } } = {}) {
  const logs = [];
  const log = { info: (_c, msg) => logs.push(msg), warn: (_c, msg) => logs.push(msg), error: (_c, msg) => logs.push(msg), debug() {} };
  const { m, injected } = mkPark({
    PENDING_DIR, REGISTRY_DIR: home, log,
    getUiSettings: () => ({ get: () => settings }),
    shouldHoldDm: () => ({ hold: true, reason: 'cold' }),
    draftChunkSignal: require('../proxy-util').draftChunkSignal,
    getPeerManager: () => null,
    isHumanPtyInput: require('../proxy-util').isHumanPtyInput,
    randBase36: (n) => String(++idN).padStart(n, 'p'), parkIdInUse: require('../pending-store').parkIdInUse,
  });
  m.sessions.set('root', { name: 'root', agentType: 'claude', activityState: 'idle', createdAt: 1, pty: { write() {} } });
  return { m, injected, logs, settings, home, PENDING_DIR, root: () => m.sessions.get('root') };
}

function captureDeliverDm(manager) {
  const { createRemoteWiring } = require('../remote-wiring');
  let srv = null;
  const deps = {
    path, fs, os: tmpHomeOs(), log: QUIET,
    DEFAULT_WORKSPACE_ID: 'default', AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: '/tmp/reg', OUTBOX_DIR: '/tmp/outbox', SELF_LABEL: 'debian',
    parseCtxFile: () => null, cachedMessages: () => [], jsonlToMessages: () => [], sliceSince: () => ({ messages: [] }),
    ensureDir: () => {}, homeRelativize: (x) => x, claimOutbox: () => [], listOutboxOrigins: () => [],
    manager, proxyPoller: { snapshot: () => null },
    loadManifest: () => { throw new Error('no teams here'); },
    restartClodex: () => {}, restartSession: () => {}, peerProxyView: () => null,
    readSessionArgs: () => ({ ok: false }), applySessionArgs: () => ({ ok: true }),
    readSkillCatalog: () => ({ ok: false }), applySessionSkills: () => ({ ok: false }),
    fetchProxyContext: () => {}, fetchProxyReport: () => {}, fetchProxyBust: () => {},
    fetchSessionFiles: () => {}, fetchFilePeek: () => {}, fetchFileDiff: () => {},
    CLAUDE_TOOLS: ['Bash', 'Read'],
    getPromptLibrary: () => ({ list: () => [] }), getAgentLibrary: () => ({ list: () => [] }), getSkillLibrary: () => ({ list: () => [] }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    getUiSettings: () => ({ get: () => ({ remoteEnabled: true, remotePort: 0 }) }),
    getWorkspaces: () => ({ get: () => ({}) }), getNotifications: () => null,
    getRemoteServer: () => srv, setRemoteServer: (v) => { srv = v; },
    setRemoteError: () => {}, getDrawerPtys: () => null,
    readRemoteEnvToken: () => null, resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '9.9.9', isPackaged: () => false, getWebInfo: () => null, getWirescopeInfo: () => null,
  };
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  let opts = null;
  remoteMod.RemoteServer = function (o) {
    opts = o;
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() {}, setWtermCallbacks() {} };
  };
  try { createRemoteWiring(deps).syncRemoteServer(); } finally { remoteMod.RemoteServer = orig; }
  return opts.deliverDm;
}

let refN = 0;
function sendFromLaptop(receiver) {
  const deliverDm = captureDeliverDm(receiver);
  const sender = mk({ log: QUIET });
  const bounces = [];
  sender._injectText = (_s, text) => bounces.push(text);
  const conn = { dm: (msg, cb) => cb(deliverDm({ ...msg, origin: 'laptop' })) };
  return (body = 'notice') => {
    const ref = `r${++refN}`;
    sender._sendFederatedDm(conn, 'debian', { to: 'root', from: 'clodex', body, urgent: false, target: 'root@debian', ref }, () => ({ name: 'clodex' }));
    return bounces.pop();
  };
}

const bounceFor = (clause, ref) => `[agent:dm] parked on debian for root — ${clause}. If it can't wait, resend as \`[agent:dm root@debian urgent] <message>\`. (ref ${ref})`;

test('bounce: 1 waiting, then 3 waiting with the oldest age, counted from the receiving store', withClock(async (t) => {
  const r = rig(t);
  const send = sendFromLaptop(r.m);
  const first = send();
  assert.strictEqual(first, bounceFor("1 waiting, oldest under 1m; it'll be delivered with root's next turn", `r${refN}`));
  t.mock.timers.setTime(T0 + 2 * H);
  parkDelivery(r.PENDING_DIR, 'root', '[agent:from b] typed park', `${Date.now()}.000000001`, null, false, 1);
  t.mock.timers.setTime(T0 + 7 * H + 5 * 60_000);
  const third = send();
  assert.strictEqual(countPending(r.PENDING_DIR, 'root'), 3, 'ENTER: the store holds the two sends and the park the sender never saw');
  assert.strictEqual(third, bounceFor("3 waiting, oldest 7h; it'll be delivered with root's next turn", `r${refN}`));
}));

test('hold-park logs the seat and the count, never the body', withClock(async (t) => {
  const r = rig(t);
  r.m._gatedDeliver('root', 'clodex@laptop', 'SECRET-BODY', false);
  r.m._gatedDeliver('root', 'clodex@laptop', 'SECRET-BODY-2', false);
  const lines = r.logs.filter((l) => l.startsWith('park-on-hold for root'));
  assert.deepStrictEqual(lines.map((l) => l.replace(/ as \w+:/, ' as ID:')), ['park-on-hold for root as ID: 1 waiting', 'park-on-hold for root as ID: 2 waiting']);
  assert.ok(!r.logs.some((l) => l.includes('SECRET')));
}));

test('setting off (the default): no wake however old the mail', withClock(async (t) => {
  const dir = mkTmpRoot('clodex-pw-stores-');
  const ui = initStores(dir, { log: QUIET, registryDir: path.join(dir, 'registry'), resourcesDir: path.join(dir, '__no_seed__') }).uiSettings;
  assert.strictEqual(ui.get().parkWakeHours, 0);
  const r = rig(t, { settings: ui.get() });
  r.m._gatedDeliver('root', 'clodex@laptop', 'old', false);
  assert.deepStrictEqual(r.m._sweepParkWake(T0 + 1000 * H), []);
  assert.deepStrictEqual(r.injected, []);
  assert.strictEqual(countPending(r.PENDING_DIR, 'root'), 1);
}));

test('parkWakeHours sanitizes to 1-48 or off, and survives a reload', () => {
  const dir = mkTmpRoot('clodex-pw-stores-');
  const open = () => initStores(dir, { log: QUIET, registryDir: path.join(dir, 'registry'), resourcesDir: path.join(dir, '__no_seed__') }).uiSettings;
  const ui = open();
  for (const [value, want] of [[12, 12], [1, 1], [48, 48], [49, 0], [0, 0], [1.5, 0], ['6', 0], [null, 0]]) {
    ui.set({ parkWakeHours: 24 });
    ui.set({ parkWakeHours: value });
    assert.strictEqual(ui.get().parkWakeHours, want, `${JSON.stringify(value)}`);
    assert.strictEqual(open().get().parkWakeHours, want, `${JSON.stringify(value)} after reload`);
  }
});

test('setting on: wakes at the limit, not before, and logs the cause', withClock(async (t) => {
  const r = rig(t, { hours: 12 });
  r.m._gatedDeliver('root', 'clodex@laptop', 'wake me', false);
  assert.deepStrictEqual(r.m._sweepParkWake(T0 + 12 * H - 1), []);
  assert.deepStrictEqual(r.injected, []);
  t.mock.timers.setTime(T0 + 12 * H);
  assert.deepStrictEqual(r.m._sweepParkWake(T0 + 12 * H), ['root']);
  assert.strictEqual(r.injected.length, 1);
  assert.match(r.injected[0], /wake me/);
  assert.strictEqual(countPending(r.PENDING_DIR, 'root'), 0);
  assert.ok(r.logs.includes('park-drain for root (age limit): claimed 1 for delivery, oldest 12h'), r.logs.join('\n'));
}));

test('the age survives a restart, a resend re-park and a later message', withClock(async (t) => {
  const first = rig(t, { hours: 12 });
  const r0 = first.m._gatedDeliver('root', 'clodex@laptop', 'oldest', false);
  t.mock.timers.setTime(T0 + 3 * H);
  const held = claimParkedById(first.PENDING_DIR, r0.parked);
  assert.strictEqual(held.held, T0);
  parkDelivery(first.PENDING_DIR, 'root', held.text, `${Date.now()}.000000002`, r0.parked, false, 1, null, null, held.held);
  t.mock.timers.setTime(T0 + 11 * H);
  first.m._gatedDeliver('root', 'clodex@laptop', 'later', false);
  const second = rig(t, { hours: 12, home: first.home, PENDING_DIR: first.PENDING_DIR });
  assert.deepStrictEqual(second.m._sweepParkWake(T0 + 12 * H - 1), []);
  assert.deepStrictEqual(second.m._sweepParkWake(T0 + 12 * H), ['root']);
  assert.match(second.injected[0], /oldest[\s\S]*later/);
}));

test('after the automatic wake a second batch stays parked, across a restart, and the bounce says so', withClock(async (t) => {
  const r = rig(t, { hours: 12 });
  const send = sendFromLaptop(r.m);
  assert.strictEqual(send(), bounceFor("1 waiting, oldest under 1m; it'll be delivered with root's next turn, or will be delivered after 12h idle", `r${refN}`));
  assert.deepStrictEqual(r.m._sweepParkWake(T0 + 12 * H), ['root']);
  t.mock.timers.setTime(T0 + 13 * H);
  assert.strictEqual(send(), bounceFor("1 waiting, oldest under 1m; automatic delivery already used; waits for the seat's next turn", `r${refN}`));
  assert.deepStrictEqual(r.m._sweepParkWake(T0 + 40 * H), []);
  const after = rig(t, { hours: 12, home: r.home, PENDING_DIR: r.PENDING_DIR });
  assert.deepStrictEqual(after.m._sweepParkWake(T0 + 40 * H), []);
  assert.strictEqual(countPending(r.PENDING_DIR, 'root'), 1);
}));

test('hourly peer mail over 12 hours wakes once; typed input, a ✉ click and an operator message each re-arm', withClock(async (t) => {
  const r = rig(t, { hours: 1 });
  let turns = 0;
  for (let h = 0; h <= 12; h++) {
    t.mock.timers.setTime(T0 + h * H);
    r.m._gatedDeliver('root', `peer${h}@laptop`, `hourly ${h}`, false);
    turns += r.m._sweepParkWake(T0 + h * H + 1).length;
  }
  assert.strictEqual(turns, 1);
  for (const touch of [() => r.m.write('root', 'x'), () => r.m.flushPending('root'), () => r.m._deliverMessage('root', 'user', 'hi', 'dm')]) {
    t.mock.timers.setTime(Date.now() + 2 * H);
    r.m._gatedDeliver('root', 'peer@laptop', 'next', false);
    assert.deepStrictEqual(r.m._sweepParkWake(Date.now() + 2 * H), [], 'ENTER: spent before the touch');
    touch();
    r.root()._draft = '';
    r.root()._draftState = null;
    r.root().lastUserInputTs = 0;
    r.m._gatedDeliver('root', 'peer@laptop', 'after touch', false);
    t.mock.timers.setTime(Date.now() + 2 * H);
    assert.deepStrictEqual(r.m._sweepParkWake(Date.now()), ['root'], String(touch));
  }
}));

test('a seat on a permission dialog is skipped without spending the allowance', withClock(async (t) => {
  const r = rig(t, { hours: 2 });
  r.m._gatedDeliver('root', 'clodex@laptop', 'held', false);
  r.root().needsAttention = { kind: 'permission' };
  assert.deepStrictEqual(r.m._sweepParkWake(T0 + 3 * H), []);
  assert.strictEqual(r.m._parkWakeSpent('root'), false);
  r.root().activityState = 'thinking';
  r.root().needsAttention = null;
  assert.deepStrictEqual(r.m._sweepParkWake(T0 + 3 * H), []);
  r.root().activityState = 'idle';
  assert.deepStrictEqual(r.m._sweepParkWake(T0 + 3 * H), ['root']);
}));

test('timer drain racing a manual drain delivers each message once, and a lost race spends nothing', withClock(async (t) => {
  const r = rig(t, { hours: 1 });
  const producers = [];
  r.m._injectText = (_s, _text, opts) => producers.push(opts.produce);
  for (const body of ['m1', 'm2', 'm3']) r.m._gatedDeliver('root', 'clodex@laptop', body, false);
  assert.deepStrictEqual(r.m._sweepParkWake(T0 + 2 * H), ['root']);
  r.m.flushPending('root');
  assert.strictEqual(producers.length, 2);
  const out = [producers[1](), producers[0]()];
  assert.strictEqual(out[1], null);
  for (const body of ['m1', 'm2', 'm3']) assert.strictEqual(out[0].split(body).length, 2, body);
  assert.strictEqual(r.m._parkWakeSpent('root'), false);
}));

test('[agent:who] shows the waiting count on the owning node', async () => {
  const PENDING_DIR = mkTmpRoot('clodex-pw-pend-');
  const injected = [];
  const m = mk({ PENDING_DIR, registry: { listPeers: () => [] }, getPeerManager: () => null, peerStatusLabel: () => 'idle' });
  m._injectText = (_s, text) => injected.push(text);
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1' });
  m.sessions.set('b', { name: 'b', agentType: 'claude', workspaceId: 'ws1' });
  m.sessions.set('c', { name: 'c', agentType: 'claude', workspaceId: 'ws1' });
  for (const n of [1, 2, 3]) parkDelivery(PENDING_DIR, 'b', `[agent:from x] ${n}`, `1.00000000${n}`);
  await m._handleIntent('a', { type: 'who' });
  assert.deepStrictEqual(injected, ['[agent:peers] b (idle) (3 waiting), c (idle)']);
});

test('the 60 s ticket watchdog pass runs the age wake', withClock(async (t) => {
  const r = rig(t, { hours: 12 });
  r.m._gatedDeliver('root', 'clodex@laptop', 'via watchdog', false);
  await r.m._sweepTickets(T0 + 12 * H);
  assert.strictEqual(r.injected.length, 1);
  assert.match(r.injected[0], /via watchdog/);
}));
