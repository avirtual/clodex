'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');

const { createSessionManager } = require('../session-manager');
const { effectiveHandCap } = require('../team-manifest');
const ticketsMod = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');
const { parseWithRegistry } = require('../intent-registry');
const { mkTmpRoot } = require('./lib/tmp-roots');

function mkFixture({ maxHands, env = {}, cpus = 6, extraRoles = {} } = {}) {
  const home = mkTmpRoot('clodex-t1897-');
  const root = mkTmpRoot('clodex-t1897-root-');
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const teamsDir = pathReal.join(home, 'teams');
  const team = {
    name: 'team', root, lead: 'lead', watchdogMs: null, file: pathReal.join(teamsDir, 'team', 'team.json'),
    roles: {
      lead: { brief: 'the lead', dispatch: 'standing' },
      hand: { brief: 'the hand', dispatch: 'worktree', template: 'clodex-team-hand' },
      ...extraRoles,
    },
    trunk: 'master', ...(maxHands !== undefined ? { maxHands } : {}),
  };
  const persistence = {
    list: () => [], get: (n) => (n === 'lead' ? { name: 'lead', extraArgs: [] } : null),
    upsert: () => {}, remove: () => {}, setWorktree: () => {},
  };
  const deps = {
    knownSkillNames: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => [] }),
    notifyOS: () => {},
    intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    fencedLines: require('../intent-scanner').fencedLines,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    intentEnabledForSeat: require('../intent-registry').intentEnabledForSeat,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fs: fsReal,
    path: pathReal,
    os: { cpus: () => new Array(cpus).fill({}) },
    cpuMaxFile: pathReal.join(root, 'no-cpu.max'),
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
    resolveTeam: (cwd) => (cwd && cwd.startsWith(root) ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith(root) ? root : null),
    teamsDir,
    refreshAppMenu: () => {},
    env,
    setTeamMaxHands: (name, v) => { team.maxHands = v; return team; },
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  const injected = [];
  const acks = [];
  const spawned = [];
  m._injectText = (s, text) => { injected.push(text); };
  m._taskAck = (s, line) => { acks.push(line); };
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._spawnTicketSeat = (opener, t, ticket, roleKey, minted) => { spawned.push({ id: ticket.id, name: minted.name }); };
  const seat = (name) => {
    if (!m.sessions.has(name)) m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd: root, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  const add = (extra = {}) => {
    m._handleTask(seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build it', ...extra });
    const all = tstore.load(root);
    for (const x of all) if (!x.taskDir) x.taskDir = `tasks/${x.id}-fixture/SPEC.md`;
    tstore.save(root, all);
  };
  const start = (id) => m._handleTask(seat('lead'), { type: 'task', sub: 'start', who: null, id, body: '' });
  const retire = (name) => {
    const s = m.sessions.get(name);
    m.sessions.delete(name);
    m._handSeatGone(s);
  };
  const one = (id) => tstore.load(root).find((t) => t.id === id);
  return { m, team, root, tstore, seat, add, start, retire, one, injected, acks, spawned };
}

const PARK_REPLY = '[agent:task] ticket t1 parked: hand cap reached (3/3 live hands) — it starts when one retires';

function capped() {
  const f = mkFixture({ maxHands: 3 });
  for (const n of ['team-hand-91', 'team-hand-92', 'team-hand-93']) f.seat(n);
  f.add();
  f.acks.length = 0;
  f.start('t1');
  return f;
}

test('cap 3 with three live one-shot hands: the 4th task start parks with the literal reply and mints nothing', () => {
  const f = capped();
  assert.deepStrictEqual(f.acks, [PARK_REPLY]);
  assert.deepStrictEqual(f.spawned, []);
  const t = f.one('t1');
  assert.strictEqual(t.parked, true);
  assert.strictEqual(t.parkedBy, 'cap');
  assert.strictEqual(t.assignee, 'hand', 'the ticket keeps its assignee');
  assert.strictEqual(t.startedAt, null, 'a cap-parked ticket is not started');
});

test('retiring one of the three hands auto-starts the cap-parked ticket through the mint path', () => {
  const f = capped();
  assert.deepStrictEqual(f.spawned, [], 'ENTER: parked, nothing minted');
  f.acks.length = 0;
  f.retire('team-hand-91');
  assert.deepStrictEqual(f.spawned, [{ id: 't1', name: 'team-hand-1' }]);
  assert.strictEqual(f.acks.length, 1);
  assert.match(f.acks[0], /^\[agent:task\] cap freed: ticket t1 \(unparked\) → spawning team-hand-1 in a worktree on branch /);
  const t = f.one('t1');
  assert.strictEqual(t.parked, undefined);
  assert.strictEqual(t.parkedBy, undefined);
  assert.ok(t.startedAt, 'the ticket is started');
});

test('a spawn rollback frees its slot and the next ticket sweep starts the cap-parked ticket', async () => {
  const f = mkFixture({ maxHands: 1 });
  f.add({ body: 'first' });
  f.add({ body: 'second' });
  f.start('t1');
  f.start('t2');
  assert.strictEqual(f.one('t2').parkedBy, 'cap', 'ENTER: t2 parked behind the in-flight t1');
  const all = f.tstore.load(f.root);
  const t1 = all.find((t) => t.id === 't1');
  t1.assignee = 'hand';
  delete t1.role;
  t1.startedAt = null;
  f.tstore.save(f.root, all);
  f.acks.length = 0;
  await f.m._sweepTickets();
  assert.deepStrictEqual(f.spawned.map((x) => x.id), ['t1', 't2']);
  assert.match(f.acks[0], /^\[agent:task\] cap freed: ticket t2 \(unparked\) → spawning team-hand-2 /);
});

test('a hand retiring while the lead is down is caught by the sweep once the lead is back', async () => {
  const f = capped();
  f.m.sessions.delete('lead');
  f.retire('team-hand-91');
  assert.deepStrictEqual(f.spawned, [], 'ENTER: no lead, no auto-start at the exit');
  f.seat('lead');
  await f.m._sweepTickets();
  assert.deepStrictEqual(f.spawned, [{ id: 't1', name: 'team-hand-1' }]);
});

test('a lead-parked ticket is not auto-started when a hand retires', () => {
  const f = mkFixture({ maxHands: 3 });
  for (const n of ['team-hand-91', 'team-hand-92', 'team-hand-93']) f.seat(n);
  f.add({ park: true });
  assert.strictEqual(f.one('t1').parked, true, 'ENTER: the lead parked it');
  f.retire('team-hand-91');
  assert.deepStrictEqual(f.spawned, []);
  assert.strictEqual(f.one('t1').parked, true);
});

test('standing-dispatch seats do not count toward the cap', () => {
  const f = mkFixture({ maxHands: 3, extraRoles: { dev: { brief: 'the dev', dispatch: 'standing' } } });
  for (const n of ['team-dev-1', 'team-dev-2', 'team-dev-3']) f.seat(n);
  f.add();
  f.start('t1');
  assert.deepStrictEqual(f.spawned, [{ id: 't1', name: 'team-hand-1' }]);
});

test('seats minted but not yet live count toward the cap, so a burst of starts stops at it', () => {
  const f = mkFixture({ maxHands: 2 });
  for (let i = 0; i < 3; i++) f.add({ body: `build ${i}` });
  f.acks.length = 0;
  f.injected.length = 0;
  for (const id of ['t1', 't2', 't3']) f.start(id);
  assert.deepStrictEqual(f.spawned.map((s) => s.id), ['t1', 't2']);
  assert.strictEqual(f.one('t3').parkedBy, 'cap');
  assert.strictEqual(f.acks[2], '[agent:task] ticket t3 parked: hand cap reached (2/2 live hands) — it starts when one retires');
});

test('task list marks a cap-parked ticket with its stored count', () => {
  const f = capped();
  f.injected.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'list', filter: 'open' });
  const row = f.injected.join('\n').split('\n').find((l) => l.startsWith('t1 '));
  assert.ok(row, 'ENTER: t1 is listed');
  assert.match(row, /^t1 \[open parked\] hand .* — build it \(parked: cap 3\/3\)/);
});

for (const [name, input, want] of [
  ['{maxHands:2}', { maxHands: 2, inBox: false, cpuMax: null, cpus: 8 }, { cap: 2, source: 'set' }],
  ['in-box cpu.max 300000 100000', { maxHands: undefined, inBox: true, cpuMax: '300000 100000\n', cpus: 12 }, { cap: 1, source: 'box default (3 vCPU → 1)' }],
  ['in-box cpu.max max 100000, 6 cpus', { maxHands: undefined, inBox: true, cpuMax: 'max 100000\n', cpus: 6 }, { cap: 3, source: 'box default (6 vCPU → 3)' }],
  ['desktop unset', { maxHands: undefined, inBox: false, cpuMax: null, cpus: 6 }, { cap: null, source: 'off' }],
  ['in-box explicit off', { maxHands: null, inBox: true, cpuMax: null, cpus: 6 }, { cap: null, source: 'off' }],
]) {
  test(`effective hand cap: ${name}`, () => {
    assert.deepStrictEqual(effectiveHandCap(input), want);
  });
}

const teamVerb = (f, who, line) => {
  f.injected.length = 0;
  f.m._handleTeam(f.seat(who), parseWithRegistry(line));
  return f.injected.slice();
};

test('[agent:team hands] verb table', () => {
  const f = mkFixture({});
  assert.deepStrictEqual(teamVerb(f, 'lead', '[agent:team hands 3]'),
    ['[agent:team] hand cap of team set to 3 — a task start past it parks the ticket until a hand retires']);
  assert.strictEqual(f.team.maxHands, 3);
  assert.deepStrictEqual(teamVerb(f, 'lead', '[agent:team hands]'),
    ['[agent:team] hand cap of team: 3 (set) — [agent:team hands <n|off>] sets it']);
  assert.deepStrictEqual(teamVerb(f, 'lead', '[agent:team hands 0]'),
    ['[agent:team] error: hands must be a positive integer or off, not "0"']);
  assert.deepStrictEqual(teamVerb(f, 'lead', '[agent:team hands x]'),
    ['[agent:team] error: hands must be a positive integer or off, not "x"']);
  assert.strictEqual(f.team.maxHands, 3, 'refusals write nothing');
  assert.deepStrictEqual(teamVerb(f, 'lead', '[agent:team hands off]'),
    ['[agent:team] hand cap of team set to off — task start no longer parks for a cap']);
  assert.strictEqual(f.team.maxHands, null);
  assert.deepStrictEqual(teamVerb(f, 'lead', '[agent:team hands]'),
    ['[agent:team] hand cap of team: off — [agent:team hands <n|off>] sets it']);
  assert.deepStrictEqual(teamVerb(f, 'team-hand-1', '[agent:team hands 2]'),
    ['[agent:team] error: only the team lead (lead) can edit team metadata']);
});

test('bare [agent:team hands] inside a box names the box default and its source', () => {
  const f = mkFixture({ env: { CLODEX_IN_SANDBOX: '1' }, cpus: 6 });
  assert.deepStrictEqual(teamVerb(f, 'lead', '[agent:team hands]'),
    ['[agent:team] hand cap of team: 3 (box default (6 vCPU → 3)) — [agent:team hands <n|off>] sets it']);
});
