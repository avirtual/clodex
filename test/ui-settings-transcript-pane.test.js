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

const paneSlice = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k.startsWith('transcriptPane')));

test('transcriptPaneMode defaults to conversation and internals survives set() then a reload from disk', () => {
  const dir = mkTmpRoot('clodex-uisettings-');
  const ui = openStores(dir).uiSettings;
  assert.strictEqual(ui.get().transcriptPaneMode, 'conversation');
  ui.set({ transcriptPaneMode: 'internals' });
  assert.strictEqual(ui.get().transcriptPaneMode, 'internals');
  assert.strictEqual(openStores(dir).uiSettings.get().transcriptPaneMode, 'internals');
});

test('a bogus transcriptPaneMode on disk loads as conversation', () => {
  const dir = mkTmpRoot('clodex-uisettings-');
  fs.writeFileSync(path.join(dir, 'ui-settings.json'), JSON.stringify({ transcriptPaneMode: 'bogus' }), { mode: 0o600 });
  assert.strictEqual(openStores(dir).uiSettings.get().transcriptPaneMode, 'conversation');
});

test('setting a bogus transcriptPaneMode keeps the current value', () => {
  const dir = mkTmpRoot('clodex-uisettings-');
  const ui = openStores(dir).uiSettings;
  ui.set({ transcriptPaneMode: 'internals' });
  ui.set({ transcriptPaneMode: 'bogus' });
  assert.strictEqual(ui.get().transcriptPaneMode, 'internals');
});

test('set Internals, write recentCwds through the same setter, reload: still Internals', () => {
  const dir = mkTmpRoot('clodex-uisettings-');
  const ui = openStores(dir).uiSettings;
  ui.set({ transcriptPaneMode: 'internals' });
  ui.set({ recentCwds: ['/tmp/a'] });
  const back = openStores(dir).uiSettings.get();
  assert.deepStrictEqual(back.recentCwds, ['/tmp/a']);
  assert.strictEqual(back.transcriptPaneMode, 'internals');
});

test('legacy transcriptPaneInternals/transcriptPaneTools on disk are ignored, not mapped', () => {
  const dir = mkTmpRoot('clodex-uisettings-');
  fs.writeFileSync(path.join(dir, 'ui-settings.json'), JSON.stringify({ transcriptPaneInternals: false, transcriptPaneTools: false }), { mode: 0o600 });
  assert.deepStrictEqual(paneSlice(openStores(dir).uiSettings.get()), { transcriptPane: false, transcriptPaneMode: 'conversation' });
});
