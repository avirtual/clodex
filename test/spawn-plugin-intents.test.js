'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { createTicketMethods } = require('../team-tickets');
const registry = require('../intent-registry');
const { mkTmpRoot } = require('./lib/tmp-roots');

const EXEC = 16;
const INTENTS = 17;

registry.registerIntent({ verb: 'avh-select', label: 'AVH select', parse: () => null }, 'avh-ops');
after(() => registry.unregisterSource('avh-ops'));

function harness(rec, team = null) {
  const calls = [];
  const replies = [];
  const home = fs.realpathSync(mkTmpRoot('clx-plugin-intents-'));
  const SessionManager = createSessionManager({
    knownSkillNames: () => [], os, fs, path,
    resolveTeam: () => team,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ get: (n) => (n === 'spawner' ? rec : null), setStripLevel() {}, setAutoCompact() {}, setPlugins() {} }),
    withoutPrivilegedIntentsFor: registry.withoutPrivilegedIntentsFor,
    ensureDir: () => {},
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    DEFAULT_WORKSPACE_ID: 'default',
    REGISTRY_DIR: home,
  });
  const m = new SessionManager();
  m.sessions = new Map();
  m._injectText = (_s, t) => replies.push(t);
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m.create = async (...args) => { calls.push(args); return undefined; };
  const dir = path.join(home, 'library', 'templates');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'tpl.json');
  fs.writeFileSync(file, JSON.stringify({
    type: 'clodent', cwd: os.tmpdir(), plugins: ['avh-ops'],
    intents: ['dm', 'avh-select'], execCommands: ['clodex-team', 'clodex-ctl-admin'],
  }));
  return { m, calls, replies, file };
}

async function spawn(h, opts) {
  h.m._handleSpawnIntent(
    { name: 'spawner', cwd: os.tmpdir(), workspaceId: 'default', type: 'clodent' },
    { name: 'child', template: h.file },
    opts,
  );
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

test('a lead holding avh-select spawns a template listing it and the child holds it', async () => {
  const h = harness({ plugins: ['avh-ops'], intents: ['dm', 'avh-select'], execCommands: ['clodex-team', 'clodex-ctl-admin'] });
  await spawn(h);
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual(h.calls[0][INTENTS], ['dm', 'avh-select']);
  assert.deepStrictEqual(h.calls[0][EXEC], ['clodex-team', 'clodex-ctl-admin']);
  assert.doesNotMatch(h.replies[0], /dropped/);
});

test('a lead without avh-select has it dropped, and the reply names it and the unheld exec command', async () => {
  const h = harness({ plugins: ['avh-ops'], intents: ['dm'], execCommands: ['clodex-team'] });
  await spawn(h);
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual(h.calls[0][INTENTS], ['dm']);
  assert.deepStrictEqual(h.calls[0][EXEC], ['clodex-team']);
  assert.match(h.replies[0], /^\[agent:spawn\] ok: spawned "child"/);
  assert.ok(h.replies[0].includes(" — plugin intents spawner does not hold, dropped: avh-select (the operator grants them in the seat's Intents checklist)"), h.replies[0]);
  assert.ok(h.replies[0].includes(' — exec commands spawner does not hold, dropped: clodex-ctl-admin'), h.replies[0]);
});

test('a lead holding avh-select without the avh-ops plugin has it dropped', async () => {
  const h = harness({ plugins: [], intents: ['dm', 'avh-select'] });
  await spawn(h);
  assert.strictEqual(h.calls.length, 1, 'ENTER: create was called');
  assert.deepStrictEqual(h.calls[0][INTENTS], ['dm']);
});

test('an operator spawn keeps avh-select whatever the spawner holds', async () => {
  const h = harness(null);
  const replies = [];
  await spawn(h, { operator: true, onReply: (r) => replies.push(r) });
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(replies)})`);
  assert.deepStrictEqual(h.calls[0][INTENTS], ['dm', 'avh-select']);
  assert.doesNotMatch(replies[0], /dropped/);
});

test('a core privileged intent in a template is dropped and named', async () => {
  const h = harness({ plugins: ['avh-ops'], intents: ['dm', 'avh-select'] });
  fs.writeFileSync(h.file, JSON.stringify({ type: 'clodent', cwd: os.tmpdir(), intents: ['dm', 'team-create'] }));
  await spawn(h);
  assert.strictEqual(h.calls.length, 1, 'ENTER: create was called');
  assert.deepStrictEqual(h.calls[0][INTENTS], ['dm']);
  assert.ok(h.replies[0].includes(' — privileged intents are operator grants a template cannot carry, dropped: team-create'), h.replies[0]);
});

test('template-save names the exec commands it strips and the intents a spawn may drop', () => {
  const home = mkTmpRoot('t2222-save-');
  const teamsDir = path.join(home, 'teams');
  fs.mkdirSync(path.join(teamsDir, 'clodex'), { recursive: true });
  const team = { name: 'clodex', root: '/proj', lead: 'lead', file: path.join(teamsDir, 'clodex', 'team.json'), dir: path.join(teamsDir, 'clodex'), roles: {} };
  const methods = createTicketMethods({
    fs, path, teamsDir,
    listTeams: () => ['clodex'],
    resolveTeam: (cwd) => (cwd === '/proj' ? team : null),
    refreshAppMenu: () => {},
    getPersistence: () => ({ get: () => null }),
    withoutPrivilegedIntentsFor: registry.withoutPrivilegedIntentsFor,
    log: { info() {}, warn() {}, error() {} },
  }, {});
  const injected = [];
  const m = Object.create(methods);
  m._injectText = (_s, text) => { injected.push(text); };
  m.recordMisfire = () => true;
  m._handleTeam({ name: 'lead', agentType: 'claude', cwd: '/proj' }, {
    type: 'team', sub: 'template-save', stem: 'keeper',
    body: JSON.stringify({ type: 'clodent', intents: ['dm', 'team-create', 'avh-select'], execCommands: ['clodex-ctl-admin'] }),
  });
  const file = path.join(teamsDir, 'clodex', 'templates', 'keeper.json');
  assert.strictEqual(injected.length, 1);
  assert.strictEqual(injected[0], `[agent:team] template "keeper" saved to ${file}`
    + '; stripped execCommands (clodex-ctl-admin), which lead neither holds nor may grant — the stored values are unchanged'
    + '; privileged intents are operator grants a template cannot carry, every spawn drops: team-create'
    + '; plugin intents avh-select reach a spawned seat only when its spawner holds them or, as its team lead, may grant them');
});

test('a team lead with avh-select and clodex-ctl-admin only in grantable gives them to the child; a non-lead does not', async () => {
  const rec = { plugins: ['avh-ops'], intents: ['dm'], execCommands: ['clodex-team'], grantable: { execCommands: ['clodex-ctl-admin'], intents: ['avh-select'], flags: [] } };
  const lead = harness(rec, { name: 'core', lead: 'spawner', root: os.tmpdir(), roles: {}, roster: [] });
  await spawn(lead);
  assert.strictEqual(lead.calls.length, 1, `ENTER: create was called (${JSON.stringify(lead.replies)})`);
  assert.deepStrictEqual([lead.calls[0][INTENTS], lead.calls[0][EXEC]], [['dm', 'avh-select'], ['clodex-team', 'clodex-ctl-admin']]);
  const other = harness(rec, { name: 'core', lead: 'someone-else', root: os.tmpdir(), roles: {}, roster: [] });
  await spawn(other);
  assert.strictEqual(other.calls.length, 1, `ENTER: create was called (${JSON.stringify(other.replies)})`);
  assert.deepStrictEqual([other.calls[0][INTENTS], other.calls[0][EXEC]], [['dm'], ['clodex-team']]);
});
