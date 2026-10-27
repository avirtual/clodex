'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('./lib/engine-isolation');
const { mkTmpRoot } = require('./lib/tmp-roots');

const quiet = { info() {}, warn() {}, error() {} };

function build(extra) {
  const tmp = mkTmpRoot('clx-engine-seams-');
  const registryDir = path.join(tmp, 'clodex-home');
  createEngine({ userDataPath: tmp, seams: { registryDir, ...extra }, log: quiet });
  return registryDir;
}

test('seams.noSeed: the registry gets no skills, library prompts or library templates', () => {
  const reg = build({ noSeed: true });
  assert.strictEqual(fs.existsSync(path.join(reg, 'skills')), false);
  assert.strictEqual(fs.existsSync(path.join(reg, 'library', 'prompts')), false);
  assert.strictEqual(fs.existsSync(path.join(reg, 'library', 'templates')), false);
});

test('without seams.noSeed the same registry library is seeded', () => {
  const reg = build({});
  assert.strictEqual(fs.existsSync(path.join(reg, 'skills')), true);
  assert.strictEqual(fs.existsSync(path.join(reg, 'library', 'prompts')), true);
  assert.strictEqual(fs.existsSync(path.join(reg, 'library', 'templates')), true);
});

test('seams.noSeed throws outside node --test', () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const tmp = mkTmpRoot('clx-engine-seams-');
    assert.throws(
      () => createEngine({ userDataPath: tmp, seams: { registryDir: path.join(tmp, 'clodex-home'), noSeed: true }, log: quiet }),
      { message: 'createEngine: seams.noSeed is a test seam' });
  } finally {
    if (saved === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = saved;
  }
});

test('t1927: with no openRemoteWindow seam, a remote window falls through to openExternal', () => {
  const tmp = mkTmpRoot('clx-engine-seams-');
  const opened = [];
  const engine = createEngine({
    userDataPath: tmp,
    seams: { noSeed: true, registryDir: path.join(tmp, 'clodex-home'), openExternal: (url) => opened.push(url) },
    log: quiet,
  });
  try {
    engine.openRemoteWindow('peer:p1', 'http://127.0.0.1:45001?via=tunnel', { title: 'box — Clodex' });
    assert.deepEqual(opened, ['http://127.0.0.1:45001?via=tunnel']);
  } finally { try { engine.shutdown(); } catch {} }
});
