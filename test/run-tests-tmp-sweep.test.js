'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots.js');

const RUNNER = path.join(__dirname, '..', 'scripts', 'run-tests.js');

test('the runner sweeps scratch roots older than two hours and keeps fresh ones', () => {
  const privateTmp = mkTmpRoot('clodex-sweeppin-');
  const suiteTmp = path.join(privateTmp, 'clodex-suite');
  const stale = path.join(suiteTmp, 'clodex-pend-stale');
  const fresh = path.join(suiteTmp, 'clodex-pend-fresh');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'payload'), 'x');
  fs.mkdirSync(fresh, { recursive: true });
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(stale, threeHoursAgo, threeHoursAgo);
  const file = path.join(privateTmp, 'scratch.test.js');
  fs.writeFileSync(file, "require('node:test').test('never runs', () => {});");
  const env = { ...process.env, TMPDIR: privateTmp, TMP: privateTmp, TEMP: privateTmp };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [RUNNER, '--reporter=dot', '--bogus-node-flag', file], { encoding: 'utf8', env });
  assert.match(`${r.stdout}${r.stderr}`, /run-tests: the tap stream is missing/);
  assert.match(r.stderr, /run-tests: swept 1 stale scratch roots/);
  assert.strictEqual(fs.existsSync(stale), false, 'stale root survived');
  assert.strictEqual(fs.existsSync(fresh), true, 'fresh root was swept');
});
