'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { seatBinsFor, materializeSeatBins, seatBinEnv } = require('../bin-materialize');

const BIN = { id: 'demo', shipped: false, dir: '/p/demo', name: 'demo-open', src: 'open.js', env: ['OPENER'], verb: 'demo' };

test('seatBinsFor keeps a bin only when the seat lists its verb and holds its plugin', () => {
  assert.deepStrictEqual(seatBinsFor({ bins: [BIN], intents: ['dm', 'demo'], plugins: ['demo'] }), [BIN]);
  assert.deepStrictEqual(seatBinsFor({ bins: [BIN], intents: ['dm'], plugins: ['demo'] }), []);
  assert.deepStrictEqual(seatBinsFor({ bins: [BIN], intents: ['demo'], plugins: ['other'] }), []);
  assert.deepStrictEqual(seatBinsFor({ bins: [BIN], intents: null, plugins: ['demo'] }), []);
  assert.deepStrictEqual(seatBinsFor({ bins: [BIN], intents: ['demo'], plugins: null }), []);
  assert.deepStrictEqual(seatBinsFor({ bins: [{ ...BIN, shipped: true }], intents: ['demo'], plugins: null }), [{ ...BIN, shipped: true }]);
  assert.deepStrictEqual(seatBinsFor({ bins: [{ ...BIN, verb: null }], intents: ['demo'], plugins: ['demo'] }), []);
  assert.deepStrictEqual(seatBinsFor({ bins: [{ ...BIN, name: '..' }], intents: ['demo'], plugins: ['demo'] }), []);
});

test('materializeSeatBins copies the src as an executable named bin, and skips a src outside the plugin dir', () => {
  const root = mkTmpRoot('seat-bin-');
  const dir = path.join(root, 'plugins', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'open.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(root, 'plugins', 'secret.js'), 'x');
  const binDir = path.join(root, 'run', 'seat', 'bin');
  const installed = materializeSeatBins({ binDir, bins: [{ ...BIN, dir }, { ...BIN, dir, name: 'escape', src: '../secret.js' }] });
  assert.deepStrictEqual(installed, [{ name: 'demo-open', path: path.join(binDir, 'demo-open'), env: ['OPENER'] }]);
  assert.deepStrictEqual(fs.readdirSync(binDir), ['demo-open']);
  assert.strictEqual(fs.statSync(path.join(binDir, 'demo-open')).mode & 0o111, 0o111);
  assert.strictEqual(fs.readFileSync(path.join(binDir, 'demo-open'), 'utf8'), '#!/usr/bin/env node\n');
});

test('seatBinEnv points each listed key at the bin unless the seat env sets it explicitly', () => {
  const installed = [{ name: 'o', path: '/r/bin/o', env: ['A', 'B'] }];
  assert.deepStrictEqual(seatBinEnv({ installed }), { A: '/r/bin/o', B: '/r/bin/o' });
  assert.deepStrictEqual(seatBinEnv({ installed, explicit: { B: 'mine' } }), { A: '/r/bin/o' });
});
