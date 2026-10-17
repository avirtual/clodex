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
const SHIPPED_REVIEWER_TEMPLATE = { name: 'clodex-team-reviewer', systemPromptFile: 'clodex-team-reviewer', intents: [], tools: ['Read'] };

function mkFixture({ trunk, rootBranch }) {
  const minted = [];
  const home = mkTmpRoot('clodex-t1858-');
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const teamsDir = pathReal.join(home, 'teams');
  const roleDefs = {
    lead: { brief: 'the lead', dispatch: 'standing' },
    hand: { brief: 'the hand', dispatch: 'worktree', template: 'clodex-team-hand' },
    reviewer: { prompt: 'clodex-team-reviewer', brief: 'the reviewer' },
  };
  const teamFile = pathReal.join(teamsDir, 'team', 'team.json');
  const team = { name: 'team', root: '/proj', lead: 'lead', watchdogMs: null, file: teamFile, roles: roleDefs, trunk };
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
  const injected = [];
  const created = [];
  const gated = [];
  const tplList = [HAND_TEMPLATE, SHIPPED_REVIEWER_TEMPLATE];
  const deps = {
    knownSkillNames: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => tplList }),
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
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj' : null),
    teamsDir,
    refreshAppMenu: () => {},
    gitWorktree: {
      currentBranch: async () => (rootBranch
        ? { ok: true, branch: rootBranch, head: 'abc123', repo: '/proj' }
        : { ok: false, branch: null, head: null, error: 'the checkout is detached' }),
      createWorktree: async (repo, branch) => { minted.push(branch); return { ok: true, path: `/proj-wt/${branch}`, branch, baseSha: 'abc123' }; },
    },
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  m._injectText = (s, text, opts) => {
    const out = opts && typeof opts.produce === 'function' ? opts.produce() : text;
    if (out == null || out === '') return;
    injected.push(out);
  };
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._gatedDeliver = (target, sender, body) => { gated.push({ target, sender, body }); return { queued: true }; };
  m._deliverMessage = () => {};
  m._deliverPassive = () => {};
  m._deliverParkedActive = () => {};
  m.create = async (...args) => { created.push(args); return { name: args[0] }; };
  m.kill = async (name) => { persistence.remove(name); m.sessions.delete(name); };
  const seat = (name, cwd = '/proj') => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  return { m, team, home, tstore, persistence, injected, created, gated, seat, minted };
}

const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

async function startTicket(f) {
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build it' });
  const all = f.tstore.load(f.team.root);
  for (const x of all) if (!x.taskDir) x.taskDir = `tasks/${x.id}-fixture/SPEC.md`;
  f.tstore.save(f.team.root, all);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await settle();
  await settle();
  return f.tstore.load(f.team.root).find((x) => x.id === 't1');
}

const DETACHED_REFUSAL = 'error: trunk is @head but /proj is not on a branch (detached HEAD) — check out the branch this ticket should merge into first';

test('task start under trunk @head on a detached root refuses: no tree, no seat, ticket unstarted', async () => {
  const f = mkFixture({ trunk: '@head', rootBranch: null });
  const t = await startTicket(f);
  assert.ok(f.injected.some((x) => x.includes(DETACHED_REFUSAL)), `the refusal reached the lead: ${JSON.stringify(f.injected)}`);
  assert.deepStrictEqual(f.minted, [], 'no worktree was minted');
  assert.strictEqual(f.created.length, 0, 'no seat was spawned');
  assert.strictEqual(t.startedAt, null, 'the ticket is left unstarted');
  assert.strictEqual(t.worktree, undefined);
});

test('task start under trunk master on a detached root starts as before, recording no base branch', async () => {
  const f = mkFixture({ trunk: 'master', rootBranch: null });
  const t = await startTicket(f);
  assert.ok(!f.injected.some((x) => x.includes('detached HEAD')));
  assert.strictEqual(f.created.length, 1, 'the seat was spawned');
  assert.deepStrictEqual(t.worktree, { path: `/proj-wt/${f.minted[0]}`, branch: f.minted[0], baseSha: 'abc123' });
});

test('task start records the root\'s branch as the ticket\'s base branch, under a named trunk too', async () => {
  for (const trunk of ['@head', 'master']) {
    const f = mkFixture({ trunk, rootBranch: 'feat-1' });
    const t = await startTicket(f);
    assert.strictEqual(f.created.length, 1, `${trunk}: the seat was spawned`);
    assert.deepStrictEqual(t.worktree, { path: `/proj-wt/${f.minted[0]}`, branch: f.minted[0], baseSha: 'abc123', baseBranch: 'feat-1' });
  }
});
