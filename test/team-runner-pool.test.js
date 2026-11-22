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
const { createSuiteClient, pickRunner } = require('../suite-client');
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

function mkFixture({ manifestExtra = {}, peers = [], desk = null, client = {} } = {}) {
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

test('t2362: runner rm drops a pool row, promotes the next on rm of the first, and refuses the only runner', async () => {
  const f = mkFixture({
    manifestExtra: { testRunner: { peer: 'runner-1', hands: 'full', wire: 'push', pool: [{ peer: 'laptop', wire: 'pull' }, { peer: 'runner-2', wire: 'push' }] } },
    peers: [R1, R2], desk: ATTACHED, client: { reachable: async () => INFO(0, 1, []) },
  });
  assert.deepStrictEqual(await f.verb('[agent:team runner rm runner-9]'), ['[agent:team] error: runner-9 is not a test runner of team']);
  assert.deepStrictEqual(await f.verb('[agent:team runner rm runner-1]'),
    ['[agent:team] test runner runner-1 removed from team; laptop is now the first runner, wire pull, hands off — 2 left']);
  assert.deepStrictEqual(disk(f.file).testRunner, { peer: 'laptop', hands: 'off', wire: 'pull', pool: [{ peer: 'runner-2', wire: 'push' }] });
  assert.deepStrictEqual(await f.verb('[agent:team runner rm runner-2]'), ['[agent:team] test runner runner-2 removed from team — 1 left']);
  assert.deepStrictEqual(disk(f.file).testRunner, { peer: 'laptop', hands: 'off', wire: 'pull' });
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
    '[agent:team] test runner of team: 3 runners, hands full (hand runs use runner-1 only), gate on',
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
  ['most free slots wins', [member('a', load(1, 0, 0)), member('b', load(4, 1, 0)), member('c', load(2, 0, 0))], false, 'b', true],
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
  assert.deepStrictEqual(boxVerdict(out([{ name: 'assets', version: 'v2' }]), DEF, SHARE_ASK), { fallback: 'no share' });
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
  assert.deepStrictEqual(calls, ['GET /api/suite/info', 'GET /api/suite/info'], 'no job was submitted');
  const row = records().pop();
  assert.deepStrictEqual([decided.decided, row.decidedBy, row.fallback], [false, 'home', 'no share']);
});
