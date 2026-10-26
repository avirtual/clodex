'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createEngine } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

after(() => { setImmediate(() => process.exit(0)); });

test('engine applySessionArgs without restart refreshes the seat catalog after the grant writes', async () => {
  const tmp = mkTmpRoot('clx-mcpcat-');
  const eng = createEngine({
    userDataPath: tmp,
    seams: { noSeed: true, registryDir: path.join(tmp, 'clodex-home') },
    log: { info() {}, warn() {}, error() {} },
  });
  try {
    eng.stores.persistence.upsert({ name: 'c', type: 'claude', cwd: '/tmp', workspaceId: 'default', intents: ['browser'] });
    const seen = [];
    eng.manager.refreshSeatCatalog = (n) => { seen.push([n, eng.stores.persistence.get(n).intents]); return null; };
    const res = await eng.applySessionArgs('c', { intents: [], restart: false }, 'default');
    assert.deepStrictEqual(res, { ok: true, restarted: false });
    assert.deepStrictEqual(seen, [['c', []]]);
  } finally {
    try { eng.shutdown(); } catch {}
  }
});
