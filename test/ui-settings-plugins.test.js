'use strict';

// The REAL uiSettings store against the plugin subsystem's persistence needs.
//
// The bug this exists for: plugin state (`plugins.enabled`, `plugins._failures`,
// per-plugin settings) was written through `uiSettings.set({ plugins })` — but
// `plugins` was never a key in DEFAULT_UI_SETTINGS, and this store rebuilds its
// value field-by-field from a fixed list on both load AND save. An unknown key
// is therefore not merely unsanitized, it is DROPPED. Every plugin write landed
// in a temporary object and vanished at the next read.
//
// User-visible symptom: the Plugins checkbox could not be unticked. The click
// fired, setEnabled ran, deactivate tore the plugin down in every window — and
// then the re-render read the enabled set back from disk, found nothing, fell
// through to `enabledByDefault: true` and drew the box ticked again. Quarantine
// strikes never accumulated either, so the fail-safe could never trip.
//
// Why the whole plugin suite stayed green: every one of those tests injects a
// `fakeUiSettings` whose set() is `state = { ...state, ...patch }` — a store
// that keeps whatever you give it. They test the CALLERS correctly and cannot
// see the store. This file closes that gap by using the real one, so the two
// halves are pinned against each other rather than each against a fiction.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { initStores } = require('../stores.js');

// A real store rooted in a throwaway userData dir. initStores derives every
// path from the one it is given, so this exercises the actual load/save code.
// `resourcesDir` points at a directory that does not exist on purpose: it
// suppresses the library seeding, which is irrelevant here (same trick as
// test/stores.test.js).
function openStores(dir) {
  return initStores(dir, {
    log: { info: () => {}, error: () => {} },
    registryDir: path.join(dir, 'registry'),
    resourcesDir: path.join(dir, '__no_seed__'),
  });
}

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-uisettings-'));
  return { ui: openStores(dir).uiSettings, dir };
}

test('a plugins bag survives set() → get()', () => {
  const { ui } = mkStore();
  ui.set({ plugins: { enabled: ['workbench'], workbench: { tab: 'scm' } } });
  const back = ui.get().plugins;
  assert.deepStrictEqual(back.enabled, ['workbench'], 'the enabled set must round-trip');
  assert.deepStrictEqual(back.workbench, { tab: 'scm' }, "a plugin's own settings must round-trip");
});

test('a plugins bag survives a RELOAD from disk', () => {
  // The stricter half: set() returning the right value in memory is not the
  // claim. Re-reading through a fresh _load is what the next launch does.
  const { ui, dir } = mkStore();
  ui.set({ plugins: { enabled: [], _failures: { workbench: { count: 2 } } } });
  const reread = openStores(dir).uiSettings.get().plugins;
  assert.deepStrictEqual(reread.enabled, [], 'an EMPTY enabled set is a real value, not "never chosen"');
  assert.strictEqual(reread._failures.workbench.count, 2, 'quarantine strikes must persist across launches');
});

test('disabling the last plugin persists as an empty array, not an absent key', () => {
  // This distinction IS the bug. `enabled: []` means "the user turned everything
  // off"; an absent key means "never chosen" and falls back to enabledByDefault.
  // Collapsing the former into the latter is exactly what re-ticked the box.
  const { ui, dir } = mkStore();
  ui.set({ plugins: { enabled: ['workbench'] } });
  ui.set({ plugins: { enabled: [] } });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'ui-settings.json'), 'utf-8'));
  assert.ok(raw.plugins && 'enabled' in raw.plugins, 'the enabled key must be present on disk');
  assert.deepStrictEqual(raw.plugins.enabled, []);
  assert.deepStrictEqual(openStores(dir).uiSettings.get().plugins.enabled, []);
});

test('the plugins bag is REPLACED, not merged', () => {
  // Every writer reads-spreads-writes the whole bag, so a merge here would make
  // deletion impossible: dropping an id from `enabled` or clearing a failure
  // record has to be able to actually remove it.
  const { ui } = mkStore();
  ui.set({ plugins: { enabled: ['a', 'b'], _failures: { a: { count: 1 } } } });
  ui.set({ plugins: { enabled: ['a'] } });
  const back = ui.get().plugins;
  assert.deepStrictEqual(back.enabled, ['a']);
  assert.ok(!back._failures, 'a key omitted from the new bag must be gone, not resurrected');
});

test('an unrelated set() does not disturb the plugins bag', () => {
  // The other direction: plugin state must not be collateral damage when some
  // unrelated preference is saved. `plugins` absent from the patch means keep.
  const { ui } = mkStore();
  ui.set({ plugins: { enabled: ['workbench'] } });
  ui.set({ theme: 'light' });
  assert.deepStrictEqual(ui.get().plugins.enabled, ['workbench']);
});

test('a fresh install reads plugins as an empty bag with no enabled key', () => {
  // "Never chosen" must be representable on a disk that has never seen a plugin
  // — otherwise a first launch would look like "the user disabled everything".
  const { ui } = mkStore();
  const p = ui.get().plugins;
  assert.deepStrictEqual(p, {});
  assert.ok(!('enabled' in p), 'absent enabled key = fall back to enabledByDefault');
});

test('a corrupt plugins value degrades to an empty bag, never throws', () => {
  const { dir } = mkStore();
  const file = path.join(dir, 'ui-settings.json');
  for (const bad of ['"nonsense"', '[1,2,3]', 'null', '42']) {
    fs.writeFileSync(file, JSON.stringify({ plugins: JSON.parse(bad) }));
    const got = openStores(dir).uiSettings.get().plugins;
    assert.deepStrictEqual(got, {}, `plugins: ${bad} should degrade to {}`);
  }
});

test('a corrupt enabled list is narrowed to its string entries', () => {
  // An id is compared by exact string equality downstream, so a coerced entry
  // would silently never match — dropping is the honest repair.
  const { dir } = mkStore();
  fs.writeFileSync(
    path.join(dir, 'ui-settings.json'),
    JSON.stringify({ plugins: { enabled: ['workbench', 7, null, { id: 'x' }], other: { keep: true } } }),
  );
  const got = openStores(dir).uiSettings.get().plugins;
  assert.deepStrictEqual(got.enabled, ['workbench']);
  assert.deepStrictEqual(got.other, { keep: true }, "core must not narrow a plugin's own settings");
});

test('a non-array enabled becomes an empty array, not a dropped key', () => {
  // Present-but-wrong-type is a corrupt CHOICE, not an absent one. Dropping the
  // key would flip it back to enabledByDefault and re-enable everything.
  const { dir } = mkStore();
  fs.writeFileSync(path.join(dir, 'ui-settings.json'), JSON.stringify({ plugins: { enabled: 'workbench' } }));
  const got = openStores(dir).uiSettings.get().plugins;
  assert.deepStrictEqual(got.enabled, []);
});

test('the real store satisfies the loader end to end', () => {
  // The integration the fakes could never make: drive plugin-loader's own
  // enabled-set logic through the REAL store and assert the toggle sticks.
  const { createPluginLoader } = require('../plugin-loader.js');
  const { ui, dir } = mkStore();

  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-plugins-'));
  const pdir = path.join(pluginsDir, 'demo');
  fs.mkdirSync(pdir);
  fs.writeFileSync(path.join(pdir, 'engine.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(pdir, 'manifest.json'), JSON.stringify({
    id: 'demo', name: 'Demo', version: '1.0.0',
    hostApi: require('../plugin-api.js').HOST_API_VERSION,
    entry: { engine: 'engine.js' },
  }));

  const mk = (store) => createPluginLoader({
    fs, path, pluginsDir, getUiSettings: () => store, log: { info: () => {} }, requireModule: require,
  });

  const loader = mk(ui);
  const rec = loader.discover().find((r) => r.id === 'demo');
  assert.strictEqual(loader.isEnabled(rec), true, 'enabledByDefault ⇒ on before any choice');

  loader.setEnabledInSettings('demo', false);
  assert.strictEqual(loader.isEnabled(rec), false, 'the disable must be visible immediately');

  // The claim that actually failed in the app: it is still off after a reload.
  const fresh = openStores(dir).uiSettings;
  assert.strictEqual(mk(fresh).isEnabled(rec), false, 'the disable must survive a restart');
});
