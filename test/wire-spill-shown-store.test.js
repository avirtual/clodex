'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { SpillShownStore } = require('../wire/spill-shown-store');
const { mkTmpRoot } = require('./lib/tmp-roots');

const rmTree = (root) => {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); } catch {}
};

test('SpillShownStore round-trips records at mode 0600 and removes the file when empty', (t) => {
  const dir = mkTmpRoot('clodex-spill-');
  t.after(() => rmTree(dir));
  const file = path.join(dir, 'wire-spill-shown.json');
  const errors = [];
  const store = new SpillShownStore({ path: file, onError: (m) => errors.push(m) });
  assert.deepStrictEqual(store.load(), {});
  const rec = { tester: { shown: ['a', 'b'], sessionId: 's1', lastAt: 42 } };
  assert.equal(store.save(rec), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(new SpillShownStore({ path: file }).load(), rec);
  store.save({});
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, '{not json');
  assert.deepStrictEqual(store.load(), {});
  assert.deepStrictEqual(errors, []);
});

test('session-manager builds the wire with a SpillShownStore under userData', async () => {
  const root = mkTmpRoot('clodex-t418-seam-');
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: root,
    fs,
    path,
    getUserDataPath: () => root,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const m = new SessionManager();
  m._broadcast = () => {};
  const wire = await m._ensureWire();
  try {
    assert.ok(wire.spillShownStore instanceof SpillShownStore);
    assert.equal(wire.spillShownStore.path, path.join(root, 'wire-spill-shown.json'));
  } finally {
    await wire.close();
    if (m._holdKeeper) m._holdKeeper.stop();
    if (m._quotaStore) m._quotaStore.close();
    if (wire.warmth) wire.warmth.close();
    rmTree(root);
  }
});
