'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { registerIpcHandlers } = require('../ipc-handlers');
const { unlistedOf, mergeLists, keptLockedOf } = require('../plugin-api');
const { mkTmpRoot } = require('./lib/tmp-roots');

const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

function extract(re, what) {
  const m = re.exec(rendererSrc);
  assert.ok(m, `ENTER: ${what} was not found in renderer.js`);
  return m[1];
}

const SCOPE_FN = extract(/\n(function newSessionExecScope\([\s\S]*?\n\})\n/, 'newSessionExecScope');
const REFRESH_FN = extract(/\n(async function refreshNewSessionExecCommands\([\s\S]*?\n\})\n/, 'refreshNewSessionExecCommands');
const PERSISTED_OR_FN = extract(/\n(function persistedOr\([\s\S]*?\n\})\n/, 'persistedOr');
const CURRENT_OR_FN = extract(/\n(function currentOr\([\s\S]*?\n\})\n/, 'currentOr');
const CWD_EXEC_LISTENER = extract(/\n(inputCwd\.addEventListener\('change', \(\) => \{\n  [^\n]*refreshNewSessionExecCommands[^\n]*\n\}\);)\n/, 'the cwd listener that refreshes exec commands');

function mkHandlers() {
  const tmp = mkTmpRoot('t2231-tpl-exec-');
  const teamsDir = path.join(tmp, 'clodex-home', 'teams');
  const repo = path.join(tmp, 'repo');
  const home = path.join(tmp, 'home');
  const dir = path.join(teamsDir, 'avh');
  fs.mkdirSync(path.join(dir, 'exec'), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, 'exec', 'avh-chat.json'),
    JSON.stringify({ argv: ['/bin/echo', 'chat'], description: 'team chat' }));
  const team = { name: 'avh', root: repo, lead: 'avh-lead', dir, roles: {} };
  const handlers = {};
  const stub = () => () => {};
  const deps = new Proxy({
    handle: (ch, fn) => { handlers[ch] = fn; },
    on: (ch, fn) => { handlers[ch] = fn; },
    fs, path, teamsDir,
    listTeams: () => ['avh'],
    loadManifest: (name) => { if (name !== 'avh') throw new Error(`no team ${name}`); return team; },
    resolveTeam: (cwd) => (cwd === repo ? team : null),
    persistence: { get: () => null },
    manager: { teamNameOf: () => null },
    execLibrary: { list: () => [{ name: 'lib-only', argv: ['/bin/true'], cwd: '', description: 'lib', inProcess: '', file: 'lib-only.json' }] },
    log: { info() {}, warn() {}, error() {} },
  }, { get: (t, p) => (p in t ? t[p] : stub()) });
  registerIpcHandlers(deps);
  return { handlers, repo, home };
}

function templateEditor({ cwd, team = null, ticked = [] }) {
  const { handlers, repo, home } = mkHandlers();
  const scopes = [];
  const draws = [];
  let cwdListener = null;
  const env = {
    unlistedOf, mergeLists, keptLockedOf,
    window: { api: { listExecCommands: async (scope) => { scopes.push(scope); return handlers['exec:list']({}, scope); } } },
    inputCwd: { value: cwd === 'repo' ? repo : home, addEventListener: (_ev, fn) => { cwdListener = fn; } },
    homeDir: home,
    expandPath: (p) => p,
    newSessionIsAgent: () => true,
    setExecLibCache: (rows) => { draws.push({ names: rows.map((r) => r.name) }); },
    renderExecChecklist: (_el, set) => { draws[draws.length - 1].ticked = [...set]; return draws[draws.length - 1].names; },
    collectExecChecklist: () => ticked.slice(),
    inputExecList: { querySelectorAll: () => [] },
    dialogMode: 'template',
    editingTemplateTeam: team,
  };
  const names = Object.keys(env);
  const api = new Function(...names, `let formPersisted = {}; let formRendered = {};
    ${SCOPE_FN}\n${REFRESH_FN}\n${PERSISTED_OR_FN}\n${CURRENT_OR_FN}\n${CWD_EXEC_LISTENER}
    return { open: (t) => { formPersisted = { execCommands: t }; formRendered = {}; return refreshNewSessionExecCommands(new Set(t)); } };`)(...names.map((n) => env[n]));
  return { api, scopes, draws, repo, home, setCwd: (v) => { env.inputCwd.value = v; }, fireCwd: () => cwdListener() };
}

test('a library template whose cwd is inside a team root lists the team exec commands', async () => {
  const ed = templateEditor({ cwd: 'repo' });
  await ed.api.open(['lib-only']);
  assert.deepStrictEqual(ed.scopes, [{ cwd: ed.repo }]);
  assert.deepStrictEqual(ed.draws, [{ names: ['avh-chat', 'lib-only'], ticked: ['lib-only'] }]);
});

test('a team-owned template keeps team scope, whatever its cwd', async () => {
  const ed = templateEditor({ cwd: 'home', team: 'avh' });
  await ed.api.open([]);
  assert.deepStrictEqual(ed.scopes, [{ team: 'avh' }]);
  assert.deepStrictEqual(ed.draws, [{ names: ['avh-chat', 'lib-only'], ticked: [] }]);
});

test('a library template with a home cwd lists the library rows only', async () => {
  const ed = templateEditor({ cwd: 'home' });
  await ed.api.open([]);
  assert.deepStrictEqual(ed.scopes, [{ cwd: ed.home }]);
  assert.deepStrictEqual(ed.draws, [{ names: ['lib-only'], ticked: [] }]);
});

test('a cwd edit in the template editor re-lists exec commands and keeps the ticked ones', async () => {
  const ed = templateEditor({ cwd: 'home', ticked: ['lib-only'] });
  await ed.api.open(['lib-only']);
  ed.setCwd(ed.repo);
  ed.fireCwd();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(ed.scopes, [{ cwd: ed.home }, { cwd: ed.repo }]);
  assert.deepStrictEqual(ed.draws, [
    { names: ['lib-only'], ticked: ['lib-only'] },
    { names: ['avh-chat', 'lib-only'], ticked: ['lib-only'] },
  ]);
});
