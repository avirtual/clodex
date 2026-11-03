'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { teamTemplateSave } = require('../team-prompt-dir');
const { mkTmpRoot } = require('./lib/tmp-roots');

const EXTRA_ARGS = 3;
const EXEC = 16;
const NO_WIRE = 20;
const PROTECT = 26;

function harness({ rec = null, team = null } = {}) {
  const calls = [];
  const replies = [];
  const home = fs.realpathSync(mkTmpRoot('clx-clamp-home-'));
  const SessionManager = createSessionManager({
    knownSkillNames: () => [], os, fs, path,
    resolveTeam: () => team,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ get: (n) => (n === 'spawner' ? rec : null), setStripLevel() {}, setAutoCompact() {} }),
    withoutPrivilegedIntentsFor: (x) => x,
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
  const writeTpl = (tpl, dir = path.join(home, 'library', 'templates')) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'tpl.json');
    fs.writeFileSync(file, JSON.stringify({ type: 'claude', cwd: os.tmpdir(), ...tpl }));
    return file;
  };
  return { m, calls, replies, home, writeTpl };
}

async function spawn(h, template, opts) {
  h.m._handleSpawnIntent(
    { name: 'spawner', cwd: os.tmpdir(), workspaceId: 'default', type: 'claude' },
    { name: 'child', ...(template ? { template } : { cwd: os.tmpdir() }) },
    opts,
  );
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

test('a no-grant spawner cannot mint a child holding a template\'s exec grant', async () => {
  const h = harness({ rec: null });
  await spawn(h, h.writeTpl({ execCommands: ['clodex-ctl-admin'] }));
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual(h.calls[0][EXEC], []);
});

test('exec grants are the template\'s list intersected with the spawner\'s', async () => {
  const h = harness({ rec: { execCommands: ['clodex-team', 'clodex-run-tests'] } });
  await spawn(h, h.writeTpl({ execCommands: ['clodex-team', 'clodex-ctl-admin'] }));
  assert.strictEqual(h.calls.length, 1, 'ENTER: create was called');
  assert.deepStrictEqual(h.calls[0][EXEC], ['clodex-team']);
});

test('a template carrying --settings from a spawner without it is refused, naming the flag', async () => {
  const h = harness({ rec: { extraArgs: ['--model', 'opus'] } });
  await spawn(h, h.writeTpl({ extraArgs: ['--dangerously-skip-permissions', '--settings', '/tmp/empty.json'] }));
  assert.deepStrictEqual(h.calls, []);
  assert.strictEqual(h.replies.length, 1);
  assert.match(h.replies[0], /^\[agent:spawn\] error: .*--settings/);
  assert.match(h.replies[0], /--dangerously-skip-permissions/);
});

test('a privileged flag the spawner\'s own args carry passes through', async () => {
  const h = harness({ rec: { extraArgs: ['--dangerously-skip-permissions'] } });
  await spawn(h, h.writeTpl({ extraArgs: ['--model', 'opus', '--dangerously-skip-permissions'] }));
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual(h.calls[0][EXTRA_ARGS], ['--model', 'opus', '--dangerously-skip-permissions']);
});

test('noWire passes only from a wire-off spawner', async () => {
  const on = harness({ rec: {} });
  await spawn(on, on.writeTpl({ noWire: true }));
  const off = harness({ rec: { noWire: true } });
  await spawn(off, off.writeTpl({ noWire: true }));
  assert.deepStrictEqual([on.calls[0][NO_WIRE], off.calls[0][NO_WIRE]], [false, true]);
});

test('a credential-sandboxed spawner\'s child inherits protectCredentials with no template', async () => {
  const h = harness({ rec: { extraArgs: ['--dangerously-skip-permissions'], protectCredentials: ['~/.ssh'] } });
  await spawn(h, null);
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual(h.calls[0][EXTRA_ARGS], ['--dangerously-skip-permissions'], 'ENTER: the bypass posture is inherited');
  assert.deepStrictEqual(h.calls[0][PROTECT], ['~/.ssh']);
});

test('protectCredentials is the union of the spawner\'s and the template\'s; null when neither sets it', async () => {
  const h = harness({ rec: { protectCredentials: ['~/.ssh'] } });
  await spawn(h, h.writeTpl({ protectCredentials: ['~/.aws', '~/.ssh'] }));
  const none = harness({ rec: {} });
  await spawn(none, null);
  assert.deepStrictEqual([h.calls[0][PROTECT], none.calls[0][PROTECT]], [['~/.ssh', '~/.aws'], null]);
});

test('a path template under the spawner\'s team templates dir is accepted; a symlink out of the library is refused', async () => {
  const tmp = fs.realpathSync(mkTmpRoot('clx-clamp-team-'));
  const team = { name: 't', root: tmp, lead: 't-lead', dir: path.join(tmp, 'teams', 't'), roles: {} };
  const h = harness({ rec: {}, team });
  await spawn(h, h.writeTpl({}, path.join(team.dir, 'templates')));
  assert.strictEqual(h.calls.length, 1, `team templates dir accepted (${JSON.stringify(h.replies)})`);

  const outside = h.writeTpl({}, path.join(tmp, 'seat'));
  const lib = path.join(h.home, 'library', 'templates');
  fs.mkdirSync(lib, { recursive: true });
  fs.symlinkSync(outside, path.join(lib, 'link.json'));
  await spawn(h, path.join(lib, 'link.json'));
  assert.strictEqual(h.calls.length, 1, 'the symlinked template reached no create()');
  assert.deepStrictEqual(h.replies.slice(1), ['[agent:spawn] error: template path must be under the library or the team templates dir']);
});

test('the operator door is not clamped', async () => {
  const h = harness({ rec: null });
  await spawn(h, h.writeTpl({ execCommands: ['clodex-ctl-admin'], extraArgs: ['--settings', '/x.json'], noWire: true }), { operator: true, onReply: (r) => h.replies.push(r) });
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual([h.calls[0][EXEC], h.calls[0][EXTRA_ARGS], h.calls[0][NO_WIRE]], [['clodex-ctl-admin'], ['--settings', '/x.json'], true]);
});

test('a privileged flag is held only with the spawner\'s own values', async () => {
  const swap = harness({ rec: { extraArgs: ['--settings', 'ops.json', '--add-dir', '/proj'] } });
  await spawn(swap, swap.writeTpl({ extraArgs: ['--settings', '/tmp/empty.json'] }));
  const wider = harness({ rec: { extraArgs: ['--add-dir', '/proj'] } });
  await spawn(wider, wider.writeTpl({ extraArgs: ['--add-dir', '/proj', '/'] }));
  const same = harness({ rec: { extraArgs: ['--settings=ops.json', '--add-dir', '/proj', '/b'] } });
  await spawn(same, same.writeTpl({ extraArgs: ['--settings', 'ops.json', '--add-dir', '/b'] }));
  assert.deepStrictEqual([swap.calls.length, wider.calls.length, same.calls.length], [0, 0, 1]);
  assert.match(swap.replies[0], /carries --settings,/);
  assert.match(wider.replies[0], /carries --add-dir,/);
});

function teamDeps() {
  const teamsDir = mkTmpRoot('clx-clamp-tsave-');
  fs.mkdirSync(path.join(teamsDir, 'core', 'templates'), { recursive: true });
  return { deps: { fs, path, teamsDir, listTeams: () => ['core'] }, file: path.join(teamsDir, 'core', 'templates', 'pm.json') };
}

test('template-save without operator strips execCommands and privileged flags, reports them, and keeps the stored values', () => {
  const { deps, file } = teamDeps();
  const body = { type: 'claude', execCommands: ['clodex-ctl-admin'], extraArgs: ['--model', 'opus', '--settings', '/tmp/e.json', '--add-dir', '/a', '/b'] };
  assert.deepStrictEqual(teamTemplateSave(deps, 'core', 'pm', body), { ok: true, file, stripped: ['execCommands', '--settings', '--add-dir'] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'claude', extraArgs: ['--model', 'opus'] });

  fs.writeFileSync(file, JSON.stringify({ type: 'claude', execCommands: ['clodex-team'], extraArgs: ['--dangerously-skip-permissions'] }));
  assert.deepStrictEqual(teamTemplateSave(deps, 'core', 'pm', { type: 'claude', extraArgs: ['--model', 'x'] }), { ok: true, file });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')),
    { type: 'claude', extraArgs: ['--model', 'x', '--dangerously-skip-permissions'], execCommands: ['clodex-team'] });
});

test('template-save without operator drops a non-array extraArgs and reports it', () => {
  const { deps, file } = teamDeps();
  assert.deepStrictEqual(teamTemplateSave(deps, 'core', 'pm', { type: 'claude', extraArgs: '--settings /x' }), { ok: true, file, stripped: ['extraArgs'] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'claude' });
});

test('a derive and the operator keep exec grants and flags', () => {
  const { deps, file } = teamDeps();
  const body = { type: 'claude', execCommands: ['clodex-run-tests'], extraArgs: ['--model', 'opus', '--dangerously-skip-permissions'] };
  assert.deepStrictEqual(teamTemplateSave(deps, 'core', 'pm', body, { derived: true }), { ok: true, file });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), body);
  assert.deepStrictEqual(teamTemplateSave(deps, 'core', 'pm', { ...body, execCommands: ['clodex-ctl-admin'] }, { operator: true }), { ok: true, file });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).execCommands, ['clodex-ctl-admin']);
});

const ESCALATION_ROWS = [
  { args: ['--sandbox', 'danger-full-access'], flag: '--sandbox' },
  { args: ['-s', 'danger-full-access'], flag: '--sandbox' },
  { args: ['-sdanger-full-access'], flag: '--sandbox' },
  { args: ['--ask-for-approval', 'never'], flag: '--ask-for-approval' },
  { args: ['-a', 'never'], flag: '--ask-for-approval' },
  { args: ['--config', 'sandbox_mode=danger-full-access'], flag: '--config' },
  { args: ['-c', 'sandbox_mode=danger-full-access'], flag: '--config' },
  { args: ['--config=sandbox_mode=danger-full-access'], flag: '--config' },
  { args: ['--full-auto'], flag: '--full-auto' },
  { args: ['--allowedTools', 'Bash'], flag: '--allowedTools' },
  { args: ['--allowed-tools', 'Bash'], flag: '--allowedTools' },
  { args: ['--disallowedTools', 'Bash'], flag: '--disallowedTools' },
  { args: ['--disallowed-tools', 'Bash'], flag: '--disallowedTools' },
];

for (const { args, flag } of ESCALATION_ROWS) {
  test(`${args.join(' ')} is refused from a spawner without it and passes from one carrying it`, async () => {
    const bare = harness({ rec: { extraArgs: ['--model', 'opus'] } });
    await spawn(bare, bare.writeTpl({ extraArgs: args }));
    assert.deepStrictEqual(bare.calls, []);
    assert.match(bare.replies[0] || '', new RegExp(`carries ${flag},? `));
    const held = harness({ rec: { extraArgs: args } });
    await spawn(held, held.writeTpl({ extraArgs: args }));
    assert.strictEqual(held.calls.length, 1, `ENTER: create was called (${JSON.stringify(held.replies)})`);
    assert.deepStrictEqual(held.calls[0][EXTRA_ARGS], args);
  });
}

test('a short and a long form of the same flag and value match across spawner and template', async () => {
  const sandbox = harness({ rec: { extraArgs: ['--sandbox', 'read-only'] } });
  await spawn(sandbox, sandbox.writeTpl({ extraArgs: ['-s', 'read-only'] }));
  const approval = harness({ rec: { extraArgs: ['-a', 'never'] } });
  await spawn(approval, approval.writeTpl({ extraArgs: ['--ask-for-approval=never'] }));
  const config = harness({ rec: { extraArgs: ['--config', 'sandbox_mode=read-only'] } });
  await spawn(config, config.writeTpl({ extraArgs: ['-c', 'sandbox_mode=read-only'] }));
  const tools = harness({ rec: { extraArgs: ['--allowed-tools', 'Read'] } });
  await spawn(tools, tools.writeTpl({ extraArgs: ['--allowedTools', 'Read'] }));
  const widened = harness({ rec: { extraArgs: ['--sandbox', 'read-only'] } });
  await spawn(widened, widened.writeTpl({ extraArgs: ['-s', 'danger-full-access'] }));
  assert.deepStrictEqual([sandbox.calls.length, approval.calls.length, config.calls.length, tools.calls.length, widened.calls.length], [1, 1, 1, 1, 0]);
  assert.match(widened.replies[0], /carries --sandbox,/);
});
