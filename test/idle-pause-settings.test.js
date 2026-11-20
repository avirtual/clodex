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

function mkStore() {
  const dir = mkTmpRoot('clodex-idle-pause-');
  return { ui: openStores(dir).uiSettings, dir };
}

test('a fresh store asks at 48 hours and has declined nothing', () => {
  const s = mkStore().ui.get();
  assert.strictEqual(s.idlePauseHours, 48);
  assert.strictEqual(s.idlePauseDeclined, null);
});

for (const [label, value, want] of [
  ['0 turns the question off', 0, 0],
  ['an hour count', 72, 72],
  ['a fraction', 1.5, 48],
  ['a negative', -3, 48],
  ['a string', '24', 48],
  ['null', null, 48],
  ['past a year', 9000, 48],
]) {
  test(`idlePauseHours: ${label} (${JSON.stringify(value)}) → ${want}, after a reload too`, () => {
    const { ui, dir } = mkStore();
    ui.set({ idlePauseHours: 72 });
    ui.set({ idlePauseHours: value });
    assert.strictEqual(ui.get().idlePauseHours, want);
    assert.strictEqual(openStores(dir).uiSettings.get().idlePauseHours, want);
  });
}

test('junk on disk loads as 48; an unrelated save keeps a stored value', () => {
  const { dir } = mkStore();
  fs.writeFileSync(path.join(dir, 'ui-settings.json'), JSON.stringify({ idlePauseHours: 'x', discoverOnStartup: true }));
  const loaded = openStores(dir).uiSettings;
  assert.strictEqual(loaded.get().discoverOnStartup, true, 'ENTER: the hand-written file was loaded');
  assert.strictEqual(loaded.get().idlePauseHours, 48);
  loaded.set({ idlePauseHours: 12 });
  loaded.set({ discoverOnStartup: false });
  assert.strictEqual(openStores(dir).uiSettings.get().idlePauseHours, 12);
});

test('the declined set survives a restart and drops junk names', () => {
  const { ui, dir } = mkStore();
  ui.set({ idlePauseDeclined: { at: 1000, names: ['a', '..', 7, 'b'] } });
  assert.deepStrictEqual(openStores(dir).uiSettings.get().idlePauseDeclined, { at: 1000, names: ['a', 'b'] });
  ui.set({ idlePauseDeclined: { at: 'soon', names: [] } });
  assert.strictEqual(openStores(dir).uiSettings.get().idlePauseDeclined, null);
});

test('settings:get hands idlePauseHours to the Preferences dialog', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'ipc-handlers.js'), 'utf8');
  assert.match(src, /^ {6}idlePauseHours: s\.idlePauseHours,$/m);
});

test('a session archived as idle carries archivedAt and the cause; unarchive clears both', () => {
  const dir = mkTmpRoot('clodex-idle-pause-rec-');
  const { persistence } = openStores(dir);
  persistence.upsert({ name: 'a', type: 'claude', cwd: '/tmp' });
  persistence.setArchived('a', true, 'idle');
  const rec = persistence.get('a');
  assert.ok(Number.isFinite(rec.archivedAt));
  assert.strictEqual(rec.archiveCause, 'idle');
  persistence.setArchived('a', false);
  assert.strictEqual('archivedAt' in persistence.get('a'), false);
  assert.strictEqual('archiveCause' in persistence.get('a'), false);
});
