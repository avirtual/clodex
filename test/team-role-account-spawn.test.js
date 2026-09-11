'use strict';
// Run: node --test test/team-role-account-spawn.test.js
//
// t830, the spawn half — every seat the LOOP mints for a role with an `account:`
// boots on that account's config dir.
//
// These seats are the whole reason the field exists: a ticket hand and a cold
// reviewer live minutes, so Edit Session can never reach them, and the template
// route is closed by construction — `filterTemplateEnv`'s allowlist drops
// CLAUDE_CONFIG_DIR, deliberately, because a template is shared across teams and
// agent-writable. The account is therefore applied AFTER that filter, from the
// role, which is what the two mechanisms test below pins apart: the same key is
// dropped when a template asks for it and applied when a role does.
//
// create()'s argv is the subject, not the persistence record: CLAUDE_CONFIG_DIR
// is what the CLI process is launched with, and a record asserted alone would be
// green over a seat that booted on the wrong subscription.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');

const { createSessionManager } = require('../session-manager');
const ticketsMod = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SESSION_ENV_ARG = 18;

const WORK_DIR = '/home/u/.clodex/accounts/work';
const ACCOUNTS = [
  { label: 'default', configDir: '/home/u/.claude' },
  { label: 'work', configDir: WORK_DIR },
];

// Carries an env of its OWN, every key allowlisted, so the assertions below can
// tell "the account key was added" from "the account key replaced the env".
const HAND_TEMPLATE = {
  name: 'clodex-team-hand',
  type: 'claude',
  systemPromptFile: 'clodex-team-hand',
  env: { CLODEX_DISABLE_IPC_PROMPT: '1', FORCE_PROMPT_CACHING_5M: '1' },
};

const SHIPPED_REVIEWER_TEMPLATE = {
  name: 'clodex-team-reviewer',
  systemPromptFile: 'clodex-team-reviewer',
  intents: [],
  tools: ['Read', 'Grep', 'Glob'],
  env: {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    FORCE_PROMPT_CACHING_5M: '1',
    CLODEX_DISABLE_IPC_PROMPT: '1',
    CLODEX_SPAWNER_HINT: 'off',
    CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '60000',
  },
};

function mkFixture({ handRole = {}, reviewerRole = {}, accounts = ACCOUNTS, templates, realManifest = false, accountsThrow = false } = {}) {
  const home = mkTmpRoot('clodex-t830-');
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const teamsDir = pathReal.join(home, 'teams');
  const roleDefs = {
    lead: { brief: 'the lead', dispatch: 'standing' },
    // `spawn`, not `worktree`: this dispatch reaches the same
    // _spawnTicketSeat → resolveSeatShape → create() path without touching
    // git, so the fixture root need not be a real repo. The account is
    // resolved above the branch that differs between the two modes.
    hand: { brief: 'the hand', dispatch: 'spawn', template: 'clodex-team-hand', ...handRole },
    reviewer: { prompt: 'clodex-team-reviewer', brief: 'the reviewer', ...reviewerRole },
  };
  const teamFile = pathReal.join(teamsDir, 'team', 'team.json');
  const team = { name: 'team', root: '/proj', lead: 'lead', watchdogMs: null, file: teamFile, roles: roleDefs };
  // The mutator half is only wired when a test drives it, because the REAL
  // team-manifest is the subject there: a stubbed setRole would let the reserved
  // carve-out look reachable while the manifest quietly refused it.
  let tm = null;
  if (realManifest) {
    fsReal.mkdirSync(pathReal.dirname(teamFile), { recursive: true });
    fsReal.writeFileSync(teamFile, JSON.stringify({ root: '/proj', lead: 'lead', roles: roleDefs }, null, 2));
    tm = require('../team-manifest').createTeamManifest({ fs: fsReal, clodexHome: home });
  }
  // Re-read per call, so a spawn that follows a role-set in the same test sees
  // what the mutator WROTE rather than the def the fixture was built from.
  const liveTeam = () => (tm ? { ...team, roles: tm.loadManifest('team').roles } : team);
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
  const tplList = templates || [HAND_TEMPLATE, SHIPPED_REVIEWER_TEMPLATE];
  const deps = {
    knownSkillNames: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => tplList }),
    getAccounts: () => (accountsThrow
      ? { list: () => { throw new Error('EACCES'); }, configDirFor: () => { throw new Error('EACCES'); } }
      : {
        list: () => accounts,
        configDirFor: (label) => (accounts.find((a) => a.label === label) || {}).configDir || null,
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
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? liveTeam() : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj' : null),
    teamsDir,
    refreshAppMenu: () => {},
    setRole: tm ? tm.setRole : undefined,
    addRole: tm ? tm.addRole : undefined,
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
  return { m, team, home, tstore, persistence, injected, created, gated, seat, liveTeam };
}

const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

async function dispatchTicket(f) {
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build it' });
  // Dispatch refuses a ticket whose spec names no `tasks/…` path, and this body
  // carries none — stamped on the record so the spec text stays irrelevant here.
  const all = f.tstore.load(f.team.root);
  for (const x of all) if (!x.taskDir) x.taskDir = `tasks/${x.id}-fixture/SPEC.md`;
  f.tstore.save(f.team.root, all);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await settle();
  await settle();
}

// ── (d) the ticket seat ────────────────────────────────────────────────────

test('t830: a ticket seat for a role with an account boots on that config dir, keeping the template env', async () => {
  const f = mkFixture({ handRole: { account: 'work' } });
  await dispatchTicket(f);

  assert.strictEqual(f.created.length, 1, 'ENTER: the ticket seat must have reached create()');
  const env = f.created[0][SESSION_ENV_ARG];
  assert.deepStrictEqual(env, {
    CLODEX_DISABLE_IPC_PROMPT: '1',
    FORCE_PROMPT_CACHING_5M: '1',
    CLAUDE_CONFIG_DIR: WORK_DIR,
    CLODEX_TICKET: 't1',
  }, 'the account dir is ADDED to the template env, never a replacement for it — a seat that '
    + 'lost CLODEX_DISABLE_IPC_PROMPT while gaining the account is on the right subscription '
    + 'with the wrong prompt');
});

test('t830: a ticket seat for a role with NO account carries no CLAUDE_CONFIG_DIR at all', async () => {
  const f = mkFixture();
  await dispatchTicket(f);

  assert.strictEqual(f.created.length, 1, 'ENTER: the ticket seat must have reached create()');
  const env = f.created[0][SESSION_ENV_ARG];
  assert.ok(env && !('CLAUDE_CONFIG_DIR' in env),
    `an unpinned role must inherit the box's own account, got ${JSON.stringify(env)}`);
});

// ── (e) the cold reviewer, and the two mechanisms pinned apart ─────────────

test('t830: a cold reviewer for a team whose reviewer role has an account boots on that config dir', async () => {
  const f = mkFixture({ reviewerRole: { account: 'work' } });
  f.seat('lead');
  f.m._handleTeamReview(f.m.sessions.get('lead'), 'review the diff');
  await settle();

  assert.strictEqual(f.created.length, 1, 'ENTER: the reviewer seat must have spawned');
  const env = f.created[0][SESSION_ENV_ARG];
  assert.strictEqual(env.CLAUDE_CONFIG_DIR, WORK_DIR);
  assert.strictEqual(env.CLODEX_DISABLE_IPC_PROMPT, '1',
    'and the reviewer template\'s own allowed keys are untouched');
});

// The load-bearing pin of the whole ticket: the SAME key, asked for by a template
// and by a role, must resolve opposite ways. Adding CLAUDE_CONFIG_DIR to
// REVIEWER_ENV_ALLOWLIST would make this test pass for the wrong reason and hand
// every agent-writable template the power to redirect a seat's credentials — so
// the template arm is asserted here, beside the role arm, rather than trusting
// the allowlist's own tests to stay in force.
test('t830: a TEMPLATE\'s CLAUDE_CONFIG_DIR is still dropped while the ROLE\'s is applied', async () => {
  const f = mkFixture({
    reviewerRole: { account: 'work' },
    templates: [HAND_TEMPLATE, {
      ...SHIPPED_REVIEWER_TEMPLATE,
      env: { ...SHIPPED_REVIEWER_TEMPLATE.env, CLAUDE_CONFIG_DIR: '/home/u/.clodex/accounts/side' },
    }],
  });
  f.seat('lead');
  f.m._handleTeamReview(f.m.sessions.get('lead'), 'review the diff');
  await settle();

  assert.strictEqual(f.created.length, 1, 'ENTER: the reviewer seat must have spawned');
  assert.strictEqual(f.created[0][SESSION_ENV_ARG].CLAUDE_CONFIG_DIR, WORK_DIR,
    'the ROLE wins, because the template\'s key never survived the allowlist to compete');
  assert.ok(f.injected.some((t) => /CLAUDE_CONFIG_DIR/.test(t) && /outside the allowed set/.test(t)),
    `and the template's attempt is still reported to the lead as an authority drop, got: ${JSON.stringify(f.injected)}`);
});

// ── (f) the label whose account was deleted ────────────────────────────────

test('t830: a reviewer role naming a deleted account refuses the spawn', async () => {
  const f = mkFixture({ reviewerRole: { account: 'gone' } });
  f.seat('lead');
  f.m._handleTeamReview(f.m.sessions.get('lead'), 'review the diff');
  await settle();

  assert.strictEqual(f.created.length, 0,
    'no seat at all — booting on the app\'s own account is the subscription this role was moved OFF');
  assert.ok(f.injected.some((t) => /role reviewer names account "gone", which is not in the accounts registry/.test(t)),
    `and the lead is told which label is dangling, got: ${JSON.stringify(f.injected)}`);
});

// An unreadable registry is not a deleted label, and the two want different
// responses from whoever reads the escalation: one is "fix the role", the other
// is "fix the box". Collapsing them reports a deletion that did not happen.
test('t830: a registry that cannot be READ refuses with its own reason, not a deletion', async () => {
  const f = mkFixture({ reviewerRole: { account: 'work' }, accountsThrow: true });
  f.seat('lead');
  f.m._handleTeamReview(f.m.sessions.get('lead'), 'review the diff');
  await settle();

  assert.strictEqual(f.created.length, 0, 'no seat spawned — the label may well be fine');
  assert.ok(f.injected.some((t) => /role reviewer names account "work", but the accounts registry could not be read/.test(t)),
    `the reason is the registry, not the label, got: ${JSON.stringify(f.injected)}`);
});

test('t830: a hand role naming a deleted account fails the ticket spawn and says why', async () => {
  const f = mkFixture({ handRole: { account: 'gone' } });
  await dispatchTicket(f);

  assert.strictEqual(f.created.length, 0, 'no ticket seat spawned');
  assert.ok(f.injected.some((t) => /failed to spawn/.test(t)
    && /role hand names account "gone", which is not in the accounts registry/.test(t)),
  `the spawn-failure reply carries the dangling label, got: ${JSON.stringify(f.injected)}`);
});

// ── MUST-FIX 1 (r1): the reviewer's account has to be REACHABLE ────────────
//
// The headline case of the whole ticket is moving cold reviewers to a second
// subscription, and `reviewer` is a RESERVED role: setRole refuses every patch
// on one. Without the carve-out, the only way to set reviewer.account is
// hand-editing team.json — while ipc-prompt and both lead prompts tell the lead
// to use `role-set`. So this drives the REAL manifest through the REAL intent
// handler and then spawns, rather than injecting the def into a fixture.

test('t830: role-set reviewer account:<label> is accepted, and the next cold reviewer boots on it', async () => {
  const f = mkFixture({ realManifest: true });
  f.seat('lead');
  f.m._handleTeam(f.m.sessions.get('lead'), { type: 'team', sub: 'role-set', name: 'reviewer', account: 'work', body: '' });
  assert.ok(f.injected.some((t) => /role "reviewer" updated/.test(t)),
    `the reserved refusal must not fire for an account-only patch, got: ${JSON.stringify(f.injected)}`);
  assert.strictEqual(f.liveTeam().roles.reviewer.account, 'work', 'and it reached disk');

  f.m._handleTeamReview(f.m.sessions.get('lead'), 'review the diff');
  await settle();
  assert.strictEqual(f.created.length, 1, 'ENTER: the reviewer seat must have spawned');
  assert.strictEqual(f.created[0][SESSION_ENV_ARG].CLAUDE_CONFIG_DIR, WORK_DIR,
    'the label a lead can now set is the one the seat actually boots on — the two halves must '
    + 'meet, or the grammar advertises a field the spawn never reads');
});

// The carve-out is one field wide, not a hole in the lock: everything that made
// `reviewer` operator-owned still is.
test('t830: role-set reviewer with any OTHER key is still refused', async () => {
  const f = mkFixture({ realManifest: true });
  f.seat('lead');
  f.m._handleTeam(f.m.sessions.get('lead'), { type: 'team', sub: 'role-set', name: 'reviewer', cwd: 'sub', body: '' });
  assert.ok(f.injected.some((t) => /operator-owned topology/.test(t)),
    `cwd on a reserved role keeps the refusal, got: ${JSON.stringify(f.injected)}`);
  assert.ok(!f.liveTeam().roles.reviewer.cwd, 'and nothing landed');

  f.m._handleTeam(f.m.sessions.get('lead'), { type: 'team', sub: 'role-set', name: 'reviewer', account: 'work', body: 'a new brief' });
  assert.ok(f.injected.some((t) => /operator-owned topology/.test(t) && /brief/.test(t)),
    `an account rode in beside a brief and the whole patch must bounce, got: ${JSON.stringify(f.injected)}`);
  assert.ok(!f.liveTeam().roles.reviewer.account,
    'the account must NOT half-apply out of a patch that was refused');
});
