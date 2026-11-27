'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { route, createChannelHost, createSuiteClient, boxVerdict } = require('../suite-client');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'clodex-run-tests.js');
const TREE = 'a'.repeat(40);
const HEAD_TREE = 'c'.repeat(40);
const HEAD = 'b'.repeat(40);

const teamWith = (hands) => ({ name: 'tm', lead: 'lead-1', root: '/r', testRunner: { peer: 'runner-1', hands } });

function pullTeam(hands) {
  const home = mkTmpRoot('clodex-pull-route-');
  const dir = path.join(home, 'teams', 'tm');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({
    root: home, lead: 'lead-1', roles: { lead: { brief: 'the lead' } }, testRunner: { peer: 'laptop', hands, wire: 'pull' },
  }));
  const team = require('../team-manifest').createTeamManifest({ fs, clodexHome: home }).loadManifest('tm');
  assert.deepStrictEqual(team.testRunner, { peer: 'laptop', hands, gate: 'off', wire: 'pull' }, 'ENTER: the hand-edited manifest loads');
  return team;
}

const ROUTE_ROWS = [
  ['no setting', { team: { name: 'tm', root: '/r' }, scope: 'full' }, { where: 'local', why: 'no test runner' }],
  ['hands:off', { team: teamWith('off'), scope: 'full' }, { where: 'local', why: 'hands:off' }],
  ['local:true under hands:all', { team: teamWith('all'), scope: 'full', local: true }, { where: 'local', why: 'local:true in the call', override: 'call' }],
  ['hands:full, full scope', { team: teamWith('full'), scope: 'full' }, { where: 'remote', peer: 'runner-1', wire: 'push', why: 'hands:full' }],
  ['hands:full, own scope', { team: teamWith('full'), scope: 'own' }, { where: 'local', why: 'hands:full leaves own scope local' }],
  ['hands:all, full scope', { team: teamWith('all'), scope: 'full' }, { where: 'remote', peer: 'runner-1', wire: 'push', why: 'hands:all' }],
  ['hands:all, own scope', { team: teamWith('all'), scope: 'own' }, { where: 'remote', peer: 'runner-1', wire: 'push', why: 'hands:all' }],
  ['wire:pull, hands:off', { team: pullTeam('off'), scope: 'full' }, { where: 'local', why: 'hands:off' }],
  ['wire:pull, hands:full, full scope', { team: pullTeam('full'), scope: 'full' }, { where: 'remote', peer: 'laptop', wire: 'pull', why: 'hands:full' }],
  ['wire:pull, hands:full, own scope', { team: pullTeam('full'), scope: 'own' }, { where: 'local', why: 'hands:full leaves own scope local' }],
  ['wire:pull, hands:all, own scope', { team: pullTeam('all'), scope: 'own' }, { where: 'remote', peer: 'laptop', wire: 'pull', why: 'hands:all' }],
];

for (const [name, input, want] of ROUTE_ROWS) {
  test(`route: ${name}`, () => {
    assert.deepStrictEqual(route({ kind: 'hand', ...input }), want);
  });
}

const stubSnap = (treeHash = TREE) => ({
  snapshotTree: async () => ({ treeHash, head: HEAD, headTree: HEAD_TREE, tmpDir: null }),
  releaseSnapshot: () => {},
});

function stubClient({ hang = false, result = null } = {}) {
  const runs = [];
  const cancels = [];
  const gate = {};
  return {
    runs,
    cancels,
    release: (v) => gate.release(v),
    run(opts) {
      runs.push(opts);
      opts.onSubmitted({ jobId: 'job-1', attempt: 1 });
      opts.onProgress('runner runner-1: job queued');
      return hang ? new Promise((r) => { gate.release = r; }) : Promise.resolve(result);
    },
    async cancel(peer, jobId) {
      cancels.push([peer, jobId]);
      return { ok: true };
    },
  };
}

function hostFor({ team = teamWith('all'), client = null, snapshot = stubSnap(), peers = { 'runner-1': 'p1' }, pool, box } = {}) {
  const dir = fs.realpathSync(mkTmpRoot('suite-route-'));
  const sent = [];
  const notes = [];
  let settle;
  const done = new Promise((r) => { settle = r; });
  const host = createChannelHost({
    client,
    team: team && { ...team, root: dir },
    seat: 'hand-1',
    listWorktrees: async () => ({ ok: true, worktrees: [{ path: dir }] }),
    resolvePeer: (n) => (typeof peers[n] === 'string' ? { peer: peers[n], wire: 'push', name: n } : peers[n] || null),
    send: (m) => { sent.push(m); if (m.run) settle(m); },
    notifyLead: (b) => notes.push(b),
    snapshot, pool, ...(box ? { box } : {}),
  });
  return { host, sent, notes, dir, done };
}

const ask = (dir, extra = {}) => ({ op: 'suite', measure: dir, scope: 'full', files: [], flags: {}, local: false, ...extra });

const REFUSE_ROWS = [
  ['a tree outside the team\'s worktrees', (dir) => ask(path.dirname(dir)), /^not a worktree of team tm: /],
  ['a file entry with ..', (dir) => ask(dir, { files: ['test/../../etc/x.test.js'] }), /^bad file entry "test\/\.\.\/\.\.\/etc\/x\.test\.js"$/],
  ['a file entry with a leading -', (dir) => ask(dir, { files: ['--require=evil.js'] }), /^bad file entry "--require=evil\.js"$/],
];

test('host re-validation: ENTER — a request on a team worktree with plain files is routed, not refused', async () => {
  const client = stubClient({ result: { unknown: null, res: { status: 0, signal: null, stdout: 'x', stderr: '', treeHash: TREE } } });
  const f = hostFor({ client });
  f.host.onMessage(ask(f.dir, { files: ['test/a.test.js'] }));
  assert.strictEqual((await f.done).run, 'remote');
  assert.strictEqual(client.runs.length, 1);
});

for (const [name, mk, why] of REFUSE_ROWS) {
  test(`host re-validation refuses ${name}, and nothing runs`, async () => {
    const client = stubClient();
    const f = hostFor({ client });
    f.host.onMessage(mk(f.dir));
    const m = await f.done;
    assert.strictEqual(m.run, 'refused');
    assert.match(m.why, why);
    assert.strictEqual(client.runs.length, 0);
  });
}

test('host: local:true under hands:all answers local with the override and leaves one row to the lead', async () => {
  const client = stubClient();
  const f = hostFor({ client });
  f.host.onMessage(ask(f.dir, { local: true }));
  assert.deepStrictEqual(await f.done, { run: 'local', why: 'local:true in the call', override: 'call' });
  assert.deepStrictEqual(f.notes, ['hand-1: clodex-run-tests ran here on request ({"local": true}); team tm routes hand runs to runner-1']);
  assert.strictEqual(client.runs.length, 0);
});

test('host: hands:full leaves an own-scope call local with no row to the lead', async () => {
  const client = stubClient();
  const f = hostFor({ client, team: teamWith('full') });
  f.host.onMessage(ask(f.dir, { scope: 'own' }));
  assert.deepStrictEqual(await f.done, { run: 'local', why: 'hands:full leaves own scope local', override: null });
  assert.deepStrictEqual([f.notes, client.runs.length], [[], 0]);
});

test('host: a remote run goes through the client as kind hand and streams its progress', async () => {
  const res = { status: 1, signal: null, stdout: 'TOTALS: 1 pass, 1 fail, 2 tests\n', stderr: 'e\n', treeHash: TREE };
  const client = stubClient({ result: { unknown: null, res } });
  const f = hostFor({ client });
  f.host.onMessage(ask(f.dir, { scope: 'own', files: ['test/a.test.js'], flags: { CLODEX_TEST_LOCK: '1' } }));
  assert.deepStrictEqual(await f.done, {
    run: 'remote', runner: 'runner-1', status: 1, signal: null, stdout: res.stdout, stderr: 'e\n',
    error: null, unknown: null, treeHash: TREE, note: null,
  });
  const { onSubmitted, onProgress, shouldStop, ...opts } = client.runs[0];
  assert.deepStrictEqual(opts, {
    peer: 'p1', wire: 'push', name: 'runner-1', tree: f.dir, kind: 'hand', scope: 'own', team: 'tm', ticket: null, seat: 'hand-1',
    files: ['test/a.test.js'], flags: { CLODEX_TEST_LOCK: '1' }, setup: null, env: {},
    queueBudgetMs: 15 * 60 * 1000, runBudgetMs: 38 * 60 * 1000, timeoutMs: 21 * 60 * 1000, budgetMs: 53 * 60 * 1000, route: 'hands:all',
  });
  assert.deepStrictEqual(f.sent[0], { progress: 'runner runner-1: job queued' });
});

test('host: a tree that changed during the run carries the note naming the measured tree', async () => {
  const client = stubClient({ result: { unknown: null, res: { status: 0, signal: null, stdout: '', stderr: '', treeHash: TREE } } });
  const f = hostFor({ client, snapshot: stubSnap('d'.repeat(40)) });
  f.host.onMessage(ask(f.dir));
  assert.strictEqual((await f.done).note, '(tree changed during the run; the suite measured aaaaaaaa)');
});

test('host: an unknown result is passed on as unknown with the runner name', async () => {
  const client = stubClient({ result: { unknown: 'runner unreachable', res: null } });
  const f = hostFor({ client });
  f.host.onMessage(ask(f.dir));
  assert.deepStrictEqual(await f.done, { run: 'remote', runner: 'runner-1', unknown: 'runner unreachable' });
});

function execFixture(t, bin, { client = null, team = null, peers = null, desk = null, payload = '{}' } = {}) {
  const { createSessionManager } = require('../session-manager');
  const { isFilenameToken, parseAndValidate } = require('../exec-schema');
  const REGISTRY_DIR = mkTmpRoot('suite-route-exec-');
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(execDir, 'cmd.json'), JSON.stringify({
    argv: ['/usr/bin/env', 'node', `\${CLODEX_BIN}/${bin}`],
    timeoutMs: 5000, maxBytes: 4096, replyStderr: true,
    schema: { type: 'object', additionalProperties: false, properties: { scope: { type: 'string' }, local: { type: 'boolean' } } },
  }));
  const spawned = [];
  const children = [];
  const broadcasts = [];
  const SessionManager = createSessionManager({
    knownSkillNames: () => [], REGISTRY_DIR, isFilenameToken, parseAndValidate, os, fs, path,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ list: () => [], get: () => ({ execCommands: ['cmd'] }) }),
    getSuiteClient: () => client,
    gitWorktree: { listWorktrees: async () => ({ ok: true, worktrees: [{ path: team ? team.root : '/nowhere' }] }) },
    childProcess: {
      spawn: (cmd, args, opts) => {
        spawned.push(opts);
        const ee = new EventEmitter();
        ee.stdin = { write() {}, end() {} };
        ee.stderr = new EventEmitter();
        ee.kills = [];
        ee.kill = (sig) => ee.kills.push(sig);
        if (opts.stdio[3] === 'ipc') { ee.connected = true; ee.sends = []; ee.send = (m) => { ee.sends.push(m); return true; }; }
        children.push(ee);
        return ee;
      },
    },
  });
  const m = new SessionManager();
  m._injectText = () => {};
  m._broadcast = (ch, p) => broadcasts.push(p);
  m._teamOfOrNull = () => team;
  m._runnerPeerStatus = peers ? (n) => peers[n] || null : (n) => (n === 'runner-1' ? { id: 'p1' } : null);
  if (desk) m._runnerDesk = () => desk;
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    for (const c of children) c.emit('close', 0, null);
    mock.timers.reset();
  });
  m._handleExecIntent({ name: 'hand-1', agentType: 'claude', workspaceId: 'ws1', cwd: '/x' }, 'cmd', payload);
  return { spawned, children, broadcasts };
}

const turns = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

test('exec: the child of clodex-run-tests.js gets the IPC channel and every other bin does not', async (t) => {
  const rows = [
    ['clodex-run-tests.js', ['pipe', 'ignore', 'pipe', 'ipc']],
    ['clodex-team.js', ['pipe', 'ignore', 'pipe']],
    ['clodex-monitor.js', ['pipe', 'ignore', 'pipe']],
    ['clodex-ctl-admin.js', ['pipe', 'ignore', 'pipe']],
    ['run-tests.js', ['pipe', 'ignore', 'pipe']],
  ];
  for (const [bin, stdio] of rows) {
    const f = execFixture(t, bin);
    await turns(2);
    assert.strictEqual(f.spawned.length, 1, `ENTER: ${bin} spawned`);
    assert.deepStrictEqual(f.spawned[0].stdio, stdio, bin);
    mock.timers.reset();
  }
});

async function inflightExec(t) {
  const client = stubClient({ hang: true });
  const team = { ...teamWith('all'), root: fs.realpathSync(mkTmpRoot('suite-route-tree-')) };
  const f = execFixture(t, 'clodex-run-tests.js', { client, team });
  await turns(2);
  const child = f.children[0];
  child.emit('message', ask(team.root));
  await turns();
  assert.strictEqual(client.runs.length, 1, 'ENTER: the job is in flight on the runner');
  return { client, child };
}

test('exec: the timeout kill cancels the in-flight job once, and the disconnect after it adds none', async (t) => {
  const { client, child } = await inflightExec(t);
  assert.deepStrictEqual(client.cancels, []);
  mock.timers.tick(5000 + 19 * 60 * 1000 - 1);
  assert.deepStrictEqual(child.kills, [], 'the suite channel ceiling is the def ceiling plus the 19 min hand slack');
  mock.timers.tick(1);
  assert.deepStrictEqual(child.kills, ['SIGKILL']);
  assert.deepStrictEqual(client.cancels, [['p1', 'job-1']]);
  child.emit('disconnect');
  assert.deepStrictEqual(client.cancels, [['p1', 'job-1']]);
});

test('exec: a channel disconnect cancels the in-flight job once', async (t) => {
  const { client, child } = await inflightExec(t);
  child.emit('disconnect');
  child.emit('disconnect');
  assert.deepStrictEqual(client.cancels, [['p1', 'job-1']]);
});

test('exec: a disconnect after the result arrived cancels nothing', async (t) => {
  const { client, child } = await inflightExec(t);
  client.release({ unknown: null, res: { status: 0, signal: null, stdout: '', stderr: '', treeHash: TREE } });
  await turns();
  child.emit('disconnect');
  assert.deepStrictEqual(client.cancels, []);
});

const ARGV_FILE = 'stub-argv.json';

function mkRoot(captured) {
  const root = fs.realpathSync(mkTmpRoot('suite-route-bin-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'run-tests.js'), [
    "'use strict';",
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(path.join(root, ARGV_FILE))}, JSON.stringify({`,
    "  channel: typeof process.send === 'function' ? 'ipc' : (process.env.NODE_CHANNEL_FD || null),",
    '  route: process.env.CLODEX_SUITE_ROUTE || null,',
    '  override: process.env.CLODEX_SUITE_OVERRIDE || null,',
    '}));',
    `process.stdout.write(${JSON.stringify(captured.stdout)});`,
    `process.stderr.write(${JSON.stringify(captured.stderr)});`,
    `process.exit(${captured.status});`,
  ].join('\n'));
  return root;
}

function baseEnv(home) {
  const env = { ...process.env, HOME: home, CLODEX_HOME: path.join(home, '.clodex') };
  for (const k of Object.keys(env)) if (k.startsWith('CLODEX_SUITE_') || k.startsWith('CLODEX_TEST_') || k === 'CLODEX_RUN_TESTS_REEXEC') delete env[k];
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function outcome(root, home, code, stderr) {
  const lines = String(stderr).split('\n').filter((l) => l.trim());
  const keep = path.join(home, '.clodex', 'test-failures', 'last.txt');
  const rec = path.join(root, ARGV_FILE);
  return {
    code,
    digest: lines.length ? lines[lines.length - 1] : '',
    lines,
    kept: fs.existsSync(keep) ? fs.readFileSync(keep, 'utf8') : null,
    ran: fs.existsSync(rec) ? JSON.parse(fs.readFileSync(rec, 'utf8')) : null,
  };
}

function runPlain(root, payload, home) {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, input: payload, encoding: 'utf8', timeout: 60000, env: baseEnv(home) });
  return outcome(root, home, r.status, r.stderr);
}

function runWithHost(root, payload, home, answer) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { cwd: root, env: baseEnv(home), stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    const requests = [];
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.resume();
    child.on('message', (m) => {
      requests.push(m);
      for (const reply of answer(m)) child.send(reply);
    });
    child.on('close', (code) => resolve({ ...outcome(root, home, code, stderr), requests }));
    child.stdin.end(payload);
  });
}

const CAPTURED = {
  green: { status: 0, stdout: '...\nTOTALS: 3 pass, 0 fail, 3 tests\n', stderr: '' },
  red: {
    status: 1,
    stdout: '..X\nFailed tests:\n✖ b (1.5ms)\n  Error: red\n    at t (x.test.js:2:3)\nTOTALS: 2 pass, 1 fail, 3 tests\n',
    stderr: 'a diagnostic line\n',
  },
  slow: { status: 1, stdout: 'SLOW: 7001ms test/slow.test.js\nTOTALS: 3 pass, 0 fail, 3 tests\n', stderr: '' },
};

const PREFIX = {
  green: '3/3 green (',
  red: '2/3 green, 1 failing (',
  slow: '3/3 green, 0 failing (~/.clodex/test-failures/last.txt) — SLOW GATE (not a test failure): test/slow.test.js 7001ms',
};

const wall = (s) => String(s).replace(/\d+m \d{2}s/g, '<WALL>');
const stamps = (s) => String(s).replace(/^# (start|when): .*$/gm, '# $1: <STAMP>');

for (const name of Object.keys(CAPTURED)) {
  test(`both arms: one captured ${name} output gives the same digest line, the remote one naming its runner${name === 'red' ? ' and failing-output file' : ''}`, async () => {
    const captured = CAPTURED[name];
    const root = mkRoot(captured);
    const leaf = path.basename(root);
    const local = runPlain(root, '{}', path.join(root, 'home-local'));
    assert.ok(local.ran, 'ENTER: the local arm ran the runner');
    fs.rmSync(path.join(root, ARGV_FILE));
    const remote = await runWithHost(root, '{}', path.join(root, 'home-remote'), () => [
      { progress: 'runner runner-1: job running' },
      { run: 'remote', runner: 'runner-1', ...captured, signal: null, error: null, unknown: null, treeHash: TREE, note: null },
    ]);
    assert.strictEqual(remote.ran, null, 'the remote arm never started the local runner');
    assert.ok(local.digest.startsWith(`[${leaf}] ${PREFIX[name]}`), `ENTER: ${local.digest}`);
    assert.strictEqual(wall(remote.digest), `${wall(local.digest)} (runner runner-1)`);
    assert.strictEqual(remote.code, local.code);
    assert.ok(remote.lines.includes('runner runner-1: job running'), 'progress reached stderr');
    if (name === 'red') {
      assert.ok(local.kept && local.kept.includes('✖ b (1.5ms)'), 'ENTER: the local arm preserved the failing rows');
      assert.strictEqual(stamps(remote.kept), stamps(local.kept));
    }
  });
}

test('t2425: a failing remote named run whose output names no failing test drops the empty names field before the runner and box', async () => {
  const captured = { status: 1, stdout: '..X\nTOTALS: 2 pass, 1 fail, 3 tests\n', stderr: '' };
  const root = mkRoot(captured);
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'a.test.js'), '');
  const leaf = path.basename(root);
  const r = await runWithHost(root, '{"files":["test/a.test.js"]}', path.join(root, 'h'), () => [
    { run: 'remote', runner: 'avh', ...captured, signal: null, error: null, unknown: null, treeHash: TREE, note: null, box: { isolation: 'container', imageId: 'sha256:0123456789abcdef' } },
  ]);
  assert.strictEqual(wall(r.digest), `[${leaf}] named: 1 file: 2/3 green, 1 failing (<WALL>) (~/.clodex/test-failures/last.txt) (runner avh) (box container, image 0123456789ab)`);
});

test('unknown: the digest says unknown and why, exits non-zero, and no local run starts; a local answer starts exactly one', async () => {
  const root = mkRoot(CAPTURED.green);
  const leaf = path.basename(root);
  const local = await runWithHost(root, '{}', path.join(root, 'h1'), () => [{ run: 'local', why: 'hands:off', override: null }]);
  assert.strictEqual(local.ran ? 1 : 0, 1, 'ENTER: a local answer spawns the runner once');
  fs.rmSync(path.join(root, ARGV_FILE));
  const r = await runWithHost(root, '{}', path.join(root, 'h2'), () => [{ run: 'remote', runner: 'runner-1', unknown: 'runner unreachable' }]);
  assert.strictEqual(r.digest, `[${leaf}] result unknown — the suite did not complete on runner runner-1: runner unreachable`);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.ran ? 1 : 0, 0);
});

test('a host refusal prints a refusal and runs nothing', async () => {
  const root = mkRoot(CAPTURED.green);
  const r = await runWithHost(root, '{}', path.join(root, 'h'), () => [{ run: 'refused', why: 'bad file entry "-x"' }]);
  assert.deepStrictEqual([r.digest, r.code, r.ran], [`[${path.basename(root)}] refused, nothing measured: bad file entry "-x"`, 1, null]);
});

test('no channel: the run is local, as today', () => {
  const root = mkRoot(CAPTURED.green);
  const r = runPlain(root, '{}', path.join(root, 'h'));
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.ran, { channel: null, route: null, override: null });
});

test('local:true: the request carries it, and the runner gets the route and override to record; its env has no channel variable', async () => {
  const root = mkRoot(CAPTURED.green);
  const r = await runWithHost(root, '{"local": true}', path.join(root, 'h'), () => [{ run: 'local', why: 'local:true in the call', override: 'call' }]);
  assert.deepStrictEqual(r.requests, [{ op: 'suite', measure: root, scope: 'full', files: [], flags: {}, local: true }]);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.ran, { channel: null, route: 'local:true in the call', override: 'call' });
});

test('a tree changed during a remote run appends the note to the digest', async () => {
  const root = mkRoot(CAPTURED.green);
  const r = await runWithHost(root, '{}', path.join(root, 'h'), () => [
    { run: 'remote', runner: 'runner-1', ...CAPTURED.green, signal: null, unknown: null, treeHash: TREE, note: '(tree changed during the run; the suite measured aaaaaaaa)' },
  ]);
  assert.match(r.digest, /^\[[^\]]+\] 3\/3 green \(\d+m \d{2}s\) \(runner runner-1\) \(tree changed during the run; the suite measured aaaaaaaa\)$/);
});

function stubConn(handler) {
  const calls = [];
  return {
    calls,
    conn: {
      suiteAsk: async (method, p, body) => {
        calls.push(`${method} ${p.split('?')[0]}`);
        return handler(method, p, body);
      },
    },
  };
}

function jobsAnswer(method, p, { state = 'done' } = {}) {
  if (p === '/api/suite/info') return { status: 200, body: { ok: true, limits: {}, env: { envKey: 'k' } } };
  if (method === 'POST') return { status: 200, body: { ok: true, state: 'queued' } };
  if (method === 'DELETE') return { status: 200, body: { ok: true } };
  if (p.includes('/output?')) {
    const text = p.includes('stream=stdout') ? 'TOTALS: 1 pass, 0 fail, 1 tests\n' : '';
    return { status: 200, body: { ok: true, text, offset: 0, total: Buffer.byteLength(text) } };
  }
  const id = decodeURIComponent(/ids=([^&]+)/.exec(p)[1]);
  return { status: 200, body: { ok: true, jobs: [{ id, state, treeHash: TREE, exit: { code: 0, signal: null }, reason: null, queueMs: 0, setupMs: 1, runMs: 2, out: {} }] } };
}

function clientWith(conn, extra = {}) {
  const sleeps = [];
  const client = createSuiteClient({
    getPeerManager: () => ({ get: (id) => (id === 'p1' ? conn : null) }),
    snapshot: stubSnap(), randomUUID: () => 'run-1', sleep: async (ms) => { sleeps.push(ms); }, ...extra,
  });
  return { client, sleeps };
}

test('client: the remote ledger start carries where (the runner name), queuedAt, dirty and the route; the end carries the tree', async () => {
  const ledgerFile = path.join(mkTmpRoot('suite-route-ledger-'), 'suite-runs.jsonl');
  const { conn } = stubConn((m, p) => jobsAnswer(m, p));
  const { client } = clientWith(conn, { ledgerFile, now: () => 1000 });
  const out = await client.run({ peer: 'p1', name: 'runner-1', tree: '/w', route: 'hands:all' });
  assert.strictEqual(out.unknown, null, 'ENTER: the run concluded');
  const [start, end] = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(start, {
    id: 'run-1', phase: 'start', where: 'runner-1', runner: 'p1', wire: 'push', jobId: 'run-1', attempt: 1,
    kind: 'hand', scope: 'full', team: null, ticket: null, seat: null,
    tree: '/w', sha: HEAD, treeHash: TREE, dirty: true, pid: null, route: 'hands:all', override: null,
    queuedAt: '1970-01-01T00:00:01.000Z', startedAt: '1970-01-01T00:00:01.000Z', env: { envKey: 'k' },
  });
  assert.deepStrictEqual([end.phase, end.where, end.tree, end.queuedAt], ['end', 'runner-1', '/w', '1970-01-01T00:00:01.000Z']);
});

test('client: a missing tree is a returned unknown, never a rejection', async () => {
  const { conn, calls } = stubConn((m, p) => jobsAnswer(m, p));
  const { client } = clientWith(conn);
  const out = await client.run({ peer: 'p1' });
  assert.deepStrictEqual([out.unknown, out.res, out.record.outcome, calls], ['no tree to measure', null, 'unknown', []]);
});

test('client: a release that throws leaves the result intact', async () => {
  const { conn } = stubConn((m, p) => jobsAnswer(m, p));
  const snapshot = { ...stubSnap(), releaseSnapshot: () => { throw new Error('EBUSY'); } };
  const { client } = clientWith(conn, { snapshot });
  const out = await client.run({ peer: 'p1', tree: '/w' });
  assert.deepStrictEqual([out.unknown, out.res.status, out.record.outcome], [null, 0, 'pass']);
});

test('client: a refused token is unknown at once, without waiting out the budget', async () => {
  const { conn } = stubConn(() => ({ status: 401, body: null, error: 'bad response' }));
  const { client, sleeps } = clientWith(conn);
  const out = await client.run({ peer: 'p1', tree: '/w' });
  assert.deepStrictEqual([out.unknown, sleeps], ['runner refused the token', []]);
});

test('client: a non-ok poll cancels the old job before resubmitting, and the resubmit stamps its own queuedAt', async () => {
  let clock = 0;
  let polls = 0;
  const { conn, calls } = stubConn((m, p) => {
    if (m === 'POST') clock += 1000;
    if (m === 'GET' && p.startsWith('/api/suite/jobs?') && (polls += 1) === 1) return { status: 500, body: { ok: false } };
    return jobsAnswer(m, p);
  });
  const { client } = clientWith(conn, { now: () => clock });
  const out = await client.run({ peer: 'p1', tree: '/w' });
  assert.deepStrictEqual([out.unknown, out.record.attempt], [null, 2], 'ENTER: the second attempt concluded');
  const firstDelete = calls.indexOf('DELETE /api/suite/jobs/run-1');
  const secondPost = calls.lastIndexOf('POST /api/suite/jobs');
  assert.ok(firstDelete !== -1 && firstDelete < secondPost, calls.join('\n'));
  assert.strictEqual(out.record.queuedAt, '1970-01-01T00:00:01.000Z');
});

test('host: an unreachable runner reports unknown at the 15-minute queue budget', async () => {
  let clock = 0;
  const { conn } = stubConn(() => ({ status: 0, body: null, error: 'connect ECONNREFUSED' }));
  const { client } = clientWith(conn, { now: () => clock, sleep: async (ms) => { clock += ms; } });
  const f = hostFor({ client });
  f.host.onMessage(ask(f.dir));
  assert.deepStrictEqual(await f.done, { run: 'remote', runner: 'runner-1', unknown: 'runner unreachable: connect ECONNREFUSED' });
  assert.strictEqual(clock, 15 * 60 * 1000);
});

test('host: a job that keeps running reports unknown at the 21-minute run limit plus the 17-minute setup slack and is cancelled', async () => {
  let clock = 0;
  const { conn, calls } = stubConn((m, p) => {
    const w = /[?&]wait=(\d+)/.exec(p);
    if (w) clock += Number(w[1]);
    return jobsAnswer(m, p, { state: 'running' });
  });
  const { client } = clientWith(conn, { now: () => clock });
  const f = hostFor({ client });
  f.host.onMessage(ask(f.dir));
  assert.deepStrictEqual(await f.done, { run: 'remote', runner: 'runner-1', unknown: 'no result within the 2280000ms run budget (cancelled)' });
  assert.strictEqual(clock, 25000 + 38 * 60 * 1000);
  assert.ok(calls.includes('DELETE /api/suite/jobs/run-1'), calls.join('\n'));
});

test('host: a cancel while the submit is in flight stops the job once the submit lands', async () => {
  let land;
  const landed = new Promise((r) => { land = r; });
  const events = [];
  const { conn, calls } = stubConn(async (m, p) => {
    if (m === 'POST') {
      await landed;
      events.push('POST landed');
    }
    if (m === 'DELETE') events.push(`DELETE ${p}`);
    return jobsAnswer(m, p);
  });
  const { client } = clientWith(conn);
  const f = hostFor({ client });
  f.host.onMessage(ask(f.dir));
  await turns();
  assert.ok(calls.includes('POST /api/suite/jobs'), 'ENTER: the submit is in flight');
  f.host.cancel();
  await turns();
  land();
  await f.done;
  assert.deepStrictEqual(events, ['POST landed', 'DELETE /api/suite/jobs/run-1']);
});

test('host: a cancel before the submit means no job is submitted', async () => {
  let open;
  const gate = new Promise((r) => { open = r; });
  const { conn, calls } = stubConn(async (m, p) => {
    if (p === '/api/suite/info') await gate;
    return jobsAnswer(m, p);
  });
  const { client } = clientWith(conn);
  const f = hostFor({ client });
  f.host.onMessage(ask(f.dir));
  await turns();
  assert.deepStrictEqual(calls, ['GET /api/suite/info'], 'ENTER: the client is waiting on the runner');
  f.host.cancel();
  open();
  assert.deepStrictEqual(await f.done, { run: 'remote', runner: 'runner-1', unknown: 'cancelled by the caller before submit' });
  assert.ok(!calls.includes('POST /api/suite/jobs'), calls.join('\n'));
});

test('exec: a progress line after the channel closed is not sent', async (t) => {
  const { client, child } = await inflightExec(t);
  assert.deepStrictEqual(child.sends, [{ progress: 'runner runner-1: job queued' }], 'ENTER: progress reached the open channel');
  child.connected = false;
  client.runs[0].onProgress('late line');
  assert.deepStrictEqual(child.sends, [{ progress: 'runner runner-1: job queued' }]);
});

test('t2416: the channel host\'s resolvePeer answers the member\'s address with its wire, a pull runner by its own name', async (t) => {
  const sc = require('../suite-client');
  const smPath = require.resolve('../session-manager');
  const real = sc.createChannelHost;
  const cached = require.cache[smPath];
  const seen = [];
  sc.createChannelHost = (opts) => { seen.push(opts); return real(opts); };
  delete require.cache[smPath];
  t.after(() => {
    sc.createChannelHost = real;
    if (cached) require.cache[smPath] = cached; else delete require.cache[smPath];
  });
  const push = { ...teamWith('all'), root: fs.realpathSync(mkTmpRoot('suite-route-tree-')) };
  execFixture(t, 'clodex-run-tests.js', { team: push });
  mock.timers.reset();
  execFixture(t, 'clodex-run-tests.js', { team: { ...push, testRunner: { peer: 'runner-1', hands: 'all', wire: 'pull' } } });
  await turns(2);
  assert.strictEqual(seen.length, 2, 'ENTER: both exec children got a channel host');
  assert.deepStrictEqual(seen[0].resolvePeer('runner-1'), { peer: 'p1', wire: 'push', name: 'runner-1' }, 'ENTER: runner-1 resolves to a peer row under push');
  assert.deepStrictEqual(seen[1].resolvePeer('runner-1'), { peer: 'runner-1', wire: 'pull', name: 'runner-1' });
  assert.strictEqual(seen[1].resolvePeer('runner-9'), null);
});

test('exec: a local:true call under hands:all leaves the lead one ticket-loop traffic row', async (t) => {
  const client = stubClient();
  const team = { ...teamWith('all'), root: fs.realpathSync(mkTmpRoot('suite-route-tree-')) };
  const f = execFixture(t, 'clodex-run-tests.js', { client, team });
  await turns(2);
  f.children[0].emit('message', ask(team.root, { local: true }));
  await turns();
  assert.deepStrictEqual(f.children[0].sends, [{ run: 'local', why: 'local:true in the call', override: 'call' }], 'ENTER: the host answered local');
  assert.deepStrictEqual(f.broadcasts.filter((b) => b && b.from === 'ticket-loop'), [{
    type: 'task', from: 'ticket-loop', to: 'lead-1',
    body: 'hand-1: clodex-run-tests ran here on request ({"local": true}); team tm routes hand runs to runner-1',
  }]);
});

test('reexecInMeasured runs only on the local arm: the measured tree\'s own script runs after a local answer, never after a remote one', async () => {
  const root = mkRoot(CAPTURED.green);
  const marker = path.join(root, 'reexec-marker');
  fs.writeFileSync(path.join(root, 'scripts', 'clodex-run-tests.js'),
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.exit(0);\n`);
  const remote = await runWithHost(root, '{}', path.join(root, 'h1'), () => [
    { run: 'remote', runner: 'runner-1', ...CAPTURED.green, signal: null, error: null, unknown: null, treeHash: TREE, note: null },
  ]);
  assert.strictEqual(remote.code, 0, 'ENTER: the remote arm completed');
  assert.strictEqual(fs.existsSync(marker), false);
  await runWithHost(root, '{}', path.join(root, 'h2'), () => [{ run: 'local', why: 'hands:off', override: null }]);
  assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'ran');
});

const POOL_TEAM = (pool = [{ peer: 'runner-b', wire: 'push' }]) => ({ name: 'tm', lead: 'lead-1', root: '/r', testRunner: { peer: 'runner-a', hands: 'all', wire: 'push', pool } });
const POOL_PEERS = { 'runner-a': 'pA', 'runner-b': 'pB' };
const VIA_B = { peer: 'pB', wire: 'push', name: 'runner-b' };
const DOWN = { status: 0, body: null, error: 'socket closed' };

function poolRig(script) {
  const clock = { t: 0 };
  const calls = [];
  const conn = (peer) => ({
    suiteAsk: async (method, p) => {
      calls.push(`${peer} ${method} ${p.split('?')[0]}`);
      if (p.startsWith('/api/suite/info')) return { status: 200, body: { ok: true, limits: {}, env: { envKey: 'k' } } };
      if (method === 'POST') return { status: 200, body: { ok: true, state: 'queued' } };
      if (method === 'DELETE') return { status: 200, body: { ok: true } };
      if (p.includes('/output?')) {
        const text = p.includes('stream=stdout') ? 'TOTALS: 4 pass, 0 fail, 4 tests\n' : '';
        return { status: 200, body: { ok: true, text, offset: 0, total: Buffer.byteLength(text) } };
      }
      if (script[peer].lost) return DOWN;
      const id = decodeURIComponent(/ids=([^&]+)/.exec(p)[1]);
      return { status: 200, body: { ok: true, jobs: [{ id, state: 'done', treeHash: TREE, exit: { code: 0, signal: null }, reason: null, queueMs: 0, setupMs: 1, runMs: 2, out: {} }] } };
    },
  });
  const ledgerFile = path.join(mkTmpRoot('suite-hand-pool-'), 'suite-runs.jsonl');
  const client = createSuiteClient({
    getPeerManager: () => ({ get: (id) => (script[id] ? conn(id) : null) }),
    ledgerFile, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, randomUUID: () => 'run-1', snapshot: stubSnap(),
  });
  const ends = () => fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.phase === 'end');
  return { client, calls, ends };
}

const posts = (calls) => calls.filter((c) => / POST \/api\/suite\/jobs$/.test(c));

test('t2414: on a pool whose first member is offline and whose pull member is detached the hand run goes to the push member, and the digest names it', async (t) => {
  const asked = [];
  const client = stubClient({ result: { unknown: null, res: { status: 0, signal: null, ...CAPTURED.green, treeHash: TREE } } });
  client.reachable = async (peer) => { asked.push(peer); return { ok: true, info: { limits: {}, env: {} } }; };
  const team = { ...POOL_TEAM([{ peer: 'laptop', wire: 'pull' }, { peer: 'runner-b', wire: 'push' }]), root: fs.realpathSync(mkTmpRoot('suite-route-tree-')) };
  const peers = { 'runner-a': { id: 'pA', online: false, caps: ['suite'] }, 'runner-b': { id: 'pB', online: true, caps: ['suite'] } };
  const f = execFixture(t, 'clodex-run-tests.js', { client, team, peers, desk: { attached: () => false } });
  await turns(2);
  f.children[0].emit('message', ask(team.root));
  await turns(40);
  assert.strictEqual(client.runs.length, 1, 'ENTER: the run was submitted');
  assert.deepStrictEqual(asked, ['pB']);
  const run = client.runs[0];
  assert.deepStrictEqual([run.peer, run.name, typeof run.repick, typeof run.reroute], ['pB', 'runner-b', 'function', 'function']);
  for (let i = 0; i < 5000 && !f.children[0].sends.some((m) => m.run); i += 1) await turns(1);
  const reply = f.children[0].sends.find((m) => m.run);
  assert.deepStrictEqual([reply.run, reply.runner, reply.unknown], ['remote', 'runner-b', null]);
  const root = mkRoot(CAPTURED.green);
  const d = await runWithHost(root, '{}', path.join(root, 'h'), () => [reply]);
  assert.match(d.digest, /^\[[^\]]+\] 3\/3 green \(\d+m \d{2}s\) \(runner runner-b\) \(pool: skipped runner-a: not connected, laptop: not connected\)$/);
});

test('t2414: a hand run whose runner is lost after accept is rerouted once; the reply, the digest and the ledger row name both runners', async () => {
  const r = poolRig({ pA: { lost: true }, pB: {} });
  const f = hostFor({ client: r.client, team: POOL_TEAM(), peers: POOL_PEERS, pool: async () => ({ chosen: null, repick: null, reroute: async (lost) => (lost === 'runner-a' ? VIA_B : null) }) });
  f.host.onMessage(ask(f.dir));
  const m = await f.done;
  assert.deepStrictEqual([m.run, m.runner, m.unknown, m.rerouted], ['remote', 'runner-b', null, { from: 'runner-a', to: 'runner-b' }]);
  assert.deepStrictEqual(posts(r.calls), ['pA POST /api/suite/jobs', 'pB POST /api/suite/jobs']);
  assert.deepStrictEqual(r.ends().map((x) => [x.kind, x.where, x.runner, x.attempts]), [['hand', 'runner-b', 'pB', [{ runner: 'runner-a', jobId: 'run-1', outcome: 'lost' }, { runner: 'runner-b', jobId: 'run-1-2', outcome: 'pass' }]]]);
  const root = mkRoot({ status: m.status, stdout: m.stdout, stderr: m.stderr });
  const d = await runWithHost(root, '{}', path.join(root, 'h'), () => [m]);
  assert.match(d.digest, /^\[[^\]]+\] 4\/4 green \(\d+m \d{2}s\) \(rerouted from runner-a to runner-b\)$/);
});

test('t2414: a lost runner with no other member ends the hand run unknown at 150 s naming it, exits non-zero and starts no local run', async () => {
  const r = poolRig({ pA: { lost: true } });
  const f = hostFor({ client: r.client, team: POOL_TEAM([]), peers: POOL_PEERS, pool: async () => ({ chosen: null, repick: null, reroute: async () => null }) });
  f.host.onMessage(ask(f.dir));
  const m = await f.done;
  assert.deepStrictEqual(m, { run: 'remote', runner: 'runner-a', unknown: 'runner unreachable' });
  assert.deepStrictEqual(r.ends().map((x) => [x.where, x.outcome, x.endedAt]), [['runner-a', 'unknown', '1970-01-01T00:02:30.000Z']]);
  const root = mkRoot(CAPTURED.green);
  const d = await runWithHost(root, '{}', path.join(root, 'h'), () => [m]);
  assert.strictEqual(d.digest, `[${path.basename(root)}] result unknown — the suite did not complete on runner runner-a: runner unreachable`);
  assert.deepStrictEqual([d.code, d.ran], [1, null]);
});

test('t2414: a second loss after the reroute ends the hand run unknown naming the second runner, with no third submit', async () => {
  const r = poolRig({ pA: { lost: true }, pB: { lost: true } });
  const f = hostFor({ client: r.client, team: POOL_TEAM(), peers: POOL_PEERS, pool: async () => ({ chosen: null, repick: null, reroute: async () => VIA_B }) });
  f.host.onMessage(ask(f.dir));
  assert.deepStrictEqual(await f.done, { run: 'remote', runner: 'runner-b', unknown: 'runner unreachable' });
  assert.deepStrictEqual(posts(r.calls), ['pA POST /api/suite/jobs', 'pB POST /api/suite/jobs']);
});

test('t2414: local:true runs here and never asks the pool', async () => {
  let picks = 0;
  const client = stubClient();
  const f = hostFor({ client, team: POOL_TEAM(), peers: POOL_PEERS, pool: async () => { picks += 1; return null; } });
  f.host.onMessage(ask(f.dir, { local: true }));
  assert.deepStrictEqual(await f.done, { run: 'local', why: 'local:true in the call', override: 'call' });
  assert.deepStrictEqual([picks, client.runs.length], [0, 0]);
});

test('t2416: on a mixed pool whose push member is offline the hand run is picked onto the attached pull member', async (t) => {
  const asked = [];
  const client = stubClient({ result: { unknown: null, res: { status: 0, signal: null, ...CAPTURED.green, treeHash: TREE } } });
  client.reachable = async (peer, wire) => { asked.push(`${peer}/${wire}`); return { ok: true, info: { limits: {}, env: {} } }; };
  const team = { ...POOL_TEAM([{ peer: 'laptop', wire: 'pull' }]), root: fs.realpathSync(mkTmpRoot('suite-route-tree-')) };
  const peers = { 'runner-a': { id: 'pA', online: false, caps: ['suite'] } };
  const f = execFixture(t, 'clodex-run-tests.js', { client, team, peers, desk: { attached: (o) => o === 'laptop' } });
  await turns(2);
  f.children[0].emit('message', ask(team.root));
  await turns(40);
  assert.strictEqual(client.runs.length, 1, 'ENTER: the run was submitted');
  assert.deepStrictEqual(asked, ['laptop/pull']);
  const run = client.runs[0];
  assert.deepStrictEqual([run.peer, run.wire, run.name, typeof run.repick, typeof run.reroute], ['laptop', 'pull', 'laptop', 'function', 'function']);
  for (let i = 0; i < 5000 && !f.children[0].sends.some((m) => m.run); i += 1) await turns(1);
  const reply = f.children[0].sends.find((m) => m.run);
  assert.deepStrictEqual([reply.run, reply.runner, reply.unknown], ['remote', 'laptop', null]);
});

function deskRig(script) {
  const clock = { t: 0 };
  const calls = [];
  const bodies = [];
  const conn = (origin) => ({
    suiteAsk: async (method, p, body) => {
      calls.push(`desk:${origin} ${method} ${p.split('?')[0]}`);
      if (method === 'POST') bodies.push(body);
      if (script[origin].hold && method === 'POST') await script[origin].hold;
      if (script[origin].lost && method === 'GET' && !p.startsWith('/api/suite/info')) return { status: 503, body: null, error: `runner ${origin} is not attached` };
      return jobsAnswer(method, p.startsWith('/api/suite/info') ? '/api/suite/info' : p);
    },
  });
  const ledgerFile = path.join(mkTmpRoot('suite-hand-desk-'), 'suite-runs.jsonl');
  const client = createSuiteClient({
    getPeerManager: () => ({ get: () => null }),
    getSuiteDesk: () => ({ conn: (o) => (script[o] ? conn(o) : null) }),
    ledgerFile, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, randomUUID: () => 'run-1', snapshot: stubSnap(),
  });
  const ends = () => fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.phase === 'end');
  return { client, calls, bodies, ends };
}

const PULL_TEAM = (extra = {}) => ({ name: 'tm', lead: 'lead-1', root: '/r', testRunner: { peer: 'laptop', hands: 'all', wire: 'pull', ...extra } });
const PULL_PEERS = { laptop: { peer: 'laptop', wire: 'pull', name: 'laptop' } };

test('t2416: a hand run on a single pull runner goes through the desk connection and the digest names the runner', async () => {
  const r = deskRig({ laptop: {} });
  const f = hostFor({ client: r.client, team: PULL_TEAM(), peers: PULL_PEERS });
  f.host.onMessage(ask(f.dir));
  const m = await f.done;
  assert.deepStrictEqual([m.run, m.runner, m.unknown, m.status], ['remote', 'laptop', null, 0]);
  assert.deepStrictEqual(r.calls.filter((c) => c.includes(' POST ')), ['desk:laptop POST /api/suite/jobs']);
  assert.deepStrictEqual(r.ends().map((x) => [x.kind, x.where, x.wire, x.outcome]), [['hand', 'laptop', 'pull', 'pass']]);
  const root = mkRoot({ status: m.status, stdout: m.stdout, stderr: m.stderr });
  const d = await runWithHost(root, '{}', path.join(root, 'h'), () => [m]);
  assert.match(d.digest, /^\[[^\]]+\] 1\/1 green \(\d+m \d{2}s\) \(runner laptop\)$/);
});

test('t2416: a single-file hand run on a pull runner carries its files and the team env in the job body', async () => {
  const r = deskRig({ laptop: {} });
  const f = hostFor({ client: r.client, team: PULL_TEAM({ env: { FOO: 'bar' } }), peers: PULL_PEERS });
  f.host.onMessage(ask(f.dir, { scope: 'own', files: ['test/x.test.js'] }));
  assert.strictEqual((await f.done).unknown, null);
  assert.deepStrictEqual(r.bodies.map((b) => [b.kind, b.scope, b.files, b.env]), [['hand', 'own', ['test/x.test.js'], { FOO: 'bar' }]]);
});

test('t2416: a pull runner detached for 150 s after accept is rerouted once to the second member', async () => {
  const r = deskRig({ laptop: { lost: true }, desktop: {} });
  const f = hostFor({
    client: r.client, team: PULL_TEAM({ pool: [{ peer: 'desktop', wire: 'pull' }] }), peers: PULL_PEERS,
    pool: async () => ({ chosen: null, repick: null, reroute: async (lost) => (lost === 'laptop' ? { peer: 'desktop', wire: 'pull', name: 'desktop' } : null) }),
  });
  f.host.onMessage(ask(f.dir));
  const m = await f.done;
  assert.deepStrictEqual([m.run, m.runner, m.unknown, m.rerouted], ['remote', 'desktop', null, { from: 'laptop', to: 'desktop' }]);
  assert.deepStrictEqual(r.calls.filter((c) => c.includes(' POST ')), ['desk:laptop POST /api/suite/jobs', 'desk:desktop POST /api/suite/jobs']);
});

test('t2416: a pull runner detached for 150 s with no other member ends the hand run unknown and starts no local run', async () => {
  const r = deskRig({ laptop: { lost: true } });
  const f = hostFor({ client: r.client, team: PULL_TEAM(), peers: PULL_PEERS, pool: async () => ({ chosen: null, repick: null, reroute: async () => null }) });
  f.host.onMessage(ask(f.dir));
  const m = await f.done;
  assert.deepStrictEqual(m, { run: 'remote', runner: 'laptop', unknown: 'runner unreachable' });
  assert.deepStrictEqual(r.ends().map((x) => [x.where, x.wire, x.outcome, x.endedAt]), [['laptop', 'pull', 'unknown', '1970-01-01T00:02:30.000Z']]);
  const root = mkRoot(CAPTURED.green);
  const d = await runWithHost(root, '{}', path.join(root, 'h'), () => [m]);
  assert.strictEqual(d.digest, `[${path.basename(root)}] result unknown — the suite did not complete on runner laptop: runner unreachable`);
  assert.deepStrictEqual([d.code, d.ran], [1, null]);
});

test('t2416: a cancel from the hand while the submit is in flight reaches the pull runner\'s job through the desk', async () => {
  let land;
  const r = deskRig({ laptop: { hold: new Promise((res) => { land = res; }) } });
  const f = hostFor({ client: r.client, team: PULL_TEAM(), peers: PULL_PEERS });
  f.host.onMessage(ask(f.dir));
  await turns();
  assert.ok(r.calls.includes('desk:laptop POST /api/suite/jobs'), 'ENTER: the submit is in flight');
  f.host.cancel();
  await turns();
  land();
  await f.done;
  assert.ok(r.calls.includes('desk:laptop DELETE /api/suite/jobs/run-1'));
});

const PICK_ROWS = [
  ['a pick that returns nothing uses the first member', async () => ({ chosen: null, repick: null, reroute: async () => null }), ['pA', 'runner-a', false]],
  ['a pick that throws uses the first member', async () => { throw new Error('probe failed'); }, ['pA', 'runner-a', false]],
  ['a chosen member gets the repick', async () => ({ chosen: 'runner-b', repick: async () => VIA_B, reroute: async () => null }), ['pB', 'runner-b', true]],
];

for (const [name, pool, want] of PICK_ROWS) {
  test(`t2414: ${name}`, async () => {
    const client = stubClient({ result: { unknown: null, res: { status: 0, signal: null, stdout: '', stderr: '', treeHash: TREE } } });
    const f = hostFor({ client, team: POOL_TEAM(), peers: POOL_PEERS, pool });
    f.host.onMessage(ask(f.dir));
    assert.strictEqual((await f.done).runner, want[1]);
    assert.deepStrictEqual([client.runs[0].peer, client.runs[0].name, 'repick' in client.runs[0]], want);
  });
}

const KILLED_OUT = [
  '...',
  `▶ ${'x'.repeat(250)}`,
  'second\u001b[31m red\u0007 line',
  '',
  'last line before the kill',
  '',
].join('\n');
const KILLED_ERR = 'noise\nrun-tests: TIMEOUT after 300000ms in test/hangs.test.js\n';

function killedAnswer(method, p, { stdout = KILLED_OUT, stderr = KILLED_ERR } = {}) {
  if (p.includes('/output?')) {
    const text = p.includes('stream=stdout') ? stdout : stderr;
    return { status: 200, body: { ok: true, text, offset: 0, total: Buffer.byteLength(text) } };
  }
  if (method === 'GET' && /ids=/.test(p)) {
    const id = decodeURIComponent(/ids=([^&]+)/.exec(p)[1]);
    return { status: 200, body: { ok: true, jobs: [{ id, state: 'done', treeHash: TREE, exit: { code: null, signal: 'SIGKILL' }, reason: 'timeout', queueMs: 0, setupMs: 1, runMs: 2, out: {} }] } };
  }
  return jobsAnswer(method, p);
}

const KILLED_TAIL = `; last output: ▶ ${'x'.repeat(198)} | second [31m red  line | last line before the kill; run-tests: TIMEOUT after 300000ms in test/hangs.test.js`;

test('t2418: a killed job names the asked limit and its last three stdout lines, cut and flattened, then the hung-file line; no totals', async () => {
  const { conn } = stubConn((m, p) => killedAnswer(m, p));
  const { client } = clientWith(conn);
  const out = await client.run({ peer: 'p1', name: 'runner-1', tree: '/w', timeoutMs: 30 * 60 * 1000 });
  assert.ok(out.unknown.includes('last line before the kill'), `ENTER: ${out.unknown}`);
  assert.strictEqual(out.unknown, `the suite did not finish within 1800000ms (killed)${KILLED_TAIL}`);
  assert.deepStrictEqual([out.record.outcome, out.record.pass, out.record.fail, out.record.tests], ['timeout', null, null, null]);
});

test('t2418: a killed job with no output and no hung line keeps the bare killed text', async () => {
  const { conn } = stubConn((m, p) => killedAnswer(m, p, { stdout: '\n\n', stderr: 'other\n' }));
  const { client } = clientWith(conn);
  const out = await client.run({ peer: 'p1', name: 'runner-1', tree: '/w' });
  assert.strictEqual(out.unknown, 'the suite did not finish within 1260000ms (killed)');
});

test('t2418: a runner refusing the asked timeoutMs reads as one line naming both numbers, outcome unknown, with no resubmit', async () => {
  const { conn, calls } = stubConn((m, p) => (m === 'POST' && p === '/api/suite/jobs' ? { status: 400, body: { ok: false, error: 'bad timeoutMs' } } : jobsAnswer(m, p)));
  const { client } = clientWith(conn);
  const out = await client.run({ peer: 'p1', name: 'runner-1', tree: '/w', timeoutMs: 30 * 60 * 1000 });
  assert.strictEqual(out.unknown, 'runner refused the job: bad timeoutMs — the job asked for 1800000ms, the runner\'s ceiling is lower and its info route does not report it');
  assert.strictEqual(calls.filter((c) => c === 'POST /api/suite/jobs').length, 1);
  assert.deepStrictEqual(boxVerdict(out, null), { fallback: 'outcome unknown', fallbackCode: 'outcome-unknown', fallbackClass: 'unknown' });
});

test('t2418: a runner that reports its ceiling has it named in the refusal', async () => {
  const { conn } = stubConn((m, p) => {
    if (p === '/api/suite/info') return { status: 200, body: { ok: true, limits: { maxTimeoutMs: 1200000 }, env: { envKey: 'k' } } };
    if (m === 'POST' && p === '/api/suite/jobs') return { status: 400, body: { ok: false, error: 'bad timeoutMs' } };
    return jobsAnswer(m, p);
  });
  const { client } = clientWith(conn);
  const out = await client.run({ peer: 'p1', name: 'runner-1', tree: '/w', timeoutMs: 30 * 60 * 1000 });
  assert.strictEqual(out.unknown, 'runner refused the job: bad timeoutMs — the job asked for 1800000ms, the runner\'s ceiling is 1200000ms');
});

test('t2418: a hand run sends env with handEnv over it, and its whole budget is queue plus run plus the setup slack', async () => {
  const client = stubClient({ result: { unknown: null, res: { status: 0, signal: null, stdout: '', stderr: '', treeHash: TREE } } });
  const team = { ...teamWith('all'), testRunner: { peer: 'runner-1', hands: 'all', runMs: 30 * 60 * 1000, env: { A: '1', B: '2' }, handEnv: { B: 'hand', C: '3' } } };
  const f = hostFor({ client, team });
  f.host.onMessage(ask(f.dir));
  await f.done;
  const r = client.runs[0];
  assert.deepStrictEqual([r.runBudgetMs, r.timeoutMs, r.budgetMs, r.queueBudgetMs, r.env], [2280000, 1260000, 3180000, 900000, { A: '1', B: 'hand', C: '3' }]);
});

test('t2418: the hand digest carries the killed run\'s last output whole', async () => {
  const root = mkRoot(CAPTURED.green);
  const leaf = path.basename(root);
  const why = `the suite did not finish within 1800000ms (killed)${KILLED_TAIL}`;
  const r = await runWithHost(root, '{}', path.join(root, 'h'), () => [{ run: 'remote', runner: 'runner-1', unknown: why }]);
  assert.ok(r.digest.includes('run-tests: TIMEOUT after 300000ms in test/hangs.test.js'), `ENTER: ${r.digest}`);
  assert.strictEqual(r.digest, `[${leaf}] result unknown — the suite did not complete on runner runner-1: ${why}`);
});

test('t2418: a hand run whose job spends 30 s in setup gets the runner\'s kill and its last output, not the run-budget cancel', async () => {
  const clock = { t: 0 };
  const RUN = 21 * 60 * 1000;
  const { conn, calls } = stubConn((m, p) => {
    if (m !== 'GET' || !/ids=/.test(p)) return killedAnswer(m, p);
    const id = decodeURIComponent(/ids=([^&]+)/.exec(p)[1]);
    const wait = Number((/wait=(\d+)/.exec(p) || [0, 0])[1]);
    if (clock.t >= 30000 + RUN) return killedAnswer(m, p);
    const state = clock.t < 30000 ? 'setup' : 'running';
    clock.t += Math.max(wait, 1000);
    return { status: 200, body: { ok: true, jobs: [{ id, state, treeHash: TREE, exit: null, reason: null, queueMs: 0, out: {} }] } };
  });
  const { client } = clientWith(conn, { now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
  const f = hostFor({ client });
  f.host.onMessage(ask(f.dir));
  const done = await f.done;
  assert.ok(calls.includes('GET /api/suite/jobs'), `ENTER: the client polled the job: ${calls.join(', ')}`);
  assert.strictEqual(done.unknown, `the suite did not finish within 1260000ms (killed)${KILLED_TAIL}`);
  assert.deepStrictEqual(calls.filter((c) => c.startsWith('DELETE')), []);
});

test('t2418: a team runMs moves the exec ceiling of clodex-run-tests by runMs minus 21 minutes over the hand slack, and the channel host gets it', async (t) => {
  const client = stubClient({ hang: true });
  const team = { ...teamWith('all'), testRunner: { peer: 'runner-1', hands: 'all', runMs: 30 * 60 * 1000 }, root: fs.realpathSync(mkTmpRoot('suite-route-tree-')) };
  const f = execFixture(t, 'clodex-run-tests.js', { client, team });
  await turns(2);
  const child = f.children[0];
  child.emit('message', ask(team.root));
  await turns();
  assert.strictEqual(client.runs.length, 1, 'ENTER: the job is in flight');
  assert.deepStrictEqual([client.runs[0].timeoutMs, client.runs[0].runBudgetMs, client.runs[0].budgetMs], [1800000, 2820000, 3720000]);
  mock.timers.tick(5000);
  assert.deepStrictEqual(child.kills, [], 'not killed at the def ceiling');
  mock.timers.tick(28 * 60 * 1000 - 1);
  assert.deepStrictEqual(child.kills, []);
  mock.timers.tick(1);
  assert.deepStrictEqual(child.kills, ['SIGKILL']);
});

test('t2418: a team setup.timeoutMs of 30 min widens the hand run budget to runMs plus 32 min and the exec ceiling by 34 min', async (t) => {
  const client = stubClient({ hang: true });
  const setup = { run: 'npm ci', key: ['package-lock.json'], paths: ['node_modules'], timeoutMs: 1800000 };
  const team = { ...teamWith('all'), testRunner: { peer: 'runner-1', hands: 'all', runMs: 30 * 60 * 1000, setup }, root: fs.realpathSync(mkTmpRoot('suite-route-tree-')) };
  const f = execFixture(t, 'clodex-run-tests.js', { client, team });
  await turns(2);
  const child = f.children[0];
  child.emit('message', ask(team.root));
  await turns();
  assert.strictEqual(client.runs.length, 1, 'ENTER: the job is in flight');
  assert.deepStrictEqual([client.runs[0].timeoutMs, client.runs[0].runBudgetMs, client.runs[0].budgetMs], [1800000, 3720000, 4620000]);
  mock.timers.tick(5000 + 43 * 60 * 1000 - 1);
  assert.deepStrictEqual(child.kills, []);
  mock.timers.tick(1);
  assert.deepStrictEqual(child.kills, ['SIGKILL']);
});

test('t2418: a clodex-run-tests call with local:true keeps the def ceiling, with no hand slack', async (t) => {
  const team = { ...teamWith('all'), testRunner: { peer: 'runner-1', hands: 'all', runMs: 30 * 60 * 1000 }, root: fs.realpathSync(mkTmpRoot('suite-route-tree-')) };
  const f = execFixture(t, 'clodex-run-tests.js', { client: stubClient({ hang: true }), team, payload: '{"local":true}' });
  await turns(2);
  const child = f.children[0];
  assert.ok(child, 'ENTER: the exec spawned');
  mock.timers.tick(5000 - 1);
  assert.deepStrictEqual(child.kills, []);
  mock.timers.tick(1);
  assert.deepStrictEqual(child.kills, ['SIGKILL']);
});

test('t2418: a failed clodex-run-tests delivers its long last stderr line past 200 characters', async (t) => {
  const team = { ...teamWith('all'), root: fs.realpathSync(mkTmpRoot('suite-route-tree-')) };
  const f = execFixture(t, 'clodex-run-tests.js', { client: stubClient({ hang: true }), team });
  await turns(2);
  const line = `[leaf] result unknown — the suite did not complete on runner runner-1: the suite did not finish within 1800000ms (killed)${KILLED_TAIL}`;
  assert.ok(line.length > 400, 'ENTER: the line is past the old cut');
  f.children[0].stderr.emit('data', `${line}\n`);
  f.children[0].emit('close', 1, null);
  const err = f.broadcasts.filter((b) => b && b.type === 'exec' && String(b.body).startsWith('err: '));
  assert.deepStrictEqual(err.map((b) => b.body), [`err: exit 1: ${line}`]);
});

const HAND_BOX_TEXT = 'FROM node:24-bookworm\nRUN true\n';
const HAND_BOX_HASH = require('../team-box').boxFingerprint(HAND_BOX_TEXT);
const HAND_DEF = { definitionHash: HAND_BOX_HASH, rev: 1, definition: HAND_BOX_TEXT };
const HAND_SHARES = [{ share: 'assets', version: 'v1' }];
const BOX_READY = { state: 'ready', env: { isolation: 'container', box: { imageId: 'sha256:0123456789abcdef', definitionHash: HAND_BOX_HASH } } };
const STAMPED = { platform: 'linux', arch: 'arm64', isolation: 'container', box: { imageId: 'sha256:0123456789abcdef', definitionHash: HAND_BOX_HASH, shares: [{ name: 'assets', version: 'v1' }] } };

function boxRig(wire, { info = {}, jobEnv = STAMPED, jobExtra = {} } = {}) {
  const calls = [];
  const bodies = [];
  const conn = {
    suiteAsk: async (method, p, body) => {
      calls.push(`${method} ${p.split('?')[0]}`);
      if (method === 'POST') bodies.push(body);
      if (p.startsWith('/api/suite/info')) return { status: 200, body: { ok: true, limits: {}, env: { envKey: 'k' }, ...info } };
      if (method === 'POST') return { status: 200, body: { ok: true, state: 'queued' } };
      if (method === 'DELETE') return { status: 200, body: { ok: true } };
      if (p.includes('/output?')) {
        const text = p.includes('stream=stdout') ? 'TOTALS: 2 pass, 0 fail, 2 tests\n' : '';
        return { status: 200, body: { ok: true, text, offset: 0, total: Buffer.byteLength(text) } };
      }
      const id = decodeURIComponent(/ids=([^&]+)/.exec(p)[1]);
      return { status: 200, body: { ok: true, jobs: [{ id, state: 'done', treeHash: TREE, env: jobEnv, exit: { code: 0, signal: null }, reason: null, queueMs: 0, setupMs: 1, runMs: 2, out: {}, ...jobExtra }] } };
    },
  };
  const ledgerFile = path.join(mkTmpRoot('suite-hand-box-'), 'suite-runs.jsonl');
  const client = createSuiteClient({
    getPeerManager: () => ({ get: (id) => (wire === 'push' && id === 'p1' ? conn : null) }),
    getSuiteDesk: () => ({ conn: (o) => (wire === 'pull' && o === 'laptop' ? conn : null) }),
    ledgerFile, now: () => 0, sleep: async () => {}, randomUUID: () => 'run-1', snapshot: stubSnap(),
  });
  const ends = () => fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.phase === 'end');
  const host = (box, extra = {}) => (wire === 'push'
    ? hostFor({ client, box, team: { ...teamWith('all'), testRunner: { peer: 'runner-1', hands: 'all', box: true, shares: HAND_SHARES, ...extra } } })
    : hostFor({ client, box, team: PULL_TEAM({ box: true, shares: HAND_SHARES, ...extra }), peers: PULL_PEERS }));
  return { client, calls, bodies, ends, host, runner: wire === 'push' ? 'runner-1' : 'laptop' };
}

test('t2419: a team without box:true sends its hand job with no isolation, box or shares, even with shares set', async () => {
  const r = boxRig('push');
  const f = hostFor({ client: r.client, box: () => false, team: { ...teamWith('all'), testRunner: { peer: 'runner-1', hands: 'all', shares: HAND_SHARES } } });
  f.host.onMessage(ask(f.dir));
  const m = await f.done;
  assert.strictEqual(m.box, undefined);
  assert.deepStrictEqual(r.bodies, [{
    id: 'run-1', attempt: 1, repoKey: undefined, kind: 'hand', scope: 'full', team: 'tm', ticket: null, seat: 'hand-1',
    snap: undefined, treeHash: TREE, indexTree: undefined, sha: HEAD, branch: undefined, trunk: undefined, refs: undefined, candidates: undefined,
    files: [], flags: {}, env: {}, setup: null, timeoutMs: 1260000, full: false,
  }]);
});


const NATIVE_RAN = { platform: 'linux', arch: 'arm64', isolation: 'none' };

for (const [said, recorded, note] of [
  [{ exclusive: 'honoured' }, 'honoured', null],
  [{ exclusive: 'ignored' }, 'ignored', '(did not run alone: the runner\'s owner set it to ignore exclusive requests, so other jobs could run beside it)'],
  [{}, 'unsupported', '(did not run alone: the runner is too old to know exclusive jobs, so other jobs could run beside it)'],
]) {
  test(`t2428: an exclusive team's hand job carries exclusive: true; a runner answering ${recorded} lands in the end row${note ? ' and the digest says it did not run alone' : ''}`, async () => {
    const r = boxRig('push', { jobEnv: NATIVE_RAN, jobExtra: said });
    const f = hostFor({ client: r.client, box: () => false, team: { ...teamWith('all'), testRunner: { peer: 'runner-1', hands: 'all', exclusive: true } } });
    f.host.onMessage(ask(f.dir));
    const m = await f.done;
    assert.strictEqual(m.unknown, null, 'ENTER: the run concluded');
    assert.deepStrictEqual(r.bodies.map((b) => b.exclusive), [true]);
    assert.deepStrictEqual(r.ends().map((x) => x.exclusive), [recorded]);
    assert.strictEqual(m.note, note);
    const root = mkRoot({ status: m.status, stdout: m.stdout, stderr: m.stderr });
    const d = await runWithHost(root, '{}', path.join(root, 'h'), () => [m]);
    assert.strictEqual(d.digest.endsWith(note ? `(runner runner-1) ${note}` : '(runner runner-1)'), true, d.digest);
  });
}

test('t2428: a team without the key leaves exclusive out of the end row', async () => {
  const r = boxRig('push', { jobEnv: NATIVE_RAN, jobExtra: { exclusive: 'honoured' } });
  const f = hostFor({ client: r.client, box: () => false, team: { ...teamWith('all'), testRunner: { peer: 'runner-1', hands: 'all' } } });
  f.host.onMessage(ask(f.dir));
  assert.strictEqual((await f.done).unknown, null, 'ENTER: the run concluded');
  assert.deepStrictEqual(r.ends().map((x) => 'exclusive' in x), [false]);
});
for (const wire of ['push', 'pull']) {
  test(`t2419: a box:true team's hand run on a ${wire} runner sends the box definition and shares; the reply, ledger row and digest show the box`, async () => {
    const r = boxRig(wire, { info: { box: BOX_READY, shares: [{ name: 'assets', version: 'v1' }] } });
    const f = r.host(() => HAND_DEF);
    f.host.onMessage(ask(f.dir));
    const m = await f.done;
    assert.strictEqual(m.unknown, null, 'ENTER: the boxed run concluded');
    assert.deepStrictEqual(r.bodies.map((b) => [b.isolation, b.box, b.shares]), [['container', HAND_DEF, HAND_SHARES]]);
    assert.deepStrictEqual(m.box, { isolation: 'container', imageId: 'sha256:0123456789abcdef' });
    assert.deepStrictEqual(r.ends().map((x) => [x.kind, x.where, x.wire, x.outcome, x.env]), [['hand', r.runner, wire, 'pass', STAMPED]]);
    const root = mkRoot({ status: m.status, stdout: m.stdout, stderr: m.stderr });
    const d = await runWithHost(root, '{}', path.join(root, 'h'), () => [m]);
    assert.match(d.digest, new RegExp(`^\\[[^\\]]+\\] 2/2 green \\(\\d+m \\d{2}s\\) \\(runner ${r.runner}\\) \\(box container, image 0123456789ab\\)$`));
  });
}

const BOX_FAIL_ROWS = [
  ['a runner with no box under box:true', () => true, { info: { box: { state: 'unavailable', why: 'no container daemon' } } }, 'runner has no box: no container daemon', 0],
  ['a runner without the share', () => HAND_DEF, { info: { box: BOX_READY, shares: [{ name: 'assets', version: 'v0' }] } }, 'runner has no share assets@v1', 0],
  ['a runner that ran it native', () => HAND_DEF, { info: { box: BOX_READY, shares: [{ name: 'assets', version: 'v1' }] }, jobEnv: { platform: 'linux', isolation: 'none' } }, 'box mismatch: asked container, runner ran none', 1],
];

for (const wire of ['push', 'pull']) {
  for (const [name, box, rig, why, submits] of BOX_FAIL_ROWS) {
    test(`t2419: ${name} (${wire}) reaches the hand's digest as result unknown naming the runner, never a test result`, async () => {
      const r = boxRig(wire, rig);
      const f = r.host(box);
      f.host.onMessage(ask(f.dir));
      const m = await f.done;
      assert.deepStrictEqual(m, { run: 'remote', runner: r.runner, unknown: why });
      assert.strictEqual(r.bodies.length, submits);
      const root = mkRoot(CAPTURED.green);
      const d = await runWithHost(root, '{}', path.join(root, 'h'), () => [m]);
      assert.strictEqual(d.digest, `[${path.basename(root)}] result unknown — the suite did not complete on runner ${r.runner}: ${why}`);
      assert.deepStrictEqual([d.code, d.ran], [1, null]);
    });
  }
}

function boxTeam(withDef, extra = {}) {
  const dir = mkTmpRoot('suite-hand-box-team-');
  if (withDef) require('../team-box').writeBox(dir, HAND_BOX_TEXT);
  return { ...teamWith('all'), dir, root: fs.realpathSync(mkTmpRoot('suite-route-tree-')), testRunner: { peer: 'runner-1', hands: 'all', box: true, shares: HAND_SHARES, ...extra } };
}

test('t2419: a box:true team with a definition sends it from the exec, and the exec ceiling grows by the queue and build budgets', async (t) => {
  const client = stubClient({ hang: true });
  const team = boxTeam(true);
  const f = execFixture(t, 'clodex-run-tests.js', { client, team });
  await turns(2);
  const child = f.children[0];
  child.emit('message', ask(team.root));
  await turns();
  assert.strictEqual(client.runs.length, 1, 'ENTER: the job is in flight');
  assert.deepStrictEqual([client.runs[0].box, client.runs[0].shares], [HAND_DEF, HAND_SHARES]);
  mock.timers.tick(5000 + 19 * 60 * 1000 + 40 * 60 * 1000 - 1);
  assert.deepStrictEqual(child.kills, []);
  mock.timers.tick(1);
  assert.deepStrictEqual(child.kills, ['SIGKILL']);
});

const fnless = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'function' ? 'function' : v]));

test('t2425: with no queueMs the hand run options are exactly the 15 min queue ones', async (t) => {
  const client = stubClient({ hang: true });
  const team = { ...teamWith('all'), root: fs.realpathSync(mkTmpRoot('suite-route-tree-')) };
  const f = execFixture(t, 'clodex-run-tests.js', { client, team });
  await turns(2);
  f.children[0].emit('message', ask(team.root));
  await turns();
  assert.strictEqual(client.runs.length, 1, 'ENTER: the job is in flight');
  assert.deepStrictEqual(fnless(client.runs[0]), {
    peer: 'p1', wire: 'push', name: 'runner-1', tree: team.root, kind: 'hand', scope: 'full', team: 'tm', ticket: null, seat: 'hand-1',
    files: [], flags: {}, setup: null, env: {},
    queueBudgetMs: 900000, runBudgetMs: 2280000, timeoutMs: 1260000, budgetMs: 3180000, route: 'hands:all',
    shouldStop: 'function', onSubmitted: 'function', onProgress: 'function', reroute: 'function', onReroute: 'function',
  });
});

test('t2425: a team queueMs of 45 min is the hand queue budget, and the client budget and exec ceiling grow by 30 min', async (t) => {
  const client = stubClient({ hang: true });
  const team = { ...teamWith('all'), testRunner: { peer: 'runner-1', hands: 'all', queueMs: 45 * 60 * 1000 }, root: fs.realpathSync(mkTmpRoot('suite-route-tree-')) };
  const f = execFixture(t, 'clodex-run-tests.js', { client, team });
  await turns(2);
  const child = f.children[0];
  child.emit('message', ask(team.root));
  await turns();
  assert.strictEqual(client.runs.length, 1, 'ENTER: the job is in flight');
  const r = client.runs[0];
  assert.deepStrictEqual([r.queueBudgetMs, r.runBudgetMs, r.timeoutMs, r.budgetMs], [2700000, 2280000, 1260000, 4980000]);
  mock.timers.tick(5000 + 19 * 60 * 1000 + 30 * 60 * 1000 - 1);
  assert.deepStrictEqual(child.kills, []);
  mock.timers.tick(1);
  assert.deepStrictEqual(child.kills, ['SIGKILL']);
});

test('t2425: a box team with a definition and queueMs 45 min adds the 45 min queue again for the build', async (t) => {
  const client = stubClient({ hang: true });
  const team = boxTeam(true, { queueMs: 45 * 60 * 1000 });
  const f = execFixture(t, 'clodex-run-tests.js', { client, team });
  await turns(2);
  const child = f.children[0];
  child.emit('message', ask(team.root));
  await turns();
  assert.strictEqual(client.runs.length, 1, 'ENTER: the job is in flight');
  assert.strictEqual(client.runs[0].queueBudgetMs, 2700000);
  mock.timers.tick(5000 + 19 * 60 * 1000 + 30 * 60 * 1000 + 70 * 60 * 1000 - 1);
  assert.deepStrictEqual(child.kills, []);
  mock.timers.tick(1);
  assert.deepStrictEqual(child.kills, ['SIGKILL']);
});

test('t2419: a box:true team with no definition sends box:true and keeps the plain hand ceiling', async (t) => {
  const client = stubClient({ hang: true });
  const team = boxTeam(false);
  const f = execFixture(t, 'clodex-run-tests.js', { client, team });
  await turns(2);
  const child = f.children[0];
  child.emit('message', ask(team.root));
  await turns();
  assert.strictEqual(client.runs.length, 1, 'ENTER: the job is in flight');
  assert.deepStrictEqual([client.runs[0].box, client.runs[0].shares], [true, HAND_SHARES]);
  mock.timers.tick(5000 + 19 * 60 * 1000);
  assert.deepStrictEqual(child.kills, ['SIGKILL']);
});

test('t2419: on a pool a box:true hand run is picked onto the member that holds the box and the share, asked with the definition', async (t) => {
  const asked = [];
  const client = stubClient({ result: { unknown: null, res: { status: 0, signal: null, ...CAPTURED.green, treeHash: TREE } } });
  const infos = {
    pA: { limits: {}, env: {}, box: BOX_READY, shares: [{ name: 'assets', version: 'v0' }] },
    pB: { limits: {}, env: {}, box: BOX_READY, shares: [{ name: 'assets', version: 'v1' }], queue: { running: 'j', queued: ['q'] } },
  };
  client.reachable = async (peer, wire, want) => { asked.push([peer, want]); return { ok: true, info: infos[peer] }; };
  const team = { ...boxTeam(true, { peer: 'runner-a', pool: [{ peer: 'runner-b', wire: 'push' }] }) };
  const peers = { 'runner-a': { id: 'pA', online: true, caps: ['suite'] }, 'runner-b': { id: 'pB', online: true, caps: ['suite'] } };
  const f = execFixture(t, 'clodex-run-tests.js', { client, team, peers });
  await turns(2);
  f.children[0].emit('message', ask(team.root));
  await turns(40);
  assert.strictEqual(client.runs.length, 1, 'ENTER: the run was submitted');
  const want = { definitionHash: HAND_BOX_HASH, rev: 1, definition: HAND_BOX_TEXT };
  assert.deepStrictEqual(asked, [['pA', want], ['pB', want]]);
  assert.deepStrictEqual([client.runs[0].peer, client.runs[0].name], ['pB', 'runner-b']);
});

test('host: a named-files call routes exactly as scope own — local under hands:full, local on local:true, remote under hands:all carrying named and the files', async () => {
  const NAMED = { scope: 'own', files: ['test/b.test.js', 'test/a.test.js'], named: true };
  const full = hostFor({ client: stubClient(), team: teamWith('full') });
  full.host.onMessage(ask(full.dir, NAMED));
  assert.deepStrictEqual(await full.done, { run: 'local', why: 'hands:full leaves own scope local', override: null });
  const forced = hostFor({ client: stubClient() });
  forced.host.onMessage(ask(forced.dir, { ...NAMED, local: true }));
  assert.deepStrictEqual(await forced.done, { run: 'local', why: 'local:true in the call', override: 'call' });
  const client = stubClient({ result: { unknown: null, res: { status: 0, signal: null, stdout: 'x', stderr: '', treeHash: TREE } } });
  const all = hostFor({ client });
  all.host.onMessage(ask(all.dir, NAMED));
  assert.strictEqual((await all.done).run, 'remote');
  const o = client.runs[0];
  assert.deepStrictEqual([o.scope, o.named, o.files, o.route], ['own', 2, ['test/b.test.js', 'test/a.test.js'], 'hands:all']);
});

for (const [name, extra] of [
  ['named false', { scope: 'own', files: ['test/a.test.js'], named: false }],
  ['named with scope full', { scope: 'full', files: ['test/a.test.js'], named: true }],
  ['named with no files', { scope: 'own', files: [], named: true }],
]) {
  test(`host re-validation refuses ${name}, and nothing runs`, async () => {
    const client = stubClient();
    const f = hostFor({ client });
    f.host.onMessage(ask(f.dir, extra));
    assert.deepStrictEqual(await f.done, { run: 'refused', why: 'named must be true, with scope own and files' });
    assert.strictEqual(client.runs.length, 0);
  });
}

const SKIPPED_B = { chosen: 'runner-a', skipped: [{ member: 'runner-b', reason: 'no answer' }] };

test('t2439: a hand run whose pick skipped a member ends its digest with the pool note, green or unknown', async () => {
  const r = poolRig({ pA: {} });
  const f = hostFor({ client: r.client, team: POOL_TEAM(), peers: POOL_PEERS, pool: async () => ({ chosen: 'runner-a', repick: null, reroute: null, pick: SKIPPED_B }) });
  f.host.onMessage(ask(f.dir));
  const m = await f.done;
  assert.deepStrictEqual([m.runner, m.unknown, m.note], ['runner-a', null, '(pool: skipped runner-b: no answer)']);
  assert.deepStrictEqual(r.ends().map((x) => x.pick), [SKIPPED_B]);
  const root = mkRoot({ status: m.status, stdout: m.stdout, stderr: m.stderr });
  const d = await runWithHost(root, '{}', path.join(root, 'h'), () => [m]);
  assert.match(d.digest, /^\[[^\]]+\] 4\/4 green \(\d+m \d{2}s\) \(runner runner-a\) \(pool: skipped runner-b: no answer\)$/);
  const u = await runWithHost(root, '{}', path.join(root, 'h2'), () => [{ run: 'remote', runner: 'runner-a', unknown: 'runner unreachable', note: '(pool: skipped runner-b: no answer)' }]);
  assert.strictEqual(u.digest.endsWith('runner unreachable (pool: skipped runner-b: no answer)'), true, u.digest);
});
