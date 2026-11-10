'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerIpcHandlers } = require('../ipc-handlers');
const { createSessionManager } = require('../session-manager');
const { isFilenameToken, parseAndValidate } = require('../exec-schema');
const { mkTmpRoot } = require('./lib/tmp-roots');

function mkBox() {
  const tmp = mkTmpRoot('t2229-exec-list-');
  const home = path.join(tmp, 'clodex-home');
  const teamsDir = path.join(home, 'teams');
  const repo = path.join(tmp, 'repo');
  const elsewhere = path.join(tmp, 'elsewhere');
  const dir = path.join(teamsDir, 'avh');
  fs.mkdirSync(path.join(dir, 'exec'), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(dir, 'exec', 'avh-chat.json'),
    JSON.stringify({ argv: ['/bin/echo', 'chat'], description: 'team chat', schema: { type: 'object', additionalProperties: false } }));
  fs.writeFileSync(path.join(dir, 'exec', 'shared.json'),
    JSON.stringify({ argv: ['/bin/echo', 'team-shared'], description: 'team copy' }));
  const team = { name: 'avh', root: repo, lead: 'avh-lead', dir, roles: {} };
  const libRows = [
    { name: 'lib-only', argv: ['/bin/true'], cwd: '', description: 'lib', inProcess: '', file: 'lib-only.json' },
    { name: 'shared', argv: ['/bin/echo', 'lib-shared'], cwd: '', description: 'lib copy', inProcess: '', file: 'shared.json' },
  ];
  const records = {
    'avh-steward-clodent': { name: 'avh-steward-clodent', type: 'clodent', cwd: repo },
    'outsider': { name: 'outsider', type: 'clodent', cwd: elsewhere },
  };
  const handlers = {};
  const stub = () => () => {};
  const deps = new Proxy({
    handle: (ch, fn) => { handlers[ch] = fn; },
    on: (ch, fn) => { handlers[ch] = fn; },
    fs, path, teamsDir,
    listTeams: () => ['avh'],
    loadManifest: (name) => { if (name !== 'avh') throw new Error(`no team ${name}`); return team; },
    resolveTeam: (cwd) => (cwd === repo ? team : null),
    persistence: { get: (n) => records[n] || null },
    manager: { teamNameOf: (_n, cwd) => (cwd === repo ? 'avh' : null) },
    execLibrary: { list: () => libRows.map((r) => ({ ...r })) },
    log: { info() {}, warn() {}, error() {} },
  }, { get: (t, p) => (p in t ? t[p] : stub()) });
  registerIpcHandlers(deps);
  return { handlers, repo, elsewhere, team, home, tmp };
}

const AVH_CHAT = { name: 'avh-chat', argv: ['/bin/echo', 'chat'], cwd: '', description: 'team chat', inProcess: '', file: 'avh-chat.json', team: 'avh' };
const TEAM_SHARED = { name: 'shared', argv: ['/bin/echo', 'team-shared'], cwd: '', description: 'team copy', inProcess: '', file: 'shared.json', team: 'avh' };
const LIB_ONLY = { name: 'lib-only', argv: ['/bin/true'], cwd: '', description: 'lib', inProcess: '', file: 'lib-only.json' };
const LIB_SHARED = { name: 'shared', argv: ['/bin/echo', 'lib-shared'], cwd: '', description: 'lib copy', inProcess: '', file: 'shared.json' };

test('exec:list for a seat in the team lists the team commands, team copy shadowing the library one', () => {
  const { handlers } = mkBox();
  assert.deepStrictEqual(handlers['exec:list']({}, { session: 'avh-steward-clodent' }), [AVH_CHAT, LIB_ONLY, TEAM_SHARED]);
});

test('exec:list for a seat outside the team lists the library only', () => {
  const { handlers } = mkBox();
  assert.deepStrictEqual(handlers['exec:list']({}, { session: 'outsider' }), [LIB_ONLY, LIB_SHARED]);
});

test('exec:list for a new-seat cwd inside the team root lists the team commands', () => {
  const { handlers, repo } = mkBox();
  assert.deepStrictEqual(handlers['exec:list']({}, { cwd: repo }), [AVH_CHAT, LIB_ONLY, TEAM_SHARED]);
});

test('exec:list for a cwd outside every team, and with no scope, lists the library only', () => {
  const { handlers, elsewhere } = mkBox();
  assert.deepStrictEqual(handlers['exec:list']({}, { cwd: elsewhere }), [LIB_ONLY, LIB_SHARED]);
  assert.deepStrictEqual(handlers['exec:list']({}), [LIB_ONLY, LIB_SHARED]);
});

test('exec:list for a team template lists its own team commands', () => {
  const { handlers } = mkBox();
  assert.deepStrictEqual(handlers['exec:list']({}, { team: 'avh' }), [AVH_CHAT, LIB_ONLY, TEAM_SHARED]);
});

test('exec:list refuses a traversing team name and falls back to the library', () => {
  const { handlers } = mkBox();
  assert.deepStrictEqual(handlers['exec:list']({}, { team: '..' }), [LIB_ONLY, LIB_SHARED]);
});

function dispatchHarness({ home, team, repo, grants }) {
  const spawned = [];
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: home,
    isFilenameToken,
    parseAndValidate,
    resolveTeam: (cwd) => (cwd === repo ? team : null),
    os, fs, path,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ list: () => [], get: () => ({ execCommands: grants }) }),
    childProcess: { spawn: (cmd, args) => { spawned.push([cmd, ...args]); throw new Error('spawn stubbed'); } },
  });
  const m = new SessionManager();
  const replies = [];
  m._injectText = (_s, t) => replies.push(t);
  m._broadcast = () => {};
  return { m, replies, spawned };
}

for (const agentType of ['clodent', 'claude']) {
  test(`a granted team-scoped command dispatches from a ${agentType} seat; an ungranted one is refused`, async () => {
    const { home, team, repo } = mkBox();
    const { m, replies, spawned } = dispatchHarness({ home, team, repo, grants: ['avh-chat'] });
    const seat = { name: 'avh-steward', agentType, cwd: repo };
    m._handleExecIntent(seat, 'avh-chat', '{}');
    m._handleExecIntent(seat, 'shared', '{}');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(spawned, [['/bin/echo', 'chat']]);
    assert.deepStrictEqual(replies, [
      '[agent:exec] shared: not granted to this seat (granted: avh-chat)',
      '[agent:exec] avh-chat: spawn failed (spawn stubbed)',
    ]);
  });
}
