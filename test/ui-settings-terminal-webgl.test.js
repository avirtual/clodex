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

test('terminalWebgl defaults to false', () => {
  const dir = mkTmpRoot('clodex-uisettings-webgl-');
  assert.strictEqual(openStores(dir).uiSettings.get().terminalWebgl, false);
});

test('terminalWebgl survives set() then get() and a reload from disk', () => {
  const dir = mkTmpRoot('clodex-uisettings-webgl-');
  const ui = openStores(dir).uiSettings;
  ui.set({ terminalWebgl: true });
  assert.strictEqual(ui.get().terminalWebgl, true);
  assert.strictEqual(openStores(dir).uiSettings.get().terminalWebgl, true);
  ui.set({ theme: 'midnight' });
  assert.strictEqual(ui.get().terminalWebgl, true);
});

test('a non-boolean terminalWebgl on disk normalises to false', () => {
  const dir = mkTmpRoot('clodex-uisettings-webgl-');
  fs.writeFileSync(path.join(dir, 'ui-settings.json'), JSON.stringify({ terminalWebgl: 'yes' }), { mode: 0o600 });
  assert.strictEqual(openStores(dir).uiSettings.get().terminalWebgl, false);
});
