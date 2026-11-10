'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionManager } = require('../session-manager');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ACCOUNTS = { work: '/acct/work', other: '/acct/other' };

function fakeStore() {
  const rows = [];
  return {
    list: () => rows,
    get: (n) => rows.find((e) => e.name === n) || null,
    upsert: (e) => {
      const i = rows.findIndex((x) => x.name === e.name);
      if (i >= 0) rows[i] = { ...rows[i], ...e }; else rows.push({ ...e });
    },
    setIdleClear: () => false,
  };
}

function mkSpawn(t, { role = {}, tplType = 'clodent', tplEnv = null, spawnerOnOtherTeam = false } = {}) {
  const dir = mkTmpRoot('t2250-spawn-');
  const otherRoot = mkTmpRoot('t2250-other-');
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(otherRoot, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, 'library', 'templates'), { recursive: true });
  const tpl = path.join(dir, 'library', 'templates', 'hand.json');
  fs.writeFileSync(tpl, JSON.stringify({ type: tplType, ...(tplEnv ? { env: tplEnv } : {}) }));
  const team = { name: 'team', root: dir, lead: 'lead', roles: { lead: {}, hand: role } };
  const other = { name: 'other', root: otherRoot, lead: 'olead', roles: { lead: {}, hand: role } };
  const store = fakeStore();
  const SessionManager = createSessionManager({
    knownSkillNames: () => [], os, fs, path,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => store,
    getAccounts: () => ({
      list: () => Object.keys(ACCOUNTS).map((label) => ({ label })),
      configDirFor: (label) => ACCOUNTS[label] || null,
      labelFor: (d) => Object.keys(ACCOUNTS).find((k) => ACCOUNTS[k] === d) || null,
    }),
    withoutPrivilegedIntentsFor: (x) => x,
    ensureDir: () => {},
    resolveTeam: (cwd) => (cwd && cwd.startsWith(otherRoot) ? other : team),
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    DEFAULT_WORKSPACE_ID: 'default',
    REGISTRY_DIR: dir,
  });
  const m = new SessionManager();
  m.sessions = new Map();
  const replies = [];
  const created = [];
  m._injectText = (_s, text) => replies.push(text);
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._bindRosterSeat = async () => ({ ok: true });
  m.create = async (...a) => {
    created.push(a[0]);
    store.upsert({ name: a[0], type: a[1], env: a[18] });
  };
  const spawner = spawnerOnOtherTeam
    ? { name: 'olead', cwd: otherRoot, workspaceId: 'default', type: 'claude' }
    : { name: 'lead', cwd: dir, workspaceId: 'default', type: 'claude' };
  const spawn = async (name) => {
    m._handleSpawnIntent(spawner, { name, template: tpl, cwd: dir });
    await new Promise((r) => setImmediate(() => setImmediate(r)));
    await new Promise((r) => setImmediate(() => setImmediate(r)));
    return store.get(name);
  };
  return { spawn, replies, created };
}

for (const [label, opts, name, want] of [
  ['clodent: the pin sets CLODENT_HOME', { role: { account: 'work' } }, 'team-hand', { CLODENT_HOME: '/acct/work' }],
  ['claude: the pin sets CLAUDE_CONFIG_DIR', { role: { account: 'work' }, tplType: 'claude' }, 'team-hand', { CLAUDE_CONFIG_DIR: '/acct/work' }],
  ['the pin beats the template value for the same key',
    { role: { account: 'work' }, tplEnv: { CLODENT_HOME: '/acct/other', CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '9000' } },
    'team-hand', { CLODENT_HOME: '/acct/work', CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '9000' }],
  ['a role with no pin leaves the template env untouched',
    { tplEnv: { CLODENT_HOME: '/acct/other', CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '9000' } },
    'team-hand', { CLODENT_HOME: '/acct/other', CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '9000' }],
  ['a spawn onto no role gets nothing',
    { role: { account: 'work' }, tplEnv: { CLODENT_HOME: '/acct/other' } },
    'stranger', { CLODENT_HOME: '/acct/other' }],
  ['a spawn onto another team\'s role gets nothing',
    { role: { account: 'work' }, tplEnv: { CLODENT_HOME: '/acct/other' }, spawnerOnOtherTeam: true },
    'team-hand', { CLODENT_HOME: '/acct/other' }],
]) {
  test(`by-name spawn, role account: ${label}`, async (t) => {
    const f = mkSpawn(t, opts);
    const rec = await f.spawn(name);
    assert.ok(rec, `ENTER: the seat was created (replies: ${JSON.stringify(f.replies)})`);
    assert.deepStrictEqual(rec.env, want);
  });
}

for (const [label, opts, want] of [
  ['a missing account label', { role: { account: 'ghost' } }, '[agent:spawn] error: role hand names account "ghost", which is not in the accounts registry'],
  ['a platform that takes no account', { role: { account: 'work' }, tplType: 'codex' }, '[agent:spawn] error: role hand: account "work" is a Claude config dir; Codex roles take no account yet'],
]) {
  test(`by-name spawn, role account: ${label} is an error reply and no seat`, async (t) => {
    const f = mkSpawn(t, opts);
    const rec = await f.spawn('team-hand');
    assert.strictEqual(rec, null);
    assert.deepStrictEqual(f.created, []);
    assert.deepStrictEqual(f.replies, [want]);
  });
}
