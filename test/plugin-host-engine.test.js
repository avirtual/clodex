'use strict';
// plugin-host-engine.test.js — the engine-half host contract (plugin-plan.md [internal design doc, not in this repo]
// §3.2/§3.3/§3.4, Phase 1a). Unit-level: a fake manager, a fake uiSettings, a tmp
// userDataPath. No electron, no PTY, no engine bootstrap.
//
// The tests that matter most here are the ones covering behavior the unit suite
// CANNOT reach through the real code path — the onExit landmine ordering and the
// event drop semantics both live inside a PTY exit handler and a window map. This
// file pins them at the seam instead, which is the whole reason the hook points
// are injected deps rather than inline calls.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPluginHostEngine } = require('../plugin-host-engine');
const { HOST_API_VERSION, NO_SUCH_METHOD } = require('../plugin-api');

// ── fakes ──────────────────────────────────────────────────────────────────
function makeManager(sessions = []) {
  const map = new Map();
  for (const s of sessions) map.set(s.name, s);
  const sent = [];        // every _sendToSession / _broadcast / window send
  const injected = [];
  return {
    sessions: map,
    sent, injected,
    list: () => [...map.values()].map((s) => ({ name: s.name, type: s.type, cwd: s.cwd, workspaceId: s.workspaceId })),
    listForWorkspace(wsId) { return this.list().filter((s) => s.workspaceId === wsId); },
    _sendToSession: (name, channel, ...args) => sent.push({ to: { session: name }, channel, args }),
    _broadcast: (channel, ...args) => sent.push({ to: 'all', channel, args }),
    windowForWorkspace: (wsId) => (wsId === 'ws-open'
      ? { webContents: { send: (channel, ...args) => sent.push({ to: { workspace: wsId }, channel, args }) } }
      : null),
    _injectText: (session, text, opts) => injected.push({ name: session.name, text, opts }),
  };
}

function makeHost({ manager = makeManager(), settings = {}, loader = null, libraryKinds } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-plugin-test-'));
  let ui = { ...settings };
  const logged = [];
  const removals = [];
  const engine = createPluginHostEngine({
    manager,
    getUiSettings: () => ({ get: () => ui, set: (patch) => { ui = { ...ui, ...patch }; } }),
    log: { info: (scope, msg) => logged.push(`${scope} ${msg}`), error: (scope, msg) => logged.push(`${scope} ${msg}`) },
    userDataPath: dir,
    fs, path,
    gitWorktree: { list: () => 'WORKTREE_LEAF' },
    libraryKinds: libraryKinds || { memory: (ref) => { removals.push(ref); return { ok: true }; } },
    telemetrySnapshot: (name) => (name === 'a' ? { tok: 42 } : null),
    getLoader: () => loader,
  });
  return { engine, manager, dir, logged, removals, uiSettings: () => ui };
}

const sessionA = { name: 'a', type: 'claude', cwd: '/repo/a', workspaceId: 'ws-open' };
const sessionB = { name: 'b', type: 'bash', cwd: '/repo/b', workspaceId: 'ws-closed' };

// ── §3.2 sessions facade — MUST-FIX 1 ──────────────────────────────────────
test('the sessions facade offers listAll/listWorkspace and NO unqualified list', () => {
  const { engine } = makeHost({ manager: makeManager([sessionA, sessionB]) });
  const host = engine.register('demo', { activate() {} });

  assert.deepEqual(host.sessions.listAll().map((s) => s.name), ['a', 'b'], 'listAll is GLOBAL');
  assert.deepEqual(host.sessions.listWorkspace('ws-open').map((s) => s.name), ['a'],
    'listWorkspace is scoped to its workspace');
  // The conflation this API exists to prevent: a default-named accessor would
  // make the global one the easy one, and fsScope would NOT catch the mistake
  // (it refuses peers, not foreign workspaces).
  assert.equal(host.sessions.list, undefined,
    'an unqualified list() must not exist — it is the single most repeated error the plan names');
});

test('fsScope reproduces the sessionCwd guard verbatim, including the remote refusal', () => {
  const manager = makeManager([
    sessionA,
    { name: 'peered', type: 'claude', peer: 'box', cwd: '/remote', workspaceId: 'ws-open' },
    { name: 'nocwd', type: 'claude', cwd: null, workspaceId: 'ws-open' },
  ]);
  const { engine } = makeHost({ manager });
  const host = engine.register('demo', { activate() {} });

  assert.deepEqual(host.sessions.fsScope('a'), { cwd: '/repo/a' });
  assert.deepEqual(host.sessions.fsScope('missing'), { error: 'Session not found' });
  // The exact string the renderer already renders as its remote notice — the
  // host-side locality guarantee (MUST-FIX 5): a plugin cannot widen it because
  // the refusal is not the plugin's code.
  assert.deepEqual(host.sessions.fsScope('peered'), { error: 'remote' });
  assert.deepEqual(host.sessions.fsScope('nocwd'), { error: 'Session has no working directory' });
});

test('SessionHandle exposes only the frozen five-method surface', () => {
  const { engine, manager } = makeHost({ manager: makeManager([sessionA]) });
  const host = engine.register('demo', { activate() {} });
  const h = host.sessions.get('a');

  assert.deepEqual(Object.keys(h).sort(), ['cwd', 'isAlive', 'inject', 'name', 'type', 'workspaceId'].sort());
  assert.ok(Object.isFrozen(h), 'handle is frozen');
  assert.equal(h.isAlive(), true);
  // No raw session object, no pty, no persistence entry ever crosses.
  assert.equal(h.pty, undefined);
  h.inject('hello');
  assert.deepEqual(manager.injected, [{ name: 'a', text: 'hello', opts: { parkable: true } }],
    'inject defaults to parkable:true, the exec reply convention');
  assert.equal(host.sessions.get('nope'), null, 'unknown session mints no handle');
});

// ── §3.2 onExit — MUST-FIX 4, the landmine ─────────────────────────────────
test('onExit subscribers are sync-only, isolated, and see a dead handle', () => {
  const dead = { ...sessionA, _dead: true };
  const { engine, manager, logged } = makeHost({ manager: makeManager([dead]) });
  const host = engine.register('demo', { activate() {} });

  const seen = [];
  host.sessions.onExit((h) => { seen.push(['ok', h.name, h.isAlive()]); });
  // A throwing subscriber must not take down PTY teardown, which is mid-flight.
  host.sessions.onExit(() => { throw new Error('boom'); });
  // A thenable return is a CONTRACT VIOLATION: the hook's correctness is that it
  // completes before _cleanup, so an async subscriber would resume after the map
  // entry is gone — re-breaking the exact ordering the hook was placed to respect.
  host.sessions.onExit(() => Promise.resolve('async'));
  host.sessions.onExit((h) => { seen.push(['after-throw', h.name]); });

  engine.hooks.fireExit('a');

  assert.deepEqual(seen, [['ok', 'a', false], ['after-throw', 'a']],
    'a throwing subscriber is isolated — later subscribers still run');
  assert.ok(logged.some((l) => /thenable/.test(l)), 'the async return logged a contract violation');
  assert.ok(logged.some((l) => /threw \(ignored\)/.test(l)), 'the throw was logged, not propagated');

  // inject() on the dead handle is a safe no-op, matching _injectText's guard.
  const h = host.sessions.get('a');
  assert.equal(h.isAlive(), false, 'the handle is already _dead at hook time');
});

test('the onExit call site sits between the exit broadcast and _cleanup', () => {
  // The landmine ordering itself, read out of session-manager.js. A unit test
  // cannot execute that PTY handler, so it is pinned STRUCTURALLY: reversing the
  // order strands a dead sidebar tab, and the failure is invisible until a real
  // session exits with a window attached. Reordering the source must fail here.
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  const exitSend = src.indexOf("this._sendToSession(name, 'session-exit'");
  const hook = src.indexOf('getPluginHooks().fireExit(name)');
  const cleanup = src.indexOf('this._cleanup(name);', exitSend);
  assert.ok(exitSend > 0 && hook > 0 && cleanup > 0, 'all three landmarks found');
  assert.ok(exitSend < hook,
    'the plugin exit hook must fire AFTER the session-exit send (the renderer still needs session → workspace → window resolution)');
  assert.ok(hook < cleanup,
    'the plugin exit hook must fire BEFORE _cleanup(name), which drops the map entry that resolution depends on');
});

test('onCreate fires at the create() tail and disposes cleanly', () => {
  const { engine } = makeHost({ manager: makeManager([sessionA]) });
  const host = engine.register('demo', { activate() {} });
  const seen = [];
  const off = host.sessions.onCreate((h) => seen.push(h.name));

  engine.hooks.fireCreate('a');
  assert.deepEqual(seen, ['a']);
  off();
  engine.hooks.fireCreate('a');
  assert.deepEqual(seen, ['a'], 'disposed subscriber no longer fires');
  assert.deepEqual(engine._hookCounts(), { create: 0, exit: 0 });
});

// ── §3.3 events — the multi-window law ─────────────────────────────────────
test('emit requires a scope and inherits core drop semantics', () => {
  const manager = makeManager([sessionA, sessionB]);
  const { engine, logged } = makeHost({ manager });
  const host = engine.register('demo', { activate() {} });

  host.events.emit('t', { n: 1 }, 'all');
  host.events.emit('t', { n: 2 }, { session: 'a' });
  host.events.emit('t', { n: 3 }, { workspace: 'ws-open' });
  // A closed workspace DROPS — only pty-data ever buffers. This is exactly why
  // the contract mandates pull-on-open instead of maintain-by-delta.
  host.events.emit('t', { n: 4 }, { workspace: 'ws-closed' });

  assert.deepEqual(manager.sent.map((s) => [s.to, s.channel, s.args[2].n]), [
    ['all', 'plugin-event', 1],
    [{ session: 'a' }, 'plugin-event', 2],
    [{ workspace: 'ws-open' }, 'plugin-event', 3],
  ], 'the closed-workspace emit was dropped, not buffered');

  // No default scope exists, because every plausible default is wrong: 'all'
  // leaks across workspaces and any guess silently drops.
  assert.equal(host.events.emit('t', {}), false, 'a scopeless emit is refused');
  assert.ok(logged.some((l) => /scope is REQUIRED/.test(l)), 'the refusal was logged');
});

// ── §3.4 dispatch map + disposability ──────────────────────────────────────
test('dispatch is namespaced, disposable, and refuses unknown methods loudly', async () => {
  const { engine } = makeHost();
  const host = engine.register('demo', { activate() {} });

  const dispose = host.ipc.handle('do.thing', (x) => ({ ok: true, got: x }));
  assert.deepEqual(engine._dispatchKeys(), ['demo:do.thing'], 'the key names its owner');
  assert.deepEqual(await engine.dispatch('demo', 'do.thing', [7]), { ok: true, got: 7 });

  // Loud, not silent: an undefined resolution is indistinguishable from a
  // successful call that returned nothing.
  assert.deepEqual(await engine.dispatch('demo', 'nope', []), { ok: false, error: NO_SUCH_METHOD });
  assert.deepEqual(await engine.dispatch('ghost', 'do.thing', []), { ok: false, error: NO_SUCH_METHOD });

  // A throwing handler becomes an envelope, never an unhandled rejection.
  host.ipc.handle('boom', () => { throw new Error('nope'); });
  assert.deepEqual(await engine.dispatch('demo', 'boom', []), { ok: false, error: 'nope' });

  dispose();
  assert.deepEqual(await engine.dispatch('demo', 'do.thing', [7]), { ok: false, error: NO_SUCH_METHOD },
    'dispose() mutates the Map — the only shape in which disposal is implementable at all');
  dispose(); // idempotent
});

test('deactivate tears down everything the host handed out, plugin cooperation or not', async () => {
  const { engine, manager } = makeHost({ manager: makeManager([sessionA]) });
  let deactivated = false;
  const host = engine.register('demo', {
    activate(h) {
      h.ipc.handle('m', () => 'x');
      h.sessions.onCreate(() => {});
      h.sessions.onExit(() => {});
    },
    // A plugin that throws on the way out must not strand host state.
    deactivate() { deactivated = true; throw new Error('bad citizen'); },
  });
  assert.equal(engine._dispatchKeys().length, 1);
  assert.deepEqual(engine._hookCounts(), { create: 1, exit: 1 });

  engine.deactivate('demo');
  assert.ok(deactivated, "the plugin's own deactivate ran first");
  assert.deepEqual(engine._dispatchKeys(), [], 'dispatch entries torn down regardless');
  assert.deepEqual(engine._hookCounts(), { create: 0, exit: 0 }, 'hooks torn down regardless');
  assert.deepEqual(engine.catalog(), []);
  // And the hooks are genuinely gone — firing must not reach the dead plugin.
  engine.hooks.fireCreate('a');
  assert.deepEqual(await engine.dispatch('demo', 'm', []), { ok: false, error: NO_SUCH_METHOD });
  void host;
});

// ── §3.1 lifecycle + §3.2 storage/settings/lib/telemetry ───────────────────
test('a hostApi mismatch refuses to load with a named error', () => {
  const { engine } = makeHost();
  assert.throws(
    () => engine.register('demo', { activate() {} }, { hostApi: '99' }),
    new RegExp(`wants hostApi "99" but this host is "${HOST_API_VERSION}"`),
    'a manifest predating the surface must not half-activate',
  );
  // THE freeze pin, and deliberately the only literal one in the suite (T6). The
  // published version is a one-way door: plugins/plugin-api.md documents "1", every
  // out-of-tree plugin writes "1" in its manifest, and a change here silently
  // refuses all of them. Changing this line is the decision, not a consequence
  // of one — see plugin-api.js on what does and does not warrant a bump.
  assert.equal(HOST_API_VERSION, '1', 'the host API is FROZEN at "1" (Phase 3)');
});

test('storage is atomic whole-file JSON under the plugin data dir', () => {
  const { engine, dir } = makeHost();
  const host = engine.register('demo', { activate() {} });
  assert.equal(host.paths.dataDir, path.join(dir, 'plugins', 'demo'));

  assert.deepEqual(host.storage.get(), {}, 'absent state reads as empty, never throws');
  host.storage.set({ branch: 'main' });
  assert.deepEqual(host.storage.get(), { branch: 'main' });
  assert.ok(fs.existsSync(path.join(host.paths.dataDir, 'state.json')));
  assert.ok(!fs.existsSync(path.join(host.paths.dataDir, 'state.json.tmp')), 'tmp file renamed away');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings shallow-merge under uiSettings.plugins[id] and never leak across plugins', () => {
  const { engine, uiSettings } = makeHost({ settings: { theme: 'dark' } });
  const a = engine.register('alpha', { activate() {} });
  const b = engine.register('beta', { activate() {} });

  a.settings.set({ x: 1 });
  a.settings.set({ y: 2 });
  b.settings.set({ x: 99 });

  assert.deepEqual(a.settings.get(), { x: 1, y: 2 }, 'patches shallow-merge');
  assert.deepEqual(b.settings.get(), { x: 99 }, 'plugins do not see each other');
  assert.equal(uiSettings().theme, 'dark', 'unrelated uiSettings keys are untouched');
});

// ── §4 host.library ─────────────────────────────────────────────────────────
test('library.remove forwards a registered kind to its handler, ref untouched', () => {
  const { engine, removals } = makeHost();
  const host = engine.register('demo', { activate() {} });
  const ref = { agent: 'clodex', id: 'mem-1-aaaaaa', extra: 'kept' };
  assert.deepEqual(host.library.remove('memory', ref), { ok: true });
  assert.equal(removals.length, 1);
  // The engine forwards, never interprets: it must not know that a memory ref
  // carries agent/id, so the handler sees exactly what the plugin passed.
  assert.deepEqual(removals[0], ref);
});

test('library.remove REFUSES an unregistered kind, distinguishably from a failed delete', () => {
  const { engine, removals } = makeHost();
  const host = engine.register('demo', { activate() {} });
  for (const kind of ['prompts', 'templates', 'exec', '', 'toString', null, 7, {}]) {
    const res = host.library.remove(kind, { agent: 'a', id: 'b' });
    assert.equal(res.ok, false, `${String(kind)} must be refused`);
    // Distinct from a handler failure — a kind that does not exist is a
    // different bug from a file that would not unlink.
    assert.match(res.error, /unknown library kind/);
  }
  assert.equal(removals.length, 0, 'no handler ran for any refused kind');
});

test('library.remove republishes the envelope rather than the handler object', () => {
  // Not sanitization — the error still passes through verbatim. What this pins
  // is that no handler-owned object crosses into plugin land, so the published
  // { ok } / { ok, error } shape is enforced rather than merely observed.
  const cached = { ok: true, internal: { fd: 7 } };
  const okHost = makeHost({ libraryKinds: { memory: () => cached } });
  const h1 = okHost.engine.register('demo', { activate() {} });
  const res = h1.library.remove('memory', {});
  assert.deepEqual(res, { ok: true }, 'extra handler fields do not cross');
  assert.notStrictEqual(res, cached, 'the handler keeps its own object');

  const failHost = makeHost({ libraryKinds: { memory: () => ({ ok: false, error: 'no unit mem-9' }) } });
  const h2 = failHost.engine.register('demo', { activate() {} });
  assert.deepEqual(h2.library.remove('memory', {}), { ok: false, error: 'no unit mem-9' });

  // An errorless failure still arrives shaped, never as { ok: false } alone.
  const bare = makeHost({ libraryKinds: { memory: () => ({ ok: false }) } });
  const h3 = bare.engine.register('demo', { activate() {} });
  assert.equal(h3.library.remove('memory', {}).ok, false);
  assert.equal(typeof h3.library.remove('memory', {}).error, 'string');
});

test('library.remove refuses an ASYNC handler instead of leaking a pending promise', async () => {
  // A promise passes `typeof res === 'object'`, so returning it verbatim would
  // hand the plugin a pending value whose rejection escapes as an unhandled
  // rejection — the process-level failure this refusal exists to prevent.
  let rejected = null;
  const { engine } = makeHost({
    libraryKinds: { memory: async () => { throw new Error('async boom'); } },
  });
  process.once('unhandledRejection', (e) => { rejected = e; });
  const host = engine.register('demo', { activate() {} });
  const res = host.library.remove('memory', { agent: 'a', id: 'b' });
  assert.equal(res.ok, false);
  assert.match(res.error, /must be synchronous/);
  assert.equal(typeof res.then, 'undefined', 'the caller never receives a thenable');
  await new Promise((r) => setImmediate(r));
  assert.equal(rejected, null, 'no unhandled rejection escaped the seam');
});

test('library.remove refuses a non-object ref, and converts a throwing handler', () => {
  const { engine } = makeHost();
  const host = engine.register('demo', { activate() {} });
  for (const ref of [null, undefined, 'mem-1', 7]) {
    const res = host.library.remove('memory', ref);
    assert.equal(res.ok, false);
    assert.match(res.error, /ref must be an object/);
  }
  // A handler that throws becomes an envelope: the plugin seam never throws.
  const thrower = makeHost({ libraryKinds: { memory: () => { throw new Error('unlink refused'); } } });
  const h2 = thrower.engine.register('demo', { activate() {} });
  assert.deepEqual(h2.library.remove('memory', { agent: 'a', id: 'b' }),
    { ok: false, error: 'unlink refused' });
});

test('the library kind table cannot be repointed from plugin land', () => {
  const ran = [];
  const table = { memory: () => { ran.push('core'); return { ok: true }; } };
  const { engine } = makeHost({ libraryKinds: table });
  const host = engine.register('evil', { activate() {} });
  assert.throws(() => { host.library.remove = () => ({ ok: true }); }, TypeError);
  assert.ok(Object.isFrozen(host.library));
  assert.deepEqual(Object.keys(host.library), ['remove'], 'one member in "1"');

  // The injected table is a live object the façade's freeze does not reach, so
  // the wrappers close over the handler captured at construction. Mutating the
  // table afterwards must not redirect the call — this is STRICTER than
  // libGitWorktree, whose wrappers re-read their leaf at call time.
  table.memory = () => { ran.push('plugin'); return { ok: true }; };
  assert.deepEqual(host.library.remove('memory', {}), { ok: true });
  assert.deepEqual(ran, ['core'], 'core still calls core: the repoint is not honoured');
});

test('lib and telemetry are frozen read-only passthroughs', () => {
  const { engine } = makeHost({ manager: makeManager([sessionA]) });
  const host = engine.register('demo', { activate() {} });
  assert.equal(host.lib.gitWorktree.list(), 'WORKTREE_LEAF');
  assert.ok(Object.isFrozen(host.lib));
  // `lib` is the SHARED-leaf lending surface, not a dumping ground: a leaf only
  // one plugin uses belongs in that plugin's directory. W5 proved the rule by
  // moving git-scm.js / fs-explorer.js out of here and into plugins/workbench/,
  // so gitWorktree — which core itself uses — is the only entry.
  assert.deepEqual(Object.keys(host.lib), ['gitWorktree'],
    'host.lib lends only leaves core also uses');
  assert.deepEqual(host.telemetry.snapshot('a'), { tok: 42 });
  assert.equal(host.telemetry.snapshot('b'), null, 'no telemetry is null, not a throw');
});

// ── t8: telemetry.snapshot hands out a DEEP COPY ────────────────────────────
// "Read-only, may be null" was a COMMENT. The poller returns its LIVE payload —
// the same object core rebroadcasts to every window — so a plugin that mutated
// or merely kept it edited core's state and every other reader's view of it.
// Read-only is now a property of the value rather than a request.
test('t8: telemetry.snapshot returns a deep copy — a plugin cannot edit core\'s live payload', () => {
  const live = { tok: 1234, nested: { model: 'opus', calls: [1, 2] } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-plugin-test-'));
  let ui = {};
  const engine = createPluginHostEngine({
    manager: makeManager(),
    getUiSettings: () => ({ get: () => ui, set: (patch) => { ui = { ...ui, ...patch }; } }),
    log: { info: () => {}, error: () => {} },
    userDataPath: dir,
    fs, path,
    gitWorktree: {},
    telemetrySnapshot: (name) => (name === 'a' ? live : null),
    getLoader: () => null,
  });
  const host = engine.register('demo', { activate() {} });

  const snap = host.telemetry.snapshot('a');
  assert.deepEqual(snap, live, 'the VALUE is the same — this is a copy, not a redaction');
  assert.notStrictEqual(snap, live, 'but not the same object');
  assert.notStrictEqual(snap.nested, live.nested, 'DEEP — a shallow copy still shares the interior');

  snap.tok = 0;
  snap.nested.model = 'MINE';
  snap.nested.calls.push(99);
  assert.deepEqual(live, { tok: 1234, nested: { model: 'opus', calls: [1, 2] } },
    'core\'s live payload is untouched at every level');

  // Two reads are independent of each other too, not one shared copy.
  assert.notStrictEqual(host.telemetry.snapshot('a'), host.telemetry.snapshot('a'));
  // The documented normal case is unchanged, and the API still never throws.
  assert.strictEqual(host.telemetry.snapshot('b'), null, 'no telemetry is null, not a throw');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── t8 F2: host.lib is a bound façade, not the live module ──────────────────
// The freeze above covers the WRAPPER. Before F2 the value inside it was the
// git-worktree module object itself — the very object core holds under the same
// require-cache entry (ipc-handlers.js:35) — so a plugin assigning a member
// repointed CORE's worktree:remove / session-delete / New-Session calls at the
// plugin's function, and it survived deactivate. This test uses the REAL module
// as the injected leaf, because the whole claim is about identity with what core
// requires; a stub object would prove nothing.
test('t8 F2: a plugin cannot repoint a host.lib leaf that core itself calls', () => {
  const realLeaf = require('../git-worktree');
  const before = realLeaf.removeWorktree;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-plugin-test-'));
  let ui = {};
  const engine = createPluginHostEngine({
    manager: makeManager(),
    getUiSettings: () => ({ get: () => ui, set: (patch) => { ui = { ...ui, ...patch }; } }),
    log: { info: () => {}, error: () => {} },
    userDataPath: dir,
    fs, path,
    gitWorktree: realLeaf,     // exactly what engine.js injects
    telemetrySnapshot: () => null,
    getLoader: () => null,
  });
  const host = engine.register('evil', { activate() {} });

  // The façade is frozen, so the assignment is a silent no-op in sloppy mode and
  // a throw in strict (this file is strict) — either way it must not land.
  assert.throws(() => { host.lib.gitWorktree.removeWorktree = () => 'INTERCEPTED'; },
    TypeError, 'the leaf façade itself is frozen, not just the lib wrapper');
  assert.strictEqual(realLeaf.removeWorktree, before,
    'core still calls core: the module object is untouched');
  assert.notStrictEqual(host.lib.gitWorktree, realLeaf,
    'the plugin never holds the module object — only bound wrappers');
  // …and the wrappers still WORK: every function export is present and delegates.
  for (const k of Object.keys(realLeaf)) {
    if (typeof realLeaf[k] !== 'function') continue;
    assert.strictEqual(typeof host.lib.gitWorktree[k], 'function', `${k} is lent`);
    assert.notStrictEqual(host.lib.gitWorktree[k], realLeaf[k], `${k} is bound, not the raw fn`);
  }
  // The lent SET is pinned by name. Deriving the façade from the leaf's own keys
  // is what keeps a frozen "1" surface from being silently NARROWED — but the
  // same derivation would silently WIDEN it the day someone adds an unrelated
  // export to git-worktree.js, with no diff anywhere saying plugins can now
  // reach it. So adding an export is a deliberate act with a visible failure
  // here, and this list must be updated in company with plugins/plugin-api.md §4.
  assert.deepStrictEqual(Object.keys(host.lib.gitWorktree).sort(), [
    'createWorktree', 'defaultBranch', 'defaultWorktreePath', 'listWorktrees',
    'removeWorktree', 'repoInfo', 'repoToplevel',
  ], 'host.lib.gitWorktree lends exactly these seven — widening it is a published API change');

  let delegated = null;
  const origList = realLeaf.listWorktrees;
  realLeaf.listWorktrees = (...a) => { delegated = a; return 'OK'; };
  try {
    assert.strictEqual(host.lib.gitWorktree.listWorktrees('/repo'), 'OK', 'the wrapper delegates');
    assert.deepStrictEqual(delegated, ['/repo'], 'args pass through unchanged');
  } finally { realLeaf.listWorktrees = origList; }
});

test('the host deliberately exposes no stores, manager, or transport seams', () => {
  const { engine } = makeHost();
  const host = engine.register('demo', { activate() {} });
  // Every one of these is a NAMED future decision (plan §5), not a default.
  for (const forbidden of ['manager', 'stores', 'persistence', 'pty', 'fs',
    'getRemoteServer', 'getPeerManager', 'spawn']) {
    assert.equal(host[forbidden], undefined, `host must not expose ${forbidden}`);
  }
  // The whole surface, pinned: a new key is a one-way door (§2 — the taxonomy),
  // so it should cost a deliberate edit here.
  assert.deepEqual(Object.keys(host).sort(), [
    'events', 'hostApiVersion', 'id', 'intents', 'ipc', 'lib', 'library', 'log',
    'paths', 'sessions', 'settings', 'storage', 'telemetry',
  ].sort());
});

test('an invalid id or a double registration is refused', () => {
  const { engine } = makeHost();
  engine.register('demo', { activate() {} });
  assert.throws(() => engine.register('demo', { activate() {} }), /already registered/);
  for (const bad of ['', 'Demo', '_host', 'a b', '-lead', 'trail-']) {
    assert.throws(() => engine.register(bad, { activate() {} }), /invalid plugin id/, `${bad} must be refused`);
  }
});

// t8 F4's second door. The loader refuses such a manifest at discovery, but the
// invariant belongs at BOTH doors — register() is reachable by the in-tests fake
// and by any future non-loader caller, and an invariant enforced at one door only
// is the same defect class as a comment enforcing nothing.
test('t8 F4: register() refuses the RESERVED id `enabled`, saying reserved rather than invalid', () => {
  const { engine } = makeHost();
  assert.throws(() => engine.register('enabled', { activate() {} }), /reserved/,
    'a plugin named `enabled` would write its settings over the user\'s enabled ARRAY');
  // Not "invalid": the id satisfies PLUGIN_ID_RE, and telling an author it is
  // malformed sends them looking for a typo that isn't there.
  assert.throws(() => engine.register('enabled', { activate() {} }),
    (e) => !/invalid plugin id/.test(e.message));
  // Nothing survives the refusal — no ledger row, no half-registration.
  assert.deepEqual(engine._dispatchKeys(), []);
});

test('a failing activate is rolled back, not left half-registered', async () => {
  const { engine } = makeHost();
  assert.throws(() => engine.register('demo', {
    activate(h) { h.ipc.handle('m', () => 1); throw new Error('activate blew up'); },
  }), /activate blew up/);
  assert.deepEqual(engine._dispatchKeys(), [], 'partial registrations are torn down');
  assert.deepEqual(engine.catalog(), []);
  // The id is free again — a rolled-back registration must not poison it.
  assert.doesNotThrow(() => engine.register('demo', { activate() {} }));
});

// --- host.intents (§2.3, rules P1/P5) ---------------------------------------

const intentRegistry = require('../intent-registry');
const { parseIntent } = require('../intent-scanner');

test('host.intents.register makes a verb parse, and disposal removes it', () => {
  try {
    const { engine } = makeHost();
    let undo;
    engine.register('demo', {
      activate(h) {
        undo = h.intents.register({
          verb: 'branch',
          parse: (l) => (l === '[agent:branch]' ? { type: 'branch' } : null),
        });
      },
    });
    assert.equal(parseIntent('[agent:branch]').type, 'branch');
    assert.equal(intentRegistry.rowFor('branch').source, 'demo', 'the row names its owner');
    undo();
    assert.equal(parseIntent('[agent:branch]'), null);
  } finally { intentRegistry._resetPluginRows(); }
});

test('P1 — the host cannot register a NON-privileged verb, whatever it asks for', () => {
  try {
    const { engine } = makeHost();
    engine.register('demo', {
      activate(h) { h.intents.register({ verb: 'branch', parse: () => null, privileged: false }); },
    });
    assert.equal(intentRegistry.rowFor('branch').privileged, true);
    // ...which is what makes an absent allowlist a refusal rather than a grant.
    assert.equal(intentRegistry.intentEnabledFor('branch', null), false);
  } finally { intentRegistry._resetPluginRows(); }
});

test('P5 — a colliding verb throws out of activate, and rolls the plugin back', () => {
  try {
    const { engine } = makeHost();
    assert.throws(() => engine.register('demo', {
      activate(h) { h.intents.register({ verb: 'dm', parse: () => null }); },
    }), /reserved by core/);
    assert.deepEqual(engine.catalog(), [], 'a refused verb leaves no half-registered plugin');
    assert.equal(parseIntent('[agent:dm bob] hi').type, 'dm', 'and core dm is untouched');
  } finally { intentRegistry._resetPluginRows(); }
});

test('deactivate drops the plugin\'s intent rows even if the disposer was dropped', () => {
  try {
    const { engine } = makeHost();
    engine.register('demo', {
      // Note: the returned disposer is deliberately discarded here — the ledger
      // is meant to cover exactly this, and intent rows live in a MODULE-level
      // table, so a leak would outlive the plugin process-wide.
      activate(h) { h.intents.register({ verb: 'branch', parse: (l) => (l === '[agent:branch]' ? {} : null) }); },
    });
    assert.equal(parseIntent('[agent:branch]').type, 'branch');
    engine.deactivate('demo');
    assert.equal(parseIntent('[agent:branch]'), null, 'the row went with the plugin');
    assert.equal(intentRegistry.rowFor('branch'), null);
  } finally { intentRegistry._resetPluginRows(); }
});

test('two plugins get independent verbs, and one deactivation leaves the other', () => {
  try {
    const { engine } = makeHost();
    engine.register('one', { activate(h) { h.intents.register({ verb: 'aaa', parse: (l) => (l === '[agent:aaa]' ? {} : null) }); } });
    engine.register('two', { activate(h) { h.intents.register({ verb: 'bbb', parse: (l) => (l === '[agent:bbb]' ? {} : null) }); } });
    engine.deactivate('one');
    assert.equal(parseIntent('[agent:aaa]'), null);
    assert.equal(parseIntent('[agent:bbb]').type, 'bbb');
  } finally { intentRegistry._resetPluginRows(); }
});

test('hooks.handleFor mints the same SessionHandle the hooks get (one owner)', () => {
  const { engine, manager } = makeHost();
  manager.sessions.set('a', { name: 'a', type: 'claude', cwd: '/tmp/a', workspaceId: 'ws1' });
  const h = engine.hooks.handleFor('a');
  assert.deepEqual(Object.keys(h).sort(), ['cwd', 'inject', 'isAlive', 'name', 'type', 'workspaceId']);
  assert.equal(h.name, 'a');
  assert.equal(engine.hooks.handleFor('nope'), null);
});

// ── The fail-safe surface + the W7 cross-window state hint ──────────────────

// A stand-in for the loader with exactly the methods the host reaches through.
// A fake with only these proves the host isn't quietly using more of the loader
// than its three named seams.
function fakeLoader(over = {}) {
  const calls = [];
  return {
    calls,
    status: () => ({ plugins: [{ id: 'demo', name: 'Demo', enabled: true, quarantined: true, failCount: 2, lastError: 'kaboom' }], problems: [] }),
    noteRendererActivation: (id, ok, error) => { calls.push({ id, ok, error }); return { counted: true, ok }; },
    setEnabledInSettings: (id, on) => calls.push({ setEnabled: id, on }),
    activateById: () => ({ ok: true }),
    rendererInfo: () => null,
    ...over,
  };
}

test('_host plugins.status serves the settings section every plugin ON DISK', async () => {
  const loader = fakeLoader();
  const { engine } = makeHost({ loader });
  const r = await engine.dispatch('_host', 'plugins.status', []);
  assert.equal(r.ok, true);
  // Quarantined AND enabled at once — the shadow, not a replacement. `catalog()`
  // could never show this row: nothing registered.
  assert.deepEqual(r.plugins[0], { id: 'demo', name: 'Demo', enabled: true, quarantined: true, failCount: 2, lastError: 'kaboom' });
  assert.deepEqual(engine.catalog(), [], 'and the catalog is empty, which is exactly why status exists');
});

test('_host plugins.status degrades to empty with no loader (CLODEX_PLUGINS=0 shape)', async () => {
  const { engine } = makeHost();
  assert.deepEqual(await engine.dispatch('_host', 'plugins.status', []), { ok: true, plugins: [], problems: [] });
});

test('_host renderer.report forwards a window\'s outcome to the loader', async () => {
  const loader = fakeLoader();
  const { engine } = makeHost({ loader });
  await engine.dispatch('_host', 'renderer.report', ['demo', false, 'kaboom']);
  await engine.dispatch('_host', 'renderer.report', ['demo', true]);
  assert.deepEqual(loader.calls, [
    { id: 'demo', ok: false, error: 'kaboom' },
    { id: 'demo', ok: true, error: undefined },
  ]);
});

test('setEnabled BROADCASTS plugin-state so every window tears its own half down', () => {
  // W7: "disable removes button, overlay, styles and dispatch entries in EVERY
  // window". The engine half's teardown is per-app-run; a renderer half is
  // per-BrowserWindow and only the window holding it can dispose it — so the
  // engine sends a hint and each window acts. 'all' is right precisely because
  // the payload carries no data (§3.3 law 2: unbuffered invalidation hints).
  const { engine, manager } = makeHost({ loader: fakeLoader() });
  engine.register('demo', { activate() {} });
  manager.sent.length = 0;
  engine.setEnabled('demo', false);
  const hint = manager.sent.find((s) => s.channel === 'plugin-event');
  assert.ok(hint, 'a plugin-state hint went out');
  assert.equal(hint.to, 'all');
  assert.deepEqual(hint.args, ['_host', 'plugin-state', { id: 'demo', enabled: false }]);
});

test('the enable path broadcasts too, and an ALREADY-enabled plugin still hints', () => {
  // A window that missed the first hint (opened later, or whose activation
  // failed) must be able to catch up; re-announcing on a no-op enable is the
  // cheap way to give it that, and re-activation is idempotent per window.
  const { engine, manager } = makeHost({ loader: fakeLoader() });
  engine.register('demo', { activate() {} });
  manager.sent.length = 0;
  const r = engine.setEnabled('demo', true);
  assert.equal(r.already, true);
  const hint = manager.sent.find((s) => s.channel === 'plugin-event');
  assert.deepEqual(hint.args, ['_host', 'plugin-state', { id: 'demo', enabled: true }]);
});

// ── _host plugins.rescan / plugins.userRoot (t22) ──────────────────────────
// Both ride the `_host` pseudo-id rather than becoming new `plugin:*` rows.
// api-contract.js:270 freezes that transport at five rows "for every plugin,
// forever", and a re-scan is host plumbing, not any plugin's method — the same
// reasoning that already put plugins.status / renderer.info / renderer.report
// here. test/api-contract.test.js pins the five-row count from the other side.

test('_host plugins.rescan announces ADDED and REMOVED to every window', async () => {
  // A newly loaded plugin's RENDERER half is per-BrowserWindow, and only the
  // window holding it can activate it — so the engine reuses the same
  // `plugin-state` hint enable/disable already broadcasts rather than inventing
  // a second path that could drift from it.
  const manager = makeManager();
  const loader = fakeLoader({
    rescan: () => ({ added: ['fresh'], removed: ['stale'], changed: [], failed: [] }),
  });
  const { engine } = makeHost({ manager, loader });

  const r = await engine.dispatch('_host', 'plugins.rescan', []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.added, ['fresh']);

  const states = manager.sent
    .filter((s) => s.channel === 'plugin-event' && s.args[1] === 'plugin-state')
    .map((s) => s.args[2]);
  assert.deepEqual(states, [{ id: 'fresh', enabled: true }, { id: 'stale', enabled: false }]);
  assert.ok(manager.sent.every((s) => s.to === 'all'), 'every window, not just the caller');
});

test('_host plugins.rescan does NOT announce a CHANGED plugin', async () => {
  // The honest-feature rule. Nothing about a changed plugin moved in this
  // process — require handed back the cached module — so telling windows to
  // re-activate would re-run the OLD renderer half for a version the user
  // believes they just installed. The row says restart required instead.
  const manager = makeManager();
  const loader = fakeLoader({
    rescan: () => ({ added: [], removed: [], changed: ['gamma'], failed: [] }),
  });
  const { engine } = makeHost({ manager, loader });

  const r = await engine.dispatch('_host', 'plugins.rescan', []);
  assert.deepEqual(r.changed, ['gamma']);
  assert.deepEqual(manager.sent.filter((s) => s.channel === 'plugin-event'), [],
    'a changed plugin produces no state hint at all');
});

test('_host plugins.rescan degrades shaped with no loader', async () => {
  const { engine } = makeHost();
  const r = await engine.dispatch('_host', 'plugins.rescan', []);
  assert.equal(r.ok, false, 'a shaped refusal, never an undefined resolution');
});

test('_host plugins.userRoot serves the path rather than letting the renderer rebuild it', async () => {
  // The renderer has no business knowing the user root is ~/.clodex/plugins:
  // the roots are configured at the engine bootstrap, and a consumer
  // reconstructing a producer's fact is the defect shape this project keeps
  // hitting. Serving it also means the directory is created by the code that
  // owns it.
  const loader = fakeLoader({ ensureUserRoot: () => '/home/u/.clodex/plugins' });
  const { engine } = makeHost({ loader });
  assert.deepEqual(await engine.dispatch('_host', 'plugins.userRoot', []),
    { ok: true, dir: '/home/u/.clodex/plugins' });
});

test('_host plugins.userRoot refuses when no user root is configured', async () => {
  // The legacy single-root form: answering with a path would point the reveal
  // button at the read-only asar, which is worse than having no button.
  const loader = fakeLoader({ ensureUserRoot: () => null });
  const { engine } = makeHost({ loader });
  const r = await engine.dispatch('_host', 'plugins.userRoot', []);
  assert.equal(r.ok, false);
});

// ── _host plugins.listUserRoot (t28) ───────────────────────────────────────
// The browser frontend cannot reveal a folder in the HOST's file manager — and
// a reveal there would be wrong rather than merely unsupported, since it would
// open the viewer machine's folder. This row answers the same question over the
// wire instead. Its whole safety property is that it is argument-free.

test('_host plugins.listUserRoot serves the host path and its entries', async () => {
  const loader = fakeLoader({
    listUserRoot: () => ({ dir: '/home/u/.clodex/plugins', entries: [{ name: 'demo', isDir: true }] }),
  });
  const { engine } = makeHost({ loader });
  assert.deepEqual(await engine.dispatch('_host', 'plugins.listUserRoot', []),
    { ok: true, dir: '/home/u/.clodex/plugins', entries: [{ name: 'demo', isDir: true }] });
});

test('_host plugins.listUserRoot takes NO path from the caller', async () => {
  // The bound that keeps this a plugin-folder listing rather than a remote file
  // browser. A caller handing over a path must not be able to steer the read:
  // arguments dispatch through to the loader row, and the loader row takes none.
  const seen = [];
  const loader = fakeLoader({
    listUserRoot: (...args) => { seen.push(args); return { dir: '/home/u/.clodex/plugins', entries: [] }; },
  });
  const { engine } = makeHost({ loader });
  const r = await engine.dispatch('_host', 'plugins.listUserRoot', ['/etc', '..', { dir: '/' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [[]], 'the loader is called with no arguments at all');
  assert.equal(r.dir, '/home/u/.clodex/plugins', 'the answer is the configured root, not the requested path');
});

test('_host plugins.listUserRoot reports the path even when the read fails', async () => {
  // "Here is where plugins go, and I could not read it" is a usable diagnostic;
  // a bare failure leaves the user with nowhere to put anything.
  const loader = fakeLoader({
    listUserRoot: () => ({ dir: '/home/u/.clodex/plugins', entries: null, error: 'EACCES' }),
  });
  const { engine } = makeHost({ loader });
  const r = await engine.dispatch('_host', 'plugins.listUserRoot', []);
  assert.equal(r.ok, true);
  assert.equal(r.dir, '/home/u/.clodex/plugins');
  assert.equal(r.entries, null, 'null entries, distinct from an empty directory');
});

test('_host plugins.listUserRoot refuses when no user root is configured', async () => {
  const loader = fakeLoader({ listUserRoot: () => null });
  const { engine } = makeHost({ loader });
  assert.equal((await engine.dispatch('_host', 'plugins.listUserRoot', [])).ok, false);
});
