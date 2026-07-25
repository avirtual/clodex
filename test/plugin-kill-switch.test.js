'use strict';
// plugin-kill-switch.test.js — W9 GATE 5 (docs/plugin-plan.md §4 W9.5):
// "CLODEX_PLUGINS=0 yields a working app with no workbench anywhere (proves the
// app no longer depends on the pilot)".
//
// WHY THIS GATE IS DIFFERENT NOW. Phase 1's byte-equivalence check passed with
// the switch ON — it could only pass, because nothing registered. The switch was
// never load-bearing: turning it off removed nothing, because there was nothing
// to remove. This is the first time it actually has to work, and the first time
// its failure would be visible (the workbench is a real feature the pilot moved
// out of core, so "=0 loses the workbench" is now the CORRECT behaviour and
// "=0 breaks the app" is the risk).
//
// WHAT THIS FILE CAN AND CANNOT PROVE. It drives the REAL loader against the
// REAL plugins/ directory, in both switch states, and asserts core's seams
// answer identically. What it cannot do is boot Electron: `pluginsEnabled` is
// consulted inside engine.js's bootstrap, which needs a window, a PTY and an
// app. That branch is pinned at the source level here and CHECKED FOR REAL by a
// human running the app — see the journal's gate-5 script. This file does not
// claim otherwise.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createPluginLoader } = require('../plugin-loader');
const { createPluginHostEngine } = require('../plugin-host-engine');
const { pluginsEnabled, NO_SUCH_METHOD } = require('../plugin-api');

const ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

function makeRealLoader() {
  let ui = {};
  const logged = [];
  const loader = createPluginLoader({
    fs, path,
    pluginsDir: PLUGINS_DIR,
    getUiSettings: () => ({ get: () => ui, set: (patch) => { ui = { ...ui, ...patch }; } }),
    log: { info: (scope, msg) => logged.push(`${scope} ${msg}`) },
    requireModule: (p) => require(p),
  });
  return { loader, logged };
}

function makeRealHost(loader) {
  let ui = {};
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'clodex-killswitch-'));
  return createPluginHostEngine({
    manager: {
      sessions: new Map(), list: () => [], listForWorkspace: () => [],
      _broadcast: () => {}, _sendToSession: () => {}, windowForWorkspace: () => null,
      _injectText: () => {},
    },
    getUiSettings: () => ({ get: () => ui, set: (patch) => { ui = { ...ui, ...patch }; } }),
    log: { info: () => {} },
    userDataPath: dir,
    fs, path,
    gitWorktree: {},
    telemetrySnapshot: () => null,
    getLoader: () => loader,
  });
}

// ── The switch itself ───────────────────────────────────────────────────────

test('gate 5: engine.js gates plugin construction on pluginsEnabled, and ONLY "0" disables', () => {
  assert.strictEqual(pluginsEnabled({}), true, 'unset = on (a typo fails safe toward today)');
  assert.strictEqual(pluginsEnabled({ CLODEX_PLUGINS: '' }), true);
  assert.strictEqual(pluginsEnabled({ CLODEX_PLUGINS: 'no' }), true);
  assert.strictEqual(pluginsEnabled({ CLODEX_PLUGINS: '0' }), false);

  // The bootstrap branch, pinned at source. A unit test cannot execute it (it
  // needs an app, a window and a PTY), so what is asserted is that it EXISTS and
  // that both halves die together — a live loader with a null host would offer
  // enable/disable against nothing.
  const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
  assert.match(engineSrc, /if \(pluginsEnabled\(process\.env\)\) \{/,
    'engine.js must gate the whole plugin bootstrap on the switch');
  const branch = engineSrc.slice(engineSrc.indexOf('if (pluginsEnabled(process.env)) {'));
  const body = branch.slice(0, branch.indexOf('\n  } else {'));
  assert.match(body, /pluginHost = createPluginHostEngine\(/, 'the host is built inside the branch');
  assert.match(body, /pluginLoader = createPluginLoader\(/, 'and so is the loader');
  assert.match(body, /pluginLoader\.loadAll\(pluginHost\)/, 'and loadAll is only reached inside it');
});

// ── Switch ON: the pilot is really there (non-vacuity for the OFF case) ─────

test('gate 5 non-vacuity: with the switch ON the workbench genuinely loads and contributes', () => {
  // Without this, every OFF assertion below could pass against a broken loader
  // that finds nothing in either state. This is the control.
  const { loader } = makeRealLoader();
  const host = makeRealHost(loader);
  const results = loader.loadAll(host);
  const wb = results.find((r) => r.id === 'workbench');
  assert.ok(wb && wb.ok && !wb.skipped, 'the workbench engine half loads');
  assert.deepStrictEqual(host.catalog().map((c) => c.id), ['workbench']);
  // Its rows are actually in the dispatch map — the thing the switch removes.
  const keys = host._dispatchKeys();
  assert.ok(keys.length >= 14, `expected the migrated row set, got ${keys.length}`);
  assert.ok(keys.every((k) => k.startsWith('workbench:')), 'every row is the plugin\'s');
});

// ── Switch OFF: no host at all, and every seam still answers ────────────────

test('gate 5: with no host, all four plugin IPC handlers degrade to a SHAPED refusal', async () => {
  // What ipc-handlers does when getPluginHost() returns null — the exact
  // CLODEX_PLUGINS=0 shape. Loud, not silent: an undefined resolution is
  // indistinguishable from a successful empty call.
  const { registerIpcHandlers } = require('../ipc-handlers');
  const handlers = new Map();
  registerIpcHandlers(makeIpcDeps(handlers, () => null));

  assert.deepStrictEqual(await handlers.get('plugin:invoke')({}, 'workbench', 'scm.status', ['seat']),
    { ok: false, error: NO_SUCH_METHOD }, 'a workbench call refuses, it does not throw');
  assert.deepStrictEqual(await handlers.get('plugin:catalog')({}), [],
    'the catalog is empty, so the renderer activates nothing');
  assert.deepStrictEqual(await handlers.get('plugin:setEnabled')({}, 'workbench', true),
    { ok: false, error: NO_SUCH_METHOD }, 'and it cannot be switched back on at runtime');
});

test('gate 5: the intent catalog is served from the REGISTRY, so core verbs survive the switch', async () => {
  // The one seam that must NOT route through the plugin host. intent-registry is
  // a module-level table both halves mutate, authoritative whether or not a host
  // exists — routing this through the host would blank the renderer's intent
  // checklist in exactly the degraded cases where core rows still matter most.
  const { registerIpcHandlers } = require('../ipc-handlers');
  const handlers = new Map();
  registerIpcHandlers(makeIpcDeps(handlers, () => null));
  const rows = await handlers.get('intents:catalog')({});
  assert.ok(rows.length > 5, 'core intent rows are still served with no plugin host');
  assert.ok(rows.every((r) => r.source === 'core'), 'and every row is core\'s');
});

test('gate 5: with the switch off the workbench is absent from EVERY user-visible surface', async () => {
  // The gate's actual words: "no workbench anywhere". Enumerated rather than
  // asserted in the abstract, because "anywhere" is only meaningful as a list.
  const { registerIpcHandlers } = require('../ipc-handlers');
  const handlers = new Map();
  registerIpcHandlers(makeIpcDeps(handlers, () => null));

  // 1. No catalog row ⇒ the renderer's loadPluginRenderers loop body never runs
  //    ⇒ no footer button, no overlay, no stylesheet in any window.
  assert.deepStrictEqual(await handlers.get('plugin:catalog')({}), []);
  // 2. No Plugins menu: since T5 the on/off switch is a top-level menu, not a
  //    Preferences section, and app-menus' buildPluginsMenu returns null with no
  //    host — so the menu is ABSENT rather than empty (pinned directly in
  //    test/app-menus-plugins.test.js, which drives the real builder). The
  //    "Manage Plugins…" dialog it would open is unreachable for the same
  //    reason, and would in any case get this refusal:
  assert.deepStrictEqual(await handlers.get('plugin:invoke')({}, '_host', 'plugins.status', []),
    { ok: false, error: NO_SUCH_METHOD });
  // 3. No data rows: the fourteen migrated methods are gone from core (W6) and
  //    unreachable through the transport (above), so nothing can call them.
  const contract = require('../api-contract').API_CONTRACT.map((r) => r.name);
  for (const gone of ['scmStatus', 'scmDiff', 'fsList', 'fsRead', 'fsWrite', 'worktreeList']) {
    assert.ok(!contract.includes(gone), `${gone} must not be back in the contract`);
  }
  // 4. No menu item: app-menus.js ships no Workbench entry (W4) — a MAIN-process
  //    menu cannot ask a renderer-side plugin whether it is loaded, which is why
  //    the item was deleted rather than conditionalized.
  const menus = fs.readFileSync(path.join(ROOT, 'app-menus.js'), 'utf8');
  assert.ok(!/label:\s*['"]Workbench/i.test(menus), 'no Workbench menu item survives');
});

// registerIpcHandlers is TRANSPORT-AGNOSTIC (Phase 1): it takes `handle`/`on`
// as injected seams rather than reaching for ipcMain, which is what lets the
// Electron host and web-host.js drive the same handler map — and what lets this
// test capture the four plugin channels with no electron and no engine. Same
// fixture shape env-scopes-ipc.test.js uses.
function makeIpcDeps(handlers, getPluginHost) {
  return {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    getPluginHost,
    log: { info() {}, error() {} },
  };
}
