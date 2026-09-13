'use strict';
// team-sandbox-verb.test.js — t808: `[agent:team sandbox up|rebuild|down|status]`
// mints or rebuilds the box `team-<name>` and writes the team's URLs and
// peer-wire token to ~/.clodex/teams/<name>/sandbox.json.
//
// The sandbox MANAGER is a fake — docker is not available in the suite and a
// real box would take minutes — but everything the verb decides is real: the
// teams dir is bytes under a temp root, so sandbox.json's contents and its mode
// are read back off disk rather than off a spy's arguments. What the fake stands
// in for is the docker call itself, never the handler's own choices.
//
// The token assertions are the security half and are written against the fake's
// LITERAL secret string: a reply that leaked it would still satisfy any regex
// that only checked for a plausible shape.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createTicketMethods } = require('../team-tickets');
const { mkTmpRoot } = require('./lib/tmp-roots');

const TOKEN = 'deadbeefcafe0000deadbeefcafe1111deadbeefcafe2222deadbeefcafe3333';

function mkFakeManager({ boxes = [], ports = { web: 7810, wire: 7820 }, upResult, statusResult, downResult, setConfigResult, healthResult, config = {}, noStateDir = false, stateRoot = null } = {}) {
  const calls = { create: [], get: [], setConfig: [], up: 0, rebuild: 0, down: 0, status: 0, waitHealthy: 0, unregisterPeer: 0 };
  const rows = new Map(boxes.map((id) => [id, { id }]));
  // The box's config is REAL state here, not a spy log: the handler reads it back
  // (to decide whether to seed a default ref) and the "config survives" subjects
  // assert on it after a later action, which a write-only spy cannot express.
  const makeBox = (id) => ({
    id,
    getConfig() { return { ...config }; },
    setConfig(partial) {
      calls.setConfig.push(partial);
      if (setConfigResult) return setConfigResult;
      Object.assign(config, partial);
      return { ...config };
    },
    async up() { calls.up++; return upResult || { ok: true, ports }; },
    async rebuild() { calls.rebuild++; return upResult || { ok: true, ports }; },
    async down() { calls.down++; return downResult || { ok: true }; },
    unregisterPeer() { calls.unregisterPeer++; },
    // `ref` is read back off config, exactly as the real status() derives it from
    // getConfig(). Hardcoding it would make this fake report a ref the box is not
    // configured with, and the "tracked ref survives" subjects would then be
    // measuring the fake's constant instead of the handler's behaviour.
    async status() {
      calls.status++;
      return statusResult || { state: 'running', ref: config.ref || null, sha: 'abcdef1234567890', ports };
    },
    remoteToken: () => TOKEN,
    async waitHealthy() { calls.waitHealthy++; return healthResult || { ok: true, polls: 1, ms: 4000 }; },
    translateHostPath: () => ({ container: '/home/clodex/work' }),
    ...(noStateDir ? {} : { stateDir: () => stateRoot }),
  });
  const instances = new Map();
  const manager = {
    get(id) {
      calls.get.push(id);
      if (!rows.has(id)) return null;
      if (!instances.has(id)) instances.set(id, makeBox(id));
      return instances.get(id);
    },
    create(id, label) {
      calls.create.push([id, label]);
      rows.set(id, { id, label });
      return { ok: true, box: { id, label } };
    },
  };
  return { manager, calls };
}

// The seeding half is driven through a fake fetch that RECORDS every request —
// url, method, headers and the literal body — because what the handler must get
// right is the request sequence, not a return value it could fake past.
function mkFakeFetch({ sessions = [], post } = {}) {
  const requests = [];
  const reply = (status, body) => ({
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  });
  const fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    requests.push({ url, method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (method === 'GET') return reply(200, { ok: true, sessions: sessions.map((name) => ({ name })) });
    const name = requests[requests.length - 1].body.name;
    const out = post ? post(name) : null;
    if (out) return reply(out.status, out.body);
    return reply(200, { ok: true, name });
  };
  return { fetch, requests };
}

function mkBox(opts = {}) {
  const home = mkTmpRoot('t808-');
  const teamsDir = path.join(home, 'teams');
  const dir = path.join(teamsDir, 'clodex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const team = {
    name: 'clodex',
    root: '/proj',
    lead: 'lead',
    file: path.join(dir, 'team.json'),
    dir,
    roles: { lead: { brief: 'the lead' }, hand: { brief: 'the hand' } },
  };
  const manifest = {
    name: 'clodex',
    root: '/proj',
    lead: 'lead',
    kit: 'clodex-team',
    roles: {
      lead: { brief: 'the lead', account: 'opsguru' },
      hand: { brief: 'the hand', account: 'personal' },
    },
  };
  fs.writeFileSync(team.file, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.mkdirSync(path.join(dir, 'prompts', 'system'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompts', 'system', 'x.md'), 'system prompt x\n');
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'templates', 'y.json'), '{"type":"claude"}\n');
  fs.mkdirSync(path.join(dir, 'exec'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'exec', 'z.json'), '{"command":"true"}\n');
  fs.writeFileSync(path.join(dir, 'tickets.json'), '{"tickets":[]}\n');
  const stateRoot = opts.stateRoot || mkTmpRoot('t836-state-');
  const fake = opts.noManager ? null : mkFakeManager({ ...opts, stateRoot });
  const net = mkFakeFetch(opts);
  const methods = createTicketMethods({
    fs,
    path,
    teamsDir,
    listTeams: () => ['clodex'],
    resolveTeam: (cwd) => (cwd === '/proj' ? team : null),
    refreshAppMenu: () => {},
    getSandboxManager: () => (fake ? fake.manager : null),
    getPeerManager: opts.getPeerManager || (() => null),
    fetch: net.fetch,
    log: { info() {}, warn() {}, error() {} },
  }, {});
  const injected = [];
  const m = Object.create(methods);
  m._injectText = (_s, text) => { injected.push(text); };
  return {
    m,
    team,
    calls: fake ? fake.calls : null,
    injected,
    lead: { name: 'lead', agentType: 'claude', cwd: '/proj' },
    hand: { name: 'clodex-hand', agentType: 'claude', cwd: '/proj' },
    last: () => injected[injected.length - 1] || '',
    box: () => fake.manager.get('team-clodex'),
    mgr: fake ? fake.manager : null,
    requests: net.requests,
    file: path.join(teamsDir, 'clodex', 'sandbox.json'),
    srcDir: dir,
    stateRoot,
    shipped: path.join(stateRoot, 'dot', 'teams', 'clodex'),
    replies: injected,
  };
}

// _handleTeam dispatches the async handler and returns; every subject awaits
// this so the assertions read the state the docker, health and seeding steps
// actually left. Rounds, not one tick: each is a macrotask boundary that drains
// every microtask queued by the await chain before it.
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const fire = async (b, session, intent) => {
  b.m._handleTeam(session, { type: 'team', sub: 'sandbox', action: 'up', ref: null, body: '', ...intent });
  await settle();
};

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

test('up creates box team-<name>, sets ref + workDir, and writes sandbox.json', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'up' });

  assert.deepStrictEqual(b.calls.create, [['team-clodex', 'clodex team']]);
  // Whole-object compare: a patch that also carried `image` would silently
  // overwrite the operator's GUI override, which t807 made precedence-bearing.
  // A bare `up` on a box with no ref seeds the default — the LITERAL 'master',
  // applied here in the handler and no longer by the parser.
  assert.deepStrictEqual(b.calls.setConfig, [{ workDir: '/proj', ref: 'master' }]);
  assert.strictEqual(b.calls.up, 1);

  assert.ok(exists(b.file), 'sandbox.json landed');
  const rec = JSON.parse(fs.readFileSync(b.file, 'utf-8'));
  assert.deepStrictEqual(Object.keys(rec).sort(),
    ['boxId', 'ref', 'sha', 'startedAt', 'teamDir', 'token', 'webUrl', 'wireUrl'].sort());
  assert.strictEqual(rec.boxId, 'team-clodex');
  assert.strictEqual(rec.ref, 'master');
  assert.strictEqual(rec.sha, 'abcdef1234567890');
  assert.strictEqual(rec.webUrl, 'http://127.0.0.1:7810');
  assert.strictEqual(rec.wireUrl, 'http://127.0.0.1:7820');
  assert.strictEqual(rec.token, TOKEN);
  assert.ok(!Number.isNaN(Date.parse(rec.startedAt)), 'startedAt is an ISO instant');
});

test('sandbox.json is written 0600 — the peer-wire token is not group- or world-readable', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'up' });
  assert.strictEqual(fs.statSync(b.file).mode & 0o777, 0o600);
});

test('the reply names the file, never the token', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'up' });
  const line = b.last();
  assert.ok(!line.includes(TOKEN), `the reply leaked the token: ${line}`);
  assert.match(line, /sandbox team-clodex up @ abcdef12 \(ref master\)/);
  assert.match(line, /web http:\/\/127\.0\.0\.1:7810 · wire :7820/);
  assert.ok(line.includes(b.file), 'the reply points at the file the token is in');
});

test('a second up does NOT create the box again', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'up' });
  await fire(b, b.lead, { action: 'up' });
  assert.deepStrictEqual(b.calls.create, [['team-clodex', 'clodex team']]);
  assert.strictEqual(b.calls.up, 2);
});

test('rebuild goes through rebuild(), not up(), and still writes the file', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'rebuild', ref: 't9-x' });
  assert.strictEqual(b.calls.rebuild, 1);
  assert.strictEqual(b.calls.up, 0);
  assert.deepStrictEqual(b.calls.setConfig, [{ workDir: '/proj', ref: 't9-x' }]);
  assert.ok(exists(b.file));
});

test('down stops the box and deletes sandbox.json', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'up' });
  assert.ok(exists(b.file));
  await fire(b, b.lead, { action: 'down' });
  assert.strictEqual(b.calls.down, 1);
  assert.ok(!exists(b.file), 'the token file is gone once the box is down');
  assert.match(b.last(), /sandbox team-clodex down/);
  assert.strictEqual(b.calls.unregisterPeer, 1);
  assert.match(b.last(), /peer entry team-clodex unregistered/);
});

test('down that fails leaves the peer entry registered', async () => {
  const b = mkBox({ downResult: { ok: false, error: 'compose exploded' } });
  await fire(b, b.lead, { action: 'up' });
  assert.ok(exists(b.file));
  await fire(b, b.lead, { action: 'down' });
  assert.strictEqual(b.calls.down, 1);
  assert.strictEqual(b.calls.unregisterPeer, 0);
  assert.match(b.last(), /^\[agent:team\] error: compose exploded/);
  assert.ok(exists(b.file), 'a failed down leaves the token file in place');
});

test('status writes nothing and reports the state', async () => {
  const b = mkBox({ config: { ref: 'master' } });
  await fire(b, b.lead, { action: 'status' });
  assert.ok(!exists(b.file), 'status is read-only — no token file appears');
  assert.match(b.last(), /^\[agent:team\] sandbox team-clodex running \(ref master\)/);
});

// An unconfigured box has no ref to report, and status must not invent one by
// seeding a default — seeding belongs to up/rebuild alone.
test('status on a box with no ref reports no ref clause, and still configures nothing', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'status' });
  assert.strictEqual(b.calls.setConfig.length, 0);
  assert.match(b.last(), /^\[agent:team\] sandbox team-clodex running/);
  assert.ok(!/\(ref /.test(b.last()), `no ref was configured, so none is claimed: ${b.last()}`);
});

test('status names the clodex version the box reports on its wire', async () => {
  const b = mkBox({
    getPeerManager: () => ({ statuses: () => [{ id: 'team-clodex', online: true, version: '5.64.4' }] }),
  });
  await fire(b, b.lead, { action: 'status' });
  assert.match(b.last(), / · clodex 5\.64\.4$/);
});

test('status marks the version as last seen when the box wire is offline', async () => {
  const b = mkBox({
    getPeerManager: () => ({ statuses: () => [{ id: 'team-clodex', online: false, version: '5.64.4' }] }),
  });
  await fire(b, b.lead, { action: 'status' });
  assert.match(b.last(), /clodex 5\.64\.4 \(last seen; the box's wire is offline now\)/);
});

test('status treats a peer row with no online key as offline for the version', async () => {
  const b = mkBox({
    getPeerManager: () => ({ statuses: () => [{ id: 'team-clodex', version: '5.64.4' }] }),
  });
  await fire(b, b.lead, { action: 'status' });
  assert.match(b.last(), /clodex 5\.64\.4 \(last seen; the box's wire is offline now\)/);
});

test('status with no peer manager says the version is unknown', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'status' });
  assert.match(b.last(), /clodex version unknown \(box not reporting on its wire\)/);
});

test('status ignores a peer row whose id is not the box id', async () => {
  const b = mkBox({
    getPeerManager: () => ({ statuses: () => [{ id: 'sandbox', version: '9.9.9' }] }),
  });
  await fire(b, b.lead, { action: 'status' });
  assert.match(b.last(), /clodex version unknown \(box not reporting on its wire\)/);
  assert.ok(!/9\.9\.9/.test(b.last()), `a differently-id'd row is not this box: ${b.last()}`);
});

// The r1 must-fix, in the order a lead really types it. The parser used to default
// `ref` to 'master', and setConfig ran for EVERY action — so this exact sequence
// silently rewrote a box tracking t9-x back to master, and the next rebuild would
// have built the wrong commit. Both halves are asserted: the call the handler must
// NOT make, and the config value that must survive it.
test('status after `rebuild ref:t9-x` does not touch config — the tracked ref survives', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'rebuild', ref: 't9-x' });
  assert.deepStrictEqual(b.calls.setConfig, [{ workDir: '/proj', ref: 't9-x' }], 'ENTER: rebuild configured the box');

  await fire(b, b.lead, { action: 'status' });

  assert.strictEqual(b.calls.setConfig.length, 1, 'status configured nothing — the rebuild patch is still the only one');
  assert.strictEqual(b.box().getConfig().ref, 't9-x', 'the box still tracks the ref it was built from');
  assert.match(b.last(), /\(ref t9-x\)/, 'and the status line reports that ref, not the default');
});

test('down touches no config either', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'rebuild', ref: 't9-x' });
  await fire(b, b.lead, { action: 'down' });
  assert.strictEqual(b.calls.setConfig.length, 1, 'down configured nothing');
  assert.strictEqual(b.box().getConfig().ref, 't9-x');
});

// The other half of "seed only when there is no ref": a bare `up` must not reset a
// box someone already pointed at a branch.
test('a bare `up` keeps an existing ref rather than reseeding master', async () => {
  const b = mkBox({ config: { ref: 't9-x' } });
  await fire(b, b.lead, { action: 'up' });
  assert.deepStrictEqual(b.calls.setConfig, [{ workDir: '/proj' }], 'no ref key at all — the box keeps t9-x');
  assert.strictEqual(b.box().getConfig().ref, 't9-x');
});

// sandbox.json carries what status() REPORTS, never what the intent asked for.
// Under a GUI image override the status rider returns ref/sha null precisely so the
// box does not advertise a ref it is not running; a fallback to the intent ref would
// put "master" back into the file beside a null sha.
test('sandbox.json ref is null when status reports null, even though the intent named a ref', async () => {
  const b = mkBox({ statusResult: { state: 'running', ref: null, sha: null, ports: { web: 7810, wire: 7820 } } });
  await fire(b, b.lead, { action: 'up', ref: 't9-x' });
  const rec = JSON.parse(fs.readFileSync(b.file, 'utf-8'));
  assert.strictEqual(rec.ref, null, 'the file reports the box, not the request');
  assert.strictEqual(rec.sha, null);
});

test('up ships prompts, templates and exec grants into the box, with a rewritten team.json', async () => {
  const b = mkBox();
  const before = JSON.parse(fs.readFileSync(path.join(b.srcDir, 'team.json'), 'utf-8'));
  assert.strictEqual(before.roles.lead.account, 'opsguru', 'ENTER: the host manifest carries an account');
  assert.strictEqual(before.roles.hand.account, 'personal', 'ENTER: on both roles');

  await fire(b, b.lead, { action: 'up' });

  assert.strictEqual(fs.readFileSync(path.join(b.shipped, 'prompts', 'system', 'x.md'), 'utf-8'), 'system prompt x\n');
  assert.strictEqual(fs.readFileSync(path.join(b.shipped, 'templates', 'y.json'), 'utf-8'), '{"type":"claude"}\n');
  assert.strictEqual(fs.readFileSync(path.join(b.shipped, 'exec', 'z.json'), 'utf-8'), '{"command":"true"}\n');
  assert.ok(!exists(path.join(b.shipped, 'tickets.json')), 'the box board starts empty');
  assert.ok(!exists(path.join(b.shipped, 'sandbox.json')), 'the host token file is not shipped');

  const out = JSON.parse(fs.readFileSync(path.join(b.shipped, 'team.json'), 'utf-8'));
  assert.strictEqual(out.root, '/home/clodex/work', 'root is the translated container path');
  assert.ok(!('account' in out.roles.lead), 'no role carries an account inside the box');
  assert.ok(!('account' in out.roles.hand));
  assert.strictEqual(out.lead, 'lead');
  assert.strictEqual(out.kit, 'clodex-team');
  assert.deepStrictEqual(Object.keys(out.roles).sort(), ['hand', 'lead']);
  assert.strictEqual(out.roles.lead.brief, 'the lead');
  assert.ok(b.replies.some((l) => l.includes('team clodex shipped into the box (teams/clodex)')));
});

test('a second up keeps the box-side team.json the box lead has since changed', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'up' });
  const manifest = path.join(b.shipped, 'team.json');
  fs.writeFileSync(manifest, '{"name":"clodex","changed":"by the box lead"}\n');

  await fire(b, b.lead, { action: 'up' });

  assert.strictEqual(fs.readFileSync(manifest, 'utf-8'), '{"name":"clodex","changed":"by the box lead"}\n');
  assert.ok(b.replies.some((l) => l.includes('team clodex already present in the box (kept)')));
});

test('sandbox.json records where the team landed', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'up' });
  const rec = JSON.parse(fs.readFileSync(b.file, 'utf-8'));
  assert.strictEqual(rec.teamDir, b.shipped);
});

test('a team copy that throws is reported, and sandbox.json is still written and the box still seeded', async () => {
  const blocked = path.join(mkTmpRoot('t838-blocked-'), 'state');
  fs.writeFileSync(blocked, 'a file where the box state dir should be\n');
  const b = mkBox({ stateRoot: blocked });

  await fire(b, b.lead, { action: 'up' });

  assert.ok(b.replies.some((l) => l.includes('team NOT shipped:')),
    `the failure is named to the lead: ${JSON.stringify(b.replies)}`);
  assert.ok(exists(b.file), 'the token file the box is only reachable through still landed');
  const rec = JSON.parse(fs.readFileSync(b.file, 'utf-8'));
  assert.strictEqual(rec.teamDir, null, 'and records that nothing was shipped');
  assert.strictEqual(rec.token, TOKEN);
  assert.deepStrictEqual(b.requests.filter((r) => r.method === 'POST').map((r) => r.body.name), ['bash', 'lead'],
    'the seats are still created — a box with no team copy is still a box');
  assert.match(b.last(), /seeded bash/);
});

test('a box with no state dir says so and still seeds', async () => {
  const b = mkBox({ noStateDir: true });
  await fire(b, b.lead, { action: 'up' });
  assert.ok(b.replies.some((l) => l.includes('no state dir; team not shipped')));
  const rec = JSON.parse(fs.readFileSync(b.file, 'utf-8'));
  assert.strictEqual(rec.teamDir, null);
  assert.match(b.last(), /seeded bash/);
});

test('a non-lead gets the same refusal the other team verbs give, and writes nothing', async () => {
  const b = mkBox();
  await fire(b, b.hand, { action: 'up' });
  assert.match(b.last(), /only the team lead \(lead\) can edit team metadata/);
  assert.strictEqual(b.calls.create.length, 0, 'a refused verb touches no box');
  assert.ok(!exists(b.file));
});

test('no sandbox manager on this host → the "not enabled" error, and nothing is written', async () => {
  const b = mkBox({ noManager: true });
  await fire(b, b.lead, { action: 'up' });
  assert.match(b.last(), /error: sandboxes are not enabled on this host/);
  assert.match(b.last(), /run \[agent:team sandbox …\] from a desktop seat, or use Settings > Sandboxes on the desktop/);
  assert.ok(!exists(b.file));
});

test('an unknown action is refused before any box is touched', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'restart' });
  assert.match(b.last(), /error: sandbox action must be up \| rebuild \| down \| status \(got "restart"\)/);
  assert.strictEqual(b.calls.create.length, 0);
  assert.strictEqual(b.calls.get.length, 0);
});

test('a failed up surfaces the docker message and writes no token file', async () => {
  const b = mkBox({ upResult: { ok: false, error: 'Cannot connect to the Docker daemon' } });
  await fire(b, b.lead, { action: 'up' });
  assert.match(b.last(), /error: Cannot connect to the Docker daemon/);
  assert.ok(!exists(b.file), 'a box that never came up leaves no URLs claiming it did');
});

// Two halves, because the rejection and the reaction live in different files.
// First: the REAL setConfig is what refuses `..` (via normalizeRef) and it must
// refuse without writing a half-applied config.
test('the REAL setConfig rejects a ref with ".." and stores nothing', () => {
  const { createSandbox } = require('../sandbox');
  let written = null;
  const real = createSandbox({
    id: 'team-clodex',
    label: 'clodex team',
    getUserDataPath: () => mkTmpRoot('t808-ud-'),
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    syncPeerManager: () => {},
    registryDir: mkTmpRoot('t808-reg-'),
    log: { info() {}, warn() {}, error() {} },
    readBoxConfig: () => ({ ref: 'master', workDir: '/proj' }),
    writeBoxConfig: (next) => { written = next; },
  });
  const res = real.setConfig({ ref: '../etc', workDir: '/proj' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /no "\.\."/);
  assert.strictEqual(written, null, 'a rejected ref never reaches the store');
});

// Second: whatever setConfig refuses, the handler must surface as `error:` and
// STOP — no docker call, no token file claiming a box that was never configured.
test('a setConfig refusal stops the verb before docker and writes nothing', async () => {
  const b = mkBox({
    setConfigResult: { ok: false, error: 'Track git ref may only contain letters, digits, dot, dash, underscore and slash (no ".."): ../etc' },
  });
  await fire(b, b.lead, { action: 'up', ref: '../etc' });
  assert.match(b.last(), /error: Track git ref may only contain .* \(no "\.\."\): \.\.\/etc/);
  assert.strictEqual(b.calls.up, 0, 'a refused ref never reaches docker');
  assert.ok(!exists(b.file));
});

test('_bringUpTeamBox runs the whole box-side half with no intent, and passes the patch through untouched', async () => {
  const b = mkBox({ boxes: ['team-clodex'] });
  const replies = [];
  const out = await b.m._bringUpTeamBox(b.team, {
    mgr: b.mgr,
    box: b.box(),
    boxId: 'team-clodex',
    patch: { workDir: b.team.root },
    action: 'up',
    reply: (line) => replies.push(line),
  });

  assert.deepStrictEqual(b.calls.setConfig, [{ workDir: '/proj' }]);
  assert.strictEqual(b.calls.up, 1);
  assert.strictEqual(b.calls.waitHealthy, 1);
  assert.strictEqual(fs.readFileSync(path.join(b.shipped, 'templates', 'y.json'), 'utf-8'), '{"type":"claude"}\n');
  assert.deepStrictEqual(b.requests.filter((r) => r.method === 'POST').map((r) => r.body.name), ['bash', 'lead']);
  assert.ok(exists(b.file), 'sandbox.json landed');

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.webUrl, 'http://127.0.0.1:7810');
  const { startedAt, ...fields } = out.record;
  assert.ok(!Number.isNaN(Date.parse(startedAt)));
  assert.deepStrictEqual(fields, {
    boxId: 'team-clodex',
    ref: null,
    sha: 'abcdef1234567890',
    webUrl: 'http://127.0.0.1:7810',
    wireUrl: 'http://127.0.0.1:7820',
    token: TOKEN,
    teamDir: b.shipped,
  });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(b.file, 'utf-8')), out.record);
  assert.strictEqual(b.injected.length, 0, 'nothing went out through the intent reply path');
  assert.ok(replies.some((l) => l.includes('team clodex shipped into the box (teams/clodex)')));
  assert.match(replies[replies.length - 1], /^sandbox team-clodex up @ abcdef12/);
});

test('_shipTeamIntoBox drops `sandboxed` — inside the box the team is real, not a pointer', async () => {
  const b = mkBox({ boxes: ['team-clodex'] });
  const src = JSON.parse(fs.readFileSync(b.team.file, 'utf-8'));
  src.sandboxed = true;
  fs.writeFileSync(b.team.file, `${JSON.stringify(src, null, 2)}\n`);
  assert.strictEqual(JSON.parse(fs.readFileSync(b.team.file, 'utf-8')).sandboxed, true, 'ENTER: the host manifest is a pointer');

  b.m._shipTeamIntoBox(b.team, b.mgr.get('team-clodex'));

  const obj = JSON.parse(fs.readFileSync(path.join(b.shipped, 'team.json'), 'utf-8'));
  assert.strictEqual('sandboxed' in obj, false);
  assert.strictEqual(obj.name, 'clodex');
});
