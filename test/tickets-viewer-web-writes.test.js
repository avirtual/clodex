'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createPluginHostEngine } = require('../plugin-host-engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

const MANIFEST = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'plugins', 'tickets-viewer', 'manifest.json'), 'utf8'));

function bootStub() {
  const dir = mkTmpRoot('clodex-plugin-test-');
  const engine = createPluginHostEngine({
    manager: {
      sessions: new Map(), list: () => [], listForWorkspace: () => [],
      _broadcast() {}, _sendToSession() {}, windowForWorkspace: () => null, _injectText() {},
    },
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    log: { info: () => {}, error: () => {} },
    userDataPath: dir,
    fs, path,
    gitWorktree: {},
  });
  const calls = [];
  const methods = ['add', 'editSpec', 'assign', 'close', 'cancel', 'notInManifest'];
  engine.register('tickets-viewer', {
    activate(host) {
      for (const m of methods) {
        host.ipc.handle(m, (p) => { calls.push({ method: m, payload: p }); return { ok: true, method: m }; });
      }
    },
  }, MANIFEST);
  return { engine, calls };
}

test('tickets-viewer manifest: the surfaces table opens the nine reads and the five writes, nothing else', () => {
  assert.deepStrictEqual(MANIFEST.surfaces, {
    projects: 'any',
    teams: 'any',
    board: 'any',
    sessions: 'any',
    teamCost: 'any',
    ticket: 'any',
    search: 'any',
    closed: 'any',
    feed: 'any',
    add: 'any',
    editSpec: 'any',
    assign: 'any',
    close: 'any',
    cancel: 'any',
  });
});

for (const method of ['add', 'editSpec', 'assign', 'close', 'cancel']) {
  test(`tickets-viewer: ${method} from the web surface reaches its handler with the payload`, async () => {
    const { engine, calls } = bootStub();
    const payload = { project: 'k', id: 't1', marker: method };
    const res = await engine.dispatch('tickets-viewer', method, [payload], 'web');
    assert.deepStrictEqual(calls, [{ method, payload }]);
    assert.deepStrictEqual(res, { ok: true, method });
  });
}

test('tickets-viewer ENTER: a registered method the manifest does not list is still refused on the web', async () => {
  const { engine, calls } = bootStub();
  const res = await engine.dispatch('tickets-viewer', 'notInManifest', [{ x: 1 }], 'web');
  assert.deepStrictEqual(res, { ok: false, error: 'plugin method not available on this surface' });
  assert.deepStrictEqual(calls, []);
  const desk = await engine.dispatch('tickets-viewer', 'notInManifest', [{ x: 1 }], 'desktop');
  assert.deepStrictEqual(desk, { ok: true, method: 'notInManifest' });
});
