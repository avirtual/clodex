// Run: node --test
// The engine→ipc-handlers seam for the teams front door (docs/teams-design.md,
// tasks/7-front-door REWORK 1). The green suite once masked a DEAD front door:
// createTeam/addRole/resolveTeam/listTeams were threaded into the SessionManager
// deps but NOT createEngine's return, so ipc-handlers destructured `undefined`
// and every team:* handler threw `not a function` internally — swallowed into
// {ok:false}. These tests drive the REGISTERED handlers with STUBBED writers and
// assert the handler REACHES the writer (arguments forwarded), not that it merely
// returns {ok:false}. Two guards in one: (a) createEngine must actually export
// the writers (the missing-seam regression), asserted separately below; (b) the
// handlers forward to them correctly.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// Register ipc-handlers with capturing transport seams + a Proxy of inert stubs
// for everything EXCEPT the named overrides, so a handler body can run against
// real stubbed writers. Returns { handlers, calls } — handlers keyed by channel.
function registerWith(overrides = {}) {
  const handlers = {};
  const capture = {
    handle: (ch, fn) => { handlers[ch] = fn; },
    on: (ch, fn) => { handlers[ch] = fn; },
  };
  const stub = () => () => {};
  const deps = new Proxy({ ...capture, ...overrides }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return stub();
    },
  });
  const { registerIpcHandlers } = require('../ipc-handlers');
  registerIpcHandlers(deps);
  return handlers;
}

// A minimal manager stub whose create() records the spawn params — the team
// handlers must fall through to it AFTER the manifest write.
function fakeManager(created) {
  return {
    create: async (...args) => { created.push(args); return { name: args[0], team: 'shop' }; },
    sessions: new Map(),
    list: () => [],
  };
}

test('team:create reaches createTeam with {name,root,lead} then spawns', async () => {
  const created = [];
  const writes = [];
  const handlers = registerWith({
    manager: fakeManager(created),
    createTeam: (arg) => { writes.push(['createTeam', arg]); return { name: arg.name }; },
    agentDefaults: { getDefaultDeny: () => [], getStrip: () => 0 },
    persistence: { setStripLevel: () => {}, get: () => null },
    workspaceOfSender: () => 'ws1',
  });
  const res = await handlers['team:create']({}, { teamName: 'shop', name: 'clodex', type: 'claude', cwd: '/proj' });
  // The handler REACHED the writer with the right shape — not a swallowed failure.
  assert.deepStrictEqual(writes, [['createTeam', { name: 'shop', root: '/proj', lead: 'clodex' }]]);
  assert.strictEqual(res.ok, true, 'handler returns ok after a successful write+spawn');
  assert.strictEqual(created.length, 1, 'falls through to the normal spawn');
  assert.strictEqual(created[0][0], 'clodex', 'seat name spawned');
});

test('team:join reaches addRole (hand = stock def) then spawns', async () => {
  const created = [];
  const writes = [];
  const handlers = registerWith({
    manager: fakeManager(created),
    addRole: (team, role, def) => { writes.push([team, role, def]); return {}; },
    agentDefaults: { getDefaultDeny: () => [], getStrip: () => 0 },
    persistence: { setStripLevel: () => {}, get: () => null },
    workspaceOfSender: () => 'ws1',
  });
  const res = await handlers['team:join']({}, { team: 'shop', role: 'hand', name: 'shop-hand', type: 'claude', cwd: '/proj/sub' });
  assert.strictEqual(writes.length, 1, 'addRole reached');
  assert.strictEqual(writes[0][0], 'shop');
  assert.strictEqual(writes[0][1], 'hand');
  assert.strictEqual(writes[0][2].prompt, 'clodex-team-hand', 'stock hand def forwarded');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(created.length, 1, 'falls through to the spawn');
});

test('team:join custom role forwards the picked prompt into the role def', async () => {
  const created = [];
  const writes = [];
  const handlers = registerWith({
    manager: fakeManager(created),
    addRole: (team, role, def) => { writes.push([team, role, def]); return {}; },
    agentDefaults: { getDefaultDeny: () => [], getStrip: () => 0 },
    persistence: { setStripLevel: () => {}, get: () => null },
    workspaceOfSender: () => 'ws1',
  });
  await handlers['team:join']({}, { team: 'shop', role: 'analyst', prompt: 'my-analyst', name: 'shop-analyst', type: 'claude', cwd: '/proj/sub' });
  assert.strictEqual(writes[0][1], 'analyst');
  assert.deepStrictEqual(writes[0][2], { instantiate: 'session', prompt: 'my-analyst' });
});

test('team:forCwd reaches resolveTeam and returns {team,root}', () => {
  const handlers = registerWith({
    resolveTeam: (cwd) => (cwd === '/proj/sub' ? { name: 'shop', root: '/proj' } : null),
  });
  assert.deepStrictEqual(handlers['team:forCwd']({}, '/proj/sub'), { team: 'shop', root: '/proj' });
  assert.deepStrictEqual(handlers['team:forCwd']({}, '/elsewhere'), { team: null, root: null });
});

test('team:names reaches listTeams; team:rolePrompts filters the library', () => {
  const handlers = registerWith({
    listTeams: () => ['shop', 'lab'],
    promptLibrary: { list: () => ([
      { name: 'clodex-team-hand', body: 'stock' },
      { name: 'clodex-team-lead', body: 'stock' },       // non-session → excluded
      { name: 'clodex-team-reviewer', body: 'stock' },   // non-session → excluded
      { name: 'house', body: 'no front matter' },        // undeclared → excluded
    ]) },
  });
  assert.deepStrictEqual(handlers['team:names']({}), { ok: true, names: ['shop', 'lab'] });
  assert.deepStrictEqual(handlers['team:rolePrompts']({}), { ok: true, prompts: ['clodex-team-hand'] });
});

test('a write refusal surfaces as {ok:false} WITHOUT spawning', async () => {
  const created = [];
  const handlers = registerWith({
    manager: fakeManager(created),
    createTeam: () => { throw new Error('team "shop" already exists'); },
    agentDefaults: { getDefaultDeny: () => [], getStrip: () => 0 },
    persistence: { setStripLevel: () => {}, get: () => null },
    workspaceOfSender: () => 'ws1',
  });
  const res = await handlers['team:create']({}, { teamName: 'shop', name: 'clodex', type: 'claude', cwd: '/proj' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /already exists/);
  assert.strictEqual(created.length, 0, 'a refused write never spawns the session');
});

// --- T29 Layer A Slice 2: the metadata-mutation IPC handlers (GUI backend) ---
// Operator-driven (no lead-gate here — the renderer IS the operator). removeRole/
// renameRole run manager._roleInUse (C5) BEFORE the mutator and return
// {ok:false, blockedBy} when a seat/ticket references the role.
test('team:setRole / team:setWatchdog forward to their mutators and return the reloaded team', () => {
  const writes = [];
  const handlers = registerWith({
    setRole: (t, r, patch) => { writes.push(['setRole', t, r, patch]); return { name: t, roles: {} }; },
    setTeamWatchdog: (t, ms) => { writes.push(['setTeamWatchdog', t, ms]); return { name: t, watchdogMs: ms }; },
  });
  const r1 = handlers['team:setRole']({}, 'shop', 'runner', { brief: 'new' });
  assert.deepStrictEqual(writes[0], ['setRole', 'shop', 'runner', { brief: 'new' }]);
  assert.strictEqual(r1.ok, true);
  assert.ok(r1.team, 'returns the reloaded manifest');
  const r2 = handlers['team:setWatchdog']({}, 'shop', 600000);
  assert.deepStrictEqual(writes[1], ['setTeamWatchdog', 'shop', 600000]);
  assert.strictEqual(r2.ok, true);
});

test('team:removeRole runs the C5 guard: free role removes, a referenced role returns {ok:false, blockedBy}', () => {
  const writes = [];
  let inUse = { seats: [], tickets: [] };
  const handlers = registerWith({
    loadManifest: (t) => ({ name: t, roles: {} }),
    manager: { _roleInUse: () => inUse },
    removeRole: (t, r) => { writes.push(['removeRole', t, r]); return { name: t, roles: {} }; },
  });
  // Free role → removeRole reached, ok.
  const ok = handlers['team:removeRole']({}, 'shop', 'runner');
  assert.deepStrictEqual(writes, [['removeRole', 'shop', 'runner']]);
  assert.strictEqual(ok.ok, true);
  // Referenced role → blocked, mutator NOT called, blockedBy carried.
  writes.length = 0;
  inUse = { seats: ['shop-runner-1'], tickets: ['t3'] };
  const blocked = handlers['team:removeRole']({}, 'shop', 'runner');
  assert.deepStrictEqual(writes, [], 'removeRole not called when blocked');
  assert.strictEqual(blocked.ok, false);
  assert.deepStrictEqual(blocked.blockedBy, { seats: ['shop-runner-1'], tickets: ['t3'] });
});

test('team:renameRole runs the C5 guard on the from-role and forwards when free', () => {
  const writes = [];
  let inUse = { seats: [], tickets: [] };
  const handlers = registerWith({
    loadManifest: (t) => ({ name: t, roles: {} }),
    manager: { _roleInUse: () => inUse },
    renameRole: (t, from, to) => { writes.push(['renameRole', t, from, to]); return { name: t, roles: {} }; },
  });
  const ok = handlers['team:renameRole']({}, 'shop', 'runner', 'builder');
  assert.deepStrictEqual(writes, [['renameRole', 'shop', 'runner', 'builder']]);
  assert.strictEqual(ok.ok, true);
  writes.length = 0;
  inUse = { seats: ['shop-runner-1'], tickets: [] };
  const blocked = handlers['team:renameRole']({}, 'shop', 'runner', 'builder');
  assert.deepStrictEqual(writes, [], 'renameRole not called when the from-role is in use');
  assert.strictEqual(blocked.ok, false);
  assert.deepStrictEqual(blocked.blockedBy, { seats: ['shop-runner-1'], tickets: [] });
});

test('team:setRole surfaces a mutator refusal as {ok:false}', () => {
  const handlers = registerWith({
    setRole: () => { throw new Error('the "reviewer" role is operator-owned topology'); },
  });
  const res = handlers['team:setRole']({}, 'shop', 'reviewer', { brief: 'x' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /operator-owned topology/);
});

// --- T29 Layer A Slice 3: the GUI read side (team:get) + the add-role IPC front.
test('team:get returns the loaded manifest (full role map) or {ok:false} on a bad name', () => {
  const handlers = registerWith({
    loadManifest: (name) => {
      if (name === 'shop') return { name: 'shop', lead: 'clodex', roles: { lead: {}, runner: {} }, watchdogMs: null };
      throw new Error(`no team manifest at ${name}`);
    },
  });
  const ok = handlers['team:get']({}, 'shop');
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(Object.keys(ok.team.roles), ['lead', 'runner'], 'full role map returned for the popover');
  const bad = handlers['team:get']({}, 'ghost');
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /no team manifest/);
});

test('team:addRole forwards to addRole, succeeds on an ordinary role, surfaces the guard errors', () => {
  const writes = [];
  const handlers = registerWith({
    addRole: (team, role, def) => {
      writes.push([team, role, def]);
      if (role === 'reviewer') throw new Error('the "reviewer" role is operator-owned topology');
      if (def && def.template === '/tmp/evil.json') throw new Error('template must be a library-template name matching');
      return { name: team, roles: { [role]: def } };
    },
  });
  // Ordinary role → reaches addRole, ok, reloaded manifest returned.
  const ok = handlers['team:addRole']({}, 'shop', 'runner', { instantiate: 'session', brief: 'r' });
  assert.deepStrictEqual(writes[0], ['shop', 'runner', { instantiate: 'session', brief: 'r' }]);
  assert.strictEqual(ok.ok, true);
  assert.ok(ok.team.roles.runner, 'reloaded manifest carries the new role');
  // C1 mint refusal surfaced verbatim.
  const reserved = handlers['team:addRole']({}, 'shop', 'reviewer', { instantiate: 'session' });
  assert.strictEqual(reserved.ok, false);
  assert.match(reserved.error, /operator-owned topology/);
  // C4 template refusal surfaced verbatim.
  const badTpl = handlers['team:addRole']({}, 'shop', 'runner', { template: '/tmp/evil.json' });
  assert.strictEqual(badTpl.ok, false);
  assert.match(badTpl.error, /library-template name/);
});

// The regression guard proper. The handler tests above inject the writer as a
// dep directly, so they prove the handler FORWARDS to it — but not that engine
// actually populates that dep. The original bug lived in engine's RETURN
// surface: the four names were passed only into the SessionManager deps block
// (inside createEngine, one name per line), never the returned object main.js
// spreads into ipc-handlers. So target the RETURN surface precisely: the four
// names appear comma-separated on ONE line only in the return literal (the deps
// block lists them one-per-line), so this regex fails loudly if the export is
// dropped again without matching the deps block by accident.
test('createEngine returns the front-door writers on the seam ipc-handlers spreads', () => {
  const src = require('fs').readFileSync(require.resolve('../engine.js'), 'utf-8');
  assert.match(src, /createTeam, addRole, resolveTeam, listTeams,/,
    'engine.js return object must list the four front-door writers on the ipc-handlers seam');
});
