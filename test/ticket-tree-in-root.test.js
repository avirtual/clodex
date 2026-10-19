'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');

const { createSessionManager } = require('../session-manager');
const ticketsMod = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ACCOUNTS = [{ label: 'default', configDir: '/home/u/.claude' }];
const HAND_TEMPLATE = { name: 'clodex-team-hand', type: 'claude', systemPromptFile: 'clodex-team-hand' };

function mkFixture({ worktrees, env }) {
  const minted = [];
  const home = mkTmpRoot('clodex-t1892-');
  const root = mkTmpRoot('clodex-t1892-root-');
  fsReal.mkdirSync(pathReal.join(root, '.git', 'info'), { recursive: true });
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const teamsDir = pathReal.join(home, 'teams');
  const roleDefs = {
    lead: { brief: 'the lead', dispatch: 'standing' },
    hand: { brief: 'the hand', dispatch: 'worktree', template: 'clodex-team-hand' },
  };
  const team = {
    name: 'team', root, lead: 'lead', watchdogMs: null, file: pathReal.join(teamsDir, 'team', 'team.json'),
    roles: roleDefs, trunk: 'master', ...(worktrees ? { worktrees } : {}),
  };
  const store = [];
  const persistence = {
    list: () => store,
    get: (n) => store.find((e) => e.name === n) || (n === 'lead' ? { name: 'lead', extraArgs: [] } : null),
    upsert: (e) => {
      const i = store.findIndex((x) => x.name === e.name);
      if (i >= 0) store[i] = { ...store[i], ...e }; else store.push({ ...e });
    },
    remove: (n) => { const i = store.findIndex((x) => x.name === n); if (i >= 0) store.splice(i, 1); },
    setWorktree: () => {},
    setStripLevel: () => {},
    setAutoCompact: () => {},
  };
  const deps = {
    knownSkillNames: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => [HAND_TEMPLATE] }),
    getAccounts: () => ({
      list: () => ACCOUNTS,
      configDirFor: (label) => (ACCOUNTS.find((a) => a.label === label) || {}).configDir || null,
    }),
    notifyOS: () => {},
    intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    fencedLines: require('../intent-scanner').fencedLines,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    intentEnabledForSeat: require('../intent-registry').intentEnabledForSeat,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fs: fsReal,
    path: pathReal,
    os: osReal,
    ensureDir: () => {},
    countPending: require('../pending-store').countPending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    termAvailableFor: require('../drawer-avail').termAvailableFor,
    REGISTRY_DIR: home,
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    resolveTeam: (cwd) => (cwd && cwd.startsWith(root) ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith(root) ? root : null),
    teamsDir,
    refreshAppMenu: () => {},
    env,
    setTeamWorktrees: (name, v) => { team.worktrees = v; return team; },
    gitWorktree: {
      currentBranch: async () => ({ ok: true, branch: 'master', head: 'abc123', repo: root }),
      createWorktree: async (repo, branch, opts) => {
        minted.push({ branch, targetPath: opts && opts.targetPath });
        return { ok: true, path: (opts && opts.targetPath) || `${repo}-${branch}`, branch, baseSha: 'abc123' };
      },
    },
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  const injected = [];
  m._injectText = (s, text) => { injected.push(text); };
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._gatedDeliver = () => ({ queued: true });
  m._deliverMessage = () => {};
  m._deliverPassive = () => {};
  m._deliverParkedActive = () => {};
  m.create = async (...args) => ({ name: args[0] });
  const seat = (name) => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd: root, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  return { m, team, root, tstore, seat, minted, injected };
}

const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

async function startTicket(f, id) {
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: `build ${id}` });
  const all = f.tstore.load(f.root);
  for (const x of all) if (!x.taskDir) x.taskDir = `tasks/${x.id}-fixture/SPEC.md`;
  f.tstore.save(f.root, all);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id, body: '' });
  await settle();
  await settle();
}

const excludeLines = (f) => fsReal.readFileSync(pathReal.join(f.root, '.git', 'info', 'exclude'), 'utf8')
  .split('\n').filter((l) => l === '.clodex-wt/');

test('worktrees: in-root mints each local ticket tree under <root>/.clodex-wt/<branch> and excludes the dir once', async () => {
  const f = mkFixture({ worktrees: 'in-root', env: {} });
  await startTicket(f, 't1');
  await startTicket(f, 't2');
  assert.strictEqual(f.minted.length, 2, 'ENTER: both tickets minted a tree');
  for (const { branch, targetPath } of f.minted) {
    assert.strictEqual(targetPath, pathReal.join(f.root, '.clodex-wt', branch));
  }
  assert.deepStrictEqual(excludeLines(f), ['.clodex-wt/']);
  const t1 = f.tstore.load(f.root).find((x) => x.id === 't1');
  assert.strictEqual(t1.worktree.path, pathReal.join(f.root, '.clodex-wt', f.minted[0].branch));
});

test('CLODEX_IN_SANDBOX=1 with no worktrees key mints in-root too', async () => {
  const f = mkFixture({ worktrees: null, env: { CLODEX_IN_SANDBOX: '1' } });
  await startTicket(f, 't1');
  assert.strictEqual(f.minted.length, 1, 'ENTER: the ticket minted a tree');
  assert.strictEqual(f.minted[0].targetPath, pathReal.join(f.root, '.clodex-wt', f.minted[0].branch));
  assert.deepStrictEqual(excludeLines(f), ['.clodex-wt/']);
});

test('outside a box with no worktrees key the mint passes no targetPath: the sibling default', async () => {
  const f = mkFixture({ worktrees: null, env: {} });
  await startTicket(f, 't1');
  assert.strictEqual(f.minted.length, 1, 'ENTER: the ticket minted a tree');
  assert.strictEqual(f.minted[0].targetPath, undefined);
  assert.strictEqual(fsReal.existsSync(pathReal.join(f.root, '.git', 'info', 'exclude')), false);
});

test('worktrees: sibling wins over the box flag', async () => {
  const f = mkFixture({ worktrees: 'sibling', env: { CLODEX_IN_SANDBOX: '1' } });
  await startTicket(f, 't1');
  assert.strictEqual(f.minted.length, 1, 'ENTER: the ticket minted a tree');
  assert.strictEqual(f.minted[0].targetPath, undefined);
});

const teamVerb = (f, who, line) => {
  const intent = require('../intent-registry').parseWithRegistry(line);
  f.injected.length = 0;
  f.m._handleTeam(f.seat(who), intent);
  return f.injected.slice();
};

test('[agent:team worktrees in-root] from the lead sets it; bare shows it as set', () => {
  const f = mkFixture({ worktrees: null, env: {} });
  assert.deepStrictEqual(teamVerb(f, 'lead', '[agent:team worktrees in-root]'),
    [`[agent:team] worktrees of team set to in-root — new ticket trees are minted under ${pathReal.join(f.root, '.clodex-wt')}; existing trees stay where they are`]);
  assert.strictEqual(f.team.worktrees, 'in-root');
  assert.deepStrictEqual(teamVerb(f, 'lead', '[agent:team worktrees]'),
    [`[agent:team] worktrees of team: in-root (${pathReal.join(f.root, '.clodex-wt', '<branch>')}) — set in team.json`]);
});

test('bare [agent:team worktrees] names the derived value and its source when unset', () => {
  const inBox = mkFixture({ worktrees: null, env: { CLODEX_IN_SANDBOX: '1' } });
  assert.deepStrictEqual(teamVerb(inBox, 'lead', '[agent:team worktrees]'),
    [`[agent:team] worktrees of team: in-root (${pathReal.join(inBox.root, '.clodex-wt', '<branch>')}) — not set; derived from running inside a sandbox box — [agent:team worktrees sibling|in-root] sets it`]);
  const desk = mkFixture({ worktrees: null, env: {} });
  assert.deepStrictEqual(teamVerb(desk, 'lead', '[agent:team worktrees]'),
    ['[agent:team] worktrees of team: sibling (beside the root) — not set; derived from running outside a sandbox box — [agent:team worktrees sibling|in-root] sets it']);
});

test('[agent:team worktrees] refuses a non-lead and an unknown value, writing nothing', () => {
  const f = mkFixture({ worktrees: null, env: {} });
  assert.deepStrictEqual(teamVerb(f, 'team-hand-t1', '[agent:team worktrees in-root]'),
    ['[agent:team] error: only the team lead (lead) can edit team metadata']);
  assert.deepStrictEqual(teamVerb(f, 'lead', '[agent:team worktrees elsewhere]'),
    ['[agent:team] error: worktrees must be sibling or in-root, not "elsewhere"']);
  assert.strictEqual(f.team.worktrees, undefined);
});
