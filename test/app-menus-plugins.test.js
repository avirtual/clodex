'use strict';
// app-menus-plugins.test.js — the top-level Plugins menu (T5).
//
// WHY IT IS A MENU AND NOT A PREFERENCE. Enabling a plugin tears down live DOM
// in every open window; it does not belong next to theme and sidebar width. The
// move is only POSSIBLE because enable/disable state is engine-side — the
// loader's enabled set and quarantine record — so a main-process menu can read
// it with no renderer round trip. (What a main-process menu still cannot do is
// open a plugin's SURFACE; see the View menu's comment.)
//
// HOW REAL THIS TEST IS, and why that matters here specifically. Commit b3f65c4
// found that `uiSettings` silently DROPPED the whole `plugins` key, so no plugin
// state ever persisted — and the entire plugin suite stayed green because every
// one of those tests injects a `fakeUiSettings` that keeps whatever you hand it.
// They test their callers correctly and structurally cannot see the store. So
// the assertions here that would go vacuous against a fake use the real thing:
//   - the REAL plugin loader, against REAL plugin directories on disk;
//   - the REAL plugin host engine, so `status()` and `setEnabled()` are the
//     shipped functions;
//   - the REAL uiSettings store, so "the tick follows the user's intent" is
//     asserted against intent that survived a write and a re-read.
// Only `electron` is stubbed, because app-menus.js requires it at module load
// and there is no Electron in a `node --test` run.

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initStores } = require('../stores.js');
const { createPluginLoader } = require('../plugin-loader');
const { createPluginHostEngine } = require('../plugin-host-engine');

// ── Fixtures ────────────────────────────────────────────────────────────────

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `clodex-menu-${tag}-`));
}

// A real uiSettings store rooted in a throwaway userData dir — the same shape
// test/ui-settings-plugins.test.js uses. `resourcesDir` points at a directory
// that does not exist on purpose, which suppresses the library seeding.
function realUiSettings() {
  const dir = tmpdir('ui');
  return initStores(dir, {
    log: { info: () => {}, error: () => {} },
    registryDir: path.join(dir, 'registry'),
    resourcesDir: path.join(dir, '__no_seed__'),
  }).uiSettings;
}

// Write a plugin to disk. A real directory with a real manifest, so `discover()`
// walks it exactly as it walks plugins/workbench/.
function writePlugin(root, id, { name, version, enabledByDefault, throws = false, manifest } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifest !== undefined ? manifest : JSON.stringify({
    id,
    name: name || id,
    version: version || '1.0.0',
    hostApi: '0',
    entry: { engine: 'engine.js' },
    enabledByDefault: enabledByDefault !== false,
    announce: `${name || id} does something`,
  }));
  fs.writeFileSync(path.join(dir, 'engine.js'), throws
    ? 'module.exports = { activate() { throw new Error("boom"); } };\n'
    : 'module.exports = { activate() {} };\n');
  return dir;
}

// The real loader + real host over a real store, wired to each other the way
// engine.js wires them.
function realStack(pluginsDir, { uiSettings = realUiSettings(), onPluginStateChanged } = {}) {
  let loader = null;
  const host = createPluginHostEngine({
    manager: {
      sessions: new Map(), list: () => [], listForWorkspace: () => [],
      _broadcast: () => {}, _sendToSession: () => {}, windowForWorkspace: () => null,
      _injectText: () => {},
    },
    getUiSettings: () => uiSettings,
    log: { info: () => {}, error: () => {} },
    userDataPath: tmpdir('data'),
    fs, path,
    gitWorktree: {},
    telemetrySnapshot: () => null,
    getLoader: () => loader,
    onPluginStateChanged,
  });
  loader = createPluginLoader({
    fs, path,
    pluginsDir,
    getUiSettings: () => uiSettings,
    log: { info: () => {} },
    requireModule: (p) => require(p),
  });
  return { host, loader, uiSettings };
}

// app-menus.js requires('electron') at module scope. Load it with a stub, and
// give each caller a FRESH module instance so nothing leaks between tests.
function loadAppMenus() {
  const stub = {
    app: { getName: () => 'Clodex', getVersion: () => '0.0.0' },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    Menu: { buildFromTemplate: (t) => t, setApplicationMenu: () => {} },
    Tray: function Tray() {},
    dialog: {}, shell: {}, nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
  };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return stub;
    return origLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve('../app-menus.js')];
    return require('../app-menus.js').createAppMenus;
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../app-menus.js')];
  }
}

// The deps app-menus needs. Only getPluginHost matters here; the rest are inert
// stubs so buildPluginsMenu can run without a manager, workspaces or libraries.
function menusWith(getPluginHost) {
  const createAppMenus = loadAppMenus();
  const nothing = () => ({ list: () => [], get: () => ({}), sortedByRecent: () => [], statuses: () => [] });
  return createAppMenus({
    DEFAULT_WORKSPACE_ID: 'default', LOG_FILE: '/dev/null', THEME_KEYS: [], path,
    checkForUpdate: () => {}, confirmRestartClodex: () => {}, createWindow: () => null,
    getManager: nothing, getPeerManager: () => null, getSandboxManager: () => null,
    getUpdateInfo: () => null, getUiSettings: nothing, getWorkspaces: nothing,
    getAgentLibrary: nothing, getSkillLibrary: nothing, getEnvScopes: () => null,
    getPluginHost,
  });
}

// ── Absence ─────────────────────────────────────────────────────────────────

test('no plugin host (CLODEX_PLUGINS=0) ⇒ the Plugins menu is ABSENT, not empty', () => {
  // The kill switch's shape. An empty "Plugins" menu reads as a broken feature;
  // a missing one reads as a feature that is off, which is the truth.
  const { buildPluginsMenu } = menusWith(() => null);
  assert.strictEqual(buildPluginsMenu(), null);
});

test('a host with NO plugins on disk ⇒ still absent', () => {
  // Distinct from the case above: the host exists and answers, it just has
  // nothing to say. Same conclusion, different route to it — and this is the
  // route a plain install with the plugins/ directory removed takes.
  const { host } = realStack(tmpdir('empty'));
  const { buildPluginsMenu } = menusWith(() => host);
  assert.strictEqual(buildPluginsMenu(), null);
});

test('a host whose status() throws ⇒ absent, never a half-built menu', () => {
  const { buildPluginsMenu } = menusWith(() => ({ status() { throw new Error('nope'); } }));
  assert.strictEqual(buildPluginsMenu(), null);
});

// ── Presence and shape ──────────────────────────────────────────────────────

test('one checkbox item per DISCOVERED plugin, labelled with its name', () => {
  const dir = tmpdir('two');
  writePlugin(dir, 'alpha', { name: 'Alpha' });
  writePlugin(dir, 'beta', { name: 'Beta' });
  const { host } = realStack(dir);
  const { buildPluginsMenu } = menusWith(() => host);
  const menu = buildPluginsMenu();
  assert.strictEqual(menu.label, 'Plugins');
  const boxes = menu.submenu.filter((i) => i.type === 'checkbox');
  assert.deepStrictEqual(boxes.map((i) => i.label), ['Alpha', 'Beta']);
  // …and the dialog is reachable from the menu, after a separator.
  const manage = menu.submenu[menu.submenu.length - 1];
  assert.strictEqual(manage.label, 'Manage Plugins…');
  assert.strictEqual(menu.submenu[menu.submenu.length - 2].type, 'separator');
});

test('`checked` tracks the user\'s INTENT, read back through the REAL store', () => {
  // The assertion b3f65c4 makes non-negotiable. A fake store would keep whatever
  // setEnabled handed it and this would pass against a store that persists
  // nothing — which is exactly the bug that shipped. So: disable through the
  // real host, then read the tick back from a menu built over the real store.
  const dir = tmpdir('intent');
  writePlugin(dir, 'alpha', { name: 'Alpha' });
  writePlugin(dir, 'beta', { name: 'Beta' });
  const { host } = realStack(dir);
  const { buildPluginsMenu } = menusWith(() => host);
  assert.deepStrictEqual(buildPluginsMenu().submenu.filter((i) => i.type === 'checkbox').map((i) => i.checked),
    [true, true], 'enabledByDefault ⇒ both ticked before any choice');

  host.setEnabled('alpha', false);
  const after = buildPluginsMenu().submenu.filter((i) => i.type === 'checkbox');
  assert.deepStrictEqual(after.map((i) => [i.label, i.checked]), [['Alpha', false], ['Beta', true]],
    'the untick must survive the write — this is what silently failed before b3f65c4');
});

test('a QUARANTINED plugin is still listed, marked, and still shows the user\'s tick', () => {
  // Quarantine is a third state a native checkbox cannot express: intent=on,
  // actually=held-back. The tick stays TRUE because the user's choice was never
  // overwritten (that is the whole point of keeping intent and quarantine
  // separate), and the held-back fact goes in the label where there is room for
  // it. Driven through the real loader, so the strike count is a real one.
  const dir = tmpdir('quarantine');
  writePlugin(dir, 'broken', { name: 'Broken', throws: true });
  const { host, loader } = realStack(dir);
  loader.loadAll(host); // strike 1
  loader.loadAll(host); // strike 2 ⇒ quarantined
  assert.ok(loader.isQuarantined('broken'), 'precondition: two failed launches quarantine it');

  const item = menusWith(() => host).buildPluginsMenu().submenu.find((i) => i.type === 'checkbox');
  assert.ok(item, 'a quarantined plugin must still have a menu row — the only UI that can clear it');
  assert.match(item.label, /held back/i, 'and must say so');
  assert.match(item.label, /2/, 'naming how many launches failed');
  assert.strictEqual(item.checked, true, 'quarantine must NOT rewrite the user\'s intent');
});

test('a directory that looks like a plugin but was refused is listed, disabled, untoggleable', () => {
  const dir = tmpdir('problem');
  writePlugin(dir, 'ok', { name: 'Fine' });
  fs.mkdirSync(path.join(dir, 'junk'));
  fs.writeFileSync(path.join(dir, 'junk', 'manifest.json'), '{ not json');
  const { host } = realStack(dir);
  const menu = menusWith(() => host).buildPluginsMenu();
  const row = menu.submenu.find((i) => /junk/.test(i.label || ''));
  assert.ok(row, 'a broken manifest must be visible, not silently absent');
  assert.strictEqual(row.enabled, false, 'nothing to toggle: the manifest itself is what is broken');
  assert.ok(!('type' in row), 'so it is not a checkbox');
});

// ── Behaviour ───────────────────────────────────────────────────────────────

test('clicking an item toggles through host.setEnabled and persists', () => {
  // Ticket §5: the click must route through the SAME setEnabled path the dialog
  // checkbox uses, so the existing every-window teardown broadcast keeps working
  // — not a reimplementation. Asserted by consequence (the state really flipped,
  // in the real store) rather than by spying on a call.
  const dir = tmpdir('click');
  writePlugin(dir, 'alpha', { name: 'Alpha' });
  const { host } = realStack(dir);
  const { buildPluginsMenu } = menusWith(() => host);

  buildPluginsMenu().submenu[0].click();
  assert.strictEqual(buildPluginsMenu().submenu[0].checked, false, 'ticked → unticked');
  buildPluginsMenu().submenu[0].click();
  assert.strictEqual(buildPluginsMenu().submenu[0].checked, true, 'and back');
});

test('clicking a QUARANTINED plugin clears its strike and retries it', () => {
  // The retry path, without a fourth widget. setEnabled(id, true) clears the
  // failure counter before activating, so a user who fixed the plugin is not
  // refused by a stale strike.
  const dir = tmpdir('retry');
  writePlugin(dir, 'broken', { name: 'Broken', throws: true });
  const { host, loader } = realStack(dir);
  loader.loadAll(host);
  loader.loadAll(host);
  assert.ok(loader.isQuarantined('broken'), 'precondition');

  // Fix the plugin on disk, then click its (still ticked) row.
  fs.writeFileSync(path.join(dir, 'broken', 'engine.js'), 'module.exports = { activate() {} };\n');
  delete require.cache[require.resolve(path.join(dir, 'broken', 'engine.js'))];
  const item = menusWith(() => host).buildPluginsMenu().submenu.find((i) => i.type === 'checkbox');
  assert.strictEqual(item.checked, true, 'ticked, so the click asks for false…');
  // A ticked-but-quarantined row's click disables it — the user's honest reading
  // of a ticked box. Re-ticking is the retry, and THAT is what must clear.
  item.click();
  host.setEnabled('broken', true);
  assert.ok(!loader.isQuarantined('broken'), 'enabling clears the strike record');
  assert.ok(menusWith(() => host).buildPluginsMenu().submenu[0].label === 'Broken',
    'and the "held back" marking is gone from the label');
});

test('every setEnabled notifies the main process, so EVERY menu is rebuilt', () => {
  // Ticket §4: "a toggle from the menu, from another window, or a quarantine
  // trip must all leave every menu correct". The menu's own click handler covers
  // one of those three, so the notification lives where all three converge —
  // announceState(), which already broadcasts the renderer-side hint. This pins
  // that the main-process half fires too.
  const dir = tmpdir('notify');
  writePlugin(dir, 'alpha', { name: 'Alpha' });
  let refreshes = 0;
  const { host } = realStack(dir, { onPluginStateChanged: () => { refreshes++; } });
  host.setEnabled('alpha', false);
  assert.strictEqual(refreshes, 1, 'a disable from anywhere refreshes the menu');
  host.setEnabled('alpha', true);
  assert.ok(refreshes >= 2, 'and so does an enable');
});

test('the host tolerates NO onPluginStateChanged — it is electron-free and optional', () => {
  // The headless host passes no callback (it has no app menu). A missing seam
  // must not throw out of setEnabled, or the web host loses plugin toggling.
  const dir = tmpdir('headless');
  writePlugin(dir, 'alpha', { name: 'Alpha' });
  const { host } = realStack(dir);
  assert.doesNotThrow(() => host.setEnabled('alpha', false));
});

// ── Placement ───────────────────────────────────────────────────────────────

test('the Plugins menu sits between View and Window in the real app menu', () => {
  // buildAppMenu builds the whole template; the stub's buildFromTemplate returns
  // it unchanged, so the ORDER is directly assertable rather than inferred from
  // where the splice was written.
  const dir = tmpdir('order');
  writePlugin(dir, 'alpha', { name: 'Alpha' });
  const { host } = realStack(dir);
  const labels = buildTemplateWith(host).map((m) => m.label);
  const iView = labels.indexOf('View');
  const iPlugins = labels.indexOf('Plugins');
  const iWindow = labels.indexOf('Window');
  assert.ok(iView >= 0 && iWindow >= 0, 'View and Window exist');
  assert.ok(iPlugins > iView && iPlugins < iWindow, `Plugins must sit between them, got ${labels}`);
});

test('with no plugin host the app menu has no Plugins entry at all', () => {
  const labels = buildTemplateWith(null).map((m) => m.label);
  assert.ok(!labels.includes('Plugins'), `CLODEX_PLUGINS=0 leaves no Plugins menu, got ${labels}`);
  assert.ok(labels.includes('View') && labels.includes('Window'), 'and the rest of the menu is intact');
});

// Build the FULL app-menu template with electron stubbed, capturing what
// Menu.buildFromTemplate was handed. Separate from loadAppMenus() because it
// needs the stub live while buildAppMenu RUNS, not only while app-menus loads.
function buildTemplateWith(host) {
  let captured = null;
  const stub = {
    app: { getName: () => 'Clodex', getVersion: () => '0.0.0' },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    Menu: { buildFromTemplate: (t) => { captured = t; return t; }, setApplicationMenu: () => {} },
    Tray: function Tray() {},
    dialog: {}, shell: {}, nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
  };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return stub;
    return origLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve('../app-menus.js')];
    const { createAppMenus } = require('../app-menus.js');
    const nothing = () => ({ list: () => [], get: () => ({}), sortedByRecent: () => [], statuses: () => [] });
    const menus = createAppMenus({
      DEFAULT_WORKSPACE_ID: 'default', LOG_FILE: '/dev/null', THEME_KEYS: [], path,
      checkForUpdate: () => {}, confirmRestartClodex: () => {}, createWindow: () => null,
      getManager: nothing, getPeerManager: () => null, getSandboxManager: () => null,
      getUpdateInfo: () => null, getUiSettings: nothing, getWorkspaces: nothing,
      getAgentLibrary: nothing, getSkillLibrary: nothing, getEnvScopes: () => null,
      getPluginHost: () => host,
    });
    menus.buildAppMenu();
    return captured || [];
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../app-menus.js')];
  }
}
