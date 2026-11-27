'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createTeamManifest, normalizeTestRoots } = require('../team-manifest');
const { createSessionManager } = require('../session-manager');
const { intentEnabled } = require('../intent-catalog');
const registry = require('../intent-registry');
const { parseAndValidate, isFilenameToken } = require('../exec-schema');
const { mkTmpRoot } = require('./lib/tmp-roots');

const RUN_TESTS_DEF = path.join(__dirname, '..', 'resources', 'library', 'exec', 'clodex-run-tests.json');

function mkHome(manifestExtra = {}) {
  const home = mkTmpRoot('clodex-roots-home-');
  const root = mkTmpRoot('clodex-roots-root-');
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

for (const [input, want] of [
  [['test'], ['test']],
  [['app/web/workshop/test'], ['app/web/workshop/test']],
  [['app/web/workshop/test/'], ['app/web/workshop/test']],
  [['test', 'test/'], ['test']],
  [['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']],
  [[`${'x'.repeat(200)}`], [`${'x'.repeat(200)}`]],
  [[], null],
  [['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], null],
  [[`${'x'.repeat(201)}`], null],
  ['test', null],
  [[7], null],
  [[''], null],
  [['/'], null],
  [['/abs/test'], null],
  [['-test'], null],
  [['a/../test'], null],
  [['..'], null],
  [['a//b'], null],
  [['a/.hidden'], null],
  [['.test'], null],
  [['my tests'], null],
  [['a\tb'], null],
  [['a\u0001b'], null],
  [['test//'], null],
  [['test', '../x'], null],
]) {
  test(`normalizeTestRoots(${JSON.stringify(input).slice(0, 60)}) is ${JSON.stringify(want)}`, () => {
    assert.deepStrictEqual(normalizeTestRoots(input), want);
  });
}

test('loadManifest: unset testRoots is absent; a valid one is normalised; an invalid one is dropped and reported', () => {
  assert.strictEqual('testRoots' in mkHome().tm.loadManifest('team'), false);
  const ok = mkHome({ testRoots: ['test', 'app/web/workshop/test/'] }).tm.loadManifest('team');
  assert.deepStrictEqual(ok.testRoots, ['test', 'app/web/workshop/test']);
  assert.deepStrictEqual(ok.droppedFields, []);
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let bad;
  try {
    bad = mkHome({ testRoots: ['test', '../elsewhere'] }).tm.loadManifest('team');
  } finally {
    console.warn = orig;
  }
  assert.strictEqual('testRoots' in bad, false);
  assert.deepStrictEqual(bad.droppedFields, [{ role: null, field: 'testRoots', status: 'invalid', remedy: null }]);
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /testRoots is invalid and ignored; own test runs look under test and cli\/test/);
});

test('setTeamTestRoots writes the normalised list, clears on null, and refuses an invalid one without writing', () => {
  const { tm, file } = mkHome();
  assert.deepStrictEqual(tm.setTeamTestRoots('team', ['web/test/']).testRoots, ['web/test']);
  assert.deepStrictEqual(disk(file).testRoots, ['web/test']);
  assert.throws(() => tm.setTeamTestRoots('team', ['../x']), /testRoots must be 1 to 8 repo-relative directories/);
  assert.deepStrictEqual(disk(file).testRoots, ['web/test'], 'a refused set writes nothing');
  assert.strictEqual('testRoots' in tm.setTeamTestRoots('team', null), false);
  assert.strictEqual('testRoots' in disk(file), false);
});

test('parse: [agent:team test-roots …] carries every token; bare carries none', () => {
  assert.deepStrictEqual(registry.parseWithRegistry('[agent:team test-roots test app/web/test]'),
    { type: 'team', sub: 'test-roots', roots: ['test', 'app/web/test'], body: '' });
  assert.deepStrictEqual(registry.parseWithRegistry('[agent:team test-roots off]').roots, ['off']);
  assert.deepStrictEqual(registry.parseWithRegistry('[agent:team test-roots]').roots, []);
});

function mkVerbFixture(manifestExtra = {}) {
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
    setTeamTestRoots: tm.setTeamTestRoots,
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  const injected = [];
  m._injectText = (s, text) => { injected.push(text); };
  m._broadcast = () => {};
  m._sendToSession = () => {};
  const seat = (name) => {
    if (!m.sessions.has(name)) m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd: root, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  const verb = async (who, line) => {
    injected.length = 0;
    await m._handleTeam(seat(who), registry.parseWithRegistry(line));
    return injected.slice();
  };
  return { verb, file, root };
}

test('[agent:team test-roots]: bare shows the default and that it is not set, then the set value', async () => {
  const f = mkVerbFixture();
  assert.deepStrictEqual(await f.verb('lead', '[agent:team test-roots]'),
    ['[agent:team] test roots of team: test cli/test (the default; not set — [agent:team test-roots <dir> …] sets it)']);
  fs.mkdirSync(path.join(f.root, 'app', 'web', 'workshop', 'test'), { recursive: true });
  fs.mkdirSync(path.join(f.root, 'test'));
  assert.deepStrictEqual(await f.verb('lead', '[agent:team test-roots test app/web/workshop/test/]'),
    ['[agent:team] test roots of team set to test app/web/workshop/test — a hand\'s own test run now finds the tests for its changed code there']);
  assert.deepStrictEqual(disk(f.file).testRoots, ['test', 'app/web/workshop/test']);
  assert.deepStrictEqual(await f.verb('lead', '[agent:team test-roots]'),
    ['[agent:team] test roots of team: test app/web/workshop/test (set in team.json; the default would be test cli/test)']);
  assert.deepStrictEqual(await f.verb('lead', '[agent:team test-roots off]'),
    ['[agent:team] test roots of team cleared — own test runs look under the default test cli/test']);
  assert.strictEqual('testRoots' in disk(f.file), false);
});

test('[agent:team test-roots]: a missing directory, a bad shape, too many, and a non-lead are refused and nothing is written', async () => {
  const f = mkVerbFixture({ testRoots: ['test'] });
  fs.mkdirSync(path.join(f.root, 'test'));
  fs.writeFileSync(path.join(f.root, 'notadir'), 'x');
  assert.deepStrictEqual(await f.verb('lead', '[agent:team test-roots test web/test]'),
    [`[agent:team] error: test root "web/test" is not a directory in ${f.root}`]);
  assert.deepStrictEqual(await f.verb('lead', '[agent:team test-roots notadir]'),
    [`[agent:team] error: test root "notadir" is not a directory in ${f.root}`]);
  assert.deepStrictEqual(await f.verb('lead', '[agent:team test-roots ../up]'),
    ['[agent:team] error: test root "../up" is not a repo-relative directory — at most 200 characters, no .., empty or dot segment, no whitespace and no leading / or -']);
  assert.deepStrictEqual(await f.verb('lead', '[agent:team test-roots a b c d e f g h i]'),
    ['[agent:team] error: test-roots takes 1 to 8 directories — got 9']);
  assert.deepStrictEqual(await f.verb('hand-1', '[agent:team test-roots off]'),
    ['[agent:team] error: only the team lead (lead) can edit team metadata']);
  assert.deepStrictEqual(disk(f.file).testRoots, ['test']);
});

function execEnvFor(team) {
  const REGISTRY_DIR = mkTmpRoot('clx-roots-exec-');
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  fs.copyFileSync(RUN_TESTS_DEF, path.join(execDir, 'cmd.json'));
  const spawned = [];
  const fakeChild = () => {
    const ee = new EventEmitter();
    ee.stdin = { write() {}, end() {} };
    ee.stderr = new EventEmitter();
    ee.kill = () => {};
    setImmediate(() => { ee.emit('exit', 0, null); ee.emit('close', 0, null); });
    return ee;
  };
  const SessionManager = createSessionManager({
    knownSkillNames: () => [], REGISTRY_DIR, isFilenameToken, parseAndValidate, os: require('os'), fs, path,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ list: () => [], get: () => ({ execCommands: ['cmd'] }) }),
    childProcess: { spawn: (cmd, args, opts) => { spawned.push(opts); return fakeChild(); } },
  });
  const m = new SessionManager();
  m._injectText = () => {};
  m._broadcast = () => {};
  m._teamOfOrNull = () => team;
  m._teamOf = () => team;
  m._handleExecIntent({ name: 'a', agentType: 'claude', workspaceId: 'ws1', cwd: '/x' }, 'cmd', '{"scope":"own"}');
  return new Promise((r) => setImmediate(() => setImmediate(() => r(spawned))));
}

test('exec: clodex-run-tests gets the team\'s roots from the host as CLODEX_SUITE_TEST_ROOTS, empty when unset', async () => {
  const prev = process.env.CLODEX_SUITE_TEST_ROOTS;
  process.env.CLODEX_SUITE_TEST_ROOTS = '["inherited"]';
  try {
    const set = await execEnvFor({ name: 'team', root: '/r', dir: '/nonexistent-team-dir', lead: 'lead', testRoots: ['test', 'app/web/workshop/test'] });
    assert.strictEqual(set.length, 1, 'ENTER: run-tests spawned');
    assert.strictEqual(set[0].env.CLODEX_SUITE_TEST_ROOTS, '["test","app/web/workshop/test"]');
    const unset = await execEnvFor({ name: 'team', root: '/r', dir: '/nonexistent-team-dir', lead: 'lead' });
    assert.strictEqual(unset.length, 1, 'ENTER: run-tests spawned');
    assert.strictEqual(unset[0].env.CLODEX_SUITE_TEST_ROOTS, '', 'an app environment value never reaches the wrapper');
  } finally {
    if (prev === undefined) delete process.env.CLODEX_SUITE_TEST_ROOTS;
    else process.env.CLODEX_SUITE_TEST_ROOTS = prev;
  }
});

test('the shipped clodex-run-tests schema refuses a testRoots payload key, so a hand cannot set or widen its roots', () => {
  const def = JSON.parse(fs.readFileSync(RUN_TESTS_DEF, 'utf8'));
  assert.strictEqual(parseAndValidate(def, '{"scope":"own"}').ok, true, 'ENTER: the plain own payload validates');
  const r = parseAndValidate(def, '{"scope":"own","testRoots":["elsewhere"]}');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /testRoots/);
});
