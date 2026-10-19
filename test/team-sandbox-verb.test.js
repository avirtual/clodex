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
const WEB_TOKEN = 'feedface0000feedface1111feedface2222feedface3333feedface4444feed';

function mkFakeManager({ boxes = [], ports = { web: 7810, wire: 7820 }, startedAts = ['2026-10-15T01:00:00.000000001Z', '2026-10-15T02:00:00.000000002Z'], upResult, statusResult, downResult, setConfigResult, healthResult, config = {}, noStateDir = false, stateRoot = null, applied = [], portsError = null, restartResult = null, applyTarget = 'rebuild' } = {}) {
  const calls = { create: [], get: [], setConfig: [], setConfigOpts: [], up: 0, rebuild: 0, down: 0, status: 0, waitHealthy: 0, unregisterPeer: 0 };
  const rows = new Map(boxes.map((id) => [id, { id }]));
  // The box's config is REAL state here, not a spy log: the handler reads it back
  // (to decide whether to seed a default ref) and the "config survives" subjects
  // assert on it after a later action, which a write-only spy cannot express.
  const makeBox = (id) => ({
    id,
    getConfig() { return { ...config }; },
    setConfig(partial, opts) {
      calls.setConfig.push(partial);
      calls.setConfigOpts.push(opts);
      if (setConfigResult) return setConfigResult;
      Object.assign(config, partial);
      return portsError ? { ...config, portsError } : { ...config };
    },
    portsState() { return { ports: config.ports || [], applied }; },
    async containerStartedAt() { calls.startedAt = (calls.startedAt || 0) + 1; return startedAts[Math.min(calls.startedAt, startedAts.length) - 1]; },
    async up() { calls.up++; return upResult || { ok: true, ports }; },
    async rebuild() { calls.rebuild++; return upResult || { ok: true, ports }; },
    async down() { calls.down++; return downResult || { ok: true }; },
    async restart() { calls.restart = (calls.restart || 0) + 1; return restartResult || { ok: true }; },
    bootstrapApplyTarget: () => applyTarget,
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
    webToken: () => WEB_TOKEN,
    async waitHealthy(ms) { calls.waitHealthy++; (calls.waitHealthyArgs = calls.waitHealthyArgs || []).push(ms); return healthResult || { ok: true, polls: 1, ms: 4000 }; },
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
    ...(opts.env ? { env: opts.env } : {}),
  }, {});
  const injected = [];
  const m = Object.create(methods);
  m._injectText = (_s, text) => { injected.push(text); };
  m.recordMisfire = () => true;
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
  assert.deepStrictEqual(b.calls.setConfig, [{ relay: true }, { workDir: '/proj', ref: 'master' }]);
  assert.strictEqual(b.calls.up, 1);

  assert.ok(exists(b.file), 'sandbox.json landed');
  const rec = JSON.parse(fs.readFileSync(b.file, 'utf-8'));
  assert.deepStrictEqual(Object.keys(rec).sort(),
    ['boxId', 'ref', 'sha', 'startedAt', 'teamDir', 'token', 'webToken', 'webUrl', 'wireUrl'].sort());
  assert.strictEqual(rec.webToken, WEB_TOKEN, 'the box\'s own web-console secret rides beside the peer-wire one');
  assert.strictEqual(rec.boxId, 'team-clodex');
  assert.strictEqual(rec.ref, 'master');
  assert.strictEqual(rec.sha, 'abcdef1234567890');
  assert.strictEqual(rec.webUrl, 'http://127.0.0.1:7810');
  assert.strictEqual(rec.wireUrl, 'http://127.0.0.1:7820');
  assert.strictEqual(rec.token, TOKEN);
  assert.strictEqual(rec.startedAt, '2026-10-15T02:00:00.000000002Z', 'startedAt is the container\'s inspected StartedAt');
});

test('the reply says `container restarted` when the container StartedAt changed', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'rebuild' });
  assert.match(b.last(), / · container restarted/);
  assert.doesNotMatch(b.last(), /NOT restarted/);
});

test('the reply says `container NOT restarted (unchanged)` when StartedAt is equal, and records it', async () => {
  const at = '2026-10-15T01:00:00.000000001Z';
  const b = mkBox({ startedAts: [at, at] });
  await fire(b, b.lead, { action: 'up' });
  assert.match(b.last(), / · container NOT restarted \(unchanged\)/);
  assert.strictEqual(JSON.parse(fs.readFileSync(b.file, 'utf-8')).startedAt, at);
});

test('a null container StartedAt records startedAt null and the reply makes no restart claim', async () => {
  const b = mkBox({ startedAts: [null, null] });
  await fire(b, b.lead, { action: 'up' });
  assert.strictEqual(JSON.parse(fs.readFileSync(b.file, 'utf-8')).startedAt, null);
  assert.doesNotMatch(b.last(), /container (NOT )?(restarted|recreated)/);
  assert.match(b.last(), /sandbox team-clodex up @/);
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
  assert.deepStrictEqual(b.calls.setConfig, [{ relay: true }, { workDir: '/proj', ref: 't9-x' }]);
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

test('status on a team with no box creates none', async () => {
  const b = mkBox();
  assert.strictEqual(b.mgr.get('team-clodex'), null, 'ENTER: the team has no box');
  await fire(b, b.lead, { action: 'status' });
  assert.strictEqual(b.calls.create.length, 0, 'a read-only status registers no box');
  assert.strictEqual(b.calls.status, 0);
  assert.match(b.last(), /no box/);
});

test('down on a team with no box creates none', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'down' });
  assert.strictEqual(b.calls.create.length, 0, 'a down registers no box to tear down');
  assert.strictEqual(b.calls.down, 0);
  assert.match(b.last(), /no box/);
});

test('down on a team with no box removes a stale token file', async () => {
  const b = mkBox();
  fs.mkdirSync(path.dirname(b.file), { recursive: true });
  fs.writeFileSync(b.file, JSON.stringify({ url: 'http://127.0.0.1:1', token: 'stale' }));
  await fire(b, b.lead, { action: 'down' });
  assert.strictEqual(b.calls.create.length, 0, 'a down registers no box to tear down');
  assert.strictEqual(b.calls.down, 0);
  assert.ok(!exists(b.file), 'the stale token file is gone');
  assert.match(b.last(), /stale .*sandbox\.json removed/);
});

test('status writes nothing and reports the state', async () => {
  const b = mkBox({ boxes: ['team-clodex'], config: { ref: 'master' } });
  await fire(b, b.lead, { action: 'status' });
  assert.ok(!exists(b.file), 'status is read-only — no token file appears');
  assert.match(b.last(), /^\[agent:team\] sandbox team-clodex running \(ref master\)/);
});

// An unconfigured box has no ref to report, and status must not invent one by
// seeding a default — seeding belongs to up/rebuild alone.
test('status on a box with no ref reports no ref clause, and still configures nothing', async () => {
  const b = mkBox({ boxes: ['team-clodex'] });
  await fire(b, b.lead, { action: 'status' });
  assert.strictEqual(b.calls.setConfig.length, 0);
  assert.match(b.last(), /^\[agent:team\] sandbox team-clodex running/);
  assert.ok(!/\(ref /.test(b.last()), `no ref was configured, so none is claimed: ${b.last()}`);
});

test('status names the clodex version the box reports on its wire', async () => {
  const b = mkBox({ boxes: ['team-clodex'],
    getPeerManager: () => ({ statuses: () => [{ id: 'team-clodex', online: true, version: '5.64.4' }] }),
  });
  await fire(b, b.lead, { action: 'status' });
  assert.match(b.last(), / · clodex 5\.64\.4\nports: none\nlimits: none\nplatform: host$/);
});

test('status marks the version as last seen when the box wire is offline', async () => {
  const b = mkBox({ boxes: ['team-clodex'],
    getPeerManager: () => ({ statuses: () => [{ id: 'team-clodex', online: false, version: '5.64.4' }] }),
  });
  await fire(b, b.lead, { action: 'status' });
  assert.match(b.last(), /clodex 5\.64\.4 \(last seen; the box's wire is offline now\)/);
});

test('status treats a peer row with no online key as offline for the version', async () => {
  const b = mkBox({ boxes: ['team-clodex'],
    getPeerManager: () => ({ statuses: () => [{ id: 'team-clodex', version: '5.64.4' }] }),
  });
  await fire(b, b.lead, { action: 'status' });
  assert.match(b.last(), /clodex 5\.64\.4 \(last seen; the box's wire is offline now\)/);
});

test('status with no peer manager says the version is unknown', async () => {
  const b = mkBox({ boxes: ['team-clodex'] });
  await fire(b, b.lead, { action: 'status' });
  assert.match(b.last(), /clodex version unknown \(box not reporting on its wire\)/);
});

test('status ignores a peer row whose id is not the box id', async () => {
  const b = mkBox({ boxes: ['team-clodex'],
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
  assert.deepStrictEqual(b.calls.setConfig, [{ relay: true }, { workDir: '/proj', ref: 't9-x' }], 'ENTER: rebuild configured the box');

  await fire(b, b.lead, { action: 'status' });

  assert.strictEqual(b.calls.setConfig.length, 2, 'status configured nothing — the rebuild patches are still the only ones');
  assert.strictEqual(b.box().getConfig().ref, 't9-x', 'the box still tracks the ref it was built from');
  assert.match(b.last(), /\(ref t9-x\)/, 'and the status line reports that ref, not the default');
});

test('down touches no config either', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'rebuild', ref: 't9-x' });
  await fire(b, b.lead, { action: 'down' });
  assert.strictEqual(b.calls.setConfig.length, 2, 'down configured nothing');
  assert.strictEqual(b.box().getConfig().ref, 't9-x');
});

// The other half of "seed only when there is no ref": a bare `up` must not reset a
// box someone already pointed at a branch.
test('a bare `up` keeps an existing ref rather than reseeding master', async () => {
  const b = mkBox({ config: { ref: 't9-x' } });
  await fire(b, b.lead, { action: 'up' });
  assert.deepStrictEqual(b.calls.setConfig, [{ relay: true }, { workDir: '/proj' }], 'no ref key at all — the box keeps t9-x');
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
  await fire(b, b.lead, { action: 'explode' });
  assert.match(b.last(), /error: sandbox action must be up \| rebuild \| down \| status \| port \| bootstrap \| restart \(got "explode"\)/);
  assert.strictEqual(b.calls.create.length, 0);
  assert.strictEqual(b.calls.get.length, 0);
});

test('a failed up surfaces the docker message and writes no token file', async () => {
  const b = mkBox({ upResult: { ok: false, error: 'Cannot connect to the Docker daemon' } });
  await fire(b, b.lead, { action: 'up' });
  assert.match(b.last(), /error: Cannot connect to the Docker daemon/);
  assert.ok(!exists(b.file), 'a box that never came up leaves no URLs claiming it did');
});

test('an up whose wire peer was not registered says so and still writes the token file', async () => {
  const b = mkBox({ upResult: { ok: true, ports: { web: 7810, wire: 7820 }, peerRegistered: false, peerError: 'ui-settings unreadable' } });
  await fire(b, b.lead, { action: 'up' });
  assert.ok(b.replies.includes('[agent:team] peer NOT registered: ui-settings unreadable'), JSON.stringify(b.replies));
  assert.ok(exists(b.file));
});

test('an up that registered its wire peer says nothing about the peer', async () => {
  const b = mkBox({ upResult: { ok: true, ports: { web: 7810, wire: 7820 }, peerRegistered: true } });
  await fire(b, b.lead, { action: 'up' });
  assert.ok(!b.replies.some((l) => l.includes('peer NOT registered')), JSON.stringify(b.replies));
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
    webToken: WEB_TOKEN,
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

test('t1096: _shipTeamIntoBox drops `removedRoleAccounts` — a host label must not resurrect inside the box', async () => {
  const b = mkBox({ boxes: ['team-clodex'] });
  const src = JSON.parse(fs.readFileSync(b.team.file, 'utf-8'));
  src.removedRoleAccounts = { reviewer: 'work' };
  fs.writeFileSync(b.team.file, `${JSON.stringify(src, null, 2)}\n`);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(b.team.file, 'utf-8')).removedRoleAccounts, { reviewer: 'work' }, 'ENTER: the host manifest carries the stash');

  b.m._shipTeamIntoBox(b.team, b.mgr.get('team-clodex'));

  const obj = JSON.parse(fs.readFileSync(path.join(b.shipped, 'team.json'), 'utf-8'));
  assert.strictEqual('removedRoleAccounts' in obj, false);
  assert.strictEqual(obj.name, 'clodex');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(b.team.file, 'utf-8')).removedRoleAccounts, { reviewer: 'work' }, 'the host manifest still has it');
});

const PUBLISHED = { container: 3000, host: 3000, proto: 'http', allInterfaces: false, label: '' };
const FAILED = { container: 5432, host: 15432, proto: 'tcp', allInterfaces: false, label: '' };
const PENDING = { container: 4000, host: 4000, proto: 'https', allInterfaces: false, label: '' };
const APPLIED = [
  { container: 3000, host: 3000, proto: 'http', allInterfaces: false, applied: true, url: 'http://localhost:3000' },
  { container: 5432, host: 15432, proto: 'tcp', allInterfaces: false, applied: false, error: 'port is already allocated' },
];
const THREE_ROWS = [
  'port 3000 → localhost:3000 (http, published)',
  'port 5432 → localhost:15432 (tcp, failed: port is already allocated)',
  'port 4000 → localhost:4000 (https, pending: box not running — sandbox up applies)',
].join('\n');

const port = (op, spec, extra = {}) => ({ action: 'port', op, spec, proto: null, label: null, ...extra });

test('port add 3000 saves the loopback entry through the intent writer', async () => {
  const b = mkBox({ boxes: ['team-clodex'] });
  await fire(b, b.lead, port('add', '3000'));
  assert.deepStrictEqual(b.calls.setConfig, [{ ports: [{ container: 3000, host: 3000, proto: 'tcp', allInterfaces: false }] }]);
  assert.deepStrictEqual(b.calls.setConfigOpts, [{ writer: 'intent' }]);
  assert.strictEqual(b.last(), '[agent:team] port 3000 → localhost:3000 (tcp, pending: box not running — sandbox up applies)');
});

test('port add 3000:3100 proto:http web sets host, proto and label, after the prior entries', async () => {
  const b = mkBox({ boxes: ['team-clodex'], config: { ports: [FAILED] } });
  await fire(b, b.lead, port('add', '3000:3100', { proto: 'http', label: 'web' }));
  assert.deepStrictEqual(b.calls.setConfig, [{ ports: [FAILED, { container: 3000, host: 3100, proto: 'http', allInterfaces: false, label: 'web' }] }]);
});

test('port add of a listed pair is a no-op that names the existing url', async () => {
  const b = mkBox({ boxes: ['team-clodex'], config: { ports: [PUBLISHED] }, applied: APPLIED });
  await fire(b, b.lead, port('add', '3000'));
  assert.strictEqual(b.calls.setConfig.length, 0);
  assert.strictEqual(b.last(), '[agent:team] already listed: port 3000 → localhost:3000 (http, published)');
});

test('port add reports a failed apply with the error setConfig returned', async () => {
  const b = mkBox({ boxes: ['team-clodex'], portsError: 'Bind failed' });
  await fire(b, b.lead, port('add', '3000'));
  assert.strictEqual(b.last(), '[agent:team] port 3000 → localhost:3000 (tcp, failed: Bind failed)');
});

test('port rm 5432 removes only that entry', async () => {
  const b = mkBox({ boxes: ['team-clodex'], config: { ports: [PUBLISHED, FAILED, PENDING] } });
  await fire(b, b.lead, port('rm', '5432'));
  assert.deepStrictEqual(b.calls.setConfig, [{ ports: [PUBLISHED, PENDING] }]);
  assert.deepStrictEqual(b.calls.setConfigOpts, [{ writer: 'intent' }]);
  assert.strictEqual(b.last(), '[agent:team] port 5432 removed (unpublished)');
});

test('a setConfig refusal is relayed verbatim', async () => {
  const refusal = '3000 is published by sandbox game-old; use 3000:3001';
  const b = mkBox({ boxes: ['team-clodex'], setConfigResult: { ok: false, error: refusal } });
  await fire(b, b.lead, port('add', '3000'));
  assert.strictEqual(b.last(), `[agent:team] error: ${refusal}`);
});

test('port list prints a published, a failed and a pending row and the coverage note', async () => {
  const b = mkBox({ boxes: ['team-clodex'], config: { ports: [PUBLISHED, FAILED, PENDING] }, applied: APPLIED });
  await fire(b, b.lead, port('list', null));
  assert.strictEqual(b.last(), `[agent:team] ${THREE_ROWS}\nURLs are for this machine; a remote Docker host shows host:port`);
  assert.strictEqual(b.calls.setConfig.length, 0);
});

test('status lists the port rows after the status line', async () => {
  const b = mkBox({ boxes: ['team-clodex'], config: { ref: 'master', ports: [PUBLISHED, FAILED, PENDING] }, applied: APPLIED });
  await fire(b, b.lead, { action: 'status' });
  const [head, ...rest] = b.last().split('\n');
  assert.match(head, /^\[agent:team\] sandbox team-clodex running \(ref master\)/);
  assert.strictEqual(rest.join('\n'), `${THREE_ROWS}\nlimits: none\nplatform: host`);
});

test('status with no ports says ports: none', async () => {
  const b = mkBox({ boxes: ['team-clodex'], config: { ref: 'master' } });
  await fire(b, b.lead, { action: 'status' });
  assert.match(b.last(), /\nports: none\nlimits: none\nplatform: host$/);
});

test('status prints applied limits and platform after the ports rows', async () => {
  const b = mkBox({ boxes: ['team-clodex'], statusResult: { state: 'running', ref: null, sha: null,
    limits: { configured: { cpus: 2, memory: '4g', pids: 512, shmSize: null },
      applied: { cpus: 2, memory: 4294967296, pids: 512, shmSize: 67108864 } },
    platform: { configured: 'linux/amd64', applied: 'linux/amd64' } } });
  await fire(b, b.lead, { action: 'status' });
  assert.match(b.last(), /\nports: none\nlimits: cpus 2 \/ memory 4g \/ pids 512 \(applied\)\nplatform: linux\/amd64 \(applied\)$/);
});

test('status marks limits and platform pending when the running box differs from config', async () => {
  const b = mkBox({ boxes: ['team-clodex'], statusResult: { state: 'running', ref: null, sha: null,
    limits: { configured: { cpus: 2, memory: '8g', pids: null, shmSize: null },
      applied: { cpus: 2, memory: 4294967296, pids: null, shmSize: 67108864 } },
    platform: { configured: 'linux/amd64', applied: 'linux/arm64' } } });
  await fire(b, b.lead, { action: 'status' });
  assert.match(b.last(), /\nlimits: cpus 2 \/ memory 8g \(pending\)\nplatform: linux\/amd64 \(pending\)$/);
});

test('port add from a seat that is not the lead is refused and saves nothing', async () => {
  const b = mkBox({ boxes: ['team-clodex'] });
  await fire(b, b.hand, port('add', '3000'));
  assert.strictEqual(b.calls.setConfig.length, 0);
  assert.strictEqual(b.last(), '[agent:team] error: only the team lead (lead) can edit team metadata');
});

test('port on a team with no box creates none', async () => {
  const b = mkBox();
  await fire(b, b.lead, port('add', '3000'));
  assert.strictEqual(b.calls.create.length, 0);
  assert.strictEqual(b.calls.setConfig.length, 0);
});

test('a row applied on a remote Docker host shows the port on that host, not localhost', async () => {
  const b = mkBox({ boxes: ['team-clodex'], config: { ports: [PUBLISHED] }, applied: [{ container: 3000, host: 3000, proto: 'http', allInterfaces: false, applied: true }] });
  await fire(b, b.lead, port('list', null));
  assert.strictEqual(b.last(), '[agent:team] port 3000 → :3000 on the Docker host (http, published)\nURLs are for this machine; a remote Docker host shows host:port');
});

test('a failed port rm names `sandbox up` as the retry', async () => {
  const b = mkBox({ boxes: ['team-clodex'], config: { ports: [PUBLISHED] }, portsError: 'boom' });
  await fire(b, b.lead, port('rm', '3000'));
  assert.strictEqual(b.last(), '[agent:team] port 3000 removed (failed: boom — `sandbox up` retries the removal)');
});

test('status marks cleared limits and platform pending while the box still runs the old ones', async () => {
  const b = mkBox({ boxes: ['team-clodex'], statusResult: { state: 'running', ref: null, sha: null,
    limits: { configured: { cpus: null, memory: null, pids: null, shmSize: null },
      applied: { cpus: 2, memory: null, pids: null, shmSize: 67108864 } },
    platform: { configured: null, applied: 'linux/s390x' } } });
  await fire(b, b.lead, { action: 'status' });
  assert.match(b.last(), /\nlimits: none \(pending\)\nplatform: host \(pending\)$/);
});

test('status asks the box for its live figures', async () => {
  const b = mkBox({ boxes: ['team-clodex'] });
  const box = b.mgr.get('team-clodex');
  const seen = [];
  const orig = box.status;
  box.status = async (opts) => { seen.push(opts); return orig.call(box, opts); };
  await fire(b, b.lead, { action: 'status' });
  assert.deepStrictEqual(seen, [{ live: true }]);
});

const IN_BOX = { CLODEX_IN_SANDBOX: '1', CLODEX_HOST_LABEL: 'mac' };

function mkInBox(env) {
  const b = mkBox({ noManager: true, env });
  const sent = [];
  b.m._sendToFederatedTarget = (from, target, body, urgent, opts) => {
    sent.push({ from, target, task: opts.task });
    return { queued: true, ref: 'r1' };
  };
  return { ...b, sent };
}

test('in-box port add is sent to the host board as a sandbox envelope', async () => {
  const b = mkInBox(IN_BOX);
  await fire(b, b.lead, port('add', '18080', { label: 'http' }));
  assert.deepStrictEqual(b.sent, [{ from: 'lead', target: 'board@mac', task: { kind: 'sandbox', verb: 'port', args: 'add 18080 http' } }]);
  assert.strictEqual(b.last(), '[agent:team] sandbox port sent to the host — its answer follows');
});

test('in-box port add proto:http carries the proto token in args', async () => {
  const b = mkInBox(IN_BOX);
  await fire(b, b.lead, port('add', '18080', { proto: 'http' }));
  assert.deepStrictEqual(b.sent.map((x) => x.task), [{ kind: 'sandbox', verb: 'port', args: 'add 18080 proto:http' }]);
});

test('in-box status is sent with empty args', async () => {
  const b = mkInBox(IN_BOX);
  await fire(b, b.lead, { action: 'status' });
  assert.deepStrictEqual(b.sent.map((x) => x.task), [{ kind: 'sandbox', verb: 'status', args: '' }]);
});

test('in-box rebuild keeps the old refusal and sends nothing', async () => {
  const b = mkInBox(IN_BOX);
  await fire(b, b.lead, { action: 'rebuild' });
  assert.match(b.last(), /error: sandboxes are not enabled on this host/);
  assert.deepStrictEqual(b.sent, []);
});

test('in-box with no host label keeps the old refusal and sends nothing', async () => {
  const b = mkInBox({ CLODEX_IN_SANDBOX: '1' });
  await fire(b, b.lead, port('add', '18080'));
  assert.match(b.last(), /error: sandboxes are not enabled on this host/);
  assert.deepStrictEqual(b.sent, []);
});

test('an up that creates the team box grants it the relay as the host writer, before docker', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'up' });
  assert.deepStrictEqual(b.calls.setConfig[0], { relay: true });
  assert.deepStrictEqual(b.calls.setConfigOpts[0], { writer: 'host' });
  assert.strictEqual(b.calls.up, 1);
});

test('an up on an existing box leaves its relay setting alone', async () => {
  const b = mkBox({ boxes: ['team-clodex'], config: { relay: false } });
  await fire(b, b.lead, { action: 'up' });
  assert.deepStrictEqual(b.calls.setConfig, [{ workDir: '/proj', ref: 'master' }]);
  assert.strictEqual(b.box().getConfig().relay, false);
});

function realBox(written) {
  const { createSandbox } = require('../sandbox');
  return createSandbox({
    id: 'team-clodex',
    label: 'clodex team',
    getUserDataPath: () => mkTmpRoot('t1893-ud-'),
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    syncPeerManager: () => {},
    registryDir: mkTmpRoot('t1893-reg-'),
    log: { info() {}, warn() {}, error() {} },
    readBoxConfig: () => written[written.length - 1] || {},
    writeBoxConfig: (next) => { written.push(next); },
  });
}

test('the REAL setConfig refuses relay from the intent writer and stores nothing', () => {
  const written = [];
  const res = realBox(written).setConfig({ relay: true }, { writer: 'intent' });
  assert.deepStrictEqual(res, { ok: false, error: 'relay is a host setting' });
  assert.deepStrictEqual(written, []);
});

test('the REAL setConfig stores relay from the host and the panel writers', () => {
  const written = [];
  const box = realBox(written);
  assert.strictEqual(box.setConfig({ relay: true }, { writer: 'host' }).relay, true);
  assert.strictEqual(box.setConfig({ relay: false }, { writer: 'panel' }).relay, false);
  assert.deepStrictEqual(written.map((w) => w.relay), [true, false]);
});

const boot = (op, extra = {}) => ({ action: 'bootstrap', op, field: null, packages: [], body: '', ...extra });

test('bootstrap packages a b saves through the intent writer with the seat, and names the rebuild', async () => {
  const b = mkBox({ boxes: ['team-clodex'] });
  await fire(b, b.lead, boot('packages', { field: 'a', packages: ['a', 'b'] }));
  assert.deepStrictEqual(b.calls.setConfig, [{ bootstrap: { packages: ['a', 'b'], setup: '', start: '' } }]);
  assert.deepStrictEqual(b.calls.setConfigOpts, [{ writer: 'intent', seat: 'lead' }]);
  assert.strictEqual(b.last(), '[agent:team] bootstrap packages saved (2): a b — applies on the next sandbox rebuild');
});

test('bootstrap setup with a body saves the body verbatim beside the existing fields', async () => {
  const body = 'service smbd start\necho "done"\n';
  const b = mkBox({ boxes: ['team-clodex'], config: { bootstrap: { packages: ['smbclient'], setup: '', start: 'x' } } });
  await fire(b, b.lead, boot('setup', { body }));
  assert.deepStrictEqual(b.calls.setConfig, [{ bootstrap: { packages: ['smbclient'], setup: body, start: 'x' } }]);
  assert.strictEqual(b.last(), '[agent:team] bootstrap setup saved (31 B, sha f92330ec) — applies on the next sandbox rebuild');
});

test('bootstrap start names restart once the box carries the bind', async () => {
  const b = mkBox({ boxes: ['team-clodex'], applyTarget: 'restart' });
  await fire(b, b.lead, boot('start', { body: 'echo hi' }));
  assert.strictEqual(b.last(), '[agent:team] bootstrap start saved (7 B, sha 56a79f3b) — applies on the next sandbox restart');
});

test('bootstrap setup with an empty body is refused and saves nothing', async () => {
  const b = mkBox({ boxes: ['team-clodex'] });
  await fire(b, b.lead, boot('setup', { body: '  \n' }));
  assert.strictEqual(b.calls.setConfig.length, 0);
  assert.strictEqual(b.last(), '[agent:team] error: bootstrap setup needs a body — [agent:team sandbox bootstrap setup] <script> … [agent:end]');
});

test('bootstrap show prints each field under its header line', async () => {
  const b = mkBox({ boxes: ['team-clodex'], config: {
    bootstrap: { packages: ['smbclient'], setup: 'echo hi', start: '' },
    bootstrapHistory: [
      { at: '2026-10-20T01:00:00.000Z', writer: 'intent', seat: 'lead', field: 'setup', sha: 'old' },
      { at: '2026-10-20T02:00:00.000Z', writer: 'panel', seat: null, field: 'setup', sha: '56a79f3b1154' },
    ] } });
  await fire(b, b.lead, boot('show', { field: 'setup' }));
  assert.strictEqual(b.last(), '[agent:team] ## setup (7 B, sha 56a79f3b · script sha 0dd1f4df, last changed 2026-10-20T02:00:00.000Z by panel/-)\necho hi');
  await fire(b, b.lead, boot('show'));
  assert.strictEqual(b.last(), [
    '[agent:team] ## packages (9 B, sha 5f7ca3fb, never changed)', 'smbclient',
    '## setup (7 B, sha 56a79f3b · script sha 0dd1f4df, last changed 2026-10-20T02:00:00.000Z by panel/-)', 'echo hi',
    '## start (0 B, sha e3b0c442, never changed)', '',
  ].join('\n'));
  assert.strictEqual(b.calls.setConfig.length, 0);
});

test('bootstrap clear start empties only that field; clear alone empties all three', async () => {
  const b = mkBox({ boxes: ['team-clodex'], config: { bootstrap: { packages: ['a'], setup: 's', start: 't' } } });
  await fire(b, b.lead, boot('clear', { field: 'start' }));
  assert.deepStrictEqual(b.calls.setConfig[0], { bootstrap: { packages: ['a'], setup: 's', start: '' } });
  assert.strictEqual(b.last(), '[agent:team] bootstrap start cleared — applies on the next sandbox rebuild');
  await fire(b, b.lead, boot('clear'));
  assert.deepStrictEqual(b.calls.setConfig[1], { bootstrap: { packages: [], setup: '', start: '' } });
  assert.strictEqual(b.last(), '[agent:team] bootstrap packages, setup, start cleared — applies on the next sandbox rebuild');
});

test('a bootstrap setConfig refusal is relayed verbatim', async () => {
  const refusal = "bootstrap.setup line 1 looks like a secret: put it in the box's env_file, not in a script";
  const b = mkBox({ boxes: ['team-clodex'], setConfigResult: { ok: false, error: refusal } });
  await fire(b, b.lead, boot('setup', { body: 'DB_PASSWORD=x' }));
  assert.strictEqual(b.last(), `[agent:team] error: ${refusal}`);
});

test('restart restarts the box and names what happens to its seats', async () => {
  const b = mkBox({ boxes: ['team-clodex'] });
  await fire(b, b.lead, { action: 'restart' });
  assert.strictEqual(b.calls.restart, 1);
  assert.strictEqual(b.calls.setConfig.length, 0);
  assert.strictEqual(b.last(), '[agent:team] restarting team-clodex — every seat inside it dies and is restored by the box; the start hook runs after healthz');
});

test('restart on a team with no box creates none', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'restart' });
  assert.strictEqual(b.calls.create.length, 0);
  assert.strictEqual(b.last(), '[agent:team] sandbox team-clodex: no box — this team has none; [agent:team sandbox up] creates it');
});

test('in-box restart is refused as desktop-only and sends nothing', async () => {
  const b = mkInBox(IN_BOX);
  await fire(b, b.lead, { action: 'restart' });
  assert.strictEqual(b.last(), '[agent:team] sandbox restart is desktop-only: it kills every seat in the box, including the one asking — ask the operator, or a desktop seat');
  assert.deepStrictEqual(b.sent, []);
});

const BOOT_ST = (bootstrap) => ({ state: 'running', ref: null, sha: null, bootstrap });

test('status prints the bootstrap rows: configured, setup ok, start running', async () => {
  const b = mkBox({ boxes: ['team-clodex'], statusResult: BOOT_ST({
    configured: { packages: 2, setup: true, start: true },
    setup: { sha: 'abcdef0123456789', exit: 0, at: '2026-10-20T01:00:00Z', timedOut: false },
    start: { pid: 42, at: '2026-10-20T01:00:05Z', exit: null }, degraded: false }) });
  await fire(b, b.lead, { action: 'status' });
  const lines = b.last().split('\n');
  assert.doesNotMatch(lines[0], /DEGRADED/);
  assert.deepStrictEqual(lines.slice(-3), [
    'bootstrap: 2 packages, setup yes, start yes',
    'setup: ok (script sha abcdef01) at 2026-10-20T01:00:00Z',
    'start hook: running pid 42 since 2026-10-20T01:00:05Z',
  ]);
});

test('status on a degraded box: the first line says so and the setup row says FAILED (timed out)', async () => {
  const b = mkBox({ boxes: ['team-clodex'], statusResult: BOOT_ST({
    configured: { packages: 0, setup: true, start: false },
    setup: { sha: 'abcdef0123456789', exit: 124, at: '2026-10-20T01:00:00Z', timedOut: true },
    start: { pid: 7, at: '2026-10-19T01:00:05Z', exit: 1 }, degraded: true }) });
  await fire(b, b.lead, { action: 'status' });
  const lines = b.last().split('\n');
  assert.match(lines[0], / — ENVIRONMENT DEGRADED \(setup failed\)$/);
  assert.deepStrictEqual(lines.slice(-3), [
    'bootstrap: 0 packages, setup yes, start no',
    'setup: FAILED exit 124 at 2026-10-20T01:00:00Z (timed out) — fix the script and sandbox rebuild',
    'start hook: exited 1 at 2026-10-19T01:00:05Z',
  ]);
});

test('status with bootstrap but no records says none for both hooks', async () => {
  const b = mkBox({ boxes: ['team-clodex'], statusResult: BOOT_ST({
    configured: { packages: 0, setup: false, start: false }, setup: null, start: null, degraded: false }) });
  await fire(b, b.lead, { action: 'status' });
  assert.match(b.last(), /\nplatform: host\nbootstrap: 0 packages, setup no, start no\nsetup: none\nstart hook: none$/);
});

test('the relayed status DTO carries the bootstrap rows and the degraded clause', async () => {
  const b = mkBox({ boxes: ['team-clodex'], statusResult: BOOT_ST({
    configured: { packages: 1, setup: false, start: false },
    setup: { sha: 'abcdef0123456789', exit: 3, at: '2026-10-20T01:00:00Z', timedOut: false }, start: null, degraded: true }) });
  const r = await b.m._sandboxVerb(b.team, b.box(), 'status', { action: 'status' }, { relay: true });
  assert.strictEqual(r.reply, [
    'sandbox team-clodex running — ENVIRONMENT DEGRADED (setup failed)', 'ports: none', 'limits: none', 'platform: host',
    'bootstrap: 1 packages, setup no, start no',
    'setup: FAILED exit 3 at 2026-10-20T01:00:00Z — fix the script and sandbox rebuild',
    'start hook: none',
  ].join('\n'));
});

test('in-box bootstrap setup with a body sends the body on the envelope and the op as args', async () => {
  const b = mkInBox(IN_BOX);
  await fire(b, b.lead, boot('setup', { body: 'service smbd start\n' }));
  assert.deepStrictEqual(b.sent, [{ from: 'lead', target: 'board@mac', task: { kind: 'sandbox', verb: 'bootstrap', args: 'setup', body: 'service smbd start\n' } }]);
  assert.strictEqual(b.last(), '[agent:team] sandbox bootstrap sent to the host — its answer follows');
});

test('in-box bootstrap packages and show carry their words in args and no body', async () => {
  const b = mkInBox(IN_BOX);
  await fire(b, b.lead, boot('packages', { field: 'smbclient', packages: ['smbclient', 'mariadb-server'] }));
  await fire(b, b.lead, boot('show', { field: 'setup' }));
  assert.deepStrictEqual(b.sent.map((x) => x.task), [
    { kind: 'sandbox', verb: 'bootstrap', args: 'packages smbclient mariadb-server' },
    { kind: 'sandbox', verb: 'bootstrap', args: 'show setup' },
  ]);
});

function relayedRig() {
  const written = [];
  const box = realBox(written);
  box.setConfig({ relay: true }, { writer: 'host' });
  const methods = createTicketMethods({
    fs,
    path,
    teamsDir: mkTmpRoot('t1895-teams-'),
    listTeams: () => ['clodex'],
    loadManifest: (name) => { if (name !== 'clodex') throw new Error('no team'); return { name: 'clodex', root: '/proj', lead: 'lead', roles: {} }; },
    getSandboxManager: () => ({ get: (id) => (id === 'team-clodex' ? box : null) }),
    getPeerManager: () => null,
    log: { info() {}, warn() {}, error() {} },
  }, {});
  return { m: Object.create(methods), box, written };
}

test('a relayed bootstrap setup whose body carries a secret line gets the A2a refusal and stores nothing', async () => {
  const r = relayedRig();
  const before = r.written.length;
  const out = await r.m._remoteSandboxVerb({ peerId: 'team-clodex', origin: 'team-clodex', from: 'lead', verb: 'bootstrap', args: 'setup', body: 'DB_PASSWORD=x' });
  assert.strictEqual(out.reply, "error: bootstrap.setup line 1 looks like a secret: put it in the box's env_file, not in a script");
  assert.strictEqual(r.written.length, before);
});

test('a relayed bootstrap write records the asking seat as from@peer in the history', async () => {
  const r = relayedRig();
  const out = await r.m._remoteSandboxVerb({ peerId: 'team-clodex', origin: 'team-clodex', from: 'lead', verb: 'bootstrap', args: 'setup', body: 'echo hi' });
  assert.strictEqual(out.reply, 'bootstrap setup saved (7 B, sha 56a79f3b) — applies on the next sandbox rebuild');
  const rows = r.box.getConfig().bootstrapHistory;
  assert.deepStrictEqual(rows.map((h) => [h.writer, h.seat, h.field, h.sha]), [['intent', 'lead@team-clodex', 'setup', '56a79f3b1154']]);
});

const DEGRADED_ST = { state: 'running', ref: null, sha: 'abcdef1234567890', ports: { web: 7810, wire: 7820 },
  bootstrap: { configured: { packages: 0, setup: true, start: false }, setup: { sha: 'abcdef0123456789', exit: 3, at: '2026-10-20T01:00:00Z', timedOut: false }, start: null, degraded: true } };

test('a bring-up whose setup failed seeds no seats and says why', async () => {
  const b = mkBox({ boxes: ['team-clodex'], statusResult: DEGRADED_ST });
  const replies = [];
  const out = await b.m._bringUpTeamBox(b.team, { mgr: b.mgr, box: b.box(), boxId: 'team-clodex', patch: { workDir: b.team.root }, action: 'rebuild', reply: (line) => replies.push(line) });
  assert.strictEqual(b.calls.waitHealthy, 1, 'ENTER: the handler reached the health wait');
  assert.deepStrictEqual(b.requests, []);
  assert.deepStrictEqual(out, { ok: false, degraded: true });
  assert.strictEqual(replies[replies.length - 1], 'box team-clodex is up but ENVIRONMENT DEGRADED: setup failed exit 3 at 2026-10-20T01:00:00Z — no seats seeded; fix the script ([agent:team sandbox bootstrap show setup]) and [agent:team sandbox rebuild], or Start without hooks from the Sandbox panel');
});

test('the health wait grows by the setup timeout only when a setup script or packages exist', async () => {
  const plain = mkBox({ boxes: ['team-clodex'] });
  await fire(plain, plain.lead, { action: 'up' });
  const withSetup = mkBox({ boxes: ['team-clodex'], config: { bootstrap: { packages: [], setup: 'echo hi', start: '' } } });
  await fire(withSetup, withSetup.lead, { action: 'up' });
  const withPackages = mkBox({ boxes: ['team-clodex'], config: { bootstrap: { packages: ['smbclient'], setup: '', start: 'x' } } });
  await fire(withPackages, withPackages.lead, { action: 'up' });
  assert.deepStrictEqual([plain.calls.waitHealthyArgs, withSetup.calls.waitHealthyArgs, withPackages.calls.waitHealthyArgs], [[180000], [780000], [780000]]);
});

test('status says hooks are disabled for this start when the compose carried CLODEX_NO_HOOKS', async () => {
  const b = mkBox({ boxes: ['team-clodex'], statusResult: BOOT_ST({
    configured: { packages: 0, setup: true, start: false }, setup: null, start: null, degraded: false, noHooks: true }) });
  await fire(b, b.lead, { action: 'status' });
  assert.match(b.last(), /\nsetup: none\nstart hook: none\nbootstrap: hooks disabled for this start$/);
});
