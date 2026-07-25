'use strict';
// plugin-host-engine.test.js — the engine-half host contract (docs/plugin-plan.md
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

function makeHost({ manager = makeManager(), settings = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-plugin-test-'));
  let ui = { ...settings };
  const logged = [];
  const engine = createPluginHostEngine({
    manager,
    getUiSettings: () => ({ get: () => ui, set: (patch) => { ui = { ...ui, ...patch }; } }),
    log: { info: (scope, msg) => logged.push(`${scope} ${msg}`) },
    userDataPath: dir,
    fs, path,
    gitWorktree: { list: () => 'WORKTREE_LEAF' },
    // TEMPORARY (W2→W4): the workbench's own leaves, exposed on host.lib only
    // until W5 moves both files into plugins/workbench/. Deleted with them.
    gitScm: { status: () => 'SCM_LEAF' },
    fsExplorer: { listDir: () => 'FS_LEAF' },
    telemetrySnapshot: (name) => (name === 'a' ? { tok: 42 } : null),
  });
  return { engine, manager, dir, logged, uiSettings: () => ui };
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
    /wants hostApi "99" but this host is "0"/,
    'a manifest predating the surface must not half-activate',
  );
  assert.equal(HOST_API_VERSION, '0', 'the host API is explicitly unstable until Phase 3');
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

test('lib and telemetry are frozen read-only passthroughs', () => {
  const { engine } = makeHost({ manager: makeManager([sessionA]) });
  const host = engine.register('demo', { activate() {} });
  assert.equal(host.lib.gitWorktree.list(), 'WORKTREE_LEAF');
  assert.ok(Object.isFrozen(host.lib));
  // The two W2→W4 temporaries. This assertion is DELETED IN W5 together with
  // the entries themselves — they exist only so the workbench's DOM move lands
  // as a commit separate from its file move.
  assert.equal(host.lib.gitScm.status(), 'SCM_LEAF');
  assert.equal(host.lib.fsExplorer.listDir(), 'FS_LEAF');
  assert.deepEqual(host.telemetry.snapshot('a'), { tok: 42 });
  assert.equal(host.telemetry.snapshot('b'), null, 'no telemetry is null, not a throw');
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
    'events', 'hostApiVersion', 'id', 'intents', 'ipc', 'lib', 'log',
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
