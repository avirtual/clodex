'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { teamTemplateSave } = require('../team-prompt-dir');
const { parseIntent } = require('../intent-scanner');
const { withoutLocalOnly, withoutExecGrants } = require('../session-args');
const { createSessionManager } = require('../session-manager');
const { registerIpcHandlers } = require('../ipc-handlers');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ROOT = path.join(__dirname, '..');
const MCP_ARG = 27;

function rootModules() {
  return fs.readdirSync(ROOT).filter((f) => f.endsWith('.js')).sort()
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
}

function methodBody(src, header) {
  const at = src.indexOf(header);
  assert.ok(at > 0, `${header} found`);
  const rest = src.slice(at + header.length);
  const end = rest.search(/\n {4}(async )?_[A-Za-z]+\([^)]*\) \{/);
  assert.ok(end > 0, `${header} has a following method`);
  return rest.slice(0, end);
}

test('part 1: the library is written only through ipc-handlers, and no intent dispatch names it', () => {
  const writers = [];
  for (const { file, src } of rootModules()) {
    if (/mcpLibrary\.(save|remove|import)\s*\(/.test(src)) writers.push(file);
  }
  assert.deepStrictEqual(writers, ['ipc-handlers.js']);
  const tt = fs.readFileSync(path.join(ROOT, 'team-tickets.js'), 'utf8');
  const sm = fs.readFileSync(path.join(ROOT, 'session-manager.js'), 'utf8');
  const bodies = [
    ['team-tickets.js _handleTeam', methodBody(tt, '    _handleTeam(session, intent) {')],
    ['session-manager.js _handleExecIntent', methodBody(sm, "    _handleExecIntent(session, cmd, rawBody, intent = { type: 'exec', cmd }) {")],
  ];
  for (const [label, body] of bodies) {
    assert.ok(body.length > 500, `${label}: ENTER — the body was sliced`);
    for (const needle of ['mcpLibrary', 'library/mcp', "'library', 'mcp'", 'getMcpLibrary']) {
      assert.ok(!body.includes(needle), `${label} references ${needle}`);
    }
  }
  assert.ok(!/mcpLibrary|getMcpLibrary|library\/mcp/.test(tt), 'team-tickets.js never reaches the library');
});

function teamDeps() {
  const teamsDir = mkTmpRoot('clx-mcp-team-');
  fs.mkdirSync(path.join(teamsDir, 'core', 'templates'), { recursive: true });
  return { deps: { fs, path, teamsDir, listTeams: () => ['core'] }, file: path.join(teamsDir, 'core', 'templates', 'pm.json') };
}

test('part 2: teamTemplateSave without operator lands no mcpServers and keeps the prior list', () => {
  const { deps, file } = teamDeps();
  const fresh = teamTemplateSave(deps, 'core', 'pm', { type: 'claude', mcpServers: ['jira'] });
  assert.deepStrictEqual(fresh, { ok: true, file, mcpIgnored: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'claude' });

  fs.writeFileSync(file, JSON.stringify({ type: 'claude', mcpServers: ['jira'] }));
  assert.deepStrictEqual(teamTemplateSave(deps, 'core', 'pm', { type: 'codex', mcpServers: ['evil'] }), { ok: true, file, mcpIgnored: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'codex', mcpServers: ['jira'] });
  assert.deepStrictEqual(teamTemplateSave(deps, 'core', 'pm', { type: 'codex', mcpServers: [] }), { ok: true, file, mcpIgnored: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'codex', mcpServers: ['jira'] });
  assert.deepStrictEqual(teamTemplateSave(deps, 'core', 'pm', { type: 'codex' }), { ok: true, file });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'codex', mcpServers: ['jira'] });

  assert.deepStrictEqual(teamTemplateSave(deps, 'core', 'pm', { type: 'claude', mcpServers: ['confluence'] }, { operator: true }), { ok: true, file });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'claude', mcpServers: ['confluence'] });
  teamTemplateSave(deps, 'core', 'pm', { type: 'claude' }, { operator: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'claude' });
});

test('part 2: the doors — the GUI passes operator, the intent and derive paths do not', () => {
  const ipc = fs.readFileSync(path.join(ROOT, 'ipc-handlers.js'), 'utf8');
  const tt = fs.readFileSync(path.join(ROOT, 'team-tickets.js'), 'utf8');
  assert.ok(ipc.includes('teamTemplateSave(teamFileDeps, team, stem, body, { operator: true })'));
  const calls = tt.match(/teamTemplateSave\([^;]*\);/g) || [];
  assert.strictEqual(calls.length, 3, 'ENTER: the intent save and both derive paths');
  for (const c of calls) assert.ok(!c.includes('operator'), c);
  assert.ok(tt.includes("res.mcpIgnored ? ': mcpServers is operator-set; the stored list is unchanged' : ''"));
});

test('part 3: no role or spawn grammar carries an mcp key', () => {
  const role = parseIntent('[agent:team role-set pm mcp:jira] x');
  assert.strictEqual(role.type, 'team');
  assert.strictEqual(role.sub, 'role-set');
  assert.strictEqual(role.name, 'pm');
  assert.ok(!Object.keys(role).some((k) => /mcp/i.test(k)), JSON.stringify(role));
  const add = parseIntent('[agent:team role-add qa mcp:jira mcpServers:jira] x');
  assert.ok(add && !Object.keys(add).some((k) => /mcp/i.test(k)), JSON.stringify(add));
  const spawn = parseIntent('[agent:spawn name:kid template:t mcp:jira mcpServers:jira]');
  assert.strictEqual(spawn.type, 'spawn');
  assert.ok(!Object.keys(spawn).some((k) => /mcp/i.test(k)), JSON.stringify(spawn));
});

test('part 4: the peer wire strips mcpServers both ways', () => {
  assert.deepStrictEqual(withoutLocalOnly({ mcpServers: ['a'], type: 'claude', env: { A: '1' } }), { type: 'claude' });
  assert.deepStrictEqual(withoutExecGrants({ mcpServers: ['a'], execCommands: ['x'], type: 'claude' }), { type: 'claude' });
});

function spawnHarness(tpl) {
  const calls = [];
  const SessionManager = createSessionManager({
    knownSkillNames: () => [], os, fs, path,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ get: () => null, setStripLevel() {}, setAutoCompact() {} }),
    withoutPrivilegedIntentsFor: (x) => x,
    ensureDir: () => {},
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    DEFAULT_WORKSPACE_ID: 'default',
  });
  const m = new SessionManager();
  m.sessions = new Map();
  m._injectText = () => {};
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m.create = async (...args) => { calls.push(args); return undefined; };
  const dir = mkTmpRoot('clx-mcp-tpl-');
  const tmpl = path.join(dir, 'tpl.json');
  fs.writeFileSync(tmpl, JSON.stringify({ type: 'claude', cwd: os.tmpdir(), ...tpl }));
  return { m, calls, tmpl };
}

async function spawnVia(tpl, body) {
  const { m, calls, tmpl } = spawnHarness(tpl);
  m._handleSpawnIntent(
    { name: 'lead', cwd: os.tmpdir(), workspaceId: 'default', type: 'claude' },
    { name: 'child', template: tpl ? tmpl : null, body },
  );
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.length, 1, 'ENTER: create was called');
  return calls[0];
}

test('part 5: an intent spawn from a template carries exactly the template\'s list; the body adds nothing', async () => {
  assert.deepStrictEqual((await spawnVia({ mcpServers: ['jira', 'docs'] }, ''))[MCP_ARG], ['jira', 'docs']);
  assert.deepStrictEqual((await spawnVia({ mcpServers: ['jira'] }, '{"mcpServers":["evil"]} mcpServers: evil'))[MCP_ARG], ['jira']);
  assert.deepStrictEqual((await spawnVia({}, '{"mcpServers":["evil"]}'))[MCP_ARG], []);
  assert.deepStrictEqual((await spawnVia(null, 'mcp:evil'))[MCP_ARG], []);
});

test('part 5: the dialog door spawns exactly the list it was handed', async () => {
  const calls = [];
  const handlers = new Map();
  const base = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: () => {},
    manager: { sessions: new Map(), create: async (...args) => { calls.push(args); return { name: args[0] }; } },
    persistence: { get: () => null, setStripLevel() {} },
    agentDefaults: { getStrip: () => 0, getDefaultDeny: () => [], getDefaultSkillDeny: () => [], getDefaultBuiltinDeny: () => [] },
    workspaceOfSender: () => 'ws-1',
  };
  registerIpcHandlers(new Proxy(base, { get(t, k) { return k in t ? t[k] : () => () => {}; } }));
  const create = handlers.get('session:create');
  const args = (mcp) => ['seat', 'claude', '/tmp', [], null, null, false, null, [], [], [], [], [], null, null, [], [], null, null, false, null, 'pty', null, mcp];
  await create({}, ...args(['jira']));
  await create({}, ...args(undefined));
  assert.deepStrictEqual(calls.map((c) => c[MCP_ARG]), [['jira'], []]);
  assert.deepStrictEqual(calls.map((c) => c.length), [28, 28]);
});
