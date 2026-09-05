'use strict';
// plugin-fake.test.js — the Phase-1 END-TO-END gate (plugin-plan.md [internal design doc, not in this repo] §6,
// Phase 1d). Every other plugin test drives ONE seam in isolation; this file
// drives a whole plugin, through the real lifecycle, across both halves.
//
// WHY A FAKE PLUGIN RATHER THAN A REAL DIRECTORY:
// The fake lives in this file — a plain module object with activate()/
// deactivate(), handed to `engine.register` / `host.activate` — and NOT as a
// directory under plugins/. Three reasons, all load-bearing:
//   1. Phase 1 ships NO LOADER. A directory would need one to be reached, and
//      writing one here is Phase 2's scope.
//   2. plugins/* is walked by test/electron-boundary.test.js and
//      test/plugin-boundary.test.js. A permanent fake there becomes a permanent
//      lint subject whose failures would be about the fake, not about core.
//   3. `node --test` (no dir arg — the package script) treats EVERY .js under
//      test/ as a suite, test/fixtures/ included. Verified by probe: a fixture
//      module gets executed and counted. So a shared helper file is not
//      available to us either, which is why the DOM stub below is a trimmed
//      copy of plugin-host.test.js's rather than an extraction.
//
// WHAT THIS FILE IS FOR, beyond coverage: it is the only place where the two
// halves are exercised as one plugin, so it is where a seam that works in
// isolation but not in composition shows up — an id namespaced by one half and
// not the other, a teardown that frees the renderer but leaks the engine's
// dispatch key, an intent verb that parses but never reaches a handler.
//
// SHARED STATE WARNING: intent rows live in a MODULE-LEVEL table (that is what
// makes a plugin verb live on all three feeds by construction), so every test
// that registers one resets it in a finally. See the note on withReset().

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPluginHostEngine } = require('../plugin-host-engine');
const { HOST_API_VERSION, HOST_PSEUDO_ID, NO_SUCH_METHOD, pluginsEnabled } = require('../plugin-api');
const intentRegistry = require('../intent-registry');
const { mkTmpRoot } = require('./lib/tmp-roots');

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — the ENGINE half
// ════════════════════════════════════════════════════════════════════════════

// A manager fake with exactly the seven members the host facade touches. Kept
// deliberately dumb: this section is testing the HOST, and a real
// SessionManager here would put its own list()/persistence behavior in the way.
// (Part 3 wires the REAL manager, where that is the point.)
function makeManager(sessions = []) {
  const map = new Map();
  for (const s of sessions) map.set(s.name, s);
  const sent = [];
  const injected = [];
  return {
    sessions: map,
    sent,
    injected,
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

const seatA = { name: 'seat-a', type: 'claude', cwd: '/repo/a', workspaceId: 'ws-open' };
const seatB = { name: 'seat-b', type: 'bash', cwd: '/repo/b', workspaceId: 'ws-closed' };

function makeEngine({ manager = makeManager([seatA, seatB]), settings = {} } = {}) {
  const dir = mkTmpRoot('clodex-fake-plugin-');
  let ui = { ...settings };
  const logged = [];
  const engine = createPluginHostEngine({
    manager,
    getUiSettings: () => ({ get: () => ui, set: (patch) => { ui = { ...ui, ...patch }; } }),
    log: { info: (scope, msg) => logged.push(`${scope} ${msg}`), error: (scope, msg) => logged.push(`${scope} ${msg}`) },
    userDataPath: dir,
    fs,
    path,
    gitWorktree: { list: () => ['wt-1'] },
    telemetrySnapshot: (name) => (name === 'seat-a' ? { tok: 1234 } : null),
    // The turn-text feed reads grants off persistence at DELIVERY time. seat-a
    // holds the `turns` grant so the feed has a live path here; seat-b holds
    // none, which is what makes the gate visible rather than assumed.
    getPersistence: () => ({
      get: (name) => (name === 'seat-a' ? { name, pluginGrants: ['fake:turns'] } : { name }),
    }),
  });
  return { engine, manager, dir, logged, uiSettings: () => ui };
}

// The registry is process-wide. Any test that lets the fake plugin register its
// verb MUST put the table back, including on the failure path — otherwise a
// leaked row changes what every LATER test in this file parses.
//
// NOTE the promise handling, and note that a plain try/finally here is WRONG in
// a way that looks right: it runs the reset the moment an async fn returns its
// promise — i.e. at fn's FIRST await, with the whole test body still to come —
// so every registry read after that point sees an empty table. This is the
// second time that shape has cost a debugging round (see session-manager.test.js's
// withVerb); it is written out longhand both times rather than abbreviated.
function withReset(fn) {
  const reset = () => intentRegistry._resetPluginRows();
  let out;
  try { out = fn(); } catch (e) { reset(); throw e; }
  if (out && typeof out.then === 'function') return out.then((v) => { reset(); return v; }, (e) => { reset(); throw e; });
  reset();
  return out;
}

// ── The fake plugin, engine half ───────────────────────────────────────────
// One module object touching EVERY §3.2 extension point. `record` is what the
// tests read; the plugin itself is written the way a real one would be, so a
// future reviewer can use it as the worked example the plan's §3.2 describes in
// prose.
function makeEnginePlugin() {
  const record = {
    activated: 0,
    deactivated: 0,
    host: null,
    created: [],
    exited: [],
    intents: [],
    text: [],
    disposers: [],
  };
  const mod = {
    activate(host) {
      record.activated++;
      record.host = host;

      // §3.4 — one multiplexed channel, an engine-owned dispatch entry.
      record.disposers.push(host.ipc.handle('ping', (n) => ({ ok: true, pong: n })));
      record.disposers.push(host.ipc.handle('boom', () => { throw new Error('handler exploded'); }));
      record.disposers.push(host.ipc.handle('slow', async () => ({ ok: true, async: true })));

      // §3.2 — session lifecycle hooks. Both SYNC by contract.
      record.disposers.push(host.sessions.onCreate((h) => { record.created.push(h ? h.name : null); }));
      record.disposers.push(host.sessions.onExit((h) => {
        // The handle is already dead here; a plugin reads it, it does not act on it.
        record.exited.push({ name: h ? h.name : null, alive: h ? h.isAlive() : null });
      }));

      // §2.2 — the turn-text feed. DEFERRED, unlike the two hooks above, and
      // gated on the session's `turns` grant: this subscriber hears seat-a and
      // never seat-b, whatever the plugin does here.
      record.disposers.push(host.sessions.onAgentText((ev) => {
        record.text.push({ session: ev.session, source: ev.source, len: ev.text.length });
      }));

      // §2.3 — an intent verb. Registered as a PLUGIN row, so the host forces
      // it privileged whatever this spec claims (see the P1 test).
      record.disposers.push(host.intents.register({
        verb: 'fake-note',
        privileged: false,               // a lie; the host must ignore it
        label: 'Fake note (test plugin)',
        promptLines: '  [agent:fake-note] text     Record a note (fake plugin)',
        parse: (line) => {
          const m = line.match(/^\[agent:fake-note\]\s*(.*)$/s);
          return m ? { type: 'fake-note', body: m[1] } : null;
        },
        bodyMode: () => 'greedy',
        handler: (handle, intent) => {
          record.intents.push({ name: handle.name, body: intent.body });
          handle.inject(`[agent:fake-note] recorded ${intent.body.length} chars`);
        },
      }));

      // Storage / settings / lib / telemetry are read-write surfaces, not
      // registrations — nothing to dispose, exercised directly in the tests.
      host.storage.set({ notes: 1 });
    },
    deactivate() { record.deactivated++; },
  };
  return { mod, record };
}

test('fake plugin: activation reaches every engine extension point exactly once', () => {
  withReset(() => {
    const { engine } = makeEngine();
    const { mod, record } = makeEnginePlugin();

    const host = engine.register('fake', mod, { name: 'Fake', version: '0.0.1' });

    assert.strictEqual(record.activated, 1, 'activate ran');
    assert.strictEqual(record.host, host, 'the host handed to activate IS the one register returns');
    assert.strictEqual(host.id, 'fake');
    assert.strictEqual(host.hostApiVersion, HOST_API_VERSION);
    // Three dispatch entries, both hooks, one intent row — all namespaced/owned.
    assert.deepStrictEqual(engine._dispatchKeys().sort(), ['fake:boom', 'fake:ping', 'fake:slow']);
    assert.deepStrictEqual(engine._hookCounts(), { create: 1, exit: 1, text: 1 });
    assert.strictEqual(intentRegistry.pluginRowFor('fake-note').source, 'fake');
    // `scope` is part of the catalog row because the renderer must know which
    // plugins are session-scoped BEFORE it activates any of them. A manifest that
    // declares none resolves to 'global'. `enabledByDefault` rides the same row
    // and defaults TRUE for a manifest that omits it, matching the loader's
    // isEnabled — a row that reported false here would show the operator a
    // default the loader does not apply. `shipped` is FALSE for the opposite
    // reason: it comes from register's opts, which only the loader fills, so a
    // direct register is custom and cannot widen its own reach. `skills` and
    // `agents` (t672) are the plugin's OWN bundle, read off disk by the loader
    // and passed through register's opts — so a direct register, which has no
    // directory behind it, reports both empty.
    assert.deepStrictEqual(engine.catalog(), [
      {
        id: 'fake', name: 'Fake', version: '0.0.1', enabled: true, announce: null,
        scope: 'global', shipped: false, enabledByDefault: true,
        skills: [], agents: [],
      },
    ]);
  });
});

test('fake plugin: ipc.handle round-trips through dispatch, incl. async and throwing handlers', async () => {
  await withReset(async () => {
    const { engine } = makeEngine();
    const { mod } = makeEnginePlugin();
    engine.register('fake', mod);

    assert.deepStrictEqual(await engine.dispatch('fake', 'ping', [7], 'desktop'), { ok: true, pong: 7 });
    // A promise-returning handler is awaited by dispatch — unlike the session
    // hooks and the intent tail, which are sync-only because they sit inside PTY
    // teardown / turn handling. An IPC call has a caller waiting on a reply, so
    // async is legal HERE and nowhere else in the host.
    assert.deepStrictEqual(await engine.dispatch('fake', 'slow', [], 'desktop'), { ok: true, async: true });
    // A throwing handler becomes a shaped refusal, never a rejected invoke: the
    // renderer half must always get something it can render.
    assert.deepStrictEqual(await engine.dispatch('fake', 'boom', [], 'desktop'), { ok: false, error: 'handler exploded' });
    // Unknown method / unknown plugin degrade the same way.
    assert.deepStrictEqual(await engine.dispatch('fake', 'nope', [], 'desktop'), { ok: false, error: NO_SUCH_METHOD });
    assert.deepStrictEqual(await engine.dispatch('ghost', 'ping', [], 'desktop'), { ok: false, error: NO_SUCH_METHOD });
  });
});

test('fake plugin: events.emit reaches all three scopes, and an omitted scope is a logged drop', () => {
  withReset(() => {
    const { engine, manager, logged } = makeEngine();
    const { mod, record } = makeEnginePlugin();
    engine.register('fake', mod);
    const host = record.host;

    // 'all' — a broadcast. Invalidation hint only; the payload is deliberately
    // a bare marker, because a broadcast crosses workspaces (§3.3 law 2).
    assert.strictEqual(host.events.emit('changed', null, 'all'), true);
    // { session } — the window owning that session.
    assert.strictEqual(host.events.emit('changed', { n: 1 }, { session: 'seat-a' }), true);
    // { workspace } — an open window gets it…
    assert.strictEqual(host.events.emit('changed', { n: 2 }, { workspace: 'ws-open' }), true);
    // …and a CLOSED one drops it. That drop is the contract, not a bug: state is
    // pull-on-open, so there is nothing to buffer.
    assert.strictEqual(host.events.emit('changed', { n: 3 }, { workspace: 'ws-closed' }), true);

    assert.deepStrictEqual(manager.sent, [
      { to: 'all', channel: 'plugin-event', args: ['fake', 'changed', null] },
      { to: { session: 'seat-a' }, channel: 'plugin-event', args: ['fake', 'changed', { n: 1 }] },
      { to: { workspace: 'ws-open' }, channel: 'plugin-event', args: ['fake', 'changed', { n: 2 }] },
    ], 'the ws-closed emit produced NO send at all');

    // No scope: refused and logged, never a silent broadcast.
    assert.strictEqual(host.events.emit('changed', { n: 4 }), false);
    assert.strictEqual(manager.sent.length, 3, 'still three — the scopeless emit sent nothing');
    assert.ok(logged.some((l) => l.includes("events.emit('changed') dropped")), 'and it said so');
  });
});

test('fake plugin: the sessions facade answers global, scoped, single and fs-scope questions', () => {
  withReset(() => {
    const manager = makeManager([
      seatA,
      seatB,
      { name: 'peered', type: 'claude', peer: 'box', cwd: '/remote', workspaceId: 'ws-open' },
    ]);
    const { engine } = makeEngine({ manager });
    const { mod, record } = makeEnginePlugin();
    engine.register('fake', mod);
    const host = record.host;

    assert.deepStrictEqual(host.sessions.listAll().map((s) => s.name), ['seat-a', 'seat-b', 'peered']);
    assert.deepStrictEqual(host.sessions.listWorkspace('ws-open').map((s) => s.name), ['seat-a', 'peered']);
    assert.strictEqual(host.sessions.list, undefined, 'no unqualified accessor, ever');

    const h = host.sessions.get('seat-a');
    assert.deepStrictEqual(Object.keys(h).sort(), ['cwd', 'inject', 'isAlive', 'name', 'type', 'workspaceId']);
    assert.strictEqual(host.sessions.get('ghost'), null);

    h.inject('hello');
    assert.deepStrictEqual(manager.injected, [{ name: 'seat-a', text: 'hello', opts: { parkable: true } }]);

    assert.deepStrictEqual(host.sessions.fsScope('seat-a'), { cwd: '/repo/a' });
    assert.deepStrictEqual(host.sessions.fsScope('peered'), { error: 'remote' });
    assert.deepStrictEqual(host.sessions.fsScope('ghost'), { error: 'Session not found' });
  });
});

test('fake plugin: onCreate/onExit fire through the hooks core calls, with a dead handle on exit', () => {
  withReset(() => {
    const manager = makeManager([seatA]);
    const { engine } = makeEngine({ manager });
    const { mod, record } = makeEnginePlugin();
    engine.register('fake', mod);

    engine.hooks.fireCreate('seat-a');
    assert.deepStrictEqual(record.created, ['seat-a']);

    // What core does before calling fireExit, in order (session-manager.js's
    // onExit landmine): mark dead, send session-exit, THEN the hook, THEN
    // _cleanup. So at hook time the session is still in the map but _dead.
    manager.sessions.get('seat-a')._dead = true;
    engine.hooks.fireExit('seat-a');
    assert.deepStrictEqual(record.exited, [{ name: 'seat-a', alive: false }],
      'the handle resolves but honestly reports a dead session');

    // And after _cleanup dropped the entry, a hook fire hands over null rather
    // than throwing — which is what makes hook order a safety margin, not a cliff.
    manager.sessions.delete('seat-a');
    engine.hooks.fireExit('seat-a');
    assert.deepStrictEqual(record.exited[1], { name: null, alive: null });
  });
});

test('fake plugin: the turn-text feed reaches a GRANTED seat only, and only after a tick', async () => {
  await withReset(async () => {
    const { engine } = makeEngine();       // seat-a holds fake:turns, seat-b holds nothing
    const { mod, record } = makeEnginePlugin();
    // The ONE registration in this file that declares a scope: everywhere else
    // the fake is global (see the catalog row test), and the feed refuses a
    // global manifest whatever grants a session carries. A real turn-text
    // consumer is session-scoped by construction. `shipped` (t661) because these
    // seats carry no plugin list, and the feed's outer gate would withhold a
    // custom plugin before any grant was read — see the header note.
    engine.register('fake', mod, { scope: 'session' }, { shipped: true });

    engine.hooks.fireAgentText({ session: 'seat-a', text: 'hello there', source: 'wire', isTurnEnd: true });
    // Deferred by contract: this junction also dispatches intents, so a
    // subscriber must not run on its stack. Unlike onCreate/onExit above, which
    // are sync BECAUSE they sit inside PTY teardown.
    assert.deepStrictEqual(record.text, [], 'nothing has run synchronously');
    await new Promise((r) => setImmediate(() => setImmediate(r)));
    assert.deepStrictEqual(record.text, [{ session: 'seat-a', source: 'wire', len: 11 }],
      'ENTER: the granted seat reached the plugin — so the absence below is the gate');

    engine.hooks.fireAgentText({ session: 'seat-b', text: 'not for you', source: 'wire', isTurnEnd: true });
    await new Promise((r) => setImmediate(() => setImmediate(r)));
    assert.strictEqual(record.text.length, 1, 'the ungranted seat delivered nothing');
  });
});

test('fake plugin: storage is per-plugin, atomic, and survives a re-read', () => {
  withReset(() => {
    const { engine, dir } = makeEngine();
    const { mod, record } = makeEnginePlugin();
    engine.register('fake', mod);          // activate() wrote { notes: 1 }

    assert.deepStrictEqual(record.host.storage.get(), { notes: 1 });
    const statePath = path.join(dir, 'plugins', 'fake', 'state.json');
    assert.ok(fs.existsSync(statePath), 'under plugins/<id>/, never in a core store file');
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'plugins', 'fake')), ['state.json'],
      'no .tmp left by the atomic rename');

    record.host.storage.set({ notes: 2, extra: 'x' });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), { notes: 2, extra: 'x' });
  });
});

test('fake plugin: settings shallow-merge into uiSettings.plugins[id], reachable over the _host id', async () => {
  await withReset(async () => {
    const { engine, uiSettings } = makeEngine({ settings: { theme: 'dark' } });
    const { mod, record } = makeEnginePlugin();
    engine.register('fake', mod);

    assert.deepStrictEqual(record.host.settings.get(), {}, 'no settings until something writes');
    record.host.settings.set({ a: 1 });
    record.host.settings.set({ b: 2 });
    assert.deepStrictEqual(record.host.settings.get(), { a: 1, b: 2 }, 'patches MERGE, they do not replace');
    assert.strictEqual(uiSettings().theme, 'dark', 'and core settings are untouched');

    // The renderer's settings sections persist through the same one channel, on
    // the _host pseudo-id — NOT a channel of their own (constraint 5).
    assert.deepStrictEqual(await engine.dispatch(HOST_PSEUDO_ID, 'settings.get', ['fake'], 'desktop'),
      { ok: true, values: { a: 1, b: 2 } });
    assert.deepStrictEqual(await engine.dispatch(HOST_PSEUDO_ID, 'settings.set', ['fake', { c: 3 }], 'desktop'), { ok: true });
    assert.deepStrictEqual(record.host.settings.get(), { a: 1, b: 2, c: 3 });
    // An unregistered plugin cannot have settings written on its behalf.
    assert.deepStrictEqual(await engine.dispatch(HOST_PSEUDO_ID, 'settings.set', ['ghost', { c: 3 }], 'desktop'),
      { ok: false, error: 'no such plugin' });
  });
});

test('fake plugin: lib and telemetry are the sanctioned read surfaces, and telemetry may be null', () => {
  withReset(() => {
    const { engine } = makeEngine();
    const { mod, record } = makeEnginePlugin();
    engine.register('fake', mod);
    const host = record.host;

    assert.deepStrictEqual(host.lib.gitWorktree.list(), ['wt-1'], 'the shared leaf, not a private copy');
    assert.ok(Object.isFrozen(host.lib), 'a plugin cannot swap a leaf out from under another plugin');
    assert.deepStrictEqual(host.telemetry.snapshot('seat-a'), { tok: 1234 });
    assert.strictEqual(host.telemetry.snapshot('seat-b'), null, 'no proxy linked ⇒ null, not a throw');
  });
});

test('fake plugin: deactivate tears down EVERY engine-side registration, plugin cooperation or not', () => {
  withReset(() => {
    const { engine } = makeEngine();
    const { mod, record } = makeEnginePlugin();
    engine.register('fake', mod);
    assert.strictEqual(engine._dispatchKeys().length, 3);

    assert.strictEqual(engine.deactivate('fake'), true);

    assert.strictEqual(record.deactivated, 1, "the plugin's own deactivate ran first");
    assert.deepStrictEqual(engine._dispatchKeys(), [], 'dispatch entries gone');
    assert.deepStrictEqual(engine._hookCounts(), { create: 0, exit: 0, text: 0 }, 'hooks unsubscribed');
    assert.strictEqual(intentRegistry.pluginRowFor('fake-note'), null, 'the module-level intent row is gone too');
    assert.deepStrictEqual(engine.catalog(), []);
  });
});

test('fake plugin: teardown holds even when the plugin forgets everything', () => {
  withReset(() => {
    const { engine } = makeEngine();
    // The uncooperative case: no deactivate() at all, and it kept no disposers.
    const mod = {
      activate(host) {
        host.ipc.handle('x', () => ({ ok: true }));
        host.sessions.onExit(() => {});
        host.intents.register({ verb: 'sloppy', parse: () => null });
      },
    };
    engine.register('messy', mod);
    assert.strictEqual(engine._dispatchKeys().length, 1);

    engine.deactivate('messy');
    assert.deepStrictEqual(engine._dispatchKeys(), []);
    assert.deepStrictEqual(engine._hookCounts(), { create: 0, exit: 0, text: 0 });
    assert.strictEqual(intentRegistry.pluginRowFor('sloppy'), null);
  });
});

test('fake plugin: a throwing activate leaves NOTHING behind (no half-registered plugin)', () => {
  withReset(() => {
    const { engine } = makeEngine();
    const mod = {
      activate(host) {
        host.ipc.handle('half', () => ({ ok: true }));
        host.intents.register({ verb: 'half', parse: () => null });
        throw new Error('bad config');
      },
    };
    assert.throws(() => engine.register('halfy', mod), /bad config/);
    assert.deepStrictEqual(engine._dispatchKeys(), [], 'rolled back');
    assert.strictEqual(intentRegistry.pluginRowFor('half'), null);
    assert.deepStrictEqual(engine.catalog(), [], 'and it is not in the catalog');
  });
});

test('fake plugin: two plugins are independent — one disabled, the other untouched', async () => {
  await withReset(async () => {
    const { engine } = makeEngine();
    const a = makeEnginePlugin();
    engine.register('fake', a.mod);
    const bMod = {
      activate(host) {
        host.ipc.handle('ping', () => ({ ok: true, from: 'other' }));
        host.intents.register({ verb: 'other-note', parse: () => null });
      },
    };
    engine.register('other', bMod);

    // Same METHOD name, different plugin: the host namespaces, so no collision.
    assert.deepStrictEqual(await engine.dispatch('fake', 'ping', [1], 'desktop'), { ok: true, pong: 1 });
    assert.deepStrictEqual(await engine.dispatch('other', 'ping', [], 'desktop'), { ok: true, from: 'other' });

    engine.setEnabled('fake', false);
    assert.deepStrictEqual(await engine.dispatch('fake', 'ping', [1], 'desktop'), { ok: false, error: NO_SUCH_METHOD });
    assert.deepStrictEqual(await engine.dispatch('other', 'ping', [], 'desktop'), { ok: true, from: 'other' });
    assert.strictEqual(intentRegistry.pluginRowFor('fake-note'), null);
    assert.ok(intentRegistry.pluginRowFor('other-note'), "the other plugin's verb survived");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — the RENDERER half
// ════════════════════════════════════════════════════════════════════════════
//
// The DOM stub below is a trimmed copy of plugin-host.test.js's. See the header
// for why it is duplicated rather than shared: a helper module under test/ would
// be executed as a suite by `node --test`.

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.className = '';
    this._text = '';
    this._html = null;
    this.children = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.type = '';
    const self = this;
    this.classList = {
      add(...c) { const s = self._classSet(); c.forEach((x) => s.add(x)); self.className = [...s].join(' '); },
      remove(...c) { const s = self._classSet(); c.forEach((x) => s.delete(x)); self.className = [...s].join(' '); },
      contains(c) { return self._classSet().has(c); },
      toggle(c, on) { if (on) self.classList.add(c); else self.classList.remove(c); },
    };
  }
  _classSet() { return new Set(this.className.split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this._html = null; this.children = []; }
  // esc() is `d.textContent = s; return d.innerHTML` — so this getter IS the
  // escaping under test, not a stub of it.
  get innerHTML() { return this._html !== null ? this._html : escapeText(this._text); }
  set innerHTML(v) { this._html = String(v); this._text = ''; this.children = []; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); if (k.startsWith('data-')) this.dataset[dataKey(k)] = String(v); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t).add(fn); }
  removeEventListener(t, fn) { if (this.listeners.has(t)) this.listeners.get(t).delete(fn); }
  fire(t, ev = {}) { for (const fn of this.listeners.get(t) || []) fn(ev); }
  listenerCount(t) { return (this.listeners.get(t) || new Set()).size; }
  descendants() {
    const out = [];
    for (const c of this.children) { out.push(c); out.push(...c.descendants()); }
    return out;
  }
  querySelector(sel) { return this.descendants().find((n) => matchSel(n, sel)) || null; }
  querySelectorAll(sel) { return this.descendants().filter((n) => matchSel(n, sel)); }
}

function dataKey(attr) {
  return attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function matchSel(node, sel) {
  const parts = String(sel).match(/\[[^\]]+\]|\.[^.[\s]+|^[a-zA-Z][\w-]*/g) || [];
  for (const p of parts) {
    if (p.startsWith('.')) { if (!node._classSet().has(p.slice(1))) return false; }
    else if (p.startsWith('[')) {
      const m = p.match(/^\[([^\]=^]+)(\^?=)?"?([^"\]]*)"?\]$/);
      if (!m) return false;
      const [, k, op, v] = m;
      const have = node.getAttribute(k);
      if (have === null) return false;
      if (op === '=' && have !== v) return false;
      if (op === '^=' && !have.startsWith(v)) return false;
    } else if (node.tagName !== p.toUpperCase()) return false;
  }
  return true;
}

function el(tag, id, cls) {
  const n = new FakeNode(tag);
  if (id) n.setAttribute('id', id);
  if (cls) n.className = cls;
  return n;
}

// A window's worth of DOM: the four mount points the six registries reach for.
function installDom() {
  const body = new FakeNode('body');
  const head = new FakeNode('head');
  const root = new FakeNode('html');
  root.appendChild(head);
  root.appendChild(body);

  const footer = el('div', 'sidebar-footer');
  body.appendChild(footer);

  // The inline settings panel under a Manage Plugins row: the host renders into
  // the container it is handed, and the panel's own Save row must survive a
  // dispose that removes the plugin's nodes.
  const settingsPanel = el('div', null, 'plugin-settings-panel');
  settingsPanel.appendChild(el('div', null, 'plugin-settings-actions'));
  body.appendChild(settingsPanel);

  const row = el('div', null, 'session-item');
  row.dataset.name = 'seat-a';
  row.dataset.type = 'claude';
  const badges = el('div', null, 'session-badges');
  row.appendChild(badges);
  body.appendChild(row);

  const doc = {
    body,
    head,
    createElement: (t) => new FakeNode(t),
    getElementById: (id) => root.descendants().find((n) => n.getAttribute('id') === id) || null,
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
    listeners: new Map(),
    addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t).add(fn); },
    removeEventListener(t, fn) { if (this.listeners.has(t)) this.listeners.get(t).delete(fn); },
    fire(t, ev = {}) { for (const fn of this.listeners.get(t) || []) fn(ev); },
  };
  global.document = doc;
  global.CSS = { escape: (s) => String(s) };
  return { doc, body, head, footer, settingsPanel, row, badges };
}

function loadIsland() {
  delete require.cache[require.resolve('../renderer/plugin-host')];
  delete require.cache[require.resolve('../renderer/lib/format')];
  return require('../renderer/plugin-host').initPluginHost;
}

function makeRendererHost() {
  const dom = installDom();
  const state = { active: 'seat-a', type: 'claude', isAgent: true, peerQ: false, peerC: false, relayouts: 0 };
  const host = loadIsland()({
    getActiveSession: () => state.active,
    sessionTypeOf: () => state.type,
    activeIsAgent: () => state.isAgent,
    activePeerQueryable: () => state.peerQ,
    activePeerConfigurable: () => state.peerC,
    scheduleSidebarRelayout: () => { state.relayouts++; },
    getWorkspaceId: () => 'ws-open',
  });
  return { host, state, dom };
}

// ── The fake plugin, renderer half ─────────────────────────────────────────
// Touches all six registries plus every teardown affordance: a returned
// dispose(), an onDispose(fn), a wrapped interval, a wrapped listener, and CSS.
function makeRendererPlugin() {
  const record = {
    activated: 0,
    ownDisposed: 0,
    onDisposed: 0,
    clicks: [],
    picks: [],
    ticks: 0,
    docClicks: 0,
    overlayMounts: 0,
    overlayOpens: 0,
    overlayCloses: 0,
    invokes: [],
    rhost: null,
    overlay: null,
    badgeText: 'B1',
  };
  const mod = {
    activate(rhost) {
      record.activated++;
      record.rhost = rhost;

      // §2.1 status bar — an action and a segment.
      rhost.ui.statusBar.addAction({
        id: 'act',
        when: (ctx) => ctx.isAgent,
        button: () => ({ label: '<b>Go</b>', tip: 'a "quoted" tip' }),
        onClick: (anchor, ctx) => { record.clicks.push(ctx.session); },
      });
      rhost.ui.statusBar.addSegment({
        id: 'seg',
        render: (ctx) => ({ text: `ws:${ctx.workspaceId}`, onClick: () => { record.clicks.push('seg'); } }),
      });

      // §2.2 sidebar — a footer button (paints on registration) and a row badge.
      rhost.ui.sidebar.footerButton({
        id: 'foot',
        glyph: '◆',
        label: 'Fake',
        tip: 'fake footer',
        badge: () => 3,
        onClick: () => { record.clicks.push('foot'); },
      });
      rhost.ui.sidebar.rowBadge({
        id: 'chip',
        resolve: (name) => (record.badgeText ? { text: record.badgeText, tip: name, cls: 'warn' } : null),
      });

      // §2.4 session menu.
      rhost.ui.sessionMenu.addProvider({
        id: 'menu',
        entriesFor: (type) => (type === 'claude' ? [{ act: 'do-thing', label: 'Do Thing' }] : []),
        onPick: (act, sessionName) => { record.picks.push([act, sessionName]); },
      });

      // §2.5 settings.
      rhost.ui.settings.section({
        id: 'sec',
        title: 'Fake Plugin',
        render: (body, values) => { body.innerHTML = `<input value="${values.mode || ''}">`; },
        collect: () => ({ mode: 'collected' }),
      });

      // §2.6 whole-surface overlay.
      record.overlay = rhost.ui.surfaces.overlay({
        id: 'ov',
        mount: (elt) => { record.overlayMounts++; elt.appendChild(document.createElement('div')); },
        onOpen: () => { record.overlayOpens++; },
        onClose: () => { record.overlayCloses++; },
      });

      // Teardown affordances (constraint 6): all three shapes.
      rhost.onDispose(() => { record.onDisposed++; });
      rhost.setInterval(() => { record.ticks++; }, 10_000);
      rhost.addEventListener(document, 'click', () => { record.docClicks++; });

      rhost.invoke('ping', 1).then((r) => record.invokes.push(r));

      return () => { record.ownDisposed++; };
    },
  };
  return { mod, record };
}

// Every renderer test disposes in a finally. Not politeness: the fake plugin
// registers a wrapped setInterval, and an undisposed one holds the event loop
// open — `node --test` would hang rather than fail, which is the worst failure
// shape there is. (It did, once.) That the sweep FIXES the hang is itself
// evidence the wrapped-timer teardown is real.
// NOTE the promise handling, same trap as session-manager.test.js's withVerb: a
// plain try/finally sweeps the moment an ASYNC fn returns its promise — i.e. at
// fn's first await, with the test body still to come.
function withRendererHost(fn) {
  const ctx = makeRendererHost();
  const sweep = () => ctx.host.disposeAll();
  let out;
  try { out = fn(ctx); } catch (e) { sweep(); throw e; }
  if (out && typeof out.then === 'function') return out.then((v) => { sweep(); return v; }, (e) => { sweep(); throw e; });
  sweep();
  return out;
}

// Build a FRESH plugin (so re-activation tests get a clean record) and drive it
// through the real activation path — the same one the Phase-2 loader will use.
function activateFake(host, { invoke, css } = {}) {
  const { mod, record } = makeRendererPlugin();
  const rhost = host.activate('fake', mod, {
    invoke: invoke || ((pluginId, method, args) => Promise.resolve({ ok: true, pluginId, method, args })),
    css,
  });
  return { rhost, record };
}

test('fake plugin (renderer): all six registries fill, namespaced and escaped', () => {
  withRendererHost(({ host, dom }) => {
    const { record } = activateFake(host, { css: '.fake { color: red }' });

    assert.strictEqual(record.activated, 1);
    assert.deepStrictEqual(host._counts(), {
      actions: 1, segments: 1, footer: 1, badges: 1, events: 0, menus: 1, sections: 1, overlays: 1,
    });

    // §2.1 — ids namespaced by the HOST, labels escaped (a plugin ships data).
    const html = host.statusBarHtml();
    assert.match(html, /data-act="fake:act"/);
    assert.match(html, /&lt;b&gt;Go&lt;\/b&gt;/);
    assert.ok(!html.includes('<b>Go</b>'), 'raw markup would break the Tier-B boundary');
    assert.match(html, /data-act="fake:seg"/, 'a segment with onClick becomes clickable');
    assert.match(html, /ws:ws-open/, "the segment saw this window's workspace id");
    assert.strictEqual(host.hasVisibleContribution(), true);

    // §2.2 — the footer button PAINTED at registration (nothing else re-renders it).
    const btn = dom.footer.querySelector('[data-plugin-footer="fake:foot"]');
    assert.ok(btn, 'footer button painted');
    assert.strictEqual(btn.querySelector('.footer-glyph').textContent, '◆');
    assert.strictEqual(btn.querySelector('.footer-label').textContent, 'Fake');
    assert.strictEqual(btn.querySelector('.footer-badge').textContent, '3');

    // §2.2 — the row badge lands in .session-badges, like applyPrBadge's chip.
    host.applyRowBadges(dom.row);
    const chip = dom.badges.querySelector('[data-plugin-badge="fake:chip"]');
    assert.ok(chip);
    assert.strictEqual(chip.textContent, 'B1');
    assert.strictEqual(chip.getAttribute('data-tip'), 'seat-a');

    // §2.4 — menu entries appended, act namespaced.
    assert.deepStrictEqual(host.menuEntriesFor('claude'), [{ act: 'fake:do-thing', label: 'Do Thing' }]);
    assert.deepStrictEqual(host.menuEntriesFor('bash'), [], 'entriesFor() decides, not the host');

    // §2.5 — the section mounts into the panel under the plugin's Manage Plugins row.
    assert.deepStrictEqual(host.settingsSectionOwners(), ['fake']);
    host.renderSectionsInto('fake', dom.settingsPanel, { mode: 'M' });
    const sec = dom.settingsPanel.querySelector('[data-plugin-section="fake:sec"]');
    assert.ok(sec);
    assert.match(sec.querySelector('.plugin-section-body').innerHTML, /value="M"/);
    assert.deepStrictEqual(host.collectSectionsFrom('fake', dom.settingsPanel), { mode: 'collected' });

    // CSS arrived as a per-plugin <style>, removable as one node.
    assert.ok(dom.head.querySelector('[data-plugin-style="fake"]'));
  });
});

test('fake plugin (renderer): clicks and picks route back to their owner, core falls through otherwise', () => {
  withRendererHost(({ host }) => {
    const { record } = activateFake(host);

    assert.strictEqual(host.handleBarClick('fake:act', null), true);
    assert.deepStrictEqual(record.clicks, ['seat-a'], 'onClick got the live ctx');
    assert.strictEqual(host.handleBarClick('fake:seg', null), true);
    assert.deepStrictEqual(record.clicks, ['seat-a', 'seg']);
    // Not a plugin act ⇒ false, so core's own if/else chain keeps its behavior.
    assert.strictEqual(host.handleBarClick('ctx', null), false);
    assert.strictEqual(host.handleBarClick('ghost:act', null), false);

    assert.strictEqual(host.handleMenuPick('fake:do-thing', 'seat-a', null), true);
    assert.deepStrictEqual(record.picks, [['do-thing', 'seat-a']], 'the provider gets the BARE act');
    assert.strictEqual(host.handleMenuPick('rename', 'seat-a', null), false, 'a core act is untouched');
  });
});

test('fake plugin (renderer): the overlay is host-owned — mounted lazily, closed centrally on Escape', () => {
  withRendererHost(({ host, dom }) => {
    const { record } = activateFake(host);

    assert.strictEqual(record.overlayMounts, 0, 'not mounted until first open');
    record.overlay.open({ from: 'test' });
    assert.strictEqual(record.overlayMounts, 1);
    assert.strictEqual(record.overlayOpens, 1);
    const ov = dom.body.querySelector('[data-plugin="fake"]');
    assert.ok(ov && !ov.classList.contains('hidden'), 'visible');

    // Escape is the HOST's document listener — no plugin installs one, so
    // teardown has one less thing to reach.
    document.fire('keydown', { key: 'Escape', stopPropagation() {} });
    assert.strictEqual(record.overlayCloses, 1);
    assert.ok(ov.classList.contains('hidden'));

    record.overlay.open();
    assert.strictEqual(record.overlayMounts, 1, 'mount is once, ever');
    assert.strictEqual(record.overlayOpens, 2);
  });
});

test('fake plugin (renderer): rhost.invoke is the ONLY engine path, and it carries the plugin id', async () => {
  await withRendererHost(async ({ host }) => {
    const calls = [];
    const { rhost, record } = activateFake(host, {
      invoke: (pluginId, method, args) => { calls.push([pluginId, method, args]); return Promise.resolve({ ok: true }); },
    });

    await Promise.resolve();
    assert.deepStrictEqual(calls, [['fake', 'ping', [1]]], 'the plugin never supplies its own id');
    assert.deepStrictEqual(record.invokes, [{ ok: true }]);
    // What is NOT on rhost: the transport itself. (test/plugin-boundary.test.js
    // lints for the require-level version of the same rule.)
    assert.strictEqual(rhost.api, undefined);
    assert.strictEqual(rhost.window, undefined);
    assert.ok(Object.isFrozen(rhost));
  });
});

test('fake plugin (renderer): dispose() leaves ZERO live resources and an untouched DOM (W9 gate)', () => {
  withRendererHost(({ host, dom }) => {
    const { record } = activateFake(host, { css: '.fake { color: red }' });

    // Everything painted and live.
    host.applyRowBadges(dom.row);
    host.renderSectionsInto('fake', dom.settingsPanel, {});
    record.overlay.open();
    assert.ok(dom.footer.querySelector('[data-plugin-footer="fake:foot"]'));
    assert.ok(dom.badges.querySelector('[data-plugin-badge="fake:chip"]'));
    assert.ok(dom.settingsPanel.querySelector('[data-plugin-section="fake:sec"]'));
    // Eight disposers: one per registry entry (7 — action, segment, footer,
    // badge, menu provider, settings section, overlay) plus the explicit
    // onDispose. Every registration goes through the ledger; that is what makes
    // the zero-assert below mean something.
    assert.deepStrictEqual(host._liveResources('fake'),
      { timers: 0, intervals: 1, listeners: 1, disposers: 8, style: true });

    assert.strictEqual(host.dispose('fake'), true);

    // 1. The plugin's own dispose ran first (while its DOM still existed), and the
    //    open overlay was closed — teardown is not "the window went away".
    assert.strictEqual(record.ownDisposed, 1);
    assert.strictEqual(record.onDisposed, 1);
    assert.strictEqual(record.overlayCloses, 1);

    // 2. Nothing the host held is still live.
    assert.deepStrictEqual(host._liveResources('fake'),
      { timers: 0, intervals: 0, listeners: 0, disposers: 0, style: false });

    // 3. The listener really is off the document, not merely forgotten.
    const before = record.docClicks;
    document.fire('click', {});
    assert.strictEqual(record.docClicks, before, 'a disposed plugin does not keep receiving events');

    // 4. Every registry is empty and every node the host created is gone.
    assert.deepStrictEqual(host._counts(), {
      actions: 0, segments: 0, footer: 0, badges: 0, events: 0, menus: 0, sections: 0, overlays: 0,
    });
    assert.strictEqual(host.statusBarHtml(), '');
    assert.strictEqual(host.hasVisibleContribution(), false);
    assert.deepStrictEqual(host.menuEntriesFor('claude'), []);
    assert.deepStrictEqual(host.settingsSectionOwners(), []);
    assert.strictEqual(host.collectSectionsFrom('fake', dom.settingsPanel), null);
    assert.strictEqual(dom.footer.querySelector('[data-plugin-footer="fake:foot"]'), null);
    assert.strictEqual(dom.badges.querySelector('[data-plugin-badge="fake:chip"]'), null);
    assert.strictEqual(dom.settingsPanel.querySelector('[data-plugin-section="fake:sec"]'), null);
    assert.strictEqual(dom.head.querySelector('[data-plugin-style="fake"]'), null);
    assert.strictEqual(dom.body.querySelector('[data-plugin="fake"]'), null, 'the overlay container too');

    // 5. And the panel's own children survived — teardown removed the plugin's
    //    nodes, not the container it mounted into.
    assert.ok(dom.settingsPanel.querySelector('.plugin-settings-actions'));
  });
});

test('fake plugin (renderer): re-activating after dispose is clean, and double-activation is inert', () => {
  withRendererHost(({ host, dom }) => {
    activateFake(host);
    host.dispose('fake');

    const { record } = activateFake(host);
    assert.strictEqual(record.activated, 1);
    assert.strictEqual(host._counts().footer, 1, 'exactly one footer button, not two');
    assert.strictEqual(dom.footer.querySelectorAll('[data-plugin-footer="fake:foot"]').length, 1);

    // Law 1 is ONE activation per window, and that is what is asserted: a second
    // call does not activate. It used to also THROW, which was the t8 bug — the
    // renderer's `plugin-state` subscriber reports a throw here as a renderer
    // failure, i.e. a quarantine strike against a healthy plugin.
    const second = activateFake(host);
    assert.strictEqual(second.record.activated, 0, 'the second module is never activated (law 1)');
    assert.strictEqual(host._counts().footer, 1, 'and contributes nothing');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 3 — the intent verb, across BOTH feeds
// ════════════════════════════════════════════════════════════════════════════
//
// This is the only section wired to the REAL SessionManager, because the thing
// under test is the difference between two of its feeds. R-INT-3: a plugin verb
// registers into ONE module-level table that `parseIntent` reads, so "live on
// one feed only" is not expressible — but the feeds do NOT agree on body
// capture, and that difference is asserted here rather than papered over.

const { createSessionManager } = require('../session-manager');
const { parseIntent, looksLikeIntent, fencedLines } = require('../intent-scanner');
const { intentEnabled } = require('../intent-catalog');

// A manager wired to a REAL plugin host engine: the handle the dispatch tail
// passes to a plugin handler is minted by the host, not rebuilt here.
// `noHost: true` models the CLODEX_PLUGINS=0 run: engine.js never constructs
// the host, so the getter yields null at every call site.
function makeWiredPair({ intents = ['fake-note'], noHost = false } = {}) {
  const injected = [];
  let engine = null;
  const SessionManager = createSessionManager({
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => ({ intents }) }),
    notifyOS: () => {},
    log: () => {},
    intentEnabled,
    withoutPrivilegedIntentsFor: intentRegistry.withoutPrivilegedIntentsFor,
    fencedLines,
    parseIntent,
    looksLikeIntent,
    execBodyCap: 64 * 1024,
    bodyModeFor: intentRegistry.bodyModeFor,
    intentEnabledFor: intentRegistry.intentEnabledFor,
    intentEnabledForSeat: intentRegistry.intentEnabledForSeat,
    pluginRowFor: intentRegistry.pluginRowFor,
    validIntentNames: intentRegistry.validIntentNames,
    getPluginHooks: () => (engine ? engine.hooks : null),
    fs,
  });
  const m = new SessionManager();
  m._injectText = (_s, text) => injected.push(text);
  m._broadcast = () => {};
  m.sessions.set('seat-a', { name: 'seat-a', type: 'claude', agentType: 'claude', cwd: '/repo/a', workspaceId: 'ws-open' });

  if (!noHost) {
    const dir = mkTmpRoot('clodex-fake-plugin-');
    engine = createPluginHostEngine({
      manager: m,
      getUiSettings: () => ({ get: () => ({}), set: () => {} }),
      log: { info: () => {}, error: () => {} },
      userDataPath: dir,
      fs,
      path,
      gitWorktree: {},
      telemetrySnapshot: () => null,
    });
  }
  return { m, engine, injected };
}

test('fake plugin (intents): the verb is live on BOTH feeds — with a body on jsonl, WITHOUT one on the bash PTY', async () => {
  await withReset(async () => {
    const { m, engine } = makeWiredPair();
    const { mod, record } = makeEnginePlugin();
    engine.register('fake', mod, {}, { shipped: true });   // activation is what registers the verb

    const text = '[agent:fake-note] line one\nline two\n[agent:who]';

    // FEED 1 — jsonl (and the wire feed, which funnels through the same call):
    // _extractIntents, fence-aware, greedy body per the row's bodyMode.
    const extracted = m._extractIntents(text);
    assert.deepStrictEqual(extracted.map((i) => i.type), ['fake-note', 'who'],
      'the plugin verb parses, and does not swallow the core verb after it');
    assert.strictEqual(extracted[0].body, 'line one\nline two', 'body captured across lines');

    // FEED 2 — the bash PTY pane, which calls parseIntent DIRECTLY (deliberately:
    // no body capture, not fence-aware — see its comment at the call site).
    assert.deepStrictEqual(parseIntent('[agent:fake-note] line one'), { type: 'fake-note', body: 'line one' });
    assert.strictEqual(parseIntent('line two'), null,
      'THE DIFFERENCE: on this feed the continuation line is its own (non-)intent');

    // And the fence rule holds for the plugin verb exactly as for a core one on
    // the feed that knows about fences.
    const fenced = m._extractIntents('```\n[agent:fake-note] quoted\n```');
    assert.deepStrictEqual(fenced, [], 'a fenced plugin intent does not fire');
    assert.deepStrictEqual(parseIntent('[agent:fake-note] quoted'), { type: 'fake-note', body: 'quoted' },
      'while the bash feed, which has no fence context, still sees it — documented, not hidden');

    // The handler is reached through the dispatch tail with a host-minted handle.
    await m._handleIntent('seat-a', extracted[0]);
    assert.deepStrictEqual(record.intents, [{ name: 'seat-a', body: 'line one\nline two' }]);
  });
});

test('fake plugin (intents): P1 — the verb is FORCED privileged, whatever the plugin claimed', async () => {
  await withReset(async () => {
    const { engine } = makeEngine();
    const { mod } = makeEnginePlugin();
    engine.register('fake', mod);          // its spec says `privileged: false`

    const row = intentRegistry.pluginRowFor('fake-note');
    assert.strictEqual(row.privileged, true, 'the host ignores the claim');
    assert.strictEqual(row.gateable, true);

    // The consequence that matters: an absent allowlist — the living
    // all-enabled default for CORE verbs — grants this one NOTHING.
    assert.strictEqual(intentRegistry.intentEnabledFor('fake-note', null), false);
    assert.strictEqual(intentRegistry.intentEnabledFor('fake-note', ['dm', 'who']), false);
    assert.strictEqual(intentRegistry.intentEnabledFor('fake-note', ['fake-note']), true);
    assert.strictEqual(intentRegistry.intentEnabledFor('dm', null), true, 'core is unaffected');
  });
});

test('fake plugin (intents): an ungranted seat is refused at the gate, never at the handler', async () => {
  await withReset(async () => {
    const { m, engine, injected } = makeWiredPair({ intents: null });   // absent allowlist
    const { mod, record } = makeEnginePlugin();
    engine.register('fake', mod);

    await m._handleIntent('seat-a', { type: 'fake-note', body: 'x' });
    assert.deepStrictEqual(record.intents, [], 'the handler never ran');
    // t170 note-not-spill: an unclassified verb (every plugin verb is one) reports
    // its body lost rather than writing it. That is the SAFE default — a plugin verb
    // that gains a greedy body later announces the loss instead of silently eating
    // it, and Clodex never writes a payload it knows nothing about to disk.
    assert.deepStrictEqual(injected, [
      '[agent:fake-note] the fake-note intent is disabled for this session — this capability is off for this seat; '
      + 'retrying will bounce the same way, and only the operator can turn it on (Edit Session → Intents). '
      + 'Your fake-note body (1 bytes) was NOT saved and exists only in your own turn'],
    'and the agent got the standard gate bounce, not a plugin-specific one');
  });
});

test('fake plugin (intents): the verb joins the catalog, the prompt and the near-miss list — then leaves', async () => {
  await withReset(async () => {
    const { engine } = makeEngine();
    const coreCatalogLen = intentRegistry.catalogRows().length;
    const { mod } = makeEnginePlugin();
    engine.register('fake', mod, {}, { shipped: true });

    // R-INT-4 — the checklist the renderer renders is served from here.
    const rows = intentRegistry.catalogRows();
    assert.strictEqual(rows.length, coreCatalogLen + 1, 'appended, not interleaved');
    assert.deepStrictEqual(rows[rows.length - 1],
      { type: 'fake-note', label: 'Fake note (test plugin)', privileged: true, source: 'fake' });

    // P3 — its grammar line rides buildIpcPrompt's third arg, and ONLY for a
    // seat that was granted the verb.
    assert.deepStrictEqual(intentRegistry.pluginGrammarLines(['fake-note']),
      ['  [agent:fake-note] text     Record a note (fake plugin)']);
    assert.deepStrictEqual(intentRegistry.pluginGrammarLines(null), [],
      'an ungranted seat is never told the verb exists');

    // P4 — the near-miss bounce list, plugin verbs after core, before `end`.
    const names = intentRegistry.validIntentNames();
    assert.strictEqual(names[names.length - 1], 'end');
    assert.strictEqual(names[names.length - 2], 'fake-note');

    // A checked plugin verb forces an EXPLICIT allowlist: collapsing to null
    // (the "everything core" shorthand) would silently drop the grant.
    assert.ok(Array.isArray(intentRegistry.allowlistFromChecked(['fake-note'])));
    assert.ok(intentRegistry.allowlistFromChecked(['fake-note']).includes('fake-note'));

    // …and all of it disappears with the plugin.
    engine.deactivate('fake');
    assert.strictEqual(intentRegistry.catalogRows().length, coreCatalogLen);
    assert.deepStrictEqual(intentRegistry.pluginGrammarLines(['fake-note']), []);
    assert.ok(!intentRegistry.validIntentNames().includes('fake-note'));
    assert.strictEqual(parseIntent('[agent:fake-note] x'), null, 'and the verb stops parsing on every feed');
  });
});

test('fake plugin (intents): a plugin verb can neither shadow nor impersonate a core one', () => {
  withReset(() => {
    const { engine } = makeEngine();
    const mod = {
      activate(host) {
        // Returning a core type is the impersonation attempt: it would route
        // into a core case of _handleIntent's switch.
        host.intents.register({
          verb: 'liar',
          parse: (line) => (line.startsWith('[agent:liar]') ? { type: 'dm', to: 'someone', body: 'x' } : null),
        });
      },
    };
    engine.register('fake', mod);

    assert.deepStrictEqual(parseIntent('[agent:liar] hi'), { type: 'liar', to: 'someone', body: 'x' },
      'the registered verb overwrites whatever type the plugin returned');
    // And a core verb still parses as core — plugin rows walk last.
    assert.strictEqual(parseIntent('[agent:who]').type, 'who');

    // Claiming a core verb outright is refused at registration.
    assert.throws(() => engine.register('other', {
      activate(host) { host.intents.register({ verb: 'dm', parse: () => null }); },
    }), /reserved by core/);
    assert.throws(() => engine.register('third', {
      activate(host) { host.intents.register({ verb: 'end', parse: () => null }); },
    }), /reserved by core/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 4 — the kill switch
// ════════════════════════════════════════════════════════════════════════════

test('kill switch: CLODEX_PLUGINS=0 is what engine.js gates host construction on', () => {
  // The switch itself is one predicate; engine.js's bootstrap is the only
  // caller. Pinned here because the Phase-1 exit criterion is stated in terms of
  // it, and because "0" must be the ONLY disabling value (an unset var, an empty
  // string and a "1" all mean on).
  assert.strictEqual(pluginsEnabled({}), true);
  assert.strictEqual(pluginsEnabled({ CLODEX_PLUGINS: '' }), true);
  assert.strictEqual(pluginsEnabled({ CLODEX_PLUGINS: '1' }), true);
  assert.strictEqual(pluginsEnabled({ CLODEX_PLUGINS: '0' }), false);
});

test('kill switch: with no host, every core seam still answers — no plugin, no difference', async () => {
  // What a CLODEX_PLUGINS=0 run looks like from core's side: getPluginHooks()
  // returns null (engine.js never constructs the host) and no plugin ever
  // registers anything. Every seam must produce the SAME answer it produced
  // before the plugin system existed.
  const { m, injected } = makeWiredPair({ intents: null, noHost: true });

  // The registry with no plugin rows is exactly core.
  assert.deepStrictEqual(intentRegistry.validIntentNames().filter((n) => n !== 'end').sort(),
    [...intentRegistry.CORE_VALID_INTENT_NAMES].sort());
  assert.deepStrictEqual(intentRegistry.pluginGrammarLines(null), []);
  assert.strictEqual(intentRegistry.catalogRows().every((r) => r.source === 'core'), true);

  // A core intent behaves exactly as it always did.
  await m._handleIntent('seat-a', { type: 'name' });
  assert.strictEqual(injected.length, 1);
  assert.match(injected[0], /^\[agent:name\]/);

  // And the renderer half with nothing activated is inert on every seam.
  withRendererHost(({ host }) => {
    assert.strictEqual(host.statusBarHtml(), '');
    assert.strictEqual(host.hasVisibleContribution(), false);
    assert.deepStrictEqual(host.menuEntriesFor('claude'), []);
    assert.strictEqual(host.handleBarClick('anything', null), false);
    assert.strictEqual(host.handleMenuPick('anything', 'seat-a', null), false);
    assert.deepStrictEqual(host.settingsSectionOwners(), [], 'no row grows a Settings button');
    assert.strictEqual(host.collectSectionsFrom('fake', el('div')), null, 'Save persists nothing');
  });
});
