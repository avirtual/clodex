'use strict';
// team-sandbox-seeds.test.js — t810: `[agent:team sandbox up|rebuild]` waits for
// the box's health check and seeds a `bash` seat plus a Claude `worker` before
// it replies, so the reply means "ready, here is what is in it".
//
// No docker and no socket: the sandbox MANAGER is the t808 fake and `fetch` is a
// recorder. That recorder is the subject of most assertions — what this feature
// has to get right is the REQUEST SEQUENCE (which URL, which method, which body,
// which bearer), and a handler that returned a plausible reply while POSTing the
// wrong body would satisfy any reply-only assertion.
//
// waitHealthy's clock is injected rather than mocked globally: the poll loop
// awaits a fetch between naps, so a global timer mock has to interleave with a
// microtask chain to advance at all. An injected now/sleep pair makes the
// elapsed-time arithmetic the test drives directly.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { waitHealthy } = require('../sandbox');
const { seedSandboxSessions } = require('../sandbox-seeds');
const { createTicketMethods } = require('../team-tickets');
const { mkTmpRoot } = require('./lib/tmp-roots');

const TOKEN = 'deadbeefcafe0000deadbeefcafe1111deadbeefcafe2222deadbeefcafe3333';
const WIRE = 'http://127.0.0.1:7820';

// ---------------------------------------------------------------- waitHealthy

// A fake clock that advances only when the loop sleeps, so "after 180s" is an
// arithmetic fact rather than a wall-clock race.
function mkClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('waitHealthy polls /healthz until a 2xx and reports the polls it took', async () => {
  const seen = [];
  const codes = [503, 503, 200];
  const clock = mkClock();
  const res = await waitHealthy({
    id: 'team-clodex',
    url: 'http://127.0.0.1:7810',
    fetch: async (u) => { seen.push(u); return { status: codes[seen.length - 1] }; },
    ...clock,
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.polls, 3);
  assert.deepStrictEqual(seen, [
    'http://127.0.0.1:7810/healthz',
    'http://127.0.0.1:7810/healthz',
    'http://127.0.0.1:7810/healthz',
  ], 'the literal URL polled — a /health or a missing port would still have "worked" against a shape match');
  assert.strictEqual(res.ms, 4000, 'two 2s naps elapsed before the 200');
});

// A box that never boots must not hang the lead's turn forever, and the error
// has to name WHICH box: a team may have several.
test('waitHealthy gives up at the timeout and names the box', async () => {
  let polls = 0;
  const res = await waitHealthy({
    id: 'team-ios',
    url: 'http://127.0.0.1:7810',
    timeoutMs: 20000,
    fetch: async () => { polls += 1; return { status: 503 }; },
    ...mkClock(),
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'box team-ios not healthy after 20s');
  assert.strictEqual(polls, 11, '2s apart across 20s, inclusive of the poll at t=0');
});

// A refused connection is the NORMAL state of a booting box, not an error to
// propagate: the loop must treat a throw exactly as it treats a 503.
test('waitHealthy treats a thrown fetch as a failed poll and keeps going', async () => {
  const codes = [null, null, 200];
  let i = 0;
  const res = await waitHealthy({
    id: 'team-clodex',
    url: 'http://127.0.0.1:7810',
    fetch: async () => { const c = codes[i++]; if (!c) throw new Error('ECONNREFUSED'); return { status: c }; },
    ...mkClock(),
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.polls, 3);
});

test('waitHealthy refuses rather than polling nothing when the box has no web port', async () => {
  let called = 0;
  const res = await waitHealthy({ id: 'team-clodex', url: null, fetch: async () => { called += 1; return { status: 200 }; } });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /box team-clodex has no web port/);
  assert.strictEqual(called, 0);
});

// ------------------------------------------------------- seedSandboxSessions

function mkNet({ sessions = [], post, listStatus = 200 } = {}) {
  const requests = [];
  const reply = (status, body) => ({
    status,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  });
  const fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, method, auth: (init.headers || {}).Authorization, body });
    if (method === 'GET') {
      return listStatus === 200
        ? reply(200, { ok: true, sessions: sessions.map((name) => ({ name })) })
        : reply(listStatus, { ok: false, error: 'unauthorized' });
    }
    const out = post ? post(body.name) : null;
    return out ? reply(out.status, out.body) : reply(200, { ok: true, name: body.name });
  };
  return { fetch, requests };
}

const SEEDS = [
  { name: 'bash', type: 'bash', cwd: '/home/clodex' },
  { name: 'worker', type: 'claude', cwd: '/home/clodex/work', extraArgs: [] },
];

test('seeding lists first, then POSTs each seat with its literal body and the bearer', async () => {
  const net = mkNet();
  const out = await seedSandboxSessions({ wireUrl: WIRE, token: TOKEN, seeds: SEEDS, fetch: net.fetch });
  assert.deepStrictEqual(out, { ok: true, seeded: ['bash', 'worker'] });
  assert.deepStrictEqual(net.requests.map((r) => [r.method, r.url]), [
    ['GET', `${WIRE}/api/sessions`],
    ['POST', `${WIRE}/api/sessions`],
    ['POST', `${WIRE}/api/sessions`],
  ]);
  assert.deepStrictEqual(net.requests[1].body, { name: 'bash', type: 'bash', cwd: '/home/clodex' });
  assert.deepStrictEqual(net.requests[2].body, { name: 'worker', type: 'claude', cwd: '/home/clodex/work', extraArgs: [] });
  for (const r of net.requests) assert.strictEqual(r.auth, `Bearer ${TOKEN}`, 'every request carries the box token');
});

// rebuild runs this against a box that already has its seats; a second `bash`
// would fail, and a handler that reported that failure would make every rebuild
// after the first look broken.
test('a seat that already exists is skipped, not POSTed again', async () => {
  const net = mkNet({ sessions: ['bash'] });
  const out = await seedSandboxSessions({ wireUrl: WIRE, token: TOKEN, seeds: SEEDS, fetch: net.fetch });
  assert.deepStrictEqual(out.seeded, ['bash', 'worker'], 'the reply still describes what is in the box');
  assert.deepStrictEqual(net.requests.filter((r) => r.method === 'POST').map((r) => r.body.name), ['worker']);
});

test('a 400 "name taken" is a skip too — the box owns the registry, not the list', async () => {
  const net = mkNet({ post: (n) => (n === 'bash' ? { status: 400, body: { ok: false, error: 'name taken "bash"' } } : null) });
  const out = await seedSandboxSessions({ wireUrl: WIRE, token: TOKEN, seeds: SEEDS, fetch: net.fetch });
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.seeded, ['bash', 'worker']);
});

test('any other POST failure stops and names the seat, keeping the earlier ones', async () => {
  const net = mkNet({ post: (n) => (n === 'worker' ? { status: 500, body: 'boom' } : null) });
  const out = await seedSandboxSessions({ wireUrl: WIRE, token: TOKEN, seeds: SEEDS, fetch: net.fetch });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /seeding worker: 500 .*boom/);
  assert.deepStrictEqual(out.seeded, ['bash'], 'the bash seat the box already created is still reported');
});

test('a failed list stops before any POST', async () => {
  const net = mkNet({ listStatus: 401 });
  const out = await seedSandboxSessions({ wireUrl: WIRE, token: TOKEN, seeds: SEEDS, fetch: net.fetch });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /listing box sessions: 401/);
  assert.strictEqual(net.requests.filter((r) => r.method === 'POST').length, 0);
});

// ------------------------------------------------------------- the handler

function mkFakeManager({ ports = { web: 7810, wire: 7820 }, healthResult, hasToken = true, translated = { container: '/proj-in-box' } } = {}) {
  const calls = { waitHealthy: 0 };
  const config = {};
  const box = {
    id: 'team-clodex',
    getConfig: () => ({ ...config }),
    setConfig: (patch) => { Object.assign(config, patch); return { ...config }; },
    async up() { return { ok: true, ports }; },
    async rebuild() { return { ok: true, ports }; },
    async down() { return { ok: true }; },
    async status() { return { state: 'running', ref: config.ref || null, sha: 'abcdef1234567890', ports }; },
    remoteToken: () => TOKEN,
    async waitHealthy() { calls.waitHealthy += 1; return healthResult || { ok: true, polls: 3, ms: 4000 }; },
    hasAuthToken: () => hasToken,
    translateHostPath: () => translated,
  };
  return { calls, manager: { get: () => box, create: () => ({ ok: true }) } };
}

function mkHandler(opts = {}) {
  const home = mkTmpRoot('t810-');
  const teamsDir = path.join(home, 'teams');
  fs.mkdirSync(path.join(teamsDir, 'clodex'), { recursive: true, mode: 0o700 });
  const team = {
    name: 'clodex',
    root: '/proj',
    lead: 'lead',
    file: path.join(teamsDir, 'clodex', 'team.json'),
    dir: path.join(teamsDir, 'clodex'),
    roles: { lead: { brief: 'the lead' } },
  };
  const fake = mkFakeManager(opts);
  const net = mkNet(opts);
  const methods = createTicketMethods({
    fs,
    path,
    teamsDir,
    listTeams: () => ['clodex'],
    resolveTeam: (cwd) => (cwd === '/proj' ? team : null),
    refreshAppMenu: () => {},
    getSandboxManager: () => fake.manager,
    fetch: net.fetch,
    log: { info() {}, warn() {}, error() {} },
  }, {});
  const injected = [];
  const m = Object.create(methods);
  m._injectText = (_s, text) => { injected.push(text); };
  return {
    m,
    calls: fake.calls,
    requests: net.requests,
    last: () => injected[injected.length - 1] || '',
    file: path.join(teamsDir, 'clodex', 'sandbox.json'),
  };
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };

const fire = async (h, intent) => {
  h.m._handleTeam({ name: 'lead', agentType: 'claude', cwd: '/proj' },
    { type: 'team', sub: 'sandbox', action: 'up', ref: null, body: '', ...intent });
  await settle();
};

const posts = (h) => h.requests.filter((r) => r.method === 'POST').map((r) => r.body.name);

test('up with a Claude token seeds bash and worker and says so, without the token', async () => {
  const h = mkHandler();
  await fire(h, { action: 'up' });

  assert.strictEqual(h.calls.waitHealthy, 1, 'ENTER: the handler waited before it seeded');
  assert.deepStrictEqual(h.requests.map((r) => [r.method, r.url]), [
    ['GET', `${WIRE}/api/sessions`],
    ['POST', `${WIRE}/api/sessions`],
    ['POST', `${WIRE}/api/sessions`],
  ]);
  assert.deepStrictEqual(h.requests[1].body, { name: 'bash', type: 'bash', cwd: '/home/clodex' });
  assert.deepStrictEqual(h.requests[2].body, { name: 'worker', type: 'claude', cwd: '/proj-in-box', extraArgs: [] },
    'the worker starts in the team root as the BOX sees it, not the host path');
  assert.strictEqual(h.requests[0].auth, `Bearer ${TOKEN}`);

  const line = h.last();
  assert.match(line, /healthy in 4s · seeded bash, worker/);
  assert.ok(!line.includes(TOKEN), `the reply leaked the token: ${line}`);
  assert.ok(line.includes(h.file), 'and still points at the file the token is in');
});

// A Claude seat with no token loops on /login forever: seeding one would look
// like success and deliver a seat nothing can talk to.
test('without a Claude token the worker is not POSTed, and the reply says how to fix it', async () => {
  const h = mkHandler({ hasToken: false });
  await fire(h, { action: 'up' });
  assert.deepStrictEqual(posts(h), ['bash']);
  assert.match(h.last(), /seeded bash · token in .* · worker NOT seeded: set a Claude token on box team-clodex \(Settings ▸ Sandbox\) and run sandbox rebuild/);
});

// The host root is outside every bind when the box has no workDir; the seat
// still needs a cwd that exists in the box.
test('a team root the box cannot reach falls back to the box work dir', async () => {
  const h = mkHandler({ translated: { reachable: false } });
  await fire(h, { action: 'up' });
  assert.deepStrictEqual(h.requests[2].body.cwd, '/home/clodex/work');
});

test('rebuild over a box that already has bash POSTs only the worker', async () => {
  const h = mkHandler({ sessions: ['bash'] });
  await fire(h, { action: 'rebuild' });
  assert.deepStrictEqual(posts(h), ['worker']);
  assert.match(h.last(), /seeded bash, worker/);
});

// The file is the ONLY way back to a box that boots slowly, so it must survive
// the failure that the reply reports.
test('a health timeout replies error, seeds nothing, and leaves sandbox.json in place', async () => {
  const h = mkHandler({ healthResult: { ok: false, error: 'box team-clodex not healthy after 180s' } });
  await fire(h, { action: 'up' });
  assert.strictEqual(h.last(), '[agent:team] error: box team-clodex not healthy after 180s');
  assert.strictEqual(h.requests.length, 0, 'nothing was sent to a box that never answered');
  assert.ok(fs.existsSync(h.file), 'the URLs and token to reach it are still on disk');
});

test('a seed failure replies error naming the seat, after the earlier seat was created', async () => {
  const h = mkHandler({ post: (n) => (n === 'worker' ? { status: 500, body: 'kaboom' } : null) });
  await fire(h, { action: 'up' });
  assert.match(h.last(), /error: seeding worker: 500 .*kaboom/);
  assert.deepStrictEqual(posts(h), ['bash', 'worker'], 'bash was created before the worker POST failed');
});

// status and down are read/teardown paths: a health wait there would block a
// lead asking about a box that is deliberately down.
test('status and down neither wait for health nor seed', async () => {
  const h = mkHandler();
  await fire(h, { action: 'status' });
  await fire(h, { action: 'down' });
  assert.strictEqual(h.calls.waitHealthy, 0);
  assert.strictEqual(h.requests.length, 0);
});
