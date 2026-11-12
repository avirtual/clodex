'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { route, createChannelHost, createSuiteClient } = require('../suite-client');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'clodex-run-tests.js');
const TREE = 'a'.repeat(40);
const HEAD_TREE = 'c'.repeat(40);
const HEAD = 'b'.repeat(40);

const teamWith = (hands) => ({ name: 'tm', lead: 'lead-1', root: '/r', testRunner: { peer: 'runner-1', hands } });

const ROUTE_ROWS = [
  ['no setting', { team: { name: 'tm', root: '/r' }, scope: 'full' }, { where: 'local', why: 'no test runner' }],
  ['hands:off', { team: teamWith('off'), scope: 'full' }, { where: 'local', why: 'hands:off' }],
  ['local:true under hands:all', { team: teamWith('all'), scope: 'full', local: true }, { where: 'local', why: 'local:true in the call', override: 'call' }],
  ['hands:full, full scope', { team: teamWith('full'), scope: 'full' }, { where: 'remote', peer: 'runner-1', why: 'hands:full' }],
  ['hands:full, own scope', { team: teamWith('full'), scope: 'own' }, { where: 'local', why: 'hands:full leaves own scope local' }],
  ['hands:all, full scope', { team: teamWith('all'), scope: 'full' }, { where: 'remote', peer: 'runner-1', why: 'hands:all' }],
  ['hands:all, own scope', { team: teamWith('all'), scope: 'own' }, { where: 'remote', peer: 'runner-1', why: 'hands:all' }],
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
      opts.onJob({ jobId: 'job-1', attempt: 1 });
      opts.onProgress('runner runner-1: job queued');
      return hang ? new Promise((r) => { gate.release = r; }) : Promise.resolve(result);
    },
    async cancel(peer, jobId) {
      cancels.push([peer, jobId]);
      return { ok: true };
    },
  };
}

function hostFor({ team = teamWith('all'), client = null, snapshot = stubSnap() } = {}) {
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
    resolvePeer: (n) => (n === 'runner-1' ? 'p1' : null),
    send: (m) => { sent.push(m); if (m.run) settle(m); },
    notifyLead: (b) => notes.push(b),
    snapshot,
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
  const { onJob, onProgress, ...opts } = client.runs[0];
  assert.deepStrictEqual(opts, {
    peer: 'p1', name: 'runner-1', tree: f.dir, kind: 'hand', scope: 'own', team: 'tm', ticket: null, seat: 'hand-1',
    files: ['test/a.test.js'], flags: { CLODEX_TEST_LOCK: '1' }, setup: null, env: {},
    budgetMs: 35 * 60 * 1000, timeoutMs: 21 * 60 * 1000, route: 'hands:all',
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

function execFixture(t, bin, { client = null, team = null } = {}) {
  const { createSessionManager } = require('../session-manager');
  const { isFilenameToken, parseAndValidate } = require('../exec-schema');
  const REGISTRY_DIR = mkTmpRoot('suite-route-exec-');
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(execDir, 'cmd.json'), JSON.stringify({
    argv: ['/usr/bin/env', 'node', `\${CLODEX_BIN}/${bin}`],
    timeoutMs: 5000, maxBytes: 4096, replyStderr: true,
    schema: { type: 'object', additionalProperties: false, properties: { scope: { type: 'string' } } },
  }));
  const spawned = [];
  const children = [];
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
        if (opts.stdio[3] === 'ipc') ee.send = () => true;
        children.push(ee);
        return ee;
      },
    },
  });
  const m = new SessionManager();
  m._injectText = () => {};
  m._broadcast = () => {};
  m._teamOfOrNull = () => team;
  m._runnerPeerStatus = (n) => (n === 'runner-1' ? { id: 'p1' } : null);
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    for (const c of children) c.emit('close', 0, null);
    mock.timers.reset();
  });
  m._handleExecIntent({ name: 'hand-1', agentType: 'claude', workspaceId: 'ws1', cwd: '/x' }, 'cmd', '{}');
  return { spawned, children };
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
  mock.timers.tick(5000);
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
  test(`both arms: one captured ${name} output gives a byte-identical digest line${name === 'red' ? ' and failing-output file' : ''}`, async () => {
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
    assert.strictEqual(wall(remote.digest), wall(local.digest));
    assert.strictEqual(remote.code, local.code);
    assert.ok(remote.lines.includes('runner runner-1: job running'), 'progress reached stderr');
    if (name === 'red') {
      assert.ok(local.kept && local.kept.includes('✖ b (1.5ms)'), 'ENTER: the local arm preserved the failing rows');
      assert.strictEqual(stamps(remote.kept), stamps(local.kept));
    }
  });
}

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
  assert.match(r.digest, /^\[[^\]]+\] 3\/3 green \(\d+m \d{2}s\) \(tree changed during the run; the suite measured aaaaaaaa\)$/);
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
    id: 'run-1', phase: 'start', where: 'runner-1', runner: 'p1', jobId: 'run-1', attempt: 1,
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
