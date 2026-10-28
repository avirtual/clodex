'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { createCliHooks } = require('../cli-hooks');
const { createEngine } = require('./lib/engine-isolation');

test('engine reconcileCodexSwaps: a live codex session in the cwd blocks the restore; once gone, the restore runs', () => {
  const home = mkTmpRoot('clodex-codexrec-home-');
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const eng = createEngine({
    userDataPath: mkTmpRoot('clodex-codexrec-ud-'),
    seams: { noSeed: true, registryDir: path.join(home, '.clodex') },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  try {
    const cwd = mkTmpRoot('clodex-codexrec-cwd-');
    fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.codex', 'hooks.json'), '{"orig":true}');
    createCliHooks({
      REGISTRY_DIR: eng.REGISTRY_DIR, memoryStore: { list: () => [] },
      getUiSettings: () => ({ get: () => ({}) }), nodeInterp: process.execPath,
    }).setupCodexHook('cx', cwd);
    const hooks = path.join(cwd, '.codex', 'hooks.json');
    assert.notStrictEqual(fs.readFileSync(hooks, 'utf8'), '{"orig":true}', 'ENTER: the swap is on disk');

    const record = { name: 'cx', type: 'codex', cwd };
    eng.manager.sessions.set('cx-live', { name: 'cx-live', agentType: 'codex', cwd });
    eng.reconcileCodexSwaps([record]);
    assert.notStrictEqual(fs.readFileSync(hooks, 'utf8'), '{"orig":true}', 'the live seat keeps our hooks');

    eng.manager.sessions.delete('cx-live');
    eng.reconcileCodexSwaps([record]);
    assert.strictEqual(fs.readFileSync(hooks, 'utf8'), '{"orig":true}');
  } finally {
    eng.manager.sessions.delete('cx-live');
    try { eng.shutdown(); } catch {}
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  }
});
