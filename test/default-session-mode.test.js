'use strict';

// The persisted `defaultSessionMode` key against the REAL uiSettings store.
//
// This store rebuilds its value field-by-field from a fixed list on both load
// and save, so a key that is not named in BOTH is dropped rather than merely
// unsanitized (see ui-settings-plugins.test.js for the bug that taught this).
// A dropped key here is invisible from the renderer: the New Session dialog
// falls back to 'optimized' and the operator's choice silently never applies.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { initStores } = require('../stores.js');
const { mkTmpRoot } = require('./lib/tmp-roots');

function openStores(dir) {
  return initStores(dir, {
    log: { info: () => {}, error: () => {} },
    registryDir: path.join(dir, 'registry'),
    resourcesDir: path.join(dir, '__no_seed__'),
  });
}

function mkStore() {
  const dir = mkTmpRoot('clodex-default-mode-');
  return { ui: openStores(dir).uiSettings, dir };
}

test("a fresh store defaults to 'optimized'", () => {
  const { ui } = mkStore();
  const s = ui.get();
  assert.ok('defaultSessionMode' in s,
    'ENTER: the key must exist on the returned object — an unknown key is DROPPED silently');
  assert.strictEqual(s.defaultSessionMode, 'optimized');
});

test("'standard' round-trips through set() and through a RELOAD from disk", () => {
  const { ui, dir } = mkStore();
  ui.set({ defaultSessionMode: 'standard' });
  const back = ui.get();
  assert.ok('defaultSessionMode' in back,
    'ENTER: the key survived set() — without this the equality below reads undefined vs undefined');
  assert.strictEqual(back.defaultSessionMode, 'standard');
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'ui-settings.json'), 'utf-8'));
  assert.strictEqual(raw.defaultSessionMode, 'standard', 'and it reached disk');
  const reread = openStores(dir).uiSettings.get();
  assert.ok('defaultSessionMode' in reread, 'ENTER: _load names the key too');
  assert.strictEqual(reread.defaultSessionMode, 'standard', 'the next launch reads what was chosen');
});

test('an invalid value in the partial keeps the current value', () => {
  const { ui } = mkStore();
  ui.set({ defaultSessionMode: 'standard' });
  for (const bogus of ['bogus', 'custom', 42, null, ['standard']]) {
    ui.set({ defaultSessionMode: bogus });
    assert.strictEqual(ui.get().defaultSessionMode, 'standard',
      `${JSON.stringify(bogus)} must not overwrite the stored choice`);
  }
  // 'custom' above is the interesting one: it is a real value of the dialog's
  // Mode selector, and storing it would open every new session on a mode that
  // applies nothing.
});

test('an unrelated save does not erase the stored choice', () => {
  const { ui, dir } = mkStore();
  ui.set({ defaultSessionMode: 'standard' });
  ui.set({ discoverOnStartup: true });
  assert.strictEqual(openStores(dir).uiSettings.get().defaultSessionMode, 'standard');
});

test('a junk value already on disk loads as the default', () => {
  const { dir } = mkStore();
  fs.writeFileSync(path.join(dir, 'ui-settings.json'),
    JSON.stringify({ defaultSessionMode: 42, discoverOnStartup: true }));
  const loaded = openStores(dir).uiSettings.get();
  assert.strictEqual(loaded.discoverOnStartup, true,
    'ENTER: the hand-written file was the one loaded — otherwise this asserts about a fresh store');
  assert.ok('defaultSessionMode' in loaded, 'ENTER: the key is still built on load');
  assert.strictEqual(loaded.defaultSessionMode, 'optimized');
});

test('settings:get names the key, or the renderer reads undefined', () => {
  // The whitelist is hand-maintained and not a spread, so an omission arrives at
  // the dialog as `undefined` — which its fallback turns into 'optimized', i.e.
  // a Standard default that silently never applies.
  const src = fs.readFileSync(path.join(__dirname, '..', 'ipc-handlers.js'), 'utf8');
  const at = src.indexOf("handle('settings:get'");
  assert.ok(at > 0, 'ENTER: the settings:get handler is in ipc-handlers.js');
  const body = src.slice(at, src.indexOf("handle('settings:set'", at));
  assert.match(body, /defaultSessionMode: s\.defaultSessionMode,/);
});
