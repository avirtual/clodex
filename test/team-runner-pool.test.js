'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createTeamManifest, normalizeTestRunner } = require('../team-manifest');
const { createSessionManager } = require('../session-manager');
const { intentEnabled } = require('../intent-catalog');
const registry = require('../intent-registry');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { createSuiteClient, pickRunner, boxVerdict } = require('../suite-client');
const { buildRunnerField } = require('../renderer/lib/team-runner-row');
const { fakeDocument, textOf } = require('./lib/fake-dom');

function mkHome(manifestExtra = {}) {
  const home = mkTmpRoot('clodex-pool-home-');
  const root = mkTmpRoot('clodex-pool-root-');
  const dir = path.join(home, 'teams', 'team');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'team.json');
  fs.writeFileSync(file, JSON.stringify({
    root, lead: 'lead',
    roles: { lead: { brief: 'the lead' }, hand: { brief: 'the hand', dispatch: 'worktree' } },
    ...manifestExtra,
  }));
  const tm = createTeamManifest({ fs, clodexHome: home });
  return { home, root, file, tm };
}

const disk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const quiet = (fn) => {
  const orig = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  try { return { out: fn(), warns }; } finally { console.warn = orig; }
};

const POOL_ACCEPT = [
  ['a pull row and a row with no wire',
    { peer: 'a', wire: 'push', pool: [{ peer: 'b', wire: 'pull' }, { peer: 'c' }] },
    { peer: 'a', hands: 'off', gate: 'off', wire: 'push', pool: [{ peer: 'b', wire: 'pull' }, { peer: 'c' }] }],
  ['eight members',
    { peer: 'a', gate: 'on', pool: [{ peer: 'b' }, { peer: 'c' }, { peer: 'd' }, { peer: 'e' }, { peer: 'f' }, { peer: 'g' }, { peer: 'h' }] },
    { peer: 'a', hands: 'off', gate: 'on', pool: [{ peer: 'b' }, { peer: 'c' }, { peer: 'd' }, { peer: 'e' }, { peer: 'f' }, { peer: 'g' }, { peer: 'h' }] }],
];

for (const [name, input, want] of POOL_ACCEPT) {
  test(`t2362: a runner pool round-trips: ${name}`, () => {
    assert.deepStrictEqual(normalizeTestRunner(input), want);
    const { tm } = mkHome({ testRunner: input });
    const team = tm.loadManifest('team');
    assert.deepStrictEqual(team.testRunner, want);
    assert.deepStrictEqual(team.droppedFields, []);
  });
}

const POOL_DROP = [
  ['a ninth member', { peer: 'a', hands: 'full', pool: [{ peer: 'b' }, { peer: 'c' }, { peer: 'd' }, { peer: 'e' }, { peer: 'f' }, { peer: 'g' }, { peer: 'h' }, { peer: 'i' }] },
    { peer: 'a', hands: 'full', gate: 'off' }],
  ['a duplicate of the first member', { peer: 'a', wire: 'pull', pool: [{ peer: 'b' }, { peer: 'a' }] },
    { peer: 'a', hands: 'off', gate: 'off', wire: 'pull' }],
  ['a duplicate inside the pool', { peer: 'a', gate: 'shadow', pool: [{ peer: 'b' }, { peer: 'b', wire: 'pull' }] },
    { peer: 'a', hands: 'off', gate: 'shadow' }],
  ['a row with an unknown key', { peer: 'a', pool: [{ peer: 'b', slots: 2 }] },
    { peer: 'a', hands: 'off', gate: 'off' }],
  ['a row with a bad wire', { peer: 'a', pool: [{ peer: 'b', wire: 'dial' }] },
    { peer: 'a', hands: 'off', gate: 'off' }],
  ['a row with a bad name', { peer: 'a', pool: [{ peer: 'bad name' }] },
    { peer: 'a', hands: 'off', gate: 'off' }],
  ['a pool that is not a list', { peer: 'a', pool: { peer: 'b' } },
    { peer: 'a', hands: 'off', gate: 'off' }],
];

for (const [name, input, want] of POOL_DROP) {
  test(`t2362: a malformed pool drops only the pool: ${name}`, () => {
    assert.deepStrictEqual(normalizeTestRunner(input), want);
    const { home, tm } = mkHome({ testRunner: input });
    const { out: team, warns } = quiet(() => tm.loadManifest('team'));
    assert.deepStrictEqual(team.testRunner, want);
    assert.deepStrictEqual(team.droppedFields, []);
    assert.deepStrictEqual(warns, [`team "team": testRunner.pool is invalid and ignored; a stays the only runner (${path.join(home, 'teams', 'team', 'team.json')})`]);
  });
}

test('t2362: setTeamTestRunner refuses a pool patch that would be dropped and writes nothing', () => {
  const { tm, file } = mkHome({ testRunner: { peer: 'a', pool: [{ peer: 'b' }] } });
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => tm.setTeamTestRunner('team', { pool: [{ peer: 'a' }] }), /testRunner would be invalid after this patch/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.deepStrictEqual(tm.setTeamTestRunner('team', { pool: null }).testRunner, { peer: 'a', hands: 'off', gate: 'off' });
});

function mkFixture({ manifestExtra = {}, peers = [], desk = null, client = {}, extraDeps = {} } = {}) {
  const { home, root, file, tm } = mkHome(manifestExtra);
  const deps = {
    knownSkillNames: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null, upsert: () => {}, remove: () => {} }),
    getTemplates: () => ({ list: () => [] }),
    notifyOS: () => {},
    intentEnabled,
    withoutPrivilegedIntentsFor: registry.withoutPrivilegedIntentsFor,
    fencedLines: require('../intent-scanner').fencedLines,
    bodyModeFor: registry.bodyModeFor,
    intentEnabledFor: registry.intentEnabledFor,
    intentEnabledForSeat: registry.intentEnabledForSeat,
    pluginRowFor: registry.pluginRowFor,
    validIntentNames: registry.validIntentNames,
    fs,
    path,
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
    resolveTeam: (cwd) => (cwd && cwd.startsWith(root) ? tm.loadManifest('team') : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith(root) ? root : null),
    teamsDir: path.join(home, 'teams'),
    refreshAppMenu: () => {},
    setTeamTestRunner: tm.setTeamTestRunner,
    getPeerManager: () => ({ statuses: () => peers }),
    getSuiteDesk: () => desk,
    getSuiteClient: () => client,
    ...extraDeps,
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  const injected = [];
  m._injectText = (s, text) => { injected.push(text); };
  m._broadcast = () => {};
  m._sendToSession = () => {};
  const verb = async (line) => {
    injected.length = 0;
    if (!m.sessions.has('lead')) m.sessions.set('lead', { name: 'lead', type: 'claude', agentType: 'claude', cwd: root, pty: { pid: 1 }, activityState: 'idle' });
    await m._handleTeam(m.sessions.get('lead'), registry.parseWithRegistry(line));
    return injected.slice();
  };
  return { verb, file, m, tm };
}

const R1 = { id: 'p1', label: 'runner-1', online: true, caps: ['peer', 'suite'] };
const R2 = { id: 'p2', label: 'runner-2', online: true, caps: ['peer', 'suite'] };
const R3 = { id: 'p3', label: 'runner-3', online: false, caps: [] };
const PLAIN = { id: 'p4', label: 'plain-1', online: true, caps: ['peer', 'dm'] };
const INFO = (inUse, total, queued) => ({
  ok: true, info: { queue: { running: inUse ? 'job-x' : null, queued }, slots: { total, inUse }, env: { runner: 'box', platform: 'linux', arch: 'arm64', node: 'v22', envKey: 'k' } },
});
const ATTACHED = { attached: (n) => n === 'laptop', origins: () => [{ origin: 'laptop', lastClaim: 0 }] };

test('t2362: runner add appends a pool row with the wire the peer verb would pick, and refuses with its texts', async () => {
  const client = { reachable: async () => INFO(0, 2, []) };
  const f = mkFixture({ manifestExtra: { testRunner: { peer: 'runner-1', hands: 'full', wire: 'push' } }, peers: [R1, R2, R3, PLAIN], desk: ATTACHED, client });
  const before = fs.readFileSync(f.file, 'utf8');
  assert.deepStrictEqual(await f.verb('[agent:team runner add runner-1]'), ['[agent:team] error: runner-1 is already the first test runner of team']);
  assert.deepStrictEqual(await f.verb('[agent:team runner add nobody]'),
    ['[agent:team] error: "nobody" is not a known peer and no node by that name has dialed in — add it as a peer first']);
  assert.deepStrictEqual(await f.verb('[agent:team runner add plain-1]'),
    ['[agent:team] error: peer plain-1 is online but does not advertise the suite capability — the runner node needs CLODEX_SUITE_RUNNER=1']);
  assert.deepStrictEqual(await f.verb('[agent:team runner add]'), ['[agent:team] error: name the runner — [agent:team runner add <peer>]']);
  assert.strictEqual(fs.readFileSync(f.file, 'utf8'), before, 'refusals write nothing');
  assert.deepStrictEqual(await f.verb('[agent:team runner add runner-2]'),
    ['[agent:team] test runner runner-2 added to team, wire push — 2 runners; reachable, suite capability, queue 0, env box linux/arm64 node v22 key k']);
  assert.deepStrictEqual(await f.verb('[agent:team runner add laptop]'),
    ['[agent:team] test runner laptop added to team, wire pull — 3 runners; attached, queue 0, env box linux/arm64 node v22 key k']);
  assert.deepStrictEqual(await f.verb('[agent:team runner add runner-3]'),
    ['[agent:team] test runner runner-3 added to team, wire push — 4 runners; warning: the peer is offline, so its suite capability is unchecked']);
  assert.deepStrictEqual(await f.verb('[agent:team runner add runner-2]'), ['[agent:team] error: runner-2 is already in the runner pool of team']);
  assert.deepStrictEqual(disk(f.file).testRunner, {
    peer: 'runner-1', hands: 'full', wire: 'push', pool: [{ peer: 'runner-2', wire: 'push' }, { peer: 'laptop', wire: 'pull' }, { peer: 'runner-3', wire: 'push' }],
  });
});

test('t2362: runner rm drops a pool row, promotes the next on rm of the first keeping the stored hands, and refuses the only runner', async () => {
  const f = mkFixture({
    manifestExtra: { testRunner: { peer: 'runner-1', hands: 'full', wire: 'push', pool: [{ peer: 'laptop', wire: 'pull' }, { peer: 'runner-2', wire: 'push' }] } },
    peers: [R1, R2], desk: ATTACHED, client: { reachable: async () => INFO(0, 1, []) },
  });
  assert.deepStrictEqual(await f.verb('[agent:team runner rm runner-9]'), ['[agent:team] error: runner-9 is not a test runner of team']);
  assert.deepStrictEqual(await f.verb('[agent:team runner rm runner-1]'),
    ['[agent:team] test runner runner-1 removed from team; laptop is now the first runner, wire pull, hands full — 2 left; stopped 0 jobs bound to it']);
  assert.deepStrictEqual(disk(f.file).testRunner, { peer: 'laptop', hands: 'full', wire: 'pull', pool: [{ peer: 'runner-2', wire: 'push' }] });
  assert.deepStrictEqual(await f.verb('[agent:team runner rm runner-2]'), ['[agent:team] test runner runner-2 removed from team — 1 left; stopped 0 jobs bound to it']);
  assert.deepStrictEqual(disk(f.file).testRunner, { peer: 'laptop', hands: 'full', wire: 'pull' });
  const before = fs.readFileSync(f.file, 'utf8');
  assert.deepStrictEqual(await f.verb('[agent:team runner rm laptop]'),
    ['[agent:team] error: laptop is the only test runner of team — [agent:team runner off] removes it']);
  assert.strictEqual(fs.readFileSync(f.file, 'utf8'), before);
});

test('t2362: [agent:team runner <peer>] replaces the first member and keeps the pool; naming a pool member is refused', async () => {
  const f = mkFixture({
    manifestExtra: { testRunner: { peer: 'runner-1', hands: 'full', wire: 'push', pool: [{ peer: 'runner-2', wire: 'push' }] } },
    peers: [R1, R2, R3], client: { reachable: async () => INFO(0, 1, []) },
  });
  assert.deepStrictEqual(await f.verb('[agent:team runner runner-2]'),
    ['[agent:team] error: runner-2 is already in the runner pool of team — [agent:team runner rm runner-2] first']);
  assert.deepStrictEqual(await f.verb('[agent:team runner runner-3]'),
    ['[agent:team] test runner of team set to runner-3, hands full — warning: the peer is offline, so its suite capability is unchecked']);
  assert.deepStrictEqual(disk(f.file).testRunner, { peer: 'runner-3', hands: 'full', wire: 'push', pool: [{ peer: 'runner-2', wire: 'push' }] });
  assert.deepStrictEqual(await f.verb('[agent:team runner off]'), ['[agent:team] test runner of team removed']);
  assert.strictEqual('testRunner' in disk(f.file), false);
});

test('t2362: bare [agent:team runner] on a pool prints one line per member with slots, then the gate tally with a per-runner count', async () => {
  const compareFile = path.join(mkTmpRoot('clodex-pool-cmp-'), 'suite-compare.jsonl');
  const row = (decidedBy, runner, fallback = null) => ({ team: 'team', kind: 'verify', ticket: 't1', agree: null, decidedBy, fallback, ...(runner ? { runner } : {}) });
  fs.writeFileSync(compareFile, [row('box', 'runner-1'), row('box', 'runner-2'), row('home', 'runner-2', 'queue budget'), row('box', null)].map((r) => `${JSON.stringify(r)}\n`).join(''));
  const real = createSuiteClient({ getPeerManager: () => null, compareFile });
  const infos = { p1: INFO(1, 2, ['q1']), laptop: INFO(0, 1, []) };
  const client = { reachable: async (id) => infos[id] || { ok: false, why: 'status 0' }, decideTally: real.decideTally, tally: real.tally };
  const f = mkFixture({
    manifestExtra: { testRunner: { peer: 'runner-1', hands: 'full', gate: 'on', wire: 'push', pool: [{ peer: 'laptop', wire: 'pull' }, { peer: 'runner-2' }] } },
    peers: [R1, R2], desk: ATTACHED, client,
  });
  assert.deepStrictEqual(await f.verb('[agent:team runner]'), [[
    '[agent:team] test runner of team: 3 runners, hands full (hand runs use the pool), gate on, run 21 min (default), queue 15 min hands, 5 min gate (default)',
    'runner-1, wire push — reachable, suite capability, queue 2, env box linux/arm64 node v22 key k, slots 1/2 in use',
    'laptop, wire pull — attached, queue 0, env box linux/arm64 node v22 key k, slots 0/1 in use',
    'runner-2, wire push — online with the suite capability, but its info route failed: status 0',
    'gate runs: 3 decided by the box, 1 fell back to home (queue budget 1); per runner: runner-1 1 box, 0 home; runner-2 1 box, 1 home',
  ].join('\n')]);
});

const box = (definitionHash) => ({ state: 'ready', env: { box: { imageId: 'sha256:e', definitionHash } } });
const DEF = { definitionHash: 'd'.repeat(64), rev: 1, definition: 'FROM x\n' };
const member = (peer, info, live = true) => ({ peer, wire: 'push', live, info });
const load = (total, inUse, queued, extra = {}) => ({ slots: { total, inUse }, queue: { running: inUse ? 'j' : null, queued: Array.from({ length: queued }, (_, i) => `q${i}`) }, ...extra });

const PICK_ROWS = [
  ['an idle runner wins, the larger idle one first', [member('a', load(1, 0, 0)), member('b', load(4, 1, 0)), member('c', load(2, 0, 0))], false, 'c', true],
  ['a tie on free slots goes to the shorter queue', [member('a', load(2, 1, 3)), member('b', load(1, 0, 1)), member('c', load(3, 2, 2))], false, 'b', true],
  ['a full tie goes to manifest order', [member('a', load(2, 1, 1)), member('b', load(2, 1, 1))], false, 'a', true],
  ['a detached member is skipped', [member('a', load(4, 0, 0), false), member('b', load(1, 0, 0))], false, 'b', true],
  ['a member whose info could not be read is skipped', [member('a', null), member('b', load(1, 1, 5))], false, 'b', true],
  ['a missing slots figure reads as one slot, in use while a job runs', [member('a', { queue: { running: 'j', queued: [] } }), member('b', { queue: { running: null, queued: [] } })], false, 'b', true],
  ['a member without the box definition is skipped for a box job',
    [member('a', load(4, 0, 0, { box: box('f'.repeat(64)) })), member('b', load(1, 0, 0, { box: box('d'.repeat(64)) }))], DEF, 'b', true],
  ['the same member is eligible for a native shadow job',
    [member('a', load(4, 0, 0, { box: box('f'.repeat(64)) })), member('b', load(1, 0, 0, { box: box('d'.repeat(64)) }))], false, 'a', true],
  ['box:true asks only for a ready box', [member('a', load(4, 0, 0, { box: { state: 'unavailable', why: 'no daemon' } })), member('b', load(1, 0, 0, { box: box(null) }))], true, 'b', true],
  ['none eligible returns the first member', [member('a', load(1, 0, 0), false), member('b', null)], false, 'a', false],
];

for (const [name, members, boxOpt, want, chosen] of PICK_ROWS) {
  test(`t2362: pickRunner — ${name}`, () => {
    const got = pickRunner(members, { box: boxOpt });
    assert.strictEqual(got.member.peer, want);
    assert.strictEqual(got.chosen, chosen);
  });
}

const BUILDING_DEF = { state: 'building', definitionHash: DEF.definitionHash };

const IDLE_ROWS = [
  ['A 1/2 and B 0/1 go to the idle B', [member('a', load(2, 1, 0)), member('b', load(1, 0, 0))], false, 1],
  ['A 0/2 and B 0/1 tie on in-use and go to the more free A', [member('a', load(2, 0, 0)), member('b', load(1, 0, 0))], false, 0],
  ['A 2/2 and B 0/1 go to B', [member('a', load(2, 2, 0)), member('b', load(1, 0, 0))], false, 1],
  ['A 2/2 queue 0 and B 1/1 queue 2 go to the shorter queue A', [member('a', load(2, 2, 0)), member('b', load(1, 1, 2))], false, 0],
  ['A 2/2 queue 1 and B 1/1 queue 1 go to A by manifest order', [member('a', load(2, 2, 1)), member('b', load(1, 1, 1))], false, 0],
  ['A 1/4 and B 0/1 go to the idle B', [member('a', load(4, 1, 0)), member('b', load(1, 0, 0))], false, 1],
  ['A 3/4 and B 1/2 go to the less busy B', [member('a', load(4, 3, 0)), member('b', load(2, 1, 0))], false, 1],
  ['a ready busy runner beats an idle building one',
    [member('a', load(2, 0, 0, { box: BUILDING_DEF })), member('b', load(2, 1, 0, { box: box(DEF.definitionHash) }))], DEF, 1],
  ['a fenced runner reporting 2/2 loses to a busy 1/2', [member('a', load(2, 2, 0)), member('b', load(2, 1, 0))], false, 1],
];

for (const [name, members, boxOpt, want] of IDLE_ROWS) {
  test(`t2404: pickRunner — ${name}`, () => {
    const got = pickRunner(members, { box: boxOpt });
    assert.deepStrictEqual([got.index, got.chosen], [want, true]);
  });
}


const HONOUR = { exclusive: 'honour' };
const EXCLUSIVE_PICK_ROWS = [
  ['an idle honouring runner beats a larger busier one', [member('a', load(4, 1, 0, HONOUR)), member('b', load(1, 0, 0, HONOUR))], false, 1],
  ['nothing queued beats more free slots with a queue', [member('a', load(2, 0, 1, HONOUR)), member('b', load(1, 0, 0, HONOUR))], false, 1],
  ['an idle runner that ignores loses to a busy one that honours', [member('a', load(4, 0, 0, { exclusive: 'ignore' })), member('b', load(2, 2, 3, HONOUR))], false, 1],
  ['an older runner with no exclusive field loses to a busy one that honours', [member('a', load(4, 0, 0)), member('b', load(1, 1, 0, HONOUR))], false, 1],
  ['two idle honouring runners keep the usual order', [member('a', load(1, 0, 0, HONOUR)), member('b', load(2, 0, 0, HONOUR))], false, 1],
  ['two busy honouring runners keep the usual order', [member('a', load(2, 2, 0, HONOUR)), member('b', load(2, 1, 0, HONOUR))], false, 1],
  ['a box job still skips a member without the definition',
    [member('a', load(4, 0, 0, { ...HONOUR, box: box('f'.repeat(64)) })), member('b', load(1, 1, 0, { ...HONOUR, box: box('d'.repeat(64)) }))], DEF, 1],
];

for (const [name, members, boxOpt, want] of EXCLUSIVE_PICK_ROWS) {
  test(`t2428: pickRunner for an exclusive job — ${name}`, () => {
    const got = pickRunner(members, { box: boxOpt, exclusive: true });
    assert.deepStrictEqual([got.index, got.chosen], [want, true]);
  });
}

test('t2428: without exclusive the same members pick by the usual order', () => {
  const members = [member('a', load(4, 0, 0, { exclusive: 'ignore' })), member('b', load(2, 2, 3, HONOUR))];
  assert.deepStrictEqual(pickRunner(members, { box: false }).index, 0);
});
test('t2362: two shadow jobs while the first member fills — the second goes to the member with a free slot', async () => {
  const state = { p1: { total: 1, inUse: 0 }, p2: { total: 1, inUse: 0 } };
  const sent = [];
  const client = {
    reachable: async (id) => ({ ok: true, info: { queue: { running: null, queued: [] }, slots: { ...state[id] } } }),
    shadow: async (o) => { sent.push([o.peer, o.name, o.pool]); state[o.peer].inUse += 1; return null; },
  };
  const f = mkFixture({ manifestExtra: { testRunner: { peer: 'runner-1', gate: 'shadow', pool: [{ peer: 'runner-2' }] } }, peers: [R1, R2], client });
  const team = f.tm.loadManifest('team');
  await f.m._shadowSubmit(team, { id: 't1' }, '/w', {});
  assert.deepStrictEqual(sent, [['p1', 'runner-1', true]], 'ENTER: a tie went to the first member');
  assert.deepStrictEqual(state.p1, { total: 1, inUse: 1 }, 'ENTER: the first member is now full');
  await f.m._shadowSubmit(team, { id: 't2' }, '/w', {});
  assert.deepStrictEqual(sent, [['p1', 'runner-1', true], ['p2', 'runner-2', true]]);
});

const TREE = 'a'.repeat(40);
const TREE2 = 'c'.repeat(40);
const GREEN = 'TOTALS: 5 pass, 0 fail, 5 tests\n';

function remote({ refuseAll = false, dropAfterSubmit = false, holds = {} } = {}) {
  const calls = [];
  const conn = {
    suiteAsk: async (method, p) => {
      calls.push(`${method} ${p.split('?')[0]}`);
      if (refuseAll) return { status: 503, body: null, error: 'runner is not attached' };
      if (p.startsWith('/api/suite/info')) return { status: 200, body: { ok: true, limits: {}, env: { envKey: 'k' } } };
      if (method === 'POST') return { status: 200, body: { ok: true, state: 'queued' } };
      if (method === 'DELETE') return { status: 200, body: { ok: true } };
      if (dropAfterSubmit) return { status: 0, body: null, error: 'socket closed' };
      if (p.includes('/output?')) {
        const text = p.includes('stream=stdout') ? GREEN : '';
        return { status: 200, body: { ok: true, text, offset: 0, total: Buffer.byteLength(text) } };
      }
      const id = decodeURIComponent(/ids=([^&]+)/.exec(p)[1]);
      if (holds[id]) await holds[id];
      return { status: 200, body: { ok: true, jobs: [{ id, state: 'done', treeHash: holds.tree ? holds.tree(id) : TREE, exit: { code: 0, signal: null }, reason: null, queueMs: 1, setupMs: 1, runMs: 1, out: {} }] } };
    },
  };
  return { conn, calls };
}

function clientOver(conns, { trees = [TREE] } = {}) {
  let n = 0;
  let snaps = 0;
  let clock = 0;
  const compareFile = path.join(mkTmpRoot('clodex-pool-shadow-'), 'suite-compare.jsonl');
  const client = createSuiteClient({
    getPeerManager: () => ({ get: (id) => conns[id] || null }),
    compareFile,
    now: () => (clock += 1000),
    randomUUID: () => `run-${(n += 1)}`,
    snapshot: {
      snapshotTree: async () => ({ treeHash: trees[Math.min((snaps += 1) - 1, trees.length - 1)], head: 'b'.repeat(40), headTree: TREE }),
      releaseSnapshot: () => {},
    },
    sleep: async () => {},
  });
  const records = () => (fs.existsSync(compareFile) ? fs.readFileSync(compareFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { client, records };
}

test('t2362: a first choice that answers 503 at submit is picked around once, and the job lands on the second', async () => {
  const a = remote({ refuseAll: true });
  const b = remote();
  const { client } = clientOver({ pA: a.conn, pB: b.conn });
  const asked = [];
  const out = await client.run({
    peer: 'pA', name: 'runner-a', tree: '/w', kind: 'verify', team: 'tm', ticket: 't1', budgetMs: 60000,
    repick: async (failed) => { asked.push(failed); return { peer: 'pB', wire: 'push', name: 'runner-b' }; },
  });
  assert.deepStrictEqual(asked, ['runner-a']);
  assert.deepStrictEqual(a.calls, ['GET /api/suite/info'], 'the first choice was asked once, not waited on');
  assert.ok(b.calls.includes('POST /api/suite/jobs'), b.calls.join('\n'));
  assert.deepStrictEqual([out.record.outcome, out.record.where, out.record.runner], ['pass', 'runner-b', 'pB']);
});

test('t2362: a failure after the runner accepted the job does not repick', async () => {
  const a = remote({ dropAfterSubmit: true });
  const { client } = clientOver({ pA: a.conn });
  const asked = [];
  const out = await client.run({
    peer: 'pA', name: 'runner-a', tree: '/w', kind: 'verify', team: 'tm', ticket: 't1', budgetMs: 60000,
    repick: async (failed) => { asked.push(failed); return { peer: 'pB', wire: 'push', name: 'runner-b' }; },
  });
  assert.ok(a.calls.includes('POST /api/suite/jobs'), 'ENTER: the job was accepted');
  assert.strictEqual(out.record.outcome, 'unknown', 'ENTER: and then failed');
  assert.deepStrictEqual(asked, []);
  assert.strictEqual(out.record.where, 'runner-a');
});

test('t2362: the cancel of a superseded shadow job goes to the member that ran it, and the pooled row names that member', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const a = remote({ refuseAll: true });
  const b = remote({ holds: { 'run-1-2': held, tree: (id) => (id === 'run-1-2' ? TREE : TREE2) } });
  const f = clientOver({ pA: a.conn, pB: b.conn }, { trees: [TREE, TREE2] });
  const opts = { peer: 'pA', name: 'runner-a', tree: '/w', kind: 'verify', team: 'tm', ticket: 't1', pool: true, repick: async () => ({ peer: 'pB', wire: 'push', name: 'runner-b' }) };
  const first = await f.client.shadow(opts);
  first.local({ outcome: 'pass', pass: 5, fail: 0, tests: 5, failing: [], slow: [], durationMs: 1 });
  for (let i = 0; i < 50 && !b.calls.some((c) => c.startsWith('GET /api/suite/jobs')); i += 1) await new Promise((r) => setImmediate(r));
  assert.ok(b.calls.includes('POST /api/suite/jobs'), 'ENTER: the first job moved to runner-b');
  const second = await f.client.shadow({ ...opts, peer: 'pB', name: 'runner-b', repick: undefined });
  second.local({ outcome: 'pass', pass: 5, fail: 0, tests: 5, failing: [], slow: [], durationMs: 1 });
  for (let i = 0; i < 50 && !f.records().length; i += 1) await new Promise((r) => setImmediate(r));
  release();
  assert.ok(b.calls.includes('DELETE /api/suite/jobs/run-1-2'), b.calls.join('\n'));
  assert.ok(!a.calls.some((c) => c.startsWith('DELETE')), a.calls.join('\n'));
  assert.deepStrictEqual(f.records().map((r) => [r.treeHash, r.runner]), [[TREE2, 'runner-b']]);
});

test('t2362: the popover runner row shows the member count and the per-member lines read-only', () => {
  const doc = fakeDocument();
  const info = { ok: true, peer: 'runner-1', hands: 'full', gate: 'on', wire: 'push', members: 2, poolLines: ['runner-1, wire push — offline', 'laptop, wire pull — attached, queue 0'], reach: 'offline', tally: null };
  const wrap = buildRunnerField(doc, info);
  const all = [];
  (function walk(n) { all.push(n); for (const c of n.childNodes) walk(c); })(wrap);
  const pool = all.filter((n) => n.dataset && n.dataset.runner === 'pool');
  assert.strictEqual(pool.length, 1);
  assert.strictEqual(textOf(pool[0]), '2 runners; a gate job goes to the attached one with the most free slots — [agent:team runner add <peer>] and [agent:team runner rm <peer>] edit the pool\nrunner-1, wire push — offline\nlaptop, wire pull — attached, queue 0');
  assert.deepStrictEqual(pool[0].childNodes.map((c) => c.nodeType), [3], 'text only, no control');
  const single = buildRunnerField(doc, { ...info, members: undefined, poolLines: undefined });
  assert.strictEqual(single.childNodes.some((n) => n.dataset && n.dataset.runner === 'pool'), false);
});

test('t2363: team shares round-trip through team.json; a row with an extra key drops the whole setting', () => {
  const input = { peer: 'a', gate: 'on', shares: [{ share: 'assets', version: 'v1' }, { share: 'models.3d', version: '2026.11' }] };
  const want = { peer: 'a', hands: 'off', gate: 'on', shares: [{ share: 'assets', version: 'v1' }, { share: 'models.3d', version: '2026.11' }] };
  assert.deepStrictEqual(normalizeTestRunner(input), want);
  const { tm } = mkHome({ testRunner: input });
  assert.deepStrictEqual(tm.loadManifest('team').testRunner, want);
  assert.strictEqual(normalizeTestRunner({ peer: 'a', shares: [{ share: 'assets', version: 'v1', at: 'assets' }] }), null);
  const { tm: tm2 } = mkHome({ testRunner: { peer: 'a', shares: [{ share: 'assets', version: 'v1', at: 'assets' }] } });
  const { out: team } = quiet(() => tm2.loadManifest('team'));
  assert.deepStrictEqual([team.testRunner, team.droppedFields.map((d) => [d.field, d.status])], [undefined, [['testRunner', 'invalid']]]);
});

const SHARE_ASK = [{ share: 'assets', version: 'v1' }];

test('t2363: pickRunner skips a member without the share for a box job and keeps it for a native one', () => {
  const rows = [
    member('a', load(2, 0, 0, { box: box(DEF.definitionHash) })),
    member('b', load(2, 1, 0, { box: box(DEF.definitionHash), shares: [{ name: 'assets', version: 'v1' }] })),
    member('c', load(2, 0, 0, { box: box(DEF.definitionHash), shares: [{ name: 'assets', version: 'v0' }] })),
  ];
  assert.strictEqual(pickRunner(rows, { box: DEF, shares: SHARE_ASK }).member.peer, 'b');
  assert.strictEqual(pickRunner(rows, { box: false, shares: SHARE_ASK }).member.peer, 'a');
});

test('t2363: boxVerdict passes stamped shares equal to the ask and falls back on a differing version', () => {
  const { boxVerdict } = require('../suite-client');
  const out = (shares) => ({
    unknown: null, res: { treeHash: TREE },
    record: { outcome: 'pass', pass: 5, fail: 0, tests: 5, treeHash: TREE, env: { isolation: 'container', box: { imageId: 'sha256:e', definitionHash: DEF.definitionHash, shares } } },
  });
  assert.deepStrictEqual(boxVerdict(out([{ name: 'assets', version: 'v1' }]), DEF, SHARE_ASK), { fallback: null });
  assert.deepStrictEqual(boxVerdict(out([{ name: 'assets', version: 'v2' }]), DEF, SHARE_ASK), { fallback: 'no share', fallbackCode: 'no-share', fallbackClass: 'deterministic' });
});

test('t2363: a single runner without the share ends unknown before submit, and under gate:on the home suite decides with no share', async () => {
  const def = 'FROM node:24-bookworm\nRUN true\n';
  const hash = require('../team-box').boxFingerprint(def);
  const calls = [];
  const conn = {
    suiteAsk: async (method, p) => {
      calls.push(`${method} ${p.split('?')[0]}`);
      return { status: 200, body: { ok: true, limits: {}, env: { envKey: 'k' }, box: box(hash), shares: [{ name: 'assets', version: 'v0' }] } };
    },
  };
  const { client, records } = clientOver({ p1: conn });
  const direct = await client.run({ peer: 'p1', tree: '/w', kind: 'verify', box: { definitionHash: hash, rev: 1, definition: def }, shares: SHARE_ASK, budgetMs: 60000 });
  assert.strictEqual(direct.unknown, 'runner has no share assets@v1');
  const f = mkFixture({ manifestExtra: { testRunner: { peer: 'runner-1', hands: 'off', gate: 'on', shares: SHARE_ASK } }, peers: [R1], client });
  const team = f.tm.loadManifest('team');
  require('../team-box').writeBox(team.dir, def);
  const ticket = { id: 't1' };
  const decided = await f.m._boxDecide(team, ticket, '/w', {});
  f.m._boxRow(team, ticket, decided, null);
  assert.deepStrictEqual(calls.filter((c) => c.startsWith('POST')), [], 'no job was submitted');
  assert.deepStrictEqual(calls.filter((c) => c === 'GET /api/suite/info').length, 2, 'ENTER: both runs asked info');
  const row = records().pop();
  assert.deepStrictEqual([decided.decided, row.decidedBy, row.fallback], [false, 'home', 'no share']);
});

const { FALLBACK_CODES } = require('../suite-client');
const BOX_TEXT = 'FROM node:24-bookworm\nRUN true\n';
const BOX_HASH = require('../team-box').boxFingerprint(BOX_TEXT);
const said = (text) => ({ verdict: { unknown: text, res: null, record: null } });
const measured = ({ outcome = 'pass', tests = 5, isolation = 'container', shares, resTree = TREE } = {}) => ({ verdict: {
  unknown: null, res: { treeHash: resTree },
  record: { outcome, pass: tests, fail: 0, tests, treeHash: TREE, env: { isolation, box: { imageId: 'sha256:e', definitionHash: DEF.definitionHash, ...(shares ? { shares } : {}) } } },
} });
const PUSH_ON = { peer: 'runner-1', hands: 'off', gate: 'on' };

const FALLBACK_ROWS = [
  ['_boxDecide: no suite client', { decide: 'no client' }, 'runner unreachable', 'runner-unreachable', 'transient'],
  ['_boxDecide: pull runner not attached', { decide: 'pull detached' }, 'runner unreachable', 'runner-unreachable', 'transient'],
  ['_boxDecide: push runner not a known peer', { decide: 'unknown peer' }, 'runner unreachable', 'runner-unreachable', 'transient'],
  ['_boxDecide: no box definition', { decide: 'no box' }, 'no box definition', 'no-box-definition', 'deterministic'],
  ['_boxDecide: guard fired in phase build', { decide: 'late', phase: 'build' }, 'box build', 'box-build-budget', 'budget'],
  ['_boxDecide: guard fired in phase running', { decide: 'late', phase: 'running' }, 'run budget', 'run-budget', 'budget'],
  ['boxVerdict: no outcome', { verdict: null }, 'outcome unknown', 'outcome-unknown', 'unknown'],
  ['runner unreachable: status 0', said('runner unreachable: status 0'), 'runner unreachable', 'runner-unreachable', 'transient'],
  ['no peer p1', said('no peer p1'), 'runner unreachable', 'runner-unreachable', 'transient'],
  ['runner refused the token', said('runner refused the token'), 'runner unreachable', 'runner-unreachable', 'transient'],
  ['queue budget text', said('the job did not start within the 300000ms queue budget (cancelled)'), 'queue budget', 'queue-budget', 'budget'],
  ['client budget text', said('no result within the 2460000ms budget (cancelled)'), 'run budget', 'run-budget', 'budget'],
  ['client run budget text', said('no result within the 600000ms run budget (cancelled)'), 'run budget', 'run-budget', 'budget'],
  ['runner killed the suite', said('the suite did not finish within 1260000ms (killed)'), 'run budget', 'run-budget', 'budget'],
  ['runner restarted', said('runner restarted'), 'runner restart', 'runner-restart', 'transient'],
  ['runner answered for another tree', said('runner answered for tree cccccccc, not aaaaaaaa'), 'tree mismatch', 'tree-mismatch', 'deterministic'],
  ['runner reported a tree mismatch', said('tree mismatch on runner (aaaaaaaa ≠ cccccccc)'), 'tree mismatch', 'tree-mismatch', 'deterministic'],
  ['box mismatch', said('box mismatch: asked container, runner ran native'), 'definition mismatch', 'definition-mismatch', 'deterministic'],
  ['runner has no box', said('runner has no box: not configured'), 'definition mismatch', 'definition-mismatch', 'deterministic'],
  ['runner has no share', said('runner has no share assets@v1'), 'no share', 'no-share', 'deterministic'],
  ['client build budget text', said('the box build did not finish within the 1500000ms build budget (cancelled)'), 'box build', 'box-build-budget', 'budget'],
  ['runner build limit', said('box build on runner: the build did not finish within 1200000 ms (killed): step 3/4'), 'box build', 'box-build-budget', 'budget'],
  ['runner build cancelled', said('box build on runner: the build was cancelled'), 'box build', 'box-build-interrupted', 'transient'],
  ['runner build stopped', said('box build on runner: the build was stopped: lease-expired'), 'box build', 'box-build-interrupted', 'transient'],
  ['runner build failed', said('box build on runner: docker build exited 1: ERROR: boom'), 'box build', 'box-build-failed', 'deterministic'],
  ['runner build refused by its cap', said('box build on runner: 3 box builds in the last 24 h for k; the cap is 3'), 'box build', 'box-build-failed', 'deterministic'],
  ['runner refused the job', said('runner refused the job: nope'), 'outcome unknown', 'outcome-unknown', 'unknown'],
  ['an unplaced runner reason', said('cancelled on runner'), 'outcome unknown', 'outcome-unknown', 'unknown'],
  ['no-summary outcome', measured({ outcome: 'no-summary' }), 'no totals', 'no-totals', 'deterministic'],
  ['timeout outcome without a reason', measured({ outcome: 'timeout' }), 'outcome unknown', 'outcome-unknown', 'unknown'],
  ['zero tests', measured({ tests: 0 }), 'no totals', 'no-totals', 'deterministic'],
  ['native isolation', measured({ isolation: 'native' }), 'definition mismatch', 'definition-mismatch', 'deterministic'],
  ['stamped share differs', measured({ shares: [{ name: 'assets', version: 'v2' }] }), 'no share', 'no-share', 'deterministic'],
  ['result tree differs', measured({ resTree: TREE2 }), 'tree mismatch', 'tree-mismatch', 'deterministic'],
];

async function decideFor(row) {
  let fire = null;
  const timers = { setTimeout: (fn) => { fire = fn; return 1; }, clearTimeout: () => {} };
  const client = row.decide === 'no client' ? {} : {
    run: (o) => { o.onState(row.phase); fire(); return new Promise(() => {}); },
  };
  const f = mkFixture({
    manifestExtra: { testRunner: row.decide === 'pull detached' ? { ...PUSH_ON, wire: 'pull' } : PUSH_ON },
    peers: row.decide === 'unknown peer' ? [] : [R1],
    desk: { attached: () => false },
    client,
    extraDeps: { boxDecideTimers: timers },
  });
  const team = f.tm.loadManifest('team');
  if (row.decide !== 'no box') require('../team-box').writeBox(team.dir, BOX_TEXT);
  return f.m._boxDecide(team, { id: 't1' }, '/w', {});
}

test('t2378: every producing fallback condition yields its literal reason, code and class', async () => {
  assert.strictEqual(FALLBACK_ROWS.length, 34);
  for (const [name, input, reason, code, cls] of FALLBACK_ROWS) {
    if (input.decide) {
      const got = await decideFor(input);
      assert.deepStrictEqual([got.decided, got.fallback, got.fallbackCode, got.fallbackClass], [false, reason, code, cls], name);
    } else {
      const { boxVerdict } = require('../suite-client');
      assert.deepStrictEqual(boxVerdict(input.verdict, DEF, []), { fallback: reason, fallbackCode: code, fallbackClass: cls }, name);
    }
  }
});

test('t2378: every exported code is produced by a row, and every class is one of the four', () => {
  const produced = new Set(FALLBACK_ROWS.map((r) => r[3]));
  assert.deepStrictEqual(Object.keys(FALLBACK_CODES).filter((c) => !produced.has(c)), []);
  assert.ok(Object.keys(FALLBACK_CODES).length > 0, 'ENTER: the table has codes');
  for (const [code, row] of Object.entries(FALLBACK_CODES)) {
    assert.ok(['transient', 'deterministic', 'budget', 'unknown'].includes(row.class), code);
    assert.deepStrictEqual(Object.keys(row).sort(), ['class', 'reason', 'retry'], code);
  }
  for (const [name, , reason, code, cls] of FALLBACK_ROWS) assert.deepStrictEqual(FALLBACK_CODES[code], { reason, class: cls, retry: FALLBACK_RETRY[code] }, name);
});

const FALLBACK_RETRY = {
  'runner-unreachable': true,
  'runner-restart': true,
  'no-box-definition': false,
  'definition-mismatch': false,
  'tree-mismatch': false,
  'no-share': false,
  'no-totals': false,
  'queue-budget': true,
  'run-budget': false,
  'box-build-budget': false,
  'box-build-failed': false,
  'box-build-interrupted': true,
  'outcome-unknown': false,
};

test('t2453: the retry flag of each of the 13 fallback codes is the literal one', () => {
  assert.deepStrictEqual(Object.keys(FALLBACK_RETRY).sort(), Object.keys(FALLBACK_CODES).sort());
  assert.strictEqual(Object.keys(FALLBACK_CODES).length, 13);
  for (const [code, retry] of Object.entries(FALLBACK_RETRY)) assert.strictEqual(FALLBACK_CODES[code].retry, retry, code);
});

test('t2453: the deciding guard grows by the queue minutes past the 5 min default, so a long queue is not read as a run overrun', async () => {
  const seen = [];
  for (const extra of [{}, { queueMs: 2700000 }]) {
    const timers = { setTimeout: (fn, ms) => { seen.push(ms); fn(); return 1; }, clearTimeout: () => {} };
    const f = mkFixture({
      manifestExtra: { testRunner: { ...PUSH_ON, ...extra } }, peers: [R1], client: { run: () => new Promise(() => {}) },
      extraDeps: { boxDecideTimers: timers },
    });
    const team = f.tm.loadManifest('team');
    require('../team-box').writeBox(team.dir, BOX_TEXT);
    await f.m._boxDecide(team, { id: 't1' }, '/w', {});
  }
  assert.strictEqual(seen.length, 2, 'ENTER: both decides armed the guard');
  assert.strictEqual(seen[1] - seen[0], 2400000);
});

test('t2378: a box-decided _boxDecide result carries no fallback code or class, and its compare row has no fallbackCode', async () => {
  const { client, records } = clientOver({});
  const pass = {
    unknown: null, res: { treeHash: TREE },
    record: { outcome: 'pass', pass: 5, fail: 0, tests: 5, treeHash: TREE, env: { isolation: 'container', box: { imageId: 'sha256:e', definitionHash: BOX_HASH } } },
  };
  const f = mkFixture({ manifestExtra: { testRunner: PUSH_ON }, peers: [R1], client: { ...client, run: async () => pass } });
  const team = f.tm.loadManifest('team');
  require('../team-box').writeBox(team.dir, BOX_TEXT);
  const got = await f.m._boxDecide(team, { id: 't1' }, '/w', {});
  assert.strictEqual(got.decided, true, 'ENTER: the box decided');
  assert.deepStrictEqual([got.fallback, 'fallbackCode' in got, 'fallbackClass' in got], [null, false, false]);
  f.m._boxRow(team, { id: 't1' }, got, null);
  const row = records().pop();
  assert.deepStrictEqual([row.decidedBy, row.fallback, 'fallbackCode' in row], ['box', null, false]);
});

test('t2378: a fallen-back _boxDecide compare row carries fallbackCode beside the unchanged reason', async () => {
  const { client, records } = clientOver({});
  const f = mkFixture({ manifestExtra: { testRunner: PUSH_ON }, peers: [R1], client: { ...client, run: async () => ({ unknown: 'runner restarted', res: null, record: null }) } });
  const team = f.tm.loadManifest('team');
  require('../team-box').writeBox(team.dir, BOX_TEXT);
  const got = await f.m._boxDecide(team, { id: 't1' }, '/w', {});
  f.m._boxRow(team, { id: 't1' }, got, null);
  const row = records().pop();
  assert.deepStrictEqual([got.fallbackCode, got.fallbackClass, row.decidedBy, row.fallback, row.fallbackCode], ['runner-restart', 'transient', 'home', 'runner restart', 'runner-restart']);
});

function restartingRunner() {
  const calls = [];
  const conn = {
    suiteAsk: async (method, p) => {
      calls.push(`${method} ${p.split('?')[0]}`);
      if (p.startsWith('/api/suite/info')) return { status: 200, body: { ok: true, limits: {}, env: { envKey: 'k' }, slots: { total: 1, inUse: 1 } } };
      if (method === 'POST') return { status: 409, body: { ok: false, status: 409, error: 'runner is restarting', code: 'runner-restarting' } };
      return { status: 200, body: { ok: true } };
    },
  };
  return { conn, calls };
}

test('t2400: a submit refused by a runner that is restarting is repicked to another runner', async () => {
  const a = restartingRunner();
  const b = remote();
  const { client } = clientOver({ pA: a.conn, pB: b.conn });
  const asked = [];
  const out = await client.run({
    peer: 'pA', name: 'runner-a', tree: '/w', kind: 'verify', team: 'tm', ticket: 't1', budgetMs: 60000,
    repick: async (failed) => { asked.push(failed); return { peer: 'pB', wire: 'push', name: 'runner-b' }; },
  });
  assert.deepStrictEqual(a.calls, ['GET /api/suite/info', 'POST /api/suite/jobs']);
  assert.deepStrictEqual(asked, ['runner-a']);
  assert.deepStrictEqual([out.record.outcome, out.record.where], ['pass', 'runner-b']);
});

test('t2400: with nowhere to repick, the restarting refusal is classed as a transient runner restart', async () => {
  const a = restartingRunner();
  const { client } = clientOver({ pA: a.conn });
  const out = await client.run({ peer: 'pA', name: 'runner-a', tree: '/w', kind: 'verify', team: 'tm', ticket: 't1', budgetMs: 60000 });
  assert.strictEqual(out.record.outcome, 'unknown', 'ENTER: the job never ran');
  assert.deepStrictEqual(boxVerdict({ unknown: out.record.reason }), { fallback: 'runner restart', fallbackCode: 'runner-restart', fallbackClass: 'transient' });
  assert.strictEqual(out.record.reason, 'runner refused the job: runner is restarting');
});

const { LOST_AFTER_MS } = require('../suite-client');
const DOWN = { status: 0, body: null, error: 'socket closed' };
const RED = 'TOTALS: 4 pass, 1 fail, 5 tests\n';
const BOX_ENV = { isolation: 'container', box: { imageId: 'sha256:e', definitionHash: DEF.definitionHash } };
const jobAt = (id, state, over = {}) => ({ status: 200, body: { ok: true, jobs: [{ id, state, treeHash: TREE, exit: { code: 0, signal: null }, reason: null, queueMs: 1, setupMs: 1, runMs: 1, out: {}, ...over }] } });

function lostRig(script, { trees = [TREE] } = {}) {
  let snaps = 0;
  const clock = { t: 0 };
  const calls = [];
  const posts = [];
  const conn = (peer) => ({
    suitePut: async () => (script[peer].put ? script[peer].put() : DOWN),
    suiteAsk: async (method, p, body) => {
      calls.push(`${peer} ${method} ${p.split('?')[0]}${p.includes('wait=0') ? ' wait=0' : ''}`);
      const s = script[peer];
      if (p.startsWith('/api/suite/info')) return { status: 200, body: { ok: true, limits: {}, env: { envKey: 'k' }, shares: [{ name: 'assets', version: 'v1' }], box: { state: 'ready', env: { box: { definitionHash: s.hash || DEF.definitionHash } } } } };
      if (method === 'POST' && p.endsWith('/commit')) return s.commit ? s.commit(clock) : { status: 200, body: { ok: true } };
      if (method === 'POST') { posts.push([peer, body.id, body.treeHash, body.box && body.box.definitionHash, JSON.stringify(body.shares), body.setup, JSON.stringify(body.env)]); return s.post ? s.post() : { status: 200, body: { ok: true, state: 'queued' } }; }
      if (method === 'DELETE') return s.cancel ? s.cancel(clock.t) : { status: 200, body: { ok: true } };
      if (p.includes('/output?')) {
        const text = p.includes('stream=stdout') ? (s.stdout || GREEN) : '';
        return { status: 200, body: { ok: true, text, offset: 0, total: Buffer.byteLength(text) } };
      }
      const id = decodeURIComponent(/ids=([^&]+)/.exec(p)[1]);
      const wait = Number(/wait=(\d+)/.exec(p)[1]);
      const r = s.poll(id, clock.t, wait);
      if (r.body && r.body.jobs && r.body.jobs[0] && r.body.jobs[0].state !== 'done') clock.t += wait;
      return r;
    },
  });
  let n = 0;
  const compareFile = path.join(mkTmpRoot('clodex-pool-lost-'), 'suite-compare.jsonl');
  const records = () => (fs.existsSync(compareFile) ? fs.readFileSync(compareFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const client = createSuiteClient({
    getPeerManager: () => ({ get: (id) => (script[id] ? conn(id) : null) }),
    compareFile,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    randomUUID: () => `run-${(n += 1)}`,
    snapshot: { snapshotTree: async () => ({ treeHash: trees[Math.min((snaps += 1) - 1, trees.length - 1)], head: 'b'.repeat(40), headTree: TREE }), releaseSnapshot: () => {}, buildPack: async () => { fs.writeFileSync(path.join(path.dirname(compareFile), 'pack'), 'x'); return { file: path.join(path.dirname(compareFile), 'pack'), bytes: 1, sha256: 'h' }; } },
  });
  const asked = [];
  const to = (next) => async (lost) => { asked.push([lost, clock.t]); return next; };
  const B = { peer: 'pB', wire: 'push', name: 'runner-b' };
  const base = { peer: 'pA', name: 'runner-a', tree: '/w', kind: 'verify', team: 'tm', ticket: 't1', budgetMs: 36 * 60000, setup: { run: 'npm ci' }, env: { K: '1' } };
  return { client, clock, calls, posts, asked, to, B, base, records };
}

test('t2412: LOST_AFTER_MS is above the runner\'s default lease, so a lost runner has already stopped the job nobody polls', () => {
  const { DEFAULT_LIMITS } = require('../suite-runner');
  assert.deepStrictEqual([LOST_AFTER_MS, DEFAULT_LIMITS.leaseMs], [150000, 120000]);
  assert.ok(LOST_AFTER_MS > DEFAULT_LIMITS.leaseMs);
});

test('t2412: a runner lost after accept is cancelled once and the same snapshot goes to the second member under a new job id, which decides', async () => {
  const r = lostRig({ pA: { poll: () => DOWN }, pB: { poll: (id) => jobAt(id, 'done', { env: BOX_ENV }) } });
  const out = await r.client.run({ ...r.base, box: DEF, shares: SHARE_ASK, reroute: r.to(r.B) });
  assert.deepStrictEqual(r.asked, [['runner-a', 150000]]);
  assert.deepStrictEqual(r.calls.filter((c) => c.includes('DELETE')), ['pA DELETE /api/suite/jobs/run-1']);
  assert.deepStrictEqual(r.posts, [
    ['pA', 'run-1', TREE, DEF.definitionHash, '[{"share":"assets","version":"v1"}]', { run: 'npm ci' }, '{"K":"1"}'],
    ['pB', 'run-1-2', TREE, DEF.definitionHash, '[{"share":"assets","version":"v1"}]', { run: 'npm ci' }, '{"K":"1"}'],
  ]);
  assert.deepStrictEqual([out.record.outcome, out.record.where, out.record.runner, out.res.jobId], ['pass', 'runner-b', 'pB', 'run-1-2']);
  assert.deepStrictEqual(out.attempts, [{ runner: 'runner-a', jobId: 'run-1', outcome: 'lost' }, { runner: 'runner-b', jobId: 'run-1-2', outcome: 'pass' }]);
  assert.deepStrictEqual(out.record.attempts, out.attempts);
  assert.deepStrictEqual(out.rerouted, { from: 'runner-a', to: 'runner-b' });
});

test('t2412: the replacement waits only for what is left of the original deadline', async () => {
  const r = lostRig({
    pA: { poll: (id, t) => (t < 1050000 ? jobAt(id, 'running') : DOWN) },
    pB: { poll: (id) => jobAt(id, 'running') },
  });
  const out = await r.client.run({ ...r.base, budgetMs: 1800000, reroute: r.to(r.B) });
  assert.deepStrictEqual(r.asked, [['runner-a', 1200000]], 'ENTER: lost at 20 minutes');
  assert.deepStrictEqual([out.record.outcome, out.record.reason, out.record.endedAt], ['timeout', 'no result within the 1800000ms budget (cancelled)', '1970-01-01T00:30:00.000Z']);
  assert.deepStrictEqual(r.calls.filter((c) => c.includes('DELETE')), ['pA DELETE /api/suite/jobs/run-1', 'pB DELETE /api/suite/jobs/run-1-2']);
});

test('t2412: a runner lost while the job is queued leaves the replacement the run budget, not the 5 min queue budget', async () => {
  const r = lostRig({
    pA: { poll: (id, t) => (t < 60000 ? jobAt(id, 'queued') : DOWN) },
    pB: { poll: (id, t) => (t < 300000 ? jobAt(id, 'queued') : t < 600000 ? jobAt(id, 'running') : jobAt(id, 'done')) },
  });
  const out = await r.client.run({ ...r.base, queueBudgetMs: 300000, reroute: r.to(r.B) });
  assert.deepStrictEqual(r.asked, [['runner-a', 225000]], 'ENTER: lost while queued');
  assert.deepStrictEqual([out.record.outcome, out.record.where, out.record.endedAt], ['pass', 'runner-b', '1970-01-01T00:10:00.000Z']);
});

const HAND_45 = { kind: 'hand', queueBudgetMs: 2700000, runBudgetMs: 2280000, timeoutMs: 1260000, budgetMs: 4980000 };

const QUEUED_40_ROWS = [
  ['a 45 min queue budget', HAND_45, ['pass', null, '1970-01-01T00:50:00.000Z']],
  ['the 15 min default', { ...HAND_45, queueBudgetMs: 900000, budgetMs: 3180000 }, ['timeout', 'the job did not start within the 900000ms queue budget (cancelled)', '1970-01-01T00:15:00.000Z']],
];

for (const [name, opts, want] of QUEUED_40_ROWS) {
  test(`t2425: a hand job queued 40 min, polled throughout, then run, under ${name}`, async () => {
    const r = lostRig({ pA: { poll: (id, t) => (t < 2400000 ? jobAt(id, 'queued') : t < 3000000 ? jobAt(id, 'running') : jobAt(id, 'done')) } });
    const out = await r.client.run({ ...r.base, ...opts });
    assert.deepStrictEqual([out.record.outcome, out.record.reason, out.record.endedAt], want);
  });
}

test('t2425: with a 45 min queue budget a runner lost after 30 min queued is rerouted and the replacement decides', async () => {
  const r = lostRig({
    pA: { poll: (id, t) => (t < 1800000 ? jobAt(id, 'queued') : DOWN) },
    pB: { poll: (id, t) => (t < 2400000 ? jobAt(id, 'queued') : t < 3000000 ? jobAt(id, 'running') : jobAt(id, 'done')) },
  });
  const out = await r.client.run({ ...r.base, ...HAND_45, reroute: r.to(r.B) });
  assert.deepStrictEqual(r.asked.map(([lost]) => lost), ['runner-a'], 'ENTER: lost while queued past the 15 min default');
  assert.ok(r.asked[0][1] > 900000, `lost after the default queue budget: ${r.asked[0][1]}`);
  assert.deepStrictEqual([out.record.outcome, out.record.where, out.record.endedAt], ['pass', 'runner-b', '1970-01-01T00:50:00.000Z']);
});

test('t2412: a runner lost during the pack upload is rerouted, and the lost job is cancelled once', async () => {
  const r = lostRig({
    pA: { post: () => ({ status: 200, body: { ok: true, state: 'awaiting-pack', have: [] } }), poll: () => DOWN },
    pB: { poll: (id) => jobAt(id, 'done') },
  });
  const out = await r.client.run({ ...r.base, reroute: r.to(r.B) });
  assert.deepStrictEqual(r.asked, [['runner-a', 150000]]);
  assert.deepStrictEqual(r.calls.filter((c) => c.includes('DELETE')), ['pA DELETE /api/suite/jobs/run-1']);
  assert.deepStrictEqual([out.record.outcome, out.record.where, out.res.jobId], ['pass', 'runner-b', 'run-1-2']);
});

test('t2412: a runner lost at the pack commit is rerouted, and the lost job is cancelled once', async () => {
  const r = lostRig({
    pA: { post: () => ({ status: 200, body: { ok: true, state: 'awaiting-pack', have: [] } }), put: () => ({ status: 200, body: { ok: true, size: 1 } }), commit: () => DOWN },
    pB: { poll: (id) => jobAt(id, 'done') },
  });
  const out = await r.client.run({ ...r.base, reroute: r.to(r.B) });
  assert.deepStrictEqual(r.asked, [['runner-a', 150000]]);
  assert.deepStrictEqual(r.calls.filter((c) => c.includes('DELETE')), ['pA DELETE /api/suite/jobs/run-1']);
  assert.deepStrictEqual([out.record.outcome, out.record.where, out.res.jobId], ['pass', 'runner-b', 'run-1-2']);
});

test('t2412: a commit that hangs for its 120 s timeout counts from when it was sent, so it is rerouted at 255 s inside the 5 min queue budget', async () => {
  const r = lostRig({
    pA: { post: () => ({ status: 200, body: { ok: true, state: 'awaiting-pack', have: [] } }), put: () => ({ status: 200, body: { ok: true, size: 1 } }), commit: (clock) => { clock.t += 120000; return DOWN; } },
    pB: { poll: (id) => jobAt(id, 'done') },
  });
  const out = await r.client.run({ ...r.base, queueBudgetMs: 300000, reroute: r.to(r.B) });
  assert.deepStrictEqual(r.asked, [['runner-a', 255000]]);
  assert.deepStrictEqual(r.calls.filter((c) => c.includes('DELETE')), ['pA DELETE /api/suite/jobs/run-1']);
  assert.deepStrictEqual([out.record.outcome, out.record.where, out.res.jobId], ['pass', 'runner-b', 'run-1-2']);
});

test('t2412: the replacement gets its own runner-restart retry after the lost runner used one', async () => {
  const gone = { status: 200, body: { ok: true, jobs: [] } };
  const r = lostRig({
    pA: { poll: (id) => (id === 'run-1' ? gone : DOWN) },
    pB: { poll: (id) => (id === 'run-1-3' ? gone : jobAt(id, 'done')) },
  });
  const out = await r.client.run({ ...r.base, reroute: r.to(r.B) });
  assert.deepStrictEqual(r.posts.map((p) => [p[0], p[1]]), [['pA', 'run-1'], ['pA', 'run-1-2'], ['pB', 'run-1-3'], ['pB', 'run-1-4']]);
  assert.deepStrictEqual([out.record.outcome, out.record.where, out.res.jobId], ['pass', 'runner-b', 'run-1-4']);
});

test('t2412: one answered poll inside the 150 s resets the count and nothing is rerouted', async () => {
  const r = lostRig({
    pA: { poll: (id, t) => (t < 135000 ? DOWN : t === 135000 ? jobAt(id, 'running') : t < 300000 ? DOWN : jobAt(id, 'done')) },
  });
  const out = await r.client.run({ ...r.base, reroute: r.to(r.B) });
  assert.strictEqual(r.clock.t, 310000, 'ENTER: 285 s of failed polls in all');
  assert.deepStrictEqual(r.asked, []);
  assert.deepStrictEqual([out.record.outcome, out.record.where, 'attempts' in out], ['pass', 'runner-a', false]);
});

test('t2412: a second loss on the replacement ends runner unreachable with no third submit', async () => {
  const r = lostRig({ pA: { poll: () => DOWN }, pB: { poll: () => DOWN } });
  const out = await r.client.run({ ...r.base, reroute: r.to(r.B) });
  assert.deepStrictEqual(r.asked, [['runner-a', 150000]]);
  assert.deepStrictEqual(r.posts.map((p) => [p[0], p[1]]), [['pA', 'run-1'], ['pB', 'run-1-2']]);
  assert.deepStrictEqual([out.record.outcome, out.record.reason, out.record.endedAt], ['unknown', 'runner unreachable', '1970-01-01T00:05:00.000Z']);
  assert.deepStrictEqual(out.attempts, [{ runner: 'runner-a', jobId: 'run-1', outcome: 'lost' }, { runner: 'runner-b', jobId: 'run-1-2', outcome: 'lost' }]);
});

test('t2412: with no other member the run ends runner unreachable at 150 s, transient, with no second submit', async () => {
  const r = lostRig({ pA: { poll: () => DOWN } });
  const out = await r.client.run({ ...r.base, reroute: r.to(null) });
  assert.deepStrictEqual(r.asked, [['runner-a', 150000]]);
  assert.deepStrictEqual(r.posts.map((p) => p[1]), ['run-1']);
  assert.deepStrictEqual([out.record.outcome, out.record.reason, out.record.endedAt, 'attempts' in out], ['unknown', 'runner unreachable', '1970-01-01T00:02:30.000Z', false]);
  assert.deepStrictEqual(boxVerdict(out), { fallback: 'runner unreachable', fallbackCode: 'runner-unreachable', fallbackClass: 'transient' });
});

const NEVER_REROUTE = [
  ['red', { poll: (id) => jobAt(id, 'done', { exit: { code: 1, signal: null } }), stdout: RED }, {}, 'fail', null],
  ['no-totals', { poll: (id) => jobAt(id, 'done'), stdout: 'no summary here\n' }, {}, 'no-summary', null],
  ['tree-mismatch', { poll: (id) => jobAt(id, 'done', { treeHash: TREE2 }) }, {}, 'unknown', 'runner answered for tree cccccccc, not aaaaaaaa'],
  ['run budget', { poll: (id) => jobAt(id, 'running') }, { runBudgetMs: 60000 }, 'timeout', 'no result within the 60000ms run budget (cancelled)'],
  ['queue budget', { poll: (id) => jobAt(id, 'queued') }, { queueBudgetMs: 60000 }, 'timeout', 'the job did not start within the 60000ms queue budget (cancelled)'],
  ['runner-restart', { poll: () => ({ status: 200, body: { ok: true, jobs: [] } }) }, {}, 'unknown', 'runner restarted'],
];

for (const [name, runner, extra, outcome, reason] of NEVER_REROUTE) {
  test(`t2412: ${name} never reaches reroute`, async () => {
    const r = lostRig({ pA: runner });
    const out = await r.client.run({ ...r.base, ...extra, reroute: r.to(r.B) });
    assert.deepStrictEqual(r.asked, []);
    assert.deepStrictEqual([out.record.outcome, out.record.reason, out.record.where], [outcome, reason, 'runner-a']);
  });
}

test('t2412: a late red from the abandoned job is recorded as late-fail and the replacement\'s pass decides', async () => {
  let polls = 0;
  const r = lostRig({
    pA: { poll: (id, t, wait) => (wait === 0 ? jobAt(id, 'done', { exit: { code: 1, signal: null } }) : DOWN) },
    pB: { poll: (id) => ((polls += 1) === 1 ? jobAt(id, 'running') : jobAt(id, 'done')) },
  });
  const out = await r.client.run({ ...r.base, reroute: r.to(r.B) });
  assert.ok(r.calls.includes('pA GET /api/suite/jobs wait=0'), 'ENTER: the abandoned job was asked for');
  assert.deepStrictEqual([out.record.outcome, out.res.jobId], ['pass', 'run-1-2']);
  assert.deepStrictEqual(out.attempts, [{ runner: 'runner-a', jobId: 'run-1', outcome: 'late-fail' }, { runner: 'runner-b', jobId: 'run-1-2', outcome: 'pass' }]);
});

test('t2412: a cancel of the lost job that rejects does not stop the reroute', async () => {
  const r = lostRig({ pA: { poll: () => DOWN, cancel: () => Promise.reject(new Error('socket hang up')) }, pB: { poll: (id) => jobAt(id, 'done') } });
  const out = await r.client.run({ ...r.base, reroute: r.to(r.B) });
  assert.ok(r.calls.includes('pA DELETE /api/suite/jobs/run-1'), 'ENTER: the cancel was tried');
  assert.deepStrictEqual([out.record.outcome, out.record.where], ['pass', 'runner-b']);
});

test('t2414: a shadow run rerouted off a lost runner forgets the lost job id, so a superseding shadow cancels nothing on the new runner', async () => {
  let release;
  const held = new Promise((res) => { release = res; });
  const r = lostRig({ pA: { poll: () => DOWN, cancel: () => held }, pB: { poll: (id) => jobAt(id, 'done') } }, { trees: [TREE, TREE2] });
  const turn = () => new Promise((res) => setImmediate(res));
  const first = await r.client.shadow({ ...r.base, pool: true, reroute: r.to(r.B) });
  for (let i = 0; i < 50 && !r.calls.includes('pA DELETE /api/suite/jobs/run-1'); i += 1) await turn();
  assert.deepStrictEqual(r.asked, [['runner-a', 150000]], 'ENTER: the shadow run was rerouted and is cancelling the lost job');
  const second = await r.client.shadow({ ...r.base, peer: 'pB', name: 'runner-b' });
  assert.ok(second, 'ENTER: the second shadow run was taken');
  for (let i = 0; i < 5; i += 1) await turn();
  release({ status: 200, body: { ok: true } });
  for (let i = 0; i < 20; i += 1) await turn();
  assert.ok(!r.calls.includes('pB DELETE /api/suite/jobs/run-1'), r.calls.join('\n'));
  first.local({ outcome: 'pass', pass: 5, fail: 0, tests: 5, failing: [], slow: [], durationMs: 1 });
  second.local({ outcome: 'pass', pass: 5, fail: 0, tests: 5, failing: [], slow: [], durationMs: 1 });
});

const RA = { id: 'pA', label: 'runner-1', online: true, caps: ['peer', 'suite'] };
const RB = { id: 'pB', label: 'runner-2', online: true, caps: ['peer', 'suite'] };
const POOL_ON = { peer: 'runner-1', hands: 'off', gate: 'on', pool: [{ peer: 'runner-2' }] };

function poolDecide(script, { busy = [] } = {}) {
  const r = lostRig(Object.fromEntries(Object.entries(script).map(([k, v]) => [k, { hash: BOX_HASH, ...v }])));
  const runs = [];
  const reachable = async (peer, ...rest) => {
    const got = await r.client.reachable(peer, ...rest);
    return busy.includes(peer) && got.ok ? { ...got, info: { ...got.info, slots: { total: 1, inUse: 1 } } } : got;
  };
  const client = { ...r.client, reachable, run: (o) => { const p = r.client.run(o); runs.push(p); return p; } };
  const f = mkFixture({ manifestExtra: { testRunner: POOL_ON }, peers: [RA, RB], client, extraDeps: { boxDecideTimers: { setTimeout: () => 1, clearTimeout: () => {} } } });
  const team = f.tm.loadManifest('team');
  require('../team-box').writeBox(team.dir, BOX_TEXT);
  return { ...r, f, team, runs };
}

const BOX_DONE = (id) => jobAt(id, 'done', { env: { isolation: 'container', box: { imageId: 'sha256:e', definitionHash: BOX_HASH } } });

test('t2412: a flight stop between the old cancel and the new submit prevents the submit and ends cancelled', async () => {
  let rig;
  rig = poolDecide({
    pA: { poll: () => DOWN, cancel: () => { rig.f.m._boxFlights.get(`${rig.team.root}\0t1`).stop('superseded'); return { status: 200, body: { ok: true } }; } },
    pB: { poll: BOX_DONE },
  });
  const got = await rig.f.m._boxDecide(rig.team, { id: 't1' }, '/w', {});
  const out = await rig.runs[0];
  assert.strictEqual(got.cancelled, 'superseded');
  assert.deepStrictEqual(rig.posts.map((p) => p[0]), ['pA']);
  assert.deepStrictEqual([out.record.reason, out.record.where], ['cancelled by the caller before submit', 'runner-2']);
  assert.deepStrictEqual(rig.calls.filter((c) => c.includes('DELETE')), ['pA DELETE /api/suite/jobs/run-1']);
});

test('t2412: two tickets losing the same runner each reroute on their own and neither picks the lost member', async () => {
  const rig = poolDecide({ pA: { poll: () => DOWN }, pB: { poll: BOX_DONE } }, { busy: ['pB'] });
  const [one, two] = await Promise.all([
    rig.f.m._boxDecide(rig.team, { id: 't1' }, '/w', {}),
    rig.f.m._boxDecide(rig.team, { id: 't2' }, '/w', {}),
  ]);
  assert.deepStrictEqual(rig.posts.map((p) => [p[0], p[1]]).sort(), [['pA', 'run-1'], ['pA', 'run-2'], ['pB', 'run-1-2'], ['pB', 'run-2-2']]);
  for (const got of [one, two]) {
    assert.deepStrictEqual([got.decided, got.runner, got.out.rerouted], [true, 'runner-2', { from: 'runner-1', to: 'runner-2' }]);
    assert.deepStrictEqual(got.out.attempts.map((a) => [a.runner, a.outcome]), [['runner-1', 'lost'], ['runner-2', 'pass']]);
  }
  rig.f.m._boxRow(rig.team, { id: 't1' }, one, null);
  assert.deepStrictEqual(rig.records().map((x) => [x.decidedBy, x.runner, x.attempts.map((a) => a.outcome)]), [['box', 'runner-2', ['lost', 'pass']]]);
});

const RUN_LIMIT_ROWS = [
  ['no runMs', {}, {}, 2460000],
  ['runMs 30 min', { runMs: 1800000 }, { timeoutMs: 1800000 }, 2460000 + 540000],
  ['runMs 10 min', { runMs: 600000 }, { timeoutMs: 600000 }, 2460000],
];

for (const [name, extra, wantTimeout, wantBudget] of RUN_LIMIT_ROWS) {
  test(`t2418: a shadow submit with ${name} sends ${wantTimeout.timeoutMs || 'no'} timeoutMs and a ${wantBudget}ms budget; handEnv stays off the gate`, async () => {
    const sent = [];
    const client = { reachable: async () => ({ ok: true, info: {} }), shadow: async (o) => { sent.push(o); return null; } };
    const f = mkFixture({ manifestExtra: { testRunner: { peer: 'runner-1', gate: 'shadow', env: { A: '1' }, handEnv: { H: '1' }, ...extra } }, peers: [R1], client });
    await f.m._shadowSubmit(f.tm.loadManifest('team'), { id: 't1' }, '/w', {});
    assert.strictEqual(sent.length, 1, 'ENTER: the shadow job was submitted');
    assert.deepStrictEqual([sent[0].budgetMs, 'timeoutMs' in sent[0] ? { timeoutMs: sent[0].timeoutMs } : {}, sent[0].env], [wantBudget, wantTimeout, { A: '1' }]);
  });

  test(`t2418: a box decide with ${name} sends ${wantTimeout.timeoutMs || 'no'} timeoutMs, a ${wantBudget}ms budget and moves the guard with it`, async () => {
    const sent = [];
    const guards = [];
    const timers = { setTimeout: (fn, ms) => { guards.push(ms); return 1; }, clearTimeout: () => {} };
    const client = { run: async (o) => { sent.push(o); return { unknown: 'runner unreachable', res: null, record: null }; } };
    const f = mkFixture({ manifestExtra: { testRunner: { ...PUSH_ON, env: { A: '1' }, handEnv: { H: '1' }, ...extra } }, peers: [R1], client, extraDeps: { boxDecideTimers: timers } });
    const team = f.tm.loadManifest('team');
    require('../team-box').writeBox(team.dir, BOX_TEXT);
    await f.m._boxDecide(team, { id: 't1' }, '/w', {});
    assert.strictEqual(sent.length, 1, 'ENTER: the box job was submitted');
    assert.deepStrictEqual([sent[0].budgetMs, 'timeoutMs' in sent[0] ? { timeoutMs: sent[0].timeoutMs } : {}, sent[0].env], [wantBudget, wantTimeout, { A: '1' }]);
    assert.deepStrictEqual(guards, [wantBudget + 2 * 60 * 1000 + 5 * 60 * 1000 + 25 * 60 * 1000]);
  });
}

const { createChannelHost, pickLine, poolNote } = require('../suite-client');
const { baseRunnerLoad, basePickRunner } = require('./lib/base-suite-pick');

const POOL_OF_TWO = { testRunner: { peer: 'runner-1', hands: 'all', pool: [{ peer: 'runner-2' }] } };
const IDLE_ONE = (extra = {}) => ({ ok: true, limits: {}, env: { envKey: 'k' }, slots: { total: 1, inUse: 0 }, queue: { running: null, queued: [] }, ...extra });
const QUIET_LOG = (lines) => ({ info: (tag, m) => lines.push([tag, m]), warn: () => {}, error: () => {}, debug: () => {} });

function infoConn(info, calls = []) {
  return { suiteAsk: async (method, p) => { calls.push(`${method} ${p.split('?')[0]}`); return { status: 200, body: info() }; } };
}

function pickRig(conns, extra = {}) {
  const lines = [];
  let n = 0;
  const ledgerFile = path.join(mkTmpRoot('clodex-pool-pick-'), 'suite-runs.jsonl');
  const client = createSuiteClient({
    getPeerManager: () => ({ get: (id) => conns[id] || null }), ledgerFile, now: () => 1000, sleep: async () => {},
    randomUUID: () => `job${(n += 1)}-0000-0000`, snapshot: { snapshotTree: async () => ({ treeHash: TREE, head: 'b'.repeat(40), headTree: TREE }), releaseSnapshot: () => {} },
  });
  const f = mkFixture({ manifestExtra: POOL_OF_TWO, peers: [R1, R2], client, extraDeps: { log: QUIET_LOG(lines), ...extra } });
  const ends = () => (fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.phase === 'end') : []);
  return { f, client, lines, ends, tr: () => f.tm.loadManifest('team').testRunner };
}

test('t2439: three hand picks in one tick against two idle single-slot members whose info never changes go runner-1, runner-2, runner-1', async () => {
  const r = pickRig({ p1: infoConn(() => IDLE_ONE()), p2: infoConn(() => IDLE_ONE()) });
  const tr = r.tr();
  const picks = await Promise.all([r.f.m._handRunners(tr), r.f.m._handRunners(tr), r.f.m._handRunners(tr)]);
  assert.deepStrictEqual(picks.map((p) => p.chosen), ['runner-1', 'runner-2', 'runner-1']);
});

test('t2439: an old runner that sends no pending still spreads: a job submitted to runner-1 and not in its queue counts there', async () => {
  let release;
  const held = new Promise((res) => { release = res; });
  const calls = [];
  const conns = {
    p1: { suiteAsk: async (method, p) => {
      calls.push(`${method} ${p.split('?')[0]}`);
      if (p.startsWith('/api/suite/info')) return { status: 200, body: IDLE_ONE() };
      if (method === 'POST') return { status: 200, body: { ok: true, state: 'queued' } };
      await held;
      return { status: 200, body: { ok: true, jobs: [{ id: 'job1-0000-0000', state: 'done', treeHash: TREE, exit: { code: 0, signal: null }, reason: null, queueMs: 1, setupMs: 1, runMs: 1, out: {} }] } };
    } },
    p2: infoConn(() => IDLE_ONE()),
  };
  const r = pickRig(conns);
  const first = await r.f.m._handRunners(r.tr());
  assert.deepStrictEqual([first.chosen, first.runId], ['runner-1', 'job1-0000-0000']);
  const run = r.client.run({ peer: 'p1', name: 'runner-1', runId: first.runId, tree: '/w', kind: 'hand', team: 'team', budgetMs: 60000 });
  for (let i = 0; i < 50 && !calls.includes('POST /api/suite/jobs'); i += 1) await new Promise((res) => setImmediate(res));
  assert.ok(calls.includes('POST /api/suite/jobs'), 'ENTER: the first job was accepted by runner-1');
  assert.strictEqual(r.client.sentTo('runner-1', IDLE_ONE()), 1);
  const second = await r.f.m._handRunners(r.tr());
  assert.strictEqual(second.chosen, 'runner-2');
  release();
  await run;
});

test('t2439: a sent job is counted once — not again when info lists it queued, or when the runner counts it in pending', async () => {
  let release;
  const held = new Promise((res) => { release = res; });
  const conn = { suiteAsk: async (method, p) => {
    if (p.startsWith('/api/suite/info')) return { status: 200, body: IDLE_ONE() };
    if (method === 'POST') return { status: 200, body: { ok: true, state: 'queued' } };
    await held;
    return { status: 200, body: { ok: true, jobs: [{ id: 'job1-0000-0000', state: 'done', treeHash: TREE, exit: { code: 0, signal: null }, reason: null, queueMs: 1, setupMs: 1, runMs: 1, out: {} }] } };
  } };
  const r = pickRig({ p1: conn });
  const id = r.client.claim('runner-1');
  assert.strictEqual(r.client.sentTo('runner-1', IDLE_ONE({ pending: 0 })), 1, 'a claim the runner has not seen counts even beside pending');
  const run = r.client.run({ peer: 'p1', name: 'runner-1', runId: id, tree: '/w', kind: 'hand', team: 'team', budgetMs: 60000 });
  for (let i = 0; i < 50 && r.client.sentTo('runner-1', IDLE_ONE({ pending: 1 })) !== 0; i += 1) await new Promise((res) => setImmediate(res));
  assert.deepStrictEqual([
    r.client.sentTo('runner-1', IDLE_ONE()),
    r.client.sentTo('runner-1', IDLE_ONE({ queue: { running: null, queued: ['job1-0000-0000'] } })),
    r.client.sentTo('runner-1', IDLE_ONE({ pending: 1 })),
    r.client.sentTo('runner-2', IDLE_ONE()),
  ], [1, 0, 0, 0]);
  release();
  await run;
  assert.strictEqual(r.client.sentTo('runner-1', IDLE_ONE()), 0, 'an ended run counts nowhere');
});

test('t2439: pickRunner folds pending into the slots, then the queue', () => {
  const got = pickRunner([member('a', load(1, 0, 0, { pending: 1 })), member('b', load(1, 0, 0))], { box: false });
  assert.deepStrictEqual([got.index, got.ranks.map((x) => [x.member, x.load])], [1, [
    ['a', { total: 1, inUse: 1, free: 0, queue: 0, pending: 1 }],
    ['b', { total: 1, inUse: 0, free: 1, queue: 0, pending: 0 }],
  ]]);
  assert.deepStrictEqual(pickRunner([member('a', load(1, 1, 0, { pending: 2 }))], { box: false }).load, { total: 1, inUse: 1, free: 0, queue: 2, pending: 2 });
});

test('t2439: a released source ignores info.pending — the base load and pick read the same with and without it', () => {
  const members = (extra) => [member('a', load(1, 0, 0, extra)), member('b', load(2, 1, 0))];
  assert.deepStrictEqual(baseRunnerLoad(load(1, 0, 0, { pending: 3 })), baseRunnerLoad(load(1, 0, 0)));
  assert.deepStrictEqual(basePickRunner(members({ pending: 3 }), { box: false }).index, basePickRunner(members({}), { box: false }).index);
  assert.strictEqual(basePickRunner(members({ pending: 3 }), { box: false }).index, 0, 'ENTER: the base still picks the member reporting pending');
});

test('t2439: a member whose info call rejects is skipped as no answer in the log line, the run row and the hand reply', async () => {
  const calls = [];
  const conns = {
    p1: { suiteAsk: async (method, p) => {
      calls.push(`${method} ${p.split('?')[0]}`);
      if (p.startsWith('/api/suite/info')) return { status: 200, body: IDLE_ONE() };
      if (method === 'POST') return { status: 200, body: { ok: true, state: 'queued' } };
      if (p.includes('/output?')) {
        const text = p.includes('stream=stdout') ? GREEN : '';
        return { status: 200, body: { ok: true, text, offset: 0, total: Buffer.byteLength(text) } };
      }
      const id = decodeURIComponent(/ids=([^&]+)/.exec(p)[1]);
      return { status: 200, body: { ok: true, jobs: [{ id, state: 'done', treeHash: TREE, exit: { code: 0, signal: null }, reason: null, queueMs: 1, setupMs: 1, runMs: 1, out: {} }] } };
    } },
    p2: { suiteAsk: async () => { throw new Error('socket hang up'); } },
  };
  const r = pickRig(conns);
  const dir = fs.realpathSync(mkTmpRoot('clodex-pool-tree-'));
  const team = { ...r.f.tm.loadManifest('team'), root: dir };
  let settle;
  const done = new Promise((res) => { settle = res; });
  const host = createChannelHost({
    client: r.client, team, seat: 'hand-1',
    listWorktrees: async () => ({ ok: true, worktrees: [{ path: dir }] }),
    resolvePeer: (n) => r.f.m._runnerVia(r.f.m._runnerMembers(team.testRunner).find((x) => x.peer === n)).via,
    pool: (box) => r.f.m._handRunners(team.testRunner, box),
    send: (m) => { if (m.run) settle(m); },
    snapshot: { snapshotTree: async () => ({ treeHash: TREE }), releaseSnapshot: () => {} },
  });
  host.onMessage({ op: 'suite', measure: dir, scope: 'full', files: [], flags: {}, local: false });
  const reply = await done;
  const picks = r.lines.filter(([tag]) => tag === 'suite-client');
  assert.deepStrictEqual(picks, [['suite-client', 'pool pick for job job1-000: chosen runner-1; runner-1 slots 0/1, pending 0, queue 0, box tier 0, exclusive rank 0; runner-2 skipped: no answer']]);
  assert.deepStrictEqual(r.ends().map((x) => [x.where, x.outcome, x.pick]), [['runner-1', 'pass', { chosen: 'runner-1', skipped: [{ member: 'runner-2', reason: 'no answer' }] }]]);
  assert.deepStrictEqual([reply.runner, reply.unknown, reply.note], ['runner-1', null, '(pool: skipped runner-2: no answer)']);
});

test('t2439: the pool note names at most two skipped members, then +N, and a pick record omits an empty skipped list', () => {
  assert.strictEqual(poolNote({ chosen: 'a', skipped: [{ member: 'b', reason: 'no answer' }, { member: 'c', reason: 'refused' }, { member: 'd', reason: 'not connected' }] }),
    '(pool: skipped b: no answer, c: refused +1)');
  assert.strictEqual(poolNote({ chosen: 'a' }), null);
  const pick = pickRunner([member('a', load(1, 0, 0)), member('b', null, false), { ...member('c', null), why: 'refused' }, member('d', load(1, 0, 0, { box: { state: 'unavailable' } }))], { box: true });
  assert.strictEqual(pickLine('0123456789', pick), 'pool pick for job 01234567: chosen none; a skipped: no box for this job; b skipped: not connected; c skipped: refused; d skipped: no box for this job');
});

test('t2439: runner rm with one queued hand job cancels exactly that job, tells its hand to resubmit, and leaves another member\'s job alone', async () => {
  const waits = {};
  const calls = { p1: [], p2: [] };
  const conn = (peer) => ({ suiteAsk: async (method, p) => {
    calls[peer].push(`${method} ${p.split('?')[0]}`);
    if (p.startsWith('/api/suite/info')) return { status: 200, body: IDLE_ONE() };
    if (method === 'POST') return { status: 200, body: { ok: true, state: 'queued' } };
    if (method === 'DELETE') {
      const id = decodeURIComponent(p.split('/').pop());
      if (waits[id]) waits[id]();
      return { status: 200, body: { ok: true } };
    }
    const id = decodeURIComponent(/ids=([^&]+)/.exec(p)[1]);
    await new Promise((res) => { waits[id] = res; });
    return { status: 200, body: { ok: true, jobs: [{ id, state: 'done', treeHash: TREE, exit: null, reason: 'cancelled', queueMs: 1, setupMs: null, runMs: null, out: {} }] } };
  } });
  const r = pickRig({ p1: conn('p1'), p2: conn('p2') });
  const kept = r.client.run({ peer: 'p1', name: 'runner-1', tree: '/w', kind: 'hand', team: 'team', budgetMs: 60000 });
  const gone = r.client.run({ peer: 'p2', name: 'runner-2', tree: '/w', kind: 'hand', team: 'team', budgetMs: 60000 });
  for (let i = 0; i < 100 && !(waits['job1-0000-0000'] && waits['job2-0000-0000']); i += 1) await new Promise((res) => setImmediate(res));
  assert.ok(waits['job1-0000-0000'] && waits['job2-0000-0000'], 'ENTER: both jobs are queued and polled');
  assert.deepStrictEqual(await r.f.verb('[agent:team runner rm runner-2]'), ['[agent:team] test runner runner-2 removed from team — 1 left; stopped 1 job bound to it']);
  const out = await gone;
  assert.deepStrictEqual([out.unknown, out.record.where], ['runner removed from the pool: resubmit', 'runner-2']);
  assert.deepStrictEqual(calls.p2.filter((c) => c.startsWith('DELETE')), ['DELETE /api/suite/jobs/job2-0000-0000']);
  assert.deepStrictEqual(calls.p1.filter((c) => c.startsWith('DELETE')), []);
  waits['job1-0000-0000']();
  await kept;
});

const BUSY_WITH = (queued, extra = {}) => ({ ok: true, limits: {}, env: { envKey: 'k' }, slots: { total: 1, inUse: 1 }, queue: { running: 'long-job', queued }, ...extra });
const READY_BOX = { box: { state: 'ready', env: { box: { imageId: 'sha256:e', definitionHash: DEF.definitionHash } } } };

function moveRig({ info = {}, poll = {}, del = {}, post = {}, manifestExtra = POOL_OF_TWO } = {}) {
  const clock = { t: 0 };
  const events = [];
  const ledgerFile = path.join(mkTmpRoot('clodex-pool-move-'), 'suite-runs.jsonl');
  const conn = (peer) => ({ suiteAsk: async (method, p, body) => {
    if (p.startsWith('/api/suite/info')) {
      if (p.includes('?')) events.push(`${clock.t} ${peer} pick-info`);
      return { status: 200, body: info[peer](clock.t) };
    }
    if (method === 'POST') {
      events.push(`${clock.t} ${peer} POST ${body.id}`);
      return post[peer] ? post[peer]() : { status: 200, body: { ok: true, state: 'queued' } };
    }
    if (method === 'DELETE') {
      events.push(`${clock.t} ${peer} DELETE ${decodeURIComponent(p.split('/').pop())}`);
      const r = del[peer] ? await del[peer]() : { status: 200, body: { ok: true } };
      events.push(`${clock.t} ${peer} DELETE answered`);
      return r;
    }
    if (p.includes('/output?')) {
      const text = p.includes('stream=stdout') ? GREEN : '';
      return { status: 200, body: { ok: true, text, offset: 0, total: Buffer.byteLength(text) } };
    }
    const id = decodeURIComponent(/ids=([^&]+)/.exec(p)[1]);
    const wait = Number(/wait=(\d+)/.exec(p)[1]);
    const r = poll[peer](id, clock.t);
    if (r.body.jobs[0].state !== 'done') clock.t += wait;
    return r;
  } });
  const conns = { p1: conn('p1'), p2: conn('p2') };
  let n = 0;
  const client = createSuiteClient({
    getPeerManager: () => ({ get: (id) => conns[id] || null }), ledgerFile, now: () => clock.t, sleep: async (ms) => { clock.t += ms; },
    randomUUID: () => `run-${(n += 1)}`,
    snapshot: { snapshotTree: async () => ({ treeHash: TREE, head: 'b'.repeat(40), headTree: TREE }), releaseSnapshot: () => {} },
  });
  const f = mkFixture({ manifestExtra, peers: [R1, R2], client });
  const tr = () => f.tm.loadManifest('team').testRunner;
  const asked = [];
  const requeue = (box = false) => {
    const real = f.m._runnerMove(tr(), box);
    return async (where, id) => { asked.push([where, clock.t]); return real(where, id); };
  };
  const base = { peer: 'p1', name: 'runner-1', tree: '/w', kind: 'hand', team: 'team', queueBudgetMs: 300000, runBudgetMs: 600000, budgetMs: 900000 };
  const posts = () => events.filter((e) => / POST /.test(e));
  return { client, clock, events, posts, asked, requeue, base, f, tr };
}

const QUEUED_ON_1 = (id) => jobAt(id, 'queued');
const RAN_ON_2 = (id, t) => (t < 120000 ? jobAt(id, 'running') : jobAt(id, 'done'));
const BOX_RAN_ON_2 = (id, t) => (t < 120000 ? jobAt(id, 'running', { env: BOX_ENV }) : jobAt(id, 'done', { env: BOX_ENV }));
const EXCLUSIVE_POOL = { testRunner: { ...POOL_OF_TWO.testRunner, exclusive: true } };

const MOVE_ROWS = [
  ['the other member idle', {}, false, () => IDLE_ONE(), true],
  ['the other member busy', {}, false, () => BUSY_WITH([]), false],
  ['the other member with a free slot and a job pending', {}, false, () => IDLE_ONE({ slots: { total: 2, inUse: 0 }, pending: 1 }), false],
  ['the other member idle but with no box ready (would build)', {}, true, () => IDLE_ONE({ box: { state: 'can-build', definitionHash: DEF.definitionHash } }), false],
  ['an exclusive job, the other member honours exclusive but has no box ready (would build)', EXCLUSIVE_POOL, true, () => IDLE_ONE({ exclusive: 'honour', box: { state: 'can-build', definitionHash: DEF.definitionHash } }), false],
  ['the other member idle with the box ready', {}, true, () => IDLE_ONE(READY_BOX), true],
  ['an exclusive job, the other member ignores exclusive', EXCLUSIVE_POOL, false, () => IDLE_ONE({ exclusive: 'ignore' }), false],
  ['an exclusive job, runner-1 too old to say, the other member ignores exclusive', EXCLUSIVE_POOL, false, () => IDLE_ONE({ exclusive: 'ignore' }), false, {}],
  ['an exclusive job, the other member honours exclusive', EXCLUSIVE_POOL, false, () => IDLE_ONE({ exclusive: 'honour' }), true],
  ['an exclusive job, the other member honours exclusive with one of two slots in use', EXCLUSIVE_POOL, false, () => IDLE_ONE({ exclusive: 'honour', slots: { total: 2, inUse: 1 } }), false],
];

for (const [name, manifestExtra, boxed, other, moves, mine = { exclusive: 'honour' }] of MOVE_ROWS) {
  test(`t2440: a hand job queued behind a long job on runner-1, ${name}: ${moves ? 'moved at the first 60 s check' : 'not moved'}`, async () => {
    const r = moveRig({
      manifestExtra: Object.keys(manifestExtra).length ? manifestExtra : POOL_OF_TWO,
      info: { p1: () => BUSY_WITH(['run-1'], { ...mine, ...(boxed ? READY_BOX : {}) }), p2: other },
      poll: { p1: QUEUED_ON_1, p2: boxed ? BOX_RAN_ON_2 : RAN_ON_2 },
    });
    const out = await r.client.run({ ...r.base, ...(boxed ? { box: DEF } : {}), requeue: r.requeue(boxed ? DEF : false) });
    assert.deepStrictEqual(r.asked[0], ['runner-1', 60000], 'ENTER: the pick was re-evaluated at 60 s');
    if (moves) {
      assert.deepStrictEqual(r.posts(), ['0 p1 POST run-1', '60000 p2 POST run-1-2']);
      assert.deepStrictEqual([out.record.outcome, out.record.where, out.record.endedAt], ['pass', 'runner-2', '1970-01-01T00:02:15.000Z']);
      assert.deepStrictEqual(out.record.moved, [{ from: 'runner-1', to: 'runner-2', at: '1970-01-01T00:01:00.000Z' }]);
    } else {
      assert.deepStrictEqual(r.posts(), ['0 p1 POST run-1']);
      assert.deepStrictEqual(r.asked.map(([, t]) => t), [60000, 120000, 180000, 240000]);
      assert.deepStrictEqual([out.record.outcome, out.record.where, out.record.endedAt, 'moved' in out.record], ['timeout', 'runner-1', '1970-01-01T00:05:00.000Z', false]);
    }
  });
}

const VIA_1 = { peer: 'p1', wire: 'push', name: 'runner-1' };
const VIA_2 = { peer: 'p2', wire: 'push', name: 'runner-2' };
const spyMove = (r, pick) => async (where) => { r.asked.push([where, r.clock.t]); return pick(where); };
const OTHER = (where) => (where === 'runner-1' ? VIA_2 : VIA_1);

test('t2440: a job that has started is never moved, and a job whose box build is in progress is not moved while it builds', async () => {
  const started = moveRig({ info: { p1: () => BUSY_WITH([]), p2: () => IDLE_ONE() }, poll: { p1: (id, t) => (t < 30000 ? jobAt(id, 'queued') : t < 400000 ? jobAt(id, 'running') : jobAt(id, 'done')) } });
  const ran = await started.client.run({ ...started.base, requeue: spyMove(started, OTHER) });
  assert.deepStrictEqual([ran.record.outcome, ran.record.where, started.asked, started.posts()], ['pass', 'runner-1', [], ['0 p1 POST run-1']]);
  const building = moveRig({ info: { p1: () => BUSY_WITH([]), p2: () => IDLE_ONE() }, poll: { p1: (id, t) => (t < 30000 ? jobAt(id, 'queued') : t < 200000 ? jobAt(id, 'build') : t < 400000 ? jobAt(id, 'running') : jobAt(id, 'done')) } });
  const built = await building.client.run({ ...building.base, requeue: spyMove(building, OTHER) });
  assert.deepStrictEqual([built.record.outcome, built.record.where, building.asked, building.posts()], ['pass', 'runner-1', [], ['0 p1 POST run-1']]);
});

test('t2440: a job moves at most twice; the third check is refused and the queue budget keeps its first clock (literal times)', async () => {
  const r = moveRig({ info: { p1: () => BUSY_WITH([]), p2: () => BUSY_WITH([]) }, poll: { p1: QUEUED_ON_1, p2: QUEUED_ON_1 } });
  const out = await r.client.run({ ...r.base, requeue: spyMove(r, OTHER) });
  assert.deepStrictEqual(r.asked, [['runner-1', 60000], ['runner-2', 120000]]);
  assert.deepStrictEqual(r.posts(), ['0 p1 POST run-1', '60000 p2 POST run-1-2', '120000 p1 POST run-1-3']);
  assert.deepStrictEqual(out.record.moved, [
    { from: 'runner-1', to: 'runner-2', at: '1970-01-01T00:01:00.000Z' },
    { from: 'runner-2', to: 'runner-1', at: '1970-01-01T00:02:00.000Z' },
  ]);
  assert.deepStrictEqual([out.record.outcome, out.record.reason, out.record.endedAt], ['timeout', 'the job did not start within the 300000ms queue budget (cancelled)', '1970-01-01T00:05:00.000Z']);
});

test('t2440: the submit to the new member waits for the old member\'s cancel to answer, and a cancel that fails leaves the job where it is', async () => {
  let ticks = 0;
  const slow = moveRig({
    info: { p1: () => BUSY_WITH([]), p2: () => IDLE_ONE() }, poll: { p1: QUEUED_ON_1, p2: RAN_ON_2 },
    del: { p1: async () => { for (; ticks < 20; ticks += 1) await new Promise((res) => setImmediate(res)); return { status: 200, body: { ok: true } }; } },
  });
  const moved = await slow.client.run({ ...slow.base, requeue: spyMove(slow, OTHER) });
  assert.deepStrictEqual(slow.events.slice(0, 4), ['0 p1 POST run-1', '60000 p1 DELETE run-1', '60000 p1 DELETE answered', '60000 p2 POST run-1-2']);
  assert.strictEqual(moved.record.where, 'runner-2');
  const stuck = moveRig({
    info: { p1: () => BUSY_WITH([]), p2: () => IDLE_ONE() }, poll: { p1: QUEUED_ON_1, p2: RAN_ON_2 },
    del: { p1: async () => ({ status: 0, body: null, error: 'socket closed' }) },
  });
  const kept = await stuck.client.run({ ...stuck.base, requeue: spyMove(stuck, OTHER) });
  assert.deepStrictEqual(stuck.asked.map(([, t]) => t), [60000, 120000, 180000, 240000], 'ENTER: every check found runner-2 idle');
  assert.deepStrictEqual(stuck.posts(), ['0 p1 POST run-1']);
  assert.deepStrictEqual([kept.record.where, kept.record.outcome, 'moved' in kept.record], ['runner-1', 'timeout', false]);
});

test('t2440: a submit the new member refuses falls back to one resubmit on the old member, which then runs it', async () => {
  const r = moveRig({
    info: { p1: () => BUSY_WITH([]), p2: () => IDLE_ONE() },
    poll: { p1: (id, t) => (id === 'run-1' ? jobAt(id, 'queued') : t < 200000 ? jobAt(id, 'running') : jobAt(id, 'done')) },
    post: { p2: () => ({ status: 503, body: null, error: 'unavailable' }) },
  });
  const out = await r.client.run({ ...r.base, requeue: spyMove(r, OTHER) });
  assert.deepStrictEqual(r.posts(), ['0 p1 POST run-1', '60000 p2 POST run-1-2', '60000 p1 POST run-1-3']);
  assert.deepStrictEqual(r.asked, [['runner-1', 60000]]);
  assert.deepStrictEqual(out.record.moved, [
    { from: 'runner-1', to: 'runner-2', at: '1970-01-01T00:01:00.000Z' },
    { from: 'runner-2', to: 'runner-1', at: '1970-01-01T00:01:00.000Z' },
  ]);
  assert.deepStrictEqual([out.record.outcome, out.record.where, out.res.jobId], ['pass', 'runner-1', 'run-1-3']);
});

test('t2440: a post-merge job is never moved', async () => {
  const r = moveRig({ info: { p1: () => BUSY_WITH([]), p2: () => IDLE_ONE() }, poll: { p1: QUEUED_ON_1 } });
  const out = await r.client.run({ ...r.base, kind: 'post-merge', requeue: spyMove(r, OTHER) });
  assert.deepStrictEqual([r.asked, r.posts(), out.record.outcome], [[], ['0 p1 POST run-1'], 'timeout']);
});

test('t2440: a job that starts on runner-1 while the move pick waits on runner-2 is re-read before the cancel and stays: no DELETE, no second POST', async () => {
  let started = false;
  const r = moveRig({
    info: { p1: () => BUSY_WITH(['run-1']), p2: () => { started = true; return IDLE_ONE(); } },
    poll: { p1: (id, t) => (!started ? jobAt(id, 'queued') : t < 200000 ? jobAt(id, 'running') : jobAt(id, 'done')) },
  });
  const out = await r.client.run({ ...r.base, requeue: r.requeue() });
  assert.deepStrictEqual(r.asked, [['runner-1', 60000]], 'ENTER: the pick ran and found runner-2 idle');
  assert.deepStrictEqual(r.events.filter((e) => / DELETE /.test(e)), []);
  assert.deepStrictEqual(r.posts(), ['0 p1 POST run-1']);
  assert.deepStrictEqual([out.record.outcome, out.record.where, 'moved' in out.record], ['pass', 'runner-1', false]);
});

test('t2440: two jobs queued on runner-1 whose 60 s checks overlap both see runner-2 idle, and only one moves there', async () => {
  let busy2 = false;
  const r = moveRig({
    info: { p1: () => BUSY_WITH(['run-1', 'run-2']), p2: () => (busy2 ? BUSY_WITH([]) : IDLE_ONE()) },
    poll: { p1: QUEUED_ON_1, p2: RAN_ON_2 },
    post: { p2: () => { busy2 = true; return { status: 200, body: { ok: true, state: 'queued' } }; } },
  });
  const inner = r.requeue();
  let open;
  const both = new Promise((res) => { open = res; });
  let picks = 0;
  const requeue = async (where, id) => {
    const next = await inner(where, id);
    picks += 1;
    if (picks === 2) open();
    if (picks <= 2) await both;
    return next;
  };
  const outs = await Promise.all([r.client.run({ ...r.base, requeue }), r.client.run({ ...r.base, requeue })]);
  assert.ok(picks >= 2, 'ENTER: both checks picked');
  assert.deepStrictEqual(r.posts().filter((e) => / p2 POST /.test(e)).length, 1);
  assert.deepStrictEqual(outs.map((o) => o.record.where).sort(), ['runner-1', 'runner-2']);
});

test('t2440: a verify shadow and a verify box decide are given a move hook on a pool; their post-merge runs are not', async () => {
  const shadowSent = [];
  const sc = { reachable: async () => ({ ok: true, info: IDLE_ONE() }), shadow: async (o) => { shadowSent.push(o); return null; } };
  const s = mkFixture({ manifestExtra: { testRunner: { peer: 'runner-1', gate: 'shadow', pool: [{ peer: 'runner-2' }] } }, peers: [R1, R2], client: sc });
  await s.m._shadowSubmit(s.tm.loadManifest('team'), { id: 't1' }, '/w', {});
  await s.m._shadowSubmit(s.tm.loadManifest('team'), { id: 't1' }, '/w', { merge: true });
  assert.deepStrictEqual(shadowSent.map((o) => [o.kind, typeof o.requeue]), [['verify', 'function'], ['post-merge', 'undefined']]);
  const runSent = [];
  const bc = { reachable: async () => ({ ok: true, info: IDLE_ONE() }), run: async (o) => { runSent.push(o); return { unknown: 'runner unreachable', res: null, record: null }; } };
  const timers = { setTimeout: () => 1, clearTimeout: () => {} };
  const b = mkFixture({ manifestExtra: { testRunner: { ...PUSH_ON, pool: [{ peer: 'runner-2' }] } }, peers: [R1, R2], client: bc, extraDeps: { boxDecideTimers: timers } });
  const team = b.tm.loadManifest('team');
  require('../team-box').writeBox(team.dir, BOX_TEXT);
  await b.m._boxDecide(team, { id: 't1' }, '/w', {});
  await b.m._boxDecide(team, { id: 't1' }, '/w', { merge: true });
  assert.deepStrictEqual(runSent.map((o) => [o.kind, typeof o.requeue, typeof o.onMove]), [['verify', 'function', 'function'], ['post-merge', 'undefined', 'undefined']]);
});

test('t2440: while a job waits on its cancel to move to runner-2, a fresh pick counts it as sent to runner-2', async () => {
  const seen = [];
  let client = null;
  const r = moveRig({
    info: { p1: () => BUSY_WITH(['run-1']), p2: () => IDLE_ONE() },
    poll: { p1: QUEUED_ON_1, p2: RAN_ON_2 },
    del: { p1: async () => { seen.push(client.sentTo('runner-2', IDLE_ONE())); return { status: 200, body: { ok: true } }; } },
  });
  client = r.client;
  const before = r.client.sentTo('runner-2', IDLE_ONE());
  const out = await r.client.run({ ...r.base, requeue: r.requeue() });
  assert.strictEqual(out.record.where, 'runner-2', 'ENTER: the job moved');
  assert.deepStrictEqual([before, seen], [0, [1]]);
});

test('t2440: a cancel that fails releases the move claim, so a fresh pick no longer counts the job on runner-2', async () => {
  const seen = [];
  let client = null;
  const r = moveRig({
    info: { p1: () => BUSY_WITH(['run-1']), p2: () => IDLE_ONE() },
    poll: { p1: (id, t) => { if (t > 60000 && t < 120000) seen.push(client.sentTo('runner-2', IDLE_ONE())); return jobAt(id, 'queued'); } },
    del: { p1: async () => ({ status: 0, body: null, error: 'socket closed' }) },
  });
  client = r.client;
  const out = await r.client.run({ ...r.base, requeue: r.requeue() });
  assert.ok(seen.length > 0, 'ENTER: a poll ran between the failed cancel and the next check');
  assert.deepStrictEqual([out.record.where, [...new Set(seen)]], ['runner-1', [0]]);
});

test('t2440: a caller stop while the moved job is set up on runner-2 ends it with one move recorded and no fallback hop', async () => {
  let armed = false;
  let stop = false;
  const r = moveRig({
    info: { p1: () => BUSY_WITH(['run-1']), p2: () => { if (armed) stop = true; return IDLE_ONE(); } },
    poll: { p1: QUEUED_ON_1, p2: RAN_ON_2 },
    del: { p1: async () => { armed = true; return { status: 200, body: { ok: true } }; } },
  });
  const out = await r.client.run({ ...r.base, requeue: r.requeue(), shouldStop: () => stop });
  assert.ok(stop, 'ENTER: the stop came during the setup on runner-2');
  assert.deepStrictEqual([r.posts(), out.record.moved], [['0 p1 POST run-1'], [{ from: 'runner-1', to: 'runner-2', at: '1970-01-01T00:01:00.000Z' }]]);
});
