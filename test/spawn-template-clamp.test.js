'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { teamTemplateSave } = require('../team-prompt-dir');
const { restoreSessionsForWorkspace } = require('../session-restore');
const { splitPrivilegedArgs } = require('../cli-adapters');
const { mkTmpRoot } = require('./lib/tmp-roots');

const EXTRA_ARGS = 3;
const EXEC = 16;
const NO_WIRE = 20;
const PROTECT = 26;
const DENY_BUILTINS = 10;
const DISABLED_TOOLS = 11;
const SHELL_DENY = 22;

function harness({ rec = null, team = null, others = {} } = {}) {
  const calls = [];
  const replies = [];
  const home = fs.realpathSync(mkTmpRoot('clx-clamp-home-'));
  const SessionManager = createSessionManager({
    knownSkillNames: () => [], os, fs, path,
    resolveTeam: () => team,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ get: (n) => (n === 'spawner' ? rec : (others[n] || null)), setStripLevel() {}, setAutoCompact() {} }),
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

async function spawn(h, template, opts, spawnerType = 'claude') {
  h.m._handleSpawnIntent(
    { name: 'spawner', cwd: os.tmpdir(), workspaceId: 'default', type: spawnerType },
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

for (const type of ['codex', 'muse']) {
  test(`a credential-sandboxed spawner cannot spawn a ${type} child, which does not enforce the sandbox`, async () => {
    const h = harness({ rec: { protectCredentials: ['~/.ssh'] } });
    await spawn(h, h.writeTpl({ type }));
    assert.deepStrictEqual(h.calls, []);
    assert.deepStrictEqual(h.replies, [`[agent:spawn] error: ${type} does not enforce a credential sandbox — a ${type} seat cannot carry the protectCredentials its spawner holds (~/.ssh)`]);
  });
}

for (const type of ['claude', 'clodent']) {
  test(`a credential-sandboxed spawner spawns a ${type} child carrying its list`, async () => {
    const h = harness({ rec: { protectCredentials: ['~/.ssh'] } });
    await spawn(h, h.writeTpl({ type }));
    assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
    assert.strictEqual(h.calls[0][1], type);
    assert.deepStrictEqual(h.calls[0][PROTECT], ['~/.ssh']);
  });
}

test('the operator door spawns a codex child from a credential-sandboxed spawner', async () => {
  const h = harness({ rec: { protectCredentials: ['~/.ssh'] } });
  await spawn(h, h.writeTpl({ type: 'codex' }), { operator: true, onReply: (r) => h.replies.push(r) });
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.strictEqual(h.calls[0][1], 'codex');
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
  { args: ['--yolo'], flag: '--yolo' },
  { args: ['--profile', 'danger'], flag: '--profile' },
  { args: ['-p', 'danger'], flag: '--profile' },
  { args: ['--sandbox-network', 'enabled'], flag: '--sandbox-network' },
  { args: ['--permission-profile', 'open'], flag: '--permission-profile' },
  { args: ['--agents', '{"x":{"permissionMode":"bypassPermissions"}}'], flag: '--agents' },
  { args: ['--plugin-dir', '/tmp/evil'], flag: '--plugin-dir' },
  { args: ['--enable', 'unsafe_feature'], flag: '--enable' },
  { args: ['--dangerously-bypass-hook-trust'], flag: '--dangerously-bypass-hook-trust' },
  { args: ['--disable-approval'], flag: '--disable-approval' },
  { args: ['--trust-workspace'], flag: '--trust-workspace' },
  { args: ['--approval-judge', 'off'], flag: '--approval-judge' },
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

test('short, glued and alias forms split into pairs under the long name', () => {
  const { pairs, kept } = splitPrivilegedArgs(['-s', 'read-only', '-anever', '-c', 'sandbox_mode=x', '-p', 'prof', '--allowed-tools', 'Read', '-m', 'o3']);
  assert.deepStrictEqual(pairs, [['--sandbox', 'read-only'], ['--ask-for-approval', 'never'], ['--config', 'sandbox_mode=x'], ['--profile', 'prof'], ['--allowedTools', 'Read']]);
  assert.deepStrictEqual(kept, ['-m', 'o3']);
});

test('a template extraArgs element that is not a string is refused, even from a spawner holding the flag', async () => {
  const h = harness({ rec: { extraArgs: ['--yolo'] } });
  await spawn(h, h.writeTpl({ extraArgs: [['--yolo']] }));
  assert.deepStrictEqual(h.calls, []);
  assert.strictEqual(h.replies.length, 1);
  assert.match(h.replies[0], /^\[agent:spawn\] error: template ".*" extraArgs must be strings$/);
});

test('template-save without operator drops an extraArgs array holding a non-string and reports it', () => {
  const { deps, file } = teamDeps();
  assert.deepStrictEqual(teamTemplateSave(deps, 'core', 'pm', { type: 'claude', extraArgs: [['--yolo'], '--model', 'x'] }), { ok: true, file, stripped: ['extraArgs'] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'claude' });
});

const CODEX_RO = ['--sandbox', 'read-only', '--ask-for-approval', 'never'];

test('a read-only spawner\'s child carries its adapter\'s read-only cap args', async () => {
  const h = harness({ rec: { extraArgs: CODEX_RO } });
  await spawn(h, h.writeTpl({ type: 'codex' }), undefined, 'codex');
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual(h.calls[0][EXTRA_ARGS], ['--sandbox', 'read-only', '--ask-for-approval', 'never']);
  const clodent = harness({ rec: { extraArgs: CODEX_RO } });
  await spawn(clodent, clodent.writeTpl({ type: 'clodent', extraArgs: ['--model', 'x'] }), undefined, 'codex');
  assert.strictEqual(clodent.calls.length, 1, `ENTER: clodent create was called (${JSON.stringify(clodent.replies)})`);
  assert.deepStrictEqual(clodent.calls[0][EXTRA_ARGS], ['--model', 'x', '--permission-mode', 'plan']);
  const alias = harness({ rec: { extraArgs: CODEX_RO } });
  await spawn(alias, alias.writeTpl({ type: 'clodent', extraArgs: ['--read-only'] }), undefined, 'codex');
  assert.strictEqual(alias.calls.length, 1, `ENTER: clodent --read-only create was called (${JSON.stringify(alias.replies)})`);
  assert.deepStrictEqual(alias.calls[0][EXTRA_ARGS], ['--read-only'], '--read-only already is the cap: no conflicting --permission-mode is appended');
});

test('a read-only spawner\'s child whose template already carries the cap is not given a second copy', async () => {
  const h = harness({ rec: { extraArgs: CODEX_RO } });
  await spawn(h, h.writeTpl({ type: 'codex', extraArgs: ['-s', 'read-only', '-a', 'never'] }), undefined, 'codex');
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual(h.calls[0][EXTRA_ARGS], ['-s', 'read-only', '-a', 'never']);
});

test('a read-only spawner cannot spawn a claude child, which has no argv cap', async () => {
  const h = harness({ rec: { extraArgs: CODEX_RO } });
  await spawn(h, h.writeTpl({ type: 'claude' }), undefined, 'codex');
  assert.deepStrictEqual(h.calls, []);
  assert.match(h.replies[0], /^\[agent:spawn\] error: spawner is read-only/);
});

test('denyBuiltins, disabledTools and shellDeny are the union of the template\'s and the spawner\'s', async () => {
  const h = harness({ rec: { disabledTools: ['WebFetch'], denyBuiltins: ['Explore'], shellDeny: ['curl'] } });
  await spawn(h, h.writeTpl({ disabledTools: ['Skill'], denyBuiltins: ['Explore', 'Plan'] }));
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual([h.calls[0][DISABLED_TOOLS], h.calls[0][DENY_BUILTINS], h.calls[0][SHELL_DENY]],
    [['Skill', 'WebFetch'], ['Explore', 'Plan'], ['curl']]);
  const bare = harness({ rec: null });
  await spawn(bare, null);
  assert.strictEqual(bare.calls.length, 1, 'ENTER: bare create was called');
  assert.deepStrictEqual([bare.calls[0][DISABLED_TOOLS], bare.calls[0][DENY_BUILTINS], bare.calls[0][SHELL_DENY]], [[], [], null]);
});

test('a clodent child spawns carrying the denies its spawner and template hold', async () => {
  for (const [rec, tpl, col, want] of [
    [{ disabledTools: ['WebFetch'] }, {}, DISABLED_TOOLS, ['WebFetch']],
    [{ shellDeny: ['curl'] }, {}, SHELL_DENY, ['curl']],
    [null, { denyBuiltins: ['Explore'] }, DENY_BUILTINS, ['Explore']],
  ]) {
    const h = harness({ rec });
    await spawn(h, h.writeTpl({ type: 'clodent', ...tpl }));
    assert.strictEqual(h.calls.length, 1, `ENTER: create was called for ${JSON.stringify([rec, tpl])} (${JSON.stringify(h.replies)})`);
    assert.strictEqual(h.calls[0][1], 'clodent');
    assert.deepStrictEqual(h.calls[0][col], want, JSON.stringify([rec, tpl]));
  }
});

test('the operator door inherits neither the spawner\'s cap nor its denies', async () => {
  const h = harness({ rec: { extraArgs: CODEX_RO, disabledTools: ['WebFetch'], shellDeny: ['curl'] } });
  await spawn(h, h.writeTpl({ type: 'clodent', disabledTools: ['Skill'] }), { operator: true, onReply: (r) => h.replies.push(r) }, 'codex');
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual([h.calls[0][EXTRA_ARGS], h.calls[0][DISABLED_TOOLS], h.calls[0][SHELL_DENY]], [[], ['Skill'], null]);
});

test('a template that sets a held cap flag to another value is refused as lifting the read-only cap', async () => {
  const h = harness({ rec: { extraArgs: ['--sandbox', 'workspace-write', ...CODEX_RO] } });
  await spawn(h, h.writeTpl({ type: 'codex', extraArgs: ['--sandbox', 'workspace-write'] }), undefined, 'codex');
  assert.deepStrictEqual(h.calls, []);
  assert.match(h.replies[0], /^\[agent:spawn\] error: template ".*" carries --sandbox, which lifts spawner's read-only cap/);
});

test('deny lists are read off the spawner\'s live session when the record has none', async () => {
  const h = harness({ rec: null });
  h.m.sessions.set('spawner', { name: 'spawner', disabledTools: ['WebFetch'], shellDeny: ['curl'] });
  await spawn(h, h.writeTpl({}));
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual([h.calls[0][DISABLED_TOOLS], h.calls[0][SHELL_DENY]], [['WebFetch'], ['curl']]);
});

const LEAD_SAVER = (record) => ({ saver: { name: 'lead', lead: 'lead', record } });

test('a lead\'s template-save keeps the exec commands it holds and names the rest as stripped', () => {
  const { deps, file } = teamDeps();
  const res = teamTemplateSave(deps, 'core', 'pm', { type: 'claude', execCommands: ['avh-chat', 'avh-warden'] }, LEAD_SAVER({ execCommands: ['avh-chat'] }));
  assert.deepStrictEqual(res, { ok: true, file, stripped: ['avh-warden'] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'claude', execCommands: ['avh-chat'] });
});

test('a lead holding --yolo keeps --dangerously-skip-permissions on a template; a lead without it has it stripped', () => {
  const { deps, file } = teamDeps();
  const body = { type: 'claude', extraArgs: ['--model', 'x', '--dangerously-skip-permissions'] };
  assert.deepStrictEqual(teamTemplateSave(deps, 'core', 'pm', body, LEAD_SAVER({ extraArgs: ['--yolo'] })), { ok: true, file });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), body);
  fs.unlinkSync(file);
  assert.deepStrictEqual(teamTemplateSave(deps, 'core', 'pm', body, LEAD_SAVER({ extraArgs: ['--model', 'x'] })),
    { ok: true, file, stripped: ['--dangerously-skip-permissions'] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'claude', extraArgs: ['--model', 'x'] });
});

test('a saver that is not the team lead, or has no record, keeps nothing privileged', () => {
  const { deps, file } = teamDeps();
  const body = { type: 'claude', execCommands: ['avh-chat'], extraArgs: ['--yolo'] };
  const record = { execCommands: ['avh-chat'], extraArgs: ['--yolo'] };
  for (const saver of [{ name: 'hand', lead: 'lead', record }, { name: 'lead', lead: 'lead', record: null }]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    assert.deepStrictEqual(teamTemplateSave(deps, 'core', 'pm', body, { saver }), { ok: true, file, stripped: ['execCommands', '--yolo'] });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'claude', extraArgs: [] });
  }
});

for (const type of ['clodent', 'claude']) {
  test(`a lead-saved avh-chat grant reaches a spawned ${type} seat and survives its restore`, async () => {
    const { deps, file } = teamDeps();
    const lead = { execCommands: ['avh-chat'], extraArgs: [] };
    teamTemplateSave(deps, 'core', 'pm', { type, cwd: os.tmpdir(), execCommands: ['avh-chat', 'avh-warden'] }, LEAD_SAVER(lead));
    const h = harness({ rec: lead });
    await spawn(h, h.writeTpl(JSON.parse(fs.readFileSync(file, "utf8"))), undefined, type);
    assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
    assert.deepStrictEqual([h.calls[0][1], h.calls[0][EXEC]], [type, ['avh-chat']]);
    const created = [];
    const manager = {
      sessions: new Map(),
      async create(...args) { created.push(args); manager.sessions.set(args[0], { backend: type }); },
      resumeCwdOf: (e) => e.cwd,
      pendingCountFor: () => 0,
      teamNameFor: () => 'core',
    };
    const entry = { name: 'child', type, cwd: os.tmpdir(), sessionId: 'sid-1', execCommands: h.calls[0][EXEC] };
    await restoreSessionsForWorkspace({
      workspaceId: 'default', manager,
      persistence: { listForWorkspace: () => [entry], upsert() {}, remove() {} },
      proxyPoller: { snapshot: () => null },
      maybeCompactBeforeResume: async () => {},
      readCtxFor: () => ({}),
      log: { error() {}, warn() {} },
    });
    assert.strictEqual(created.length, 1);
    assert.deepStrictEqual(created[0][EXEC], ['avh-chat']);
  });
}

const CORE_TEAM = (lead) => ({ name: 'core', lead, root: os.tmpdir(), dir: os.tmpdir(), roles: {}, roster: [] });
const MAY_GRANT_CHAT = { execCommands: [], extraArgs: [], grantable: { execCommands: ['avh-chat'], intents: [], flags: [] } };

test('a lead with avh-chat only in grantable saves it onto a template and strips avh-warden', () => {
  const { deps, file } = teamDeps();
  const rec = JSON.parse(JSON.stringify(MAY_GRANT_CHAT));
  const res = teamTemplateSave(deps, 'core', 'pm', { type: 'clodent', execCommands: ['avh-chat', 'avh-warden'] }, LEAD_SAVER(rec));
  assert.deepStrictEqual(res, { ok: true, file, stripped: ['avh-warden'] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'clodent', execCommands: ['avh-chat'] });
});

test('a lead may-grant flag lets the lead write --dangerously-skip-permissions into a template', () => {
  const { deps, file } = teamDeps();
  const body = { type: 'claude', extraArgs: ['--dangerously-skip-permissions'] };
  const rec = { extraArgs: [], grantable: { execCommands: [], intents: [], flags: ['--dangerously-skip-permissions'] } };
  assert.deepStrictEqual(teamTemplateSave(deps, 'core', 'pm', body, LEAD_SAVER(rec)), { ok: true, file });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), body);
});

test('the lead role template keeps only what the lead holds, never its grant-only items', () => {
  const { deps, file } = teamDeps();
  const res = teamTemplateSave(deps, 'core', 'pm', { type: 'claude', execCommands: ['avh-chat'] },
    { saver: { name: 'lead', lead: 'lead', record: MAY_GRANT_CHAT, holdOnly: true } });
  assert.deepStrictEqual(res, { ok: true, file, stripped: ['avh-chat'] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'claude' });
});

test('template-save drops a grantable key from any non-operator body', () => {
  const { deps, file } = teamDeps();
  const res = teamTemplateSave(deps, 'core', 'pm', { type: 'claude', grantable: { execCommands: ['avh-chat'] } }, LEAD_SAVER(MAY_GRANT_CHAT));
  assert.deepStrictEqual(res, { ok: true, file, stripped: ['grantable'] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'claude' });
});

for (const type of ['clodent', 'claude']) {
  test(`[agent:spawn] from a lead with avh-chat grant-only gives a ${type} child avh-chat, no grantable, and restore keeps it`, async () => {
    const h = harness({ rec: MAY_GRANT_CHAT, team: CORE_TEAM('spawner') });
    await spawn(h, h.writeTpl({ type, execCommands: ['avh-chat', 'avh-warden'], grantable: { execCommands: ['avh-warden'] } }), undefined, type);
    assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
    assert.deepStrictEqual([h.calls[0][1], h.calls[0][EXEC]], [type, ['avh-chat']]);
    assert.ok(!JSON.stringify(h.calls[0]).includes('grantable'), JSON.stringify(h.calls[0]));
    const created = [];
    const manager = {
      sessions: new Map(),
      async create(...args) { created.push(args); manager.sessions.set(args[0], { backend: type }); },
      resumeCwdOf: (e) => e.cwd,
      pendingCountFor: () => 0,
      teamNameFor: () => 'core',
    };
    await restoreSessionsForWorkspace({
      workspaceId: 'default', manager,
      persistence: { listForWorkspace: () => [{ name: 'child', type, cwd: os.tmpdir(), sessionId: 'sid-1', execCommands: ['avh-chat'] }], upsert() {}, remove() {} },
      proxyPoller: { snapshot: () => null },
      maybeCompactBeforeResume: async () => {},
      readCtxFor: () => ({}),
      log: { error() {}, warn() {} },
    });
    assert.deepStrictEqual(created.map((a) => a[EXEC]), [['avh-chat']]);
  });
}

test('a non-lead spawner with the same grantable passes nothing it does not hold', async () => {
  const h = harness({ rec: MAY_GRANT_CHAT, team: CORE_TEAM('someone-else') });
  await spawn(h, h.writeTpl({ execCommands: ['avh-chat'] }));
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual(h.calls[0][EXEC], []);
});

test('a lead holding avh-chat passes it to a child without any grantable', async () => {
  const h = harness({ rec: { execCommands: ['avh-chat'] }, team: CORE_TEAM('spawner') });
  await spawn(h, h.writeTpl({ execCommands: ['avh-chat', 'avh-warden'] }));
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual(h.calls[0][EXEC], ['avh-chat']);
});

test('a lead may-grant flag is not inherited by a child whose template is silent', async () => {
  const h = harness({ rec: { extraArgs: [], grantable: { flags: ['--dangerously-skip-permissions'] } }, team: CORE_TEAM('spawner') });
  await spawn(h, h.writeTpl({}));
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual(h.calls[0][EXTRA_ARGS], []);
});

test('a spawn cannot rebuild the lead\'s existing record from a template naming its grant-only items', async () => {
  const lead = { execCommands: ['clodex-team'], extraArgs: [], grantable: { execCommands: ['avh-chat'], flags: ['--dangerously-skip-permissions'] } };
  const h = harness({ rec: { execCommands: ['clodex-team', 'avh-chat'], extraArgs: [] }, team: CORE_TEAM('child'), others: { child: lead } });
  await spawn(h, h.writeTpl({ execCommands: ['clodex-team', 'avh-chat'] }));
  assert.deepStrictEqual([h.calls, h.replies], [[], ['[agent:spawn] error: name taken "child"']]);
});

test('restoring a lead replays only its held execCommands, never its grantable', async () => {
  const created = [];
  const manager = {
    sessions: new Map(),
    async create(...args) { created.push(args); manager.sessions.set(args[0], { backend: 'claude' }); },
    resumeCwdOf: (e) => e.cwd,
    pendingCountFor: () => 0,
    teamNameFor: () => 'core',
  };
  const entry = { name: 'lead', type: 'claude', cwd: os.tmpdir(), sessionId: 'sid-1', execCommands: ['clodex-team'], grantable: { execCommands: ['avh-chat'], intents: [], flags: [] } };
  await restoreSessionsForWorkspace({
    workspaceId: 'default', manager,
    persistence: { listForWorkspace: () => [entry], upsert() {}, remove() {} },
    proxyPoller: { snapshot: () => null },
    maybeCompactBeforeResume: async () => {},
    readCtxFor: () => ({}),
    log: { error() {}, warn() {} },
  });
  assert.strictEqual(created.length, 1);
  assert.deepStrictEqual(created[0][EXEC], ['clodex-team']);
  assert.ok(!JSON.stringify(created[0]).includes('avh-chat'), JSON.stringify(created[0]));
});

test('a bypass lead spawning by name grants its own team\'s exec command, and a non-bypass lead does not', async () => {
  for (const [extraArgs, want] of [[['--dangerously-skip-permissions'], ['avh-chat']], [[], []]]) {
    const tmp = fs.realpathSync(mkTmpRoot('clx-clamp-team-exec-'));
    const team = { name: 't', root: tmp, lead: 'spawner', dir: path.join(tmp, 'teams', 't'), roles: {} };
    fs.mkdirSync(path.join(team.dir, 'exec'), { recursive: true });
    fs.writeFileSync(path.join(team.dir, 'exec', 'avh-chat.json'), JSON.stringify({ description: 'chat', argv: ['true'] }));
    const h = harness({ rec: { type: 'claude', extraArgs, execCommands: [] }, team });
    await spawn(h, h.writeTpl({ execCommands: ['avh-chat', 'lib-cmd'] }));
    assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
    assert.deepStrictEqual(h.calls[0][EXEC], want);
  }
});
