// Run: node --test
// The engine→ipc-handlers seam for the teams front door (teams-design.md [internal design doc, not in this repo],
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
  const deps = new Proxy({
    ...capture,
    ...(overrides.templates && !overrides.listAllTemplates ? { listAllTemplates: () => overrides.templates.list() } : {}),
    ...overrides,
  }, {
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
  assert.deepStrictEqual(writes[0][2], { prompt: 'my-analyst' });
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
  // `prompts` is the picker's rail-filtered offering; `all` is everything on
  // disk. The popover needs both to tell "not installed" from "installed but off
  // the append rail" — one message for both facts sent the operator looking for
  // a file that was there the whole time (R3).
  assert.deepStrictEqual(handlers['team:rolePrompts']({}), {
    ok: true,
    prompts: ['clodex-team-hand'],
    all: ['clodex-team-hand', 'clodex-team-lead', 'clodex-team-reviewer', 'house'],
  });
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

test('team:setLead forwards the SEAT name to setLead and returns the reloaded team', () => {
  const writes = [];
  const handlers = registerWith({
    setLead: (t, seat) => { writes.push(['setLead', t, seat]); return { name: t, lead: seat }; },
    // Wired alongside so a handler that reached the ROLE mutator instead of the
    // seat one fails loudly here rather than silently editing reserved topology.
    setRole: (t, r, patch) => { writes.push(['setRole', t, r, patch]); return { name: t, roles: {} }; },
  });
  const res = handlers['team:setLead']({}, 'shop', 'shop-lead-2');
  assert.deepStrictEqual(writes, [['setLead', 'shop', 'shop-lead-2']], 'setLead reached, and setRole was NOT');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.team.lead, 'shop-lead-2', 'the reloaded manifest carries the new pointer');
});

test('team:setLead surfaces a writer refusal as {ok:false} rather than throwing', () => {
  const handlers = registerWith({
    setLead: () => { throw new Error('team "shop" lead must be a seat name matching /re/'); },
  });
  const res = handlers['team:setLead']({}, 'shop', 'bad name!');
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /must be a seat name matching/);
});

test('team:removeRole runs the C5 guard: free role removes, a referenced role returns {ok:false, blockedBy}', () => {
  const writes = [];
  let inUse = { seats: [], tickets: [] };
  const handlers = registerWith({
    loadManifest: (t) => ({ name: t, roles: {} }),
    manager: { _roleInUse: () => inUse },
    removeRole: (...args) => { writes.push(['removeRole', ...args]); return { name: 'shop', roles: {} }; },
  });
  // Free role → removeRole reached, ok. The trailing `{operator:true}` is t421's
  // opt-in and is asserted here as part of the whole call.
  const ok = handlers['team:removeRole']({}, 'shop', 'runner');
  assert.deepStrictEqual(writes, [['removeRole', 'shop', 'runner', { operator: true }]]);
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
    // Variadic for the same reason as team:removeRole above: the opt-in is a
    // trailing argument, and a three-parameter stub would drop it silently.
    addRole: (...args) => {
      const [team, role, def] = args;
      writes.push(args);
      if (def && def.template === '/tmp/evil.json') throw new Error('template must be a library-template name matching');
      return { name: team, roles: { [role]: def } };
    },
  });
  // Ordinary role → reaches addRole, ok, reloaded manifest returned.
  const ok = handlers['team:addRole']({}, 'shop', 'runner', { instantiate: 'session', brief: 'r' });
  assert.deepStrictEqual(writes[0], ['shop', 'runner', { instantiate: 'session', brief: 'r' }, { operator: true }]);
  assert.strictEqual(ok.ok, true);
  assert.ok(ok.team.roles.runner, 'reloaded manifest carries the new role');
  // C4 template refusal surfaced verbatim.
  const badTpl = handlers['team:addRole']({}, 'shop', 'runner', { template: '/tmp/evil.json' });
  assert.strictEqual(badTpl.ok, false);
  assert.match(badTpl.error, /library-template name/);
});

// t421. The opt-in is what makes an operator re-mint of a removed `reviewer`
// possible at all, and this channel is the ONLY caller that passes it — the
// `[agent:team role-add|role-rm]` intents call the same mutators without it
// (pinned in session-manager.test.js). Asserting the argument, not merely that
// the mutator was reached: the whole security property is in that fourth value.
test('team:addRole / team:removeRole pass the operator opt-in; team:join does NOT', async () => {
  const writes = [];
  const handlers = registerWith({
    manager: { _roleInUse: () => ({ seats: [], tickets: [] }), create: async () => ({}), sessions: new Map(), list: () => [] },
    // A manifest with NO `hand` role, so team:join takes its mint arm. It must
    // still LOAD: team:removeRole's C5 guard reads it first, and a throwing stub
    // would fail that handler before it ever reached its mutator.
    loadManifest: (t) => ({ name: t, roles: { lead: {} } }),
    addRole: (...args) => { writes.push(['addRole', ...args]); return { name: 'shop', roles: {} }; },
    removeRole: (...args) => { writes.push(['removeRole', ...args]); return { name: 'shop', roles: {} }; },
    agentDefaults: { getDefaultDeny: () => [], getStrip: () => 0 },
    persistence: { setStripLevel: () => {}, get: () => null },
    workspaceOfSender: () => 'ws1',
  });

  handlers['team:addRole']({}, 'shop', 'reviewer', {});
  handlers['team:removeRole']({}, 'shop', 'reviewer');
  await handlers['team:join']({}, { team: 'shop', role: 'hand', name: 'shop-hand', type: 'claude', cwd: '/proj' });

  assert.strictEqual(writes.length, 3, 'ENTER: all three handlers reached their mutator — a swallowed {ok:false} would leave the assertions below true of an empty list');
  assert.deepStrictEqual(writes[0].at(-1), { operator: true }, 'team:addRole opts in');
  assert.deepStrictEqual(writes[1].at(-1), { operator: true }, 'team:removeRole opts in');
  // join is the case this MUST stay false for: it mints an absent role from a
  // stock def, and an opt-in here would let any join re-mint a reserved key.
  const join = writes[2];
  assert.strictEqual(join[0], 'addRole');
  assert.strictEqual(join.length, 4, 'team:join calls addRole with (team, role, def) and nothing more');
  assert.notDeepStrictEqual(join.at(-1), { operator: true }, 'team:join must never carry the operator opt-in');
});

// t414: the preflight handler is the popover's only source of findings, and it
// is where the pure leaf's four probes get bound to real stores. Driven through
// the REGISTERED handler with stubbed stores, for the same reason as everything
// above it: a handler that reaches an undefined store returns {ok:false} with a
// swallowed message, which is indistinguishable from a team that owes nothing.
test('team:preflight binds the probes to the real stores and returns the leaf findings', () => {
  const handlers = registerWith({
    loadManifest: (name) => {
      if (name !== 'shop') throw new Error(`no team manifest at ${name}`);
      return { name: 'shop', root: '/repo/shop', roles: { hand: { prompt: 'gone', template: 'hand-seat' } } };
    },
    templates: { list: () => [{ name: 'hand-seat', execCommands: ['run-tests'], appendPromptFiles: ['owed'] }] },
    execLibrary: { list: () => [{ name: 'run-tests', argv: ['bash', '${TEAM_ROOT}/scripts/t.sh'] }] },
    promptLibrary: { raw: () => null }, // nothing installed, either rail
    fs: { existsSync: () => false },
  });
  const res = handlers['team:preflight']({}, 'shop');
  assert.strictEqual(res.ok, true);
  // The WHOLE findings array. Each of the four probes must have been reached for
  // this to be the answer: a probe left unbound returns undefined, the leaf takes
  // its unresolved arm anyway, and a partial assertion would read right past it.
  assert.deepStrictEqual(res.findings, [
    {
      level: 'warn', kind: 'prompt', role: 'hand', ref: 'gone', resolvedFrom: null,
      message: 'role "hand": prompt "gone" is not installed under library/prompts/system — a seat spawned for this role boots unbriefed',
    },
    {
      level: 'warn', kind: 'exec', role: 'hand', ref: 'run-tests', resolvedFrom: 'library',
      message: 'role "hand": exec command "run-tests" needs /repo/shop/scripts/t.sh, which does not exist under this team\'s root',
    },
    {
      level: 'note', kind: 'append', role: 'hand', ref: 'owed', resolvedFrom: null,
      message: 'role "hand": template "hand-seat" composes append prompt "owed", which is not installed under library/prompts/append — write it, or drop it from the template',
    },
  ]);
});

test('team:preflight resolves against the stores rather than reporting everything missing', () => {
  // The other direction, and the one that catches a probe wired to a constant:
  // the SAME team with everything installed must come back clean.
  const handlers = registerWith({
    loadManifest: () => ({ name: 'shop', root: '/repo/shop', roles: { hand: { prompt: 'p', template: 'hand-seat' } } }),
    templates: { list: () => [{ name: 'hand-seat', execCommands: ['run-tests'], appendPromptFiles: ['owed'] }] },
    execLibrary: { list: () => [{ name: 'run-tests', argv: ['bash', '${TEAM_ROOT}/scripts/t.sh'] }] },
    promptLibrary: { raw: () => 'body' },
    fs: { existsSync: (p) => p === '/repo/shop/scripts/t.sh' },
  });
  assert.deepStrictEqual(handlers['team:preflight']({}, 'shop'), { ok: true, findings: [] });
});

test('team:preflight surfaces an unreadable manifest as an error with an EMPTY findings array', () => {
  const handlers = registerWith({
    loadManifest: () => { throw new Error('no team manifest at ghost'); },
  });
  const res = handlers['team:preflight']({}, 'ghost');
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /no team manifest/);
  // `findings: []` rather than absent: the popover reads `res.findings` and an
  // undefined here would be an unrendered checklist that looks like a clean team.
  assert.deepStrictEqual(res.findings, []);
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
  // setLead (t420) rides the same seam and would fail the same silent way — the
  // handler destructures it, so an unexported name is `undefined` and every
  // team:setLead returns {ok:false, error:"setLead is not a function"}.
  //
  // Anchored to the RETURN literal by matching the PAIR of lines: the require
  // destructure at the top of engine.js also carries `setLead` on a line of
  // mutators, and matching that one would pass while the return surface stayed
  // broken — precisely the false green this whole file exists to prevent. Only
  // the return literal has `loadManifest,` ending the preceding line.
  assert.match(src, /createTeam, addRole, resolveTeam, listTeams, loadManifest,\n\s*setRole, removeRole, renameRole, setTeamWatchdog, setLead,/,
    'engine.js return object must export setLead on the ipc-handlers seam');
});

// The garbled-def split lives in the HANDLER's probe, not in the leaf: only the
// binding can tell "list() dropped it" from "there is no file", because only it
// holds raw(). A leaf-only test would pin half the fix and pass while the probe
// still returned null — the shape that made t415's first join test a false pass.
// So this drives the REGISTERED handler against a REAL execLibrary over a REAL
// temp registry with genuinely undecodable bytes on it.
const fsReal = require('fs');
const osReal = require('os');
const pathReal = require('path');
const { initStores } = require('../stores');

// try/finally, not trailing rmSync: a failing assertion throws past the cleanup
// and leaks two mkdtemp dirs per run.
function withRegistry(fn) {
  const registryDir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t416-'));
  const userData = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t416-ud-'));
  fsReal.mkdirSync(pathReal.join(registryDir, 'library', 'exec'), { recursive: true });
  try {
    return fn({ registryDir, userData, stores: initStores(userData, { log: console, registryDir }) });
  } finally {
    fsReal.rmSync(registryDir, { recursive: true, force: true });
    fsReal.rmSync(userData, { recursive: true, force: true });
  }
}

test('team:preflight: a def file that exists but does not decode reports REPAIR, end to end', () => {
  withRegistry(({ registryDir, stores }) => {
    // Real bytes that real JSON.parse really rejects — not a stub pretending to
    // fail. This is the file list() silently `continue`s past.
    fsReal.writeFileSync(pathReal.join(registryDir, 'library', 'exec', 'garbled.json'),
      '{ "argv": ["bash",  <<< truncated');

    // ENTER: the fixture must actually reach the state it names — the file is on
    // disk AND absent from the listing. If a future list() started surfacing it,
    // the assertion below would be about a case that no longer exists.
    assert.strictEqual(stores.execLibrary.list().some((d) => d.name === 'garbled'), false,
      'ENTER: list() must drop the garbled file — that is the lossiness under test');
    assert.ok(stores.execLibrary.raw('garbled') != null,
      'ENTER: the file must still be on disk — otherwise this is the no-def case');

    const handlers = registerWith({
      loadManifest: () => ({ name: 'shop', root: registryDir, roles: { hand: { prompt: 'p', template: 'hand-seat' } } }),
      templates: { list: () => [{ name: 'hand-seat', execCommands: ['garbled'] }] },
      execLibrary: stores.execLibrary, // the real store, over the real garbled file
      promptLibrary: { raw: () => 'body' },
      fs: fsReal,
    });
    const res = handlers['team:preflight']({}, 'shop');
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.findings, [{
      level: 'warn', kind: 'exec', role: 'hand', ref: 'garbled', resolvedFrom: null,
      message: 'role "hand": exec command "garbled" has a def file under library/exec that could not be read as a def object — the runner cannot read it, so every call fails; repair the file',
    }]);
    // The regression this exists to catch: revert the probe's raw() consult and
    // this message becomes "has no def installed under library/exec", sending the
    // operator to write a file that is already sitting there.
    assert.ok(!/has no def installed/.test(res.findings[0].message),
      'a def file ON DISK must never be reported as one that was never installed');
  });
});

// The same arm, reached by the OTHER route stores.js:1050 drops a file through:
// valid JSON that is not an object. "repair the JSON" would have been a wrong
// instruction here — the JSON is fine, the shape is not.
test('team:preflight: a def file holding valid non-object JSON takes the same REPAIR arm', () => {
  withRegistry(({ registryDir, stores }) => {
    fsReal.writeFileSync(pathReal.join(registryDir, 'library', 'exec', 'scalar.json'), '42');
    assert.strictEqual(stores.execLibrary.list().some((d) => d.name === 'scalar'), false,
      'ENTER: list() must drop a non-object def — parses fine, still not a def');

    const handlers = registerWith({
      loadManifest: () => ({ name: 'shop', root: registryDir, roles: { hand: { prompt: 'p', template: 'hand-seat' } } }),
      templates: { list: () => [{ name: 'hand-seat', execCommands: ['scalar'] }] },
      execLibrary: stores.execLibrary,
      promptLibrary: { raw: () => 'body' },
      fs: fsReal,
    });
    assert.deepStrictEqual(handlers['team:preflight']({}, 'shop').findings, [{
      level: 'warn', kind: 'exec', role: 'hand', ref: 'scalar', resolvedFrom: null,
      message: 'role "hand": exec command "scalar" has a def file under library/exec that could not be read as a def object — the runner cannot read it, so every call fails; repair the file',
    }]);
  });
});

test('team:preflight: a command with NO def file still reports install, through the same probe', () => {
  // The other side of the split, driven through the same real store: with an
  // empty exec dir, raw() returns null and the probe must fall through to the
  // original message. A sentinel that leaked into this case would turn every
  // missing def into a phantom parse error.
  withRegistry(({ registryDir, stores }) => {
    const handlers = registerWith({
      loadManifest: () => ({ name: 'shop', root: registryDir, roles: { hand: { prompt: 'p', template: 'hand-seat' } } }),
      templates: { list: () => [{ name: 'hand-seat', execCommands: ['ghost'] }] },
      execLibrary: stores.execLibrary,
      promptLibrary: { raw: () => 'body' },
      fs: fsReal,
    });
    assert.deepStrictEqual(handlers['team:preflight']({}, 'shop').findings, [{
      level: 'warn', kind: 'exec', role: 'hand', ref: 'ghost', resolvedFrom: null,
      message: 'role "hand": template "hand-seat" grants exec command "ghost", which has no def installed under library/exec',
    }], 'the no-def message must survive byte for byte — nothing already asserted may move');
  });
});
