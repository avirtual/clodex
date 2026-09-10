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

function mkFakeManager({ boxes = [], ports = { web: 7810, wire: 7820 }, upResult, statusResult, downResult, setConfigResult } = {}) {
  const calls = { create: [], get: [], setConfig: [], up: 0, rebuild: 0, down: 0, status: 0 };
  const rows = new Map(boxes.map((id) => [id, { id }]));
  const makeBox = (id) => ({
    id,
    setConfig(partial) { calls.setConfig.push(partial); return setConfigResult || { ...partial }; },
    async up() { calls.up++; return upResult || { ok: true, ports }; },
    async rebuild() { calls.rebuild++; return upResult || { ok: true, ports }; },
    async down() { calls.down++; return downResult || { ok: true }; },
    async status() {
      calls.status++;
      return statusResult || { state: 'running', ref: 'master', sha: 'abcdef1234567890', ports };
    },
    remoteToken: () => TOKEN,
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

function mkBox(opts = {}) {
  const home = mkTmpRoot('t808-');
  const teamsDir = path.join(home, 'teams');
  fs.mkdirSync(path.join(teamsDir, 'clodex'), { recursive: true, mode: 0o700 });
  const team = {
    name: 'clodex',
    root: '/proj',
    lead: 'lead',
    file: path.join(teamsDir, 'clodex', 'team.json'),
    dir: path.join(teamsDir, 'clodex'),
    roles: { lead: { brief: 'the lead' }, hand: { brief: 'the hand' } },
  };
  const fake = opts.noManager ? null : mkFakeManager(opts);
  const methods = createTicketMethods({
    fs,
    path,
    teamsDir,
    listTeams: () => ['clodex'],
    resolveTeam: (cwd) => (cwd === '/proj' ? team : null),
    refreshAppMenu: () => {},
    getSandboxManager: () => (fake ? fake.manager : null),
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
    file: path.join(teamsDir, 'clodex', 'sandbox.json'),
  };
}

// _handleTeam dispatches the async handler and returns; every subject awaits
// this so the assertions read the state the docker steps actually left.
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

const fire = async (b, session, intent) => {
  b.m._handleTeam(session, { type: 'team', sub: 'sandbox', action: 'up', ref: 'master', body: '', ...intent });
  await settle();
};

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

test('up creates box team-<name>, sets ref + workDir, and writes sandbox.json', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'up', ref: 'master' });

  assert.deepStrictEqual(b.calls.create, [['team-clodex', 'clodex team']]);
  // Whole-object compare: a patch that also carried `image` would silently
  // overwrite the operator's GUI override, which t807 made precedence-bearing.
  assert.deepStrictEqual(b.calls.setConfig, [{ ref: 'master', workDir: '/proj' }]);
  assert.strictEqual(b.calls.up, 1);

  assert.ok(exists(b.file), 'sandbox.json landed');
  const rec = JSON.parse(fs.readFileSync(b.file, 'utf-8'));
  assert.deepStrictEqual(Object.keys(rec).sort(),
    ['boxId', 'ref', 'sha', 'startedAt', 'token', 'webUrl', 'wireUrl'].sort());
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
  await fire(b, b.lead, { action: 'up', ref: 'master' });
  assert.strictEqual(fs.statSync(b.file).mode & 0o777, 0o600);
});

test('the reply names the file, never the token', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'up', ref: 'master' });
  const line = b.last();
  assert.ok(!line.includes(TOKEN), `the reply leaked the token: ${line}`);
  assert.match(line, /sandbox team-clodex up @ abcdef12 \(ref master\)/);
  assert.match(line, /web http:\/\/127\.0\.0\.1:7810 · wire :7820/);
  assert.ok(line.includes(b.file), 'the reply points at the file the token is in');
});

test('a second up does NOT create the box again', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'up', ref: 'master' });
  await fire(b, b.lead, { action: 'up', ref: 'master' });
  assert.deepStrictEqual(b.calls.create, [['team-clodex', 'clodex team']]);
  assert.strictEqual(b.calls.up, 2);
});

test('rebuild goes through rebuild(), not up(), and still writes the file', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'rebuild', ref: 't9-x' });
  assert.strictEqual(b.calls.rebuild, 1);
  assert.strictEqual(b.calls.up, 0);
  assert.deepStrictEqual(b.calls.setConfig, [{ ref: 't9-x', workDir: '/proj' }]);
  assert.ok(exists(b.file));
});

test('down stops the box and deletes sandbox.json', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'up', ref: 'master' });
  assert.ok(exists(b.file));
  await fire(b, b.lead, { action: 'down', ref: 'master' });
  assert.strictEqual(b.calls.down, 1);
  assert.ok(!exists(b.file), 'the token file is gone once the box is down');
  assert.match(b.last(), /sandbox team-clodex down/);
});

test('status writes nothing and reports the state', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'status', ref: 'master' });
  assert.ok(!exists(b.file), 'status is read-only — no token file appears');
  assert.match(b.last(), /^\[agent:team\] sandbox team-clodex running \(ref master\)/);
});

test('a non-lead gets the same refusal the other team verbs give, and writes nothing', async () => {
  const b = mkBox();
  await fire(b, b.hand, { action: 'up', ref: 'master' });
  assert.match(b.last(), /only the team lead \(lead\) can edit team metadata/);
  assert.strictEqual(b.calls.create.length, 0, 'a refused verb touches no box');
  assert.ok(!exists(b.file));
});

test('no sandbox manager on this host → the "not enabled" error, and nothing is written', async () => {
  const b = mkBox({ noManager: true });
  await fire(b, b.lead, { action: 'up', ref: 'master' });
  assert.match(b.last(), /error: sandboxes are not enabled on this host/);
  assert.ok(!exists(b.file));
});

test('an unknown action is refused before any box is touched', async () => {
  const b = mkBox();
  await fire(b, b.lead, { action: 'restart', ref: 'master' });
  assert.match(b.last(), /error: sandbox action must be up \| rebuild \| down \| status \(got "restart"\)/);
  assert.strictEqual(b.calls.create.length, 0);
  assert.strictEqual(b.calls.get.length, 0);
});

test('a failed up surfaces the docker message and writes no token file', async () => {
  const b = mkBox({ upResult: { ok: false, error: 'Cannot connect to the Docker daemon' } });
  await fire(b, b.lead, { action: 'up', ref: 'master' });
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
