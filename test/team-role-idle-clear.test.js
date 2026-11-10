'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTeamManifest } = require('../team-manifest');
const { createTicketMethods } = require('../team-tickets');
const { createSessionManager } = require('../session-manager');
const { registerIpcHandlers } = require('../ipc-handlers');
const { idleClearAfterMs } = require('../assistant-sleep');
const ticketsMod = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');
const { parseIntent } = require('../intent-scanner');
const lib = require('../renderer/lib/team-roles');
const { mkTmpRoot } = require('./lib/tmp-roots');

const POPOVER = fs.readFileSync(path.join(__dirname, '..', 'renderer/popovers/team-roles-popover.js'), 'utf-8');

function fakePersistence(rows = []) {
  const store = rows.map((r) => ({ ...r }));
  return {
    store,
    list: () => store,
    get: (n) => store.find((e) => e.name === n) || null,
    upsert: (e) => {
      const i = store.findIndex((x) => x.name === e.name);
      if (i >= 0) store[i] = { ...store[i], ...e }; else store.push({ ...e });
    },
    remove: (n) => { const i = store.findIndex((x) => x.name === n); if (i >= 0) store.splice(i, 1); },
    setIdleClear: (n, ic) => {
      const e = store.find((x) => x.name === n);
      if (!e) return false;
      const ms = idleClearAfterMs(ic);
      if (ms) e.idleClear = { afterMs: ms }; else delete e.idleClear;
      return true;
    },
    setWorktree: () => {},
    setStripLevel: () => {},
    setAutoCompact: () => {},
    setPlugins: () => {},
  };
}

function mkTeam(t, roles, roster = []) {
  const home = mkTmpRoot('t2248-home-');
  const root = mkTmpRoot('t2248-root-');
  const dir = path.join(home, 'teams', 't');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'team.json');
  fs.writeFileSync(file, JSON.stringify({ root, lead: 't-lead', roles: { lead: { brief: 'the lead' }, ...roles } }, null, 2));
  fs.writeFileSync(path.join(dir, 'roster.json'), JSON.stringify({ seats: roster }, null, 2));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  return { home, root, dir, file, tm, raw: () => JSON.parse(fs.readFileSync(file, 'utf-8')).roles };
}

function mkDoor(t, roles, roster, persistence) {
  const team = mkTeam(t, roles, roster);
  const methods = createTicketMethods({ fs, path, getPersistence: () => persistence, log: { info() {}, warn() {}, error() {} } }, {});
  const manager = Object.create(methods);
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, warn() {}, error() {} },
    loadManifest: team.tm.loadManifest,
    addRole: team.tm.addRole,
    setRole: team.tm.setRole,
    listAllTemplates: () => [],
    manager,
    accounts: { list: () => [], configDirFor: () => null },
  });
  return { ...team, setRole: (role, patch) => handlers.get('team:setRole')(null, 't', role, patch) };
}

test('role save: a valid idleClear is written, an invalid one writes nothing, off removes the key', (t) => {
  const d = mkDoor(t, { hand: { brief: 'h' } }, [], fakePersistence());
  assert.strictEqual(d.setRole('hand', { idleClear: { afterMs: 1800000 } }).ok, true);
  assert.deepStrictEqual(d.raw().hand.idleClear, { afterMs: 1800000 });
  assert.deepStrictEqual(d.tm.loadManifest('t').roles.hand.idleClear, { afterMs: 1800000 });
  assert.strictEqual(d.setRole('hand', { idleClear: { afterMs: 5000 } }).ok, true);
  assert.deepStrictEqual(d.raw().hand.idleClear, { afterMs: 1800000 }, 'an invalid value leaves the stored one as it was');
  assert.strictEqual(d.setRole('hand', { idleClear: null }).ok, true);
  assert.strictEqual('idleClear' in d.raw().hand, false);
  assert.strictEqual(d.tm.loadManifest('t').roles.hand.idleClear, null);
  assert.strictEqual(d.setRole('hand', { idleClear: { afterMs: 'x' } }).ok, true);
  assert.strictEqual('idleClear' in d.raw().hand, false, 'an invalid value on a role with none stores nothing');
});

test('role add: an invalid idleClear is dropped, a valid one lands', (t) => {
  const d = mkTeam(t, {});
  d.tm.addRole('t', 'good', { brief: 'g', idleClear: { afterMs: 900000 } });
  d.tm.addRole('t', 'bad', { brief: 'b', idleClear: { afterMs: 10 } });
  assert.deepStrictEqual(d.raw().good.idleClear, { afterMs: 900000 });
  assert.strictEqual('idleClear' in d.raw().bad, false);
});

test('role save applies to the role\'s roster seats, and off removes it from them', (t) => {
  const p = fakePersistence([{ name: 't-hand', idleClear: { afterMs: 120000 } }, { name: 't-hand-2' }, { name: 't-scout' }]);
  const roster = [
    { seat: 't-hand', role: 'hand', by: 'test' },
    { seat: 't-hand-2', role: 'hand', by: 'test' },
    { seat: 't-scout', role: 'scout', by: 'test' },
  ];
  const d = mkDoor(t, { hand: { brief: 'h' }, scout: { brief: 's' } }, roster, p);
  assert.strictEqual(d.setRole('hand', { idleClear: { afterMs: 3600000 } }).ok, true);
  assert.deepStrictEqual(p.get('t-hand').idleClear, { afterMs: 3600000 });
  assert.deepStrictEqual(p.get('t-hand-2').idleClear, { afterMs: 3600000 });
  assert.strictEqual('idleClear' in p.get('t-scout'), false, 'another role\'s seat is untouched');
  p.get('t-hand-2').idleClear = { afterMs: 600000 };
  assert.strictEqual(d.setRole('hand', { brief: 'new', idleClear: { afterMs: 3600000 } }).ok, true);
  assert.deepStrictEqual(p.get('t-hand-2').idleClear, { afterMs: 600000 }, 'a save that does not change the role value leaves seats alone');
  assert.strictEqual(d.setRole('hand', { idleClear: null }).ok, true);
  assert.strictEqual('idleClear' in p.get('t-hand'), false);
  assert.strictEqual('idleClear' in p.get('t-hand-2'), false);
});

function mkKvBox(t, roster = [], persistence = fakePersistence()) {
  const team = mkTeam(t, { hand: { brief: 'h' }, reviewer: { brief: 'r' } }, roster);
  const injected = [];
  const live = () => ({ ...team.tm.loadManifest('t'), dir: team.dir });
  const methods = createTicketMethods({
    fs, path, teamsDir: path.join(team.home, 'teams'),
    addRole: team.tm.addRole,
    setRole: team.tm.setRole,
    listTeams: () => ['t'],
    resolveTeam: (cwd) => (cwd === team.root ? live() : null),
    getPersistence: () => persistence,
    refreshAppMenu: () => {},
    log: { info() {}, warn() {}, error() {} },
  }, {});
  const m = Object.create(methods);
  m._injectText = (_s, text) => { injected.push(text); };
  m.recordMisfire = () => true;
  const lead = { name: 't-lead', agentType: 'claude', cwd: team.root };
  const run = (line) => m._handleTeam(lead, parseIntent(line));
  return { ...team, run, last: () => injected[injected.length - 1] || '' };
}

test('role-set idle-clear: minutes set the key, off removes it, an invalid value is refused', (t) => {
  const p = fakePersistence([{ name: 't-hand' }]);
  const b = mkKvBox(t, [{ seat: 't-hand', role: 'hand', by: 'test' }], p);
  assert.strictEqual(parseIntent('[agent:team role-set hand idle-clear:30]').idleClear, '30');
  b.run('[agent:team role-set hand idle-clear:30]');
  assert.deepStrictEqual(b.raw().hand.idleClear, { afterMs: 1800000 });
  assert.deepStrictEqual(p.get('t-hand').idleClear, { afterMs: 1800000 }, 'the roster seat got it too');
  assert.match(b.last(), /role "hand" updated/);
  for (const bad of ['abc', '0', '1.5', '-5']) {
    const before = fs.readFileSync(b.file, 'utf-8');
    b.run(`[agent:team role-set hand idle-clear:${bad}]`);
    assert.match(b.last(), /^\[agent:team\] error: idle-clear:/, `"${bad}" is refused`);
    assert.strictEqual(fs.readFileSync(b.file, 'utf-8'), before, `"${bad}" writes nothing`);
  }
  b.run('[agent:team role-set hand idle-clear:off]');
  assert.strictEqual('idleClear' in b.raw().hand, false);
  assert.strictEqual('idleClear' in p.get('t-hand'), false);
});

test('role-add idle-clear sets the key; a reserved role keeps its refusal', (t) => {
  const b = mkKvBox(t);
  b.run('[agent:team role-add builder idle-clear:15] builds');
  assert.deepStrictEqual(b.raw().builder.idleClear, { afterMs: 900000 });
  const before = fs.readFileSync(b.file, 'utf-8');
  b.run('[agent:team role-set reviewer idle-clear:30]');
  assert.match(b.last(), /error: .*operator-owned/);
  assert.strictEqual(fs.readFileSync(b.file, 'utf-8'), before);
});

const HAND_TEMPLATE = { name: 'clodex-team-hand', type: 'claude', systemPromptFile: 'clodex-team-hand' };

function mkMint({ handRole = {}, template = HAND_TEMPLATE } = {}) {
  const home = mkTmpRoot('t2248-mint-');
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const roles = {
    lead: { brief: 'the lead', dispatch: 'standing' },
    hand: { brief: 'the hand', dispatch: 'spawn', template: 'clodex-team-hand', ...handRole },
    reviewer: { prompt: 'clodex-team-reviewer', brief: 'the reviewer' },
  };
  const team = { name: 'team', root: '/proj', lead: 'lead', watchdogMs: null, file: path.join(home, 'teams', 'team', 'team.json'), roles };
  const persistence = fakePersistence();
  const baseGet = persistence.get;
  persistence.get = (n) => baseGet(n) || (n === 'lead' ? { name: 'lead', extraArgs: [] } : null);
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => [template] }),
    getAccounts: () => ({ list: () => [], configDirFor: () => null }),
    notifyOS: () => {},
    intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    fencedLines: require('../intent-scanner').fencedLines,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    intentEnabledForSeat: require('../intent-registry').intentEnabledForSeat,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fs, path, os,
    ensureDir: () => {},
    countPending: require('../pending-store').countPending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    termAvailableFor: require('../drawer-avail').termAvailableFor,
    REGISTRY_DIR: home,
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj' : null),
    teamsDir: path.join(home, 'teams'),
    refreshAppMenu: () => {},
  });
  const m = new SessionManager();
  m._injectText = () => {};
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._gatedDeliver = () => ({ queued: true });
  m._deliverMessage = () => {};
  m._deliverPassive = () => {};
  m._deliverParkedActive = () => {};
  const created = [];
  m.create = async (...args) => { created.push(args); return { name: args[0] }; };
  const seat = (name) => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd: '/proj', pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  return { m, tstore, team, persistence, created, seat, home };
}

const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

async function dispatchTicket(f) {
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build it' });
  const all = f.tstore.load(f.team.root);
  for (const x of all) if (!x.taskDir) x.taskDir = `tasks/${x.id}-fixture/SPEC.md`;
  f.tstore.save(f.team.root, all);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await settle();
  await settle();
  assert.strictEqual(f.created.length, 1, 'ENTER: the ticket seat reached create()');
  return f.persistence.get(f.created[0][0]);
}

for (const [label, handRole, template, want] of [
  ['the role value reaches the record', { idleClear: { afterMs: 1800000 } }, HAND_TEMPLATE, { afterMs: 1800000 }],
  ['the role value beats the template value', { idleClear: { afterMs: 1800000 } }, { ...HAND_TEMPLATE, idleClear: { afterMs: 7200000 } }, { afterMs: 1800000 }],
  ['no role value leaves the template value', {}, { ...HAND_TEMPLATE, idleClear: { afterMs: 7200000 } }, { afterMs: 7200000 }],
  ['neither sets nothing', {}, HAND_TEMPLATE, undefined],
]) {
  test(`ticket mint: ${label}`, async (t) => {
    const f = mkMint({ handRole, template });
    t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
    const rec = await dispatchTicket(f);
    assert.ok(rec, 'ENTER: the seat has a record');
    assert.deepStrictEqual(rec.idleClear, want);
  });
}

test('by-name team spawn: a seat resolving to a role gets the role value over the template\'s', async (t) => {
  const tplDir = mkTmpRoot('t2248-tpl-');
  t.after(() => fs.rmSync(tplDir, { recursive: true, force: true }));
  const tpl = path.join(tplDir, 'hand.json');
  fs.writeFileSync(tpl, JSON.stringify({ type: 'claude', idleClear: { afterMs: 7200000 } }));
  const store = fakePersistence();
  const team = { name: 'team', root: tplDir, lead: 'lead', roles: { lead: {}, hand: { idleClear: { afterMs: 900000 } } } };
  const SessionManager = createSessionManager({
    knownSkillNames: () => [], os, fs, path,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => store,
    withoutPrivilegedIntentsFor: (x) => x,
    ensureDir: () => {},
    resolveTeam: () => team,
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    DEFAULT_WORKSPACE_ID: 'default',
    REGISTRY_DIR: tplDir,
  });
  const m = new SessionManager();
  m.sessions = new Map();
  const replies = [];
  m._injectText = (_s, text) => replies.push(text);
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._bindRosterSeat = async () => ({ ok: true });
  m.create = async (name) => { store.upsert({ name }); return undefined; };
  m._handleSpawnIntent({ name: 'lead', cwd: tplDir, workspaceId: 'default', type: 'claude' }, { name: 'team-hand', template: tpl, cwd: tplDir });
  await settle();
  await settle();
  assert.ok(store.get('team-hand'), `ENTER: the seat was created (replies: ${JSON.stringify(replies)})`);
  assert.deepStrictEqual(store.get('team-hand').idleClear, { afterMs: 900000 });
});

function compilePaint(env) {
  const start = '  function paintIdleClearSelect(sel, stored, applies) {';
  const a = POPOVER.indexOf(start);
  assert.ok(a >= 0, 'ENTER: paintIdleClearSelect is in the popover');
  const b = POPOVER.indexOf('\n  }\n', a);
  const names = Object.keys(env);
  return new Function(...names, `${POPOVER.slice(a, b + 4)}\nreturn paintIdleClearSelect;`)(...names.map((n) => env[n]));
}

function fakeSelect() {
  const field = { title: '' };
  const sel = { options: [], value: '', disabled: false, field };
  Object.defineProperty(sel, 'innerHTML', { set() { sel.options = []; } });
  sel.appendChild = (o) => sel.options.push(o);
  sel.closest = (q) => (q === '.team-role-field' ? field : null);
  return sel;
}

const paint = compilePaint({
  document: { createElement: () => ({}) },
  idleClearOptions: lib.idleClearOptions,
  IDLE_CLEAR_TITLE: lib.IDLE_CLEAR_TITLE,
  IDLE_CLEAR_STREAM_ONLY_TITLE: lib.IDLE_CLEAR_STREAM_ONLY_TITLE,
});

const ROWS = [
  { name: 'streamy', type: 'claude', io: 'stream' },
  { name: 'ptyish', type: 'claude' },
];

test('popover: the idle clear field renders the stored value with the five choices', () => {
  const sel = fakeSelect();
  const row = lib.teamRoleRows({ roles: { hand: { template: 'streamy', idleClear: { afterMs: 3600000 } } } })[0];
  paint(sel, row.idleClear, lib.idleClearApplies(ROWS, 't', row.template));
  assert.deepStrictEqual(sel.options.map((o) => [o.value, o.textContent]),
    [['', 'off'], ['900000', '15 min'], ['1800000', '30 min'], ['3600000', '1 h'], ['7200000', '2 h']]);
  assert.strictEqual(sel.value, '3600000');
  assert.strictEqual(sel.disabled, false);
  assert.strictEqual(sel.field.title, "Clears a seat's context after it has been idle this long with nothing outstanding. For seats that keep their state in files.");
});

test('popover: a non-standard value shows as custom and survives a save', (t) => {
  const sel = fakeSelect();
  const row = lib.teamRoleRows({ roles: { hand: { template: 'streamy', idleClear: { afterMs: 5400000 } } } })[0];
  paint(sel, row.idleClear, true);
  assert.deepStrictEqual(sel.options[sel.options.length - 1], { value: '5400000', textContent: 'custom (90 min)' });
  assert.strictEqual(sel.value, '5400000');
  const rowEl = { querySelector: (q) => (q === '[data-f="idleClear"]' ? sel : null) };
  const patch = lib.buildSavePatch(lib.rowFormValues(rowEl));
  assert.deepStrictEqual(patch.idleClear, { afterMs: 5400000 });
  const d = mkDoor(t, { hand: { brief: 'h', idleClear: { afterMs: 5400000 } } }, [], fakePersistence());
  assert.strictEqual(d.setRole('hand', patch).ok, true);
  assert.deepStrictEqual(d.raw().hand.idleClear, { afterMs: 5400000 });
});

test('popover: off saves as a removal', () => {
  const sel = fakeSelect();
  paint(sel, '', true);
  const rowEl = { querySelector: (q) => (q === '[data-f="idleClear"]' ? sel : null) };
  assert.strictEqual(lib.buildSavePatch(lib.rowFormValues(rowEl)).idleClear, null);
});

test('popover: the field is disabled with a stream-only title for a non-stream role', () => {
  for (const tpl of ['ptyish', '', 'missing']) {
    const sel = fakeSelect();
    paint(sel, '1800000', lib.idleClearApplies(ROWS, 't', tpl));
    assert.strictEqual(sel.disabled, true, `template "${tpl}" disables the field`);
    assert.match(sel.field.title, /applies to stream seats/);
    assert.strictEqual(sel.value, '1800000', 'the stored value is still shown');
  }
  assert.strictEqual(lib.idleClearApplies(ROWS, 't', 'streamy'), true, 'ENTER: a stream template enables it');
});

test('popover: the role row paints the field from the row\'s own template', () => {
  assert.match(POPOVER, /paintIdleClearSelect\(body\.querySelector\('select\[data-f="idleClear"\]'\), row\.idleClear,\s*idleClearApplies\(templateRows, teamName\(\), row\.template\)\);/);
});
