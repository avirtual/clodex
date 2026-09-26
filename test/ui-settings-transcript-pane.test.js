'use strict';

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

test('transcriptPane defaults to false', () => {
  const dir = mkTmpRoot('clodex-uisettings-');
  assert.strictEqual(openStores(dir).uiSettings.get().transcriptPane, false);
});

test('transcriptPane survives set() then get() and a reload from disk', () => {
  const dir = mkTmpRoot('clodex-uisettings-');
  const ui = openStores(dir).uiSettings;
  ui.set({ transcriptPane: true });
  assert.strictEqual(ui.get().transcriptPane, true);
  assert.strictEqual(openStores(dir).uiSettings.get().transcriptPane, true);
  ui.set({ theme: 'midnight' });
  assert.strictEqual(ui.get().transcriptPane, true);
});

test('a non-boolean transcriptPane on disk normalises to false', () => {
  const dir = mkTmpRoot('clodex-uisettings-');
  fs.writeFileSync(path.join(dir, 'ui-settings.json'), JSON.stringify({ transcriptPane: 'yes' }), { mode: 0o600 });
  assert.strictEqual(openStores(dir).uiSettings.get().transcriptPane, false);
});

test('transcriptPaneInternals defaults to true and survives set() then a reload from disk', () => {
  const dir = mkTmpRoot('clodex-uisettings-');
  const ui = openStores(dir).uiSettings;
  assert.strictEqual(ui.get().transcriptPaneInternals, true);
  ui.set({ transcriptPaneInternals: false });
  assert.strictEqual(ui.get().transcriptPaneInternals, false);
  assert.strictEqual(openStores(dir).uiSettings.get().transcriptPaneInternals, false);
  ui.set({ transcriptPaneInternals: 'no' });
  assert.strictEqual(ui.get().transcriptPaneInternals, false);
});

test('a non-boolean transcriptPaneInternals on disk normalises to true', () => {
  const dir = mkTmpRoot('clodex-uisettings-');
  fs.writeFileSync(path.join(dir, 'ui-settings.json'), JSON.stringify({ transcriptPaneInternals: 'no' }), { mode: 0o600 });
  assert.strictEqual(openStores(dir).uiSettings.get().transcriptPaneInternals, true);
});
