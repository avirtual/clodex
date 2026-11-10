'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { mkTmpRoot } = require('./lib/tmp-roots');

const EXTRA_ARGS = 3;
const SESSION_ENV = 18;

function harness({ rec = null, accounts = null, templates = [], team = null } = {}) {
  const calls = [];
  const replies = [];
  const upserts = [];
  const home = fs.realpathSync(mkTmpRoot('clx-posture-home-'));
  const SessionManager = createSessionManager({
    knownSkillNames: () => [], os, fs, path,
    resolveTeam: () => team,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({
      get: (n) => (n === 'lead' ? rec : null),
      upsert: (e) => upserts.push(e),
      setStripLevel() {}, setAutoCompact() {},
    }),
    getAccounts: accounts ? () => accounts : undefined,
    getTemplates: () => ({ list: () => templates }),
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
  const writeTpl = (tpl) => {
    const dir = path.join(home, 'library', 'templates');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'tpl.json');
    fs.writeFileSync(file, JSON.stringify({ type: 'clodent', cwd: os.tmpdir(), ...tpl }));
    return file;
  };
  return { m, calls, replies, upserts, writeTpl };
}

async function spawn(h, template, leadType = 'clodent', opts = undefined) {
  h.m._handleSpawnIntent(
    { name: 'lead', cwd: os.tmpdir(), workspaceId: 'default', type: leadType },
    { name: 'child', template },
    opts,
  );
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

test('(a) a bypass lead spawning a template that pins only --model gives the child the bypass', async () => {
  const h = harness({ rec: { extraArgs: ['--dangerously-skip-permissions'] } });
  await spawn(h, h.writeTpl({ extraArgs: ['--model', 'claude-opus-5-5'] }));
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual(h.calls[0][EXTRA_ARGS], ['--model', 'claude-opus-5-5', '--dangerously-skip-permissions']);
});

test('(a) a --yolo clodent lead spawning a claude template that pins only --model gives the claude bypass', async () => {
  const h = harness({ rec: { extraArgs: ['--yolo'] } });
  await spawn(h, h.writeTpl({ type: 'claude', extraArgs: ['--model', 'opus'] }));
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual(h.calls[0][EXTRA_ARGS], ['--model', 'opus', '--dangerously-skip-permissions']);
});

test('(a) a template that sets its own posture flag is not given the lead\'s bypass on top', async () => {
  const h = harness({ rec: { extraArgs: ['--dangerously-skip-permissions', '--permission-mode', 'plan'] } });
  await spawn(h, h.writeTpl({ extraArgs: ['--model', 'x', '--permission-mode', 'plan'] }));
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.deepStrictEqual(h.calls[0][EXTRA_ARGS], ['--model', 'x', '--permission-mode', 'plan']);
});

test('(b) a lead without the bypass gets none: a --model template stays bare, a bypass template is refused', async () => {
  const bare = harness({ rec: { extraArgs: ['--model', 'x'] } });
  await spawn(bare, bare.writeTpl({ extraArgs: ['--model', 'claude-opus-5-5'] }));
  assert.strictEqual(bare.calls.length, 1, `ENTER: create was called (${JSON.stringify(bare.replies)})`);
  assert.deepStrictEqual(bare.calls[0][EXTRA_ARGS], ['--model', 'claude-opus-5-5']);
  for (const flag of ['--dangerously-skip-permissions', '--yolo']) {
    const asks = harness({ rec: { extraArgs: ['--model', 'x'] } });
    const file = asks.writeTpl({ extraArgs: ['--model', 'x', flag] });
    await spawn(asks, file);
    assert.deepStrictEqual(asks.calls, [], flag);
    assert.deepStrictEqual(asks.replies, [`[agent:spawn] error: template "${file}" carries ${flag}, which lead does not — a spawned seat cannot hold more than its spawner`]);
  }
});

for (const [held, asked] of [['--yolo', '--dangerously-skip-permissions'], ['--dangerously-skip-permissions', '--yolo']]) {
  test(`(c) a lead holding ${held} lets a template keep ${asked}`, async () => {
    const h = harness({ rec: { extraArgs: [held] } });
    await spawn(h, h.writeTpl({ extraArgs: ['--model', 'x', asked] }));
    assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
    assert.deepStrictEqual(h.calls[0][EXTRA_ARGS], ['--model', 'x', asked]);
  });
}

for (const [label, lead, opts, want] of [
  ['a team lead\'s spawn records it as spawnedBy', 'lead', undefined, 'lead'],
  ['a non-lead\'s spawn records no spawner', 'other-lead', undefined, null],
  ['an operator-door spawn records no spawner', 'lead', { operator: true }, null],
]) {
  test(`(d) ${label}`, async () => {
    const h = harness({ rec: {}, team: { name: 'crew', lead, root: os.tmpdir(), roles: {} } });
    await spawn(h, h.writeTpl({}), 'clodent', opts && { ...opts, onReply: (r) => h.replies.push(r) });
    assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
    assert.deepStrictEqual(h.upserts, [{ name: 'child', spawnedBy: want }]);
  });
}

const ACCOUNTS = {
  labelFor: (dir) => ({ '/acct/work': 'work' }[dir] || path.basename(dir)),
  configDirFor: (label) => ({ work: '/acct/work' }[label] || null),
};

for (const [label, env, leadEnv, want, note] of [
  ['a registered account dir', { CLODENT_HOME: '/acct/work' }, null, { CLODENT_HOME: '/acct/work' }, false],
  ['the lead\'s own value', { CLODENT_HOME: '/home/u/.clodent-lead' }, { CLODENT_HOME: '/home/u/.clodent-lead' }, { CLODENT_HOME: '/home/u/.clodent-lead' }, false],
  ['an arbitrary dir', { CLODENT_HOME: '/tmp/evil', FORCE_PROMPT_CACHING_5M: '1' }, { CLODENT_HOME: '/home/u/.clodent-lead' }, { FORCE_PROMPT_CACHING_5M: '1' }, true],
  ['an unregistered dir named like an account', { CLODENT_HOME: '/elsewhere/work' }, null, null, true],
  ['a relative path', { CLODENT_HOME: 'acct/work' }, null, null, true],
]) {
  test(`(e) template env CLODENT_HOME set to ${label}`, async () => {
    const h = harness({ rec: leadEnv ? { env: leadEnv } : {}, accounts: ACCOUNTS });
    await spawn(h, h.writeTpl({ env }));
    assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
    assert.deepStrictEqual(h.calls[0][SESSION_ENV], want);
    assert.strictEqual(h.replies[0].endsWith(" — env CLODENT_HOME is neither lead's own value nor a registered account dir, dropped"), note, h.replies[0]);
  });
}

test('(e) direct call, defence in depth only (filterTemplateEnv already drops CLAUDE_CONFIG_DIR): the clamp keeps it only at a registered account dir', () => {
  const h = harness({ accounts: ACCOUNTS });
  assert.deepStrictEqual(h.m._clampSeatHomeEnv({ CLAUDE_CONFIG_DIR: '/tmp/evil' }, {}), { env: null, clamped: ['CLAUDE_CONFIG_DIR'] });
  assert.deepStrictEqual(h.m._clampSeatHomeEnv({ CLAUDE_CONFIG_DIR: '/acct/work' }, {}), { env: { CLAUDE_CONFIG_DIR: '/acct/work' }, clamped: [] });
});

test('(e) with no account store only the lead\'s own value survives', async () => {
  const h = harness({ rec: {} });
  await spawn(h, h.writeTpl({ env: { CLODENT_HOME: '/acct/work' } }));
  assert.strictEqual(h.calls.length, 1, `ENTER: create was called (${JSON.stringify(h.replies)})`);
  assert.strictEqual(h.calls[0][SESSION_ENV], null);
});

test('(a) a ticket seat whose role template pins only --model inherits the lead\'s bypass', () => {
  const h = harness({ rec: { extraArgs: ['--dangerously-skip-permissions'] }, templates: [{ name: 'hand-tpl', type: 'clodent', cwd: '/repo', extraArgs: ['--model', 'x'] }] });
  const team = { name: 'crew', lead: 'lead', root: '/repo', roles: { hand: { template: 'hand-tpl' } } };
  const shape = h.m.resolveSeatShape(team, 'hand', 'ticket', { name: 'lead', cwd: '/repo', workspaceId: 'default', type: 'clodent' });
  assert.deepStrictEqual(shape.extraArgs, ['--model', 'x', '--dangerously-skip-permissions']);
});
