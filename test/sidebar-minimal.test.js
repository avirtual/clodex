'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { statusPasses } = require('../renderer/lib/sidebar-filter-fold');
const { initStores } = require('../stores.js');
const { createSessionManager } = require('../session-manager.js');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ROOT = path.join(__dirname, '..');

test('statusPasses: Minimal hides idle ephemeral seats, keeps one waiting on a dialog', () => {
  const rows = [
    ['minimal hides an idle ephemeral row', 'minimal', { ephemeral: true }, false],
    ['minimal shows an ephemeral row needing attention', 'minimal', { ephemeral: true, attention: true }, true],
    ['minimal shows a non-ephemeral row', 'minimal', {}, true],
    ['minimal hides an archived row', 'minimal', { archived: true }, false],
    ['minimal hides an archived ephemeral row needing attention', 'minimal', { archived: true, ephemeral: true, attention: true }, false],
    ['active still shows an idle ephemeral row', 'active', { ephemeral: true }, true],
    ['active hides an archived row', 'active', { archived: true }, false],
    ['archived hides a live row', 'archived', {}, false],
    ['archived shows an archived ephemeral row', 'archived', { archived: true, ephemeral: true }, true],
    ['all shows an idle ephemeral row', 'all', { ephemeral: true }, true],
    ['all shows an archived row', 'all', { archived: true }, true],
    ['an unknown stored status falls back to showing everything', 'bogus', { ephemeral: true, archived: true }, true],
  ];
  for (const [name, status, row, expected] of rows) {
    assert.strictEqual(statusPasses(status, row), expected, name);
  }
});

test('the status select offers Minimal first', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
  const select = html.match(/<select id="sidebar-status"[\s\S]*?<\/select>/);
  assert.ok(select, 'ENTER: the status select is still there');
  const values = [...select[0].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(values, ['minimal', 'active', 'archived', 'all']);
});

test('the reattach case does not focus a row the filter hides', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/renderer.js'), 'utf8');
  const reattach = src.match(/case 'reattach':[\s\S]{0,900}?break;/);
  assert.ok(reattach, 'ENTER: the reattach case is still there to check');
  assert.match(reattach[0], /if \(row && !rowPasses\(row\)\) fitSessionInBackground\(name\);\s*else switchToNewSession\(/);
});

function realManager() {
  const dir = mkTmpRoot('clodex-minimal-');
  const persistence = initStores(dir, {
    log: { info: () => {}, error: () => {} },
    registryDir: path.join(dir, 'registry'),
    resourcesDir: path.join(dir, '__no_seed__'),
  }).persistence;
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    getRemoteServer: () => null,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
  });
  return { persistence, mgr: new SessionManager() };
}

test('listForWorkspace carries the record\'s ephemeral flag', () => {
  const { persistence, mgr } = realManager();
  const WS = 'ws-minimal';
  persistence.upsert({ name: 'team-hand-1', type: 'claude', cwd: '/tmp', workspaceId: WS, ephemeral: true });
  persistence.upsert({ name: 'lead', type: 'claude', cwd: '/tmp', workspaceId: WS });
  for (const name of ['team-hand-1', 'lead']) {
    mgr.sessions.set(name, { name, type: 'claude', workspaceId: WS, cwd: '/tmp', pty: { pid: 4242 } });
  }
  const byName = Object.fromEntries(mgr.listForWorkspace(WS).map((r) => [r.name, r.ephemeral]));
  assert.deepStrictEqual(byName, { 'team-hand-1': true, lead: false });
});
