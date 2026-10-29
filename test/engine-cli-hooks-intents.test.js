'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const cliHooks = require('../cli-hooks');
const { createEngine } = require('./lib/engine-isolation');
const { mkTmpRoot } = require('./lib/tmp-roots');

const quiet = { info() {}, warn() {}, error() {} };

test('engine wires getIntents into createCliHooks: the persistence entry\'s intents, null when absent', () => {
  const real = cliHooks.createCliHooks;
  const captured = [];
  cliHooks.createCliHooks = (deps) => { captured.push(deps); return real(deps); };
  let engine;
  try {
    const tmp = mkTmpRoot('clx-engine-cli-hooks-');
    engine = createEngine({ userDataPath: tmp, seams: { noSeed: true, registryDir: path.join(tmp, 'clodex-home') }, log: quiet });
  } finally { cliHooks.createCliHooks = real; }
  assert.strictEqual(captured.length, 1, 'ENTER: createEngine built the cli hooks once');
  const { getIntents } = captured[0];
  assert.strictEqual(typeof getIntents, 'function');
  engine.stores.persistence.upsert({ name: 'gated', type: 'claude', cwd: '/w', intents: ['dm', 'profile'] });
  engine.stores.persistence.upsert({ name: 'open', type: 'claude', cwd: '/w' });
  assert.deepStrictEqual(getIntents('gated'), ['dm', 'profile']);
  assert.strictEqual(getIntents('open'), undefined);
  assert.strictEqual(getIntents('nobody'), null);
});
