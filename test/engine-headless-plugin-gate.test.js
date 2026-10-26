'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

after(() => { setImmediate(() => process.exit(0)); });

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');
const quiet = { info() {}, warn() {}, error() {} };

function boot(extraSeams = {}) {
  const tmp = mkTmpRoot('clx-headless-gate-');
  fs.writeFileSync(path.join(tmp, 'ui-settings.json'), JSON.stringify({ plugins: { enabled: ['browser-pane'] } }));
  return createEngine({
    userDataPath: tmp,
    seams: { noSeed: true, registryDir: path.join(tmp, 'clodex-home'), ...extraSeams },
    log: quiet,
  });
}

function sweepVerbs() {
  const { unregisterSource } = require('../intent-registry');
  for (const e of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (e.isDirectory()) unregisterSource(e.name);
  }
}

test('a headless engine hides browser-pane everywhere; an electron host loads it', () => {
  const { pluginRowFor } = require('../intent-registry');
  sweepVerbs();
  const headless = boot();
  try {
    assert.ok(!headless.getPluginLoader().discover().some((p) => p.id === 'browser-pane'));
    assert.ok(!headless.getPluginHost().catalog().some((p) => p.id === 'browser-pane'));
    assert.strictEqual(pluginRowFor('browser'), null);
    assert.deepStrictEqual(headless.getPluginLoader().status().problems, []);
  } finally {
    try { headless.shutdown(); } catch {}
  }
  sweepVerbs();
  const desktop = boot({ electronChild: () => ({ command: 'x', args: [], env: {} }) });
  try {
    assert.ok(desktop.getPluginLoader().discover().some((p) => p.id === 'browser-pane'));
    assert.ok(desktop.getPluginHost().catalog().some((p) => p.id === 'browser-pane'));
    assert.notStrictEqual(pluginRowFor('browser'), null);
  } finally {
    try { desktop.shutdown(); } catch {}
  }
});
