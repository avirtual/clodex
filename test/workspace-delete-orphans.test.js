'use strict';
// workspace-delete-orphans.test.js — Delete Workspace… must not strand a
// workspace's archived/saved seats, and must not call that case "empty" (F005).
//
// WHY THIS NEEDED A NEW FILE RATHER THAN AN ASSERTION IN AN EXISTING ONE.
// Both halves of the old teardown were correct and tested: killing the running
// sessions works, removing the workspace record works. What nothing owned was
// the seam — that `listForWorkspace` is the LIVE map, so an archived seat is
// killed by nothing, its persistence row is removed by nothing, and the
// workspace it points at is removed anyway. The row that survives is then
// unreachable from every surface (listings are workspace-scoped; discovery
// skips any sessionId the row itself makes "tracked").
//
// SO THE FIXTURE CONSTRUCTS THE ORPHANED STATE, it does not assert the fixed
// behaviour against a state that cannot produce the bug: a persisted, ARCHIVED
// record carrying the workspace id, with no live session — which is exactly
// what "archive a session, then delete its workspace" leaves behind.
//
// REAL on both ends, for the reason app-menus-plugins.test.js gives about
// fakeUiSettings: the store is the thing that either keeps or drops the row, so
// a fake persistence would assert the fake. This uses the REAL stores.js
// persistence over a throwaway userData dir and the REAL SessionManager, and
// fires the REAL menu item's click handler. Only `electron` is stubbed, because
// app-menus.js requires it at module load.

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initStores } = require('../stores.js');
const { createSessionManager } = require('../session-manager.js');
const { deleteWorkspaceDetail } = require('../app-menus.js');

// ── Fixtures ────────────────────────────────────────────────────────────────

function realPersistence() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-wsdel-'));
  return initStores(dir, {
    log: { info: () => {}, error: () => {} },
    registryDir: path.join(dir, 'registry'),
    resourcesDir: path.join(dir, '__no_seed__'), // absent on purpose: suppresses library seeding
  }).persistence;
}

// The real SessionManager with no PTY anywhere near it — same minimal dep set
// session-manager.test.js's mk() uses, plus the real persistence store. The
// live map stays empty, which IS the fixture: the workspace's seats are
// archived, so a correct implementation must find them without it.
function realManager(persistence) {
  const SessionManager = createSessionManager({
    getRemoteServer: () => null,
    // Silent, but WIRED: purgeWorkspace logs what it dropped, and production
    // always passes a logger — an undefined seam here would fail the test for a
    // reason that has nothing to do with the workspace.
    log: { info: () => {}, warn: () => {}, error: () => {} },
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    notifyOS: () => {},
    intentEnabled: require('../intent-catalog').intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    fencedLines: require('../intent-scanner').fencedLines,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fs: require('node:fs'),
    countPending: require('../pending-store').countPending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    termAvailableFor: require('../drawer-avail').termAvailableFor,
  });
  return new SessionManager();
}

// Build the TRAY menu with electron stubbed and hand back the captured
// template plus the dialog options the Delete item shows. The stub is live
// while buildTrayMenu RUNS (not only while app-menus loads) because the click
// handler calls dialog.showMessageBox at fire time.
function trayMenuWith({ manager, workspaces, response = 0 }) {
  const dialogCalls = [];
  const stub = {
    app: { getName: () => 'Clodex', getVersion: () => '0.0.0', setAboutPanelOptions: () => {} },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    Menu: { buildFromTemplate: (t) => t, setApplicationMenu: () => {} },
    Tray: function Tray() {},
    dialog: { showMessageBox: async (...args) => { dialogCalls.push(args[args.length - 1]); return { response }; } },
    shell: {},
    nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
  };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return stub;
    return origLoad.call(this, request, ...rest);
  };
  let template;
  try {
    delete require.cache[require.resolve('../app-menus.js')];
    const { createAppMenus } = require('../app-menus.js');
    const nothing = () => ({ list: () => [], get: () => ({}), sortedByRecent: () => [], statuses: () => [] });
    const menus = createAppMenus({
      DEFAULT_WORKSPACE_ID: 'default', LOG_FILE: '/dev/null', THEME_KEYS: [], path,
      checkForUpdate: () => {}, confirmRestartClodex: () => {}, createWindow: () => null,
      getManager: () => manager, getPeerManager: () => null, getSandboxManager: () => null,
      getUpdateInfo: () => null, getUiSettings: nothing, getWorkspaces: () => workspaces,
      getAgentLibrary: nothing, getSkillLibrary: nothing, getEnvScopes: () => null,
      getPluginHost: () => null,
    });
    template = menus.buildTrayMenu();
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../app-menus.js')];
  }
  return { template, dialogCalls };
}

function fakeWorkspaces(list) {
  const removed = [];
  return {
    removed,
    list: () => list,
    get: (id) => list.find(w => w.id === id) || null,
    sortedByRecent: () => list,
    remove: (id) => { removed.push(id); },
  };
}

// Walk the tray template to the Delete item for a workspace, by the labels a
// user actually reads.
function deleteItemFor(template, wsName) {
  const recent = template.find(i => i && i.label === 'Recent Workspaces');
  assert.ok(recent, 'tray menu has a Recent Workspaces section');
  const entry = recent.submenu.find(i => i && typeof i.label === 'string' && i.label.includes(wsName));
  assert.ok(entry, `Recent Workspaces lists ${wsName}`);
  const del = entry.submenu.find(i => i && i.label === 'Delete Workspace…');
  assert.ok(del, 'the workspace submenu has Delete Workspace…');
  return del;
}

// ── The orphan ──────────────────────────────────────────────────────────────

test('deleting a workspace whose seats are ARCHIVED drops their records, and does not touch another workspace', async () => {
  const persistence = realPersistence();
  // The state the bug needs: two archived seats in ws-1 (never in the live
  // map), one live-shaped record in ws-2 that must survive.
  persistence.upsert({ name: 'seat-a', type: 'claude', cwd: '/tmp', workspaceId: 'ws-1', sessionId: 'sid-a' });
  persistence.upsert({ name: 'seat-b', type: 'claude', cwd: '/tmp', workspaceId: 'ws-1', sessionId: 'sid-b' });
  persistence.upsert({ name: 'other', type: 'claude', cwd: '/tmp', workspaceId: 'ws-2', sessionId: 'sid-c' });
  persistence.setArchived('seat-a', true);
  persistence.setArchived('seat-b', true);

  const manager = realManager(persistence);
  // Precondition, stated so a future refactor that makes list() persistence-
  // backed does not turn this test vacuous: the live map cannot see them.
  assert.deepStrictEqual(manager.listForWorkspace('ws-1'), [], 'archived seats are NOT in the live map');
  assert.strictEqual(manager.savedForWorkspace('ws-1').length, 2, 'but persistence holds two of them');

  const workspaces = fakeWorkspaces([{ id: 'ws-1', name: 'Doomed' }]);
  const { template, dialogCalls } = trayMenuWith({ manager, workspaces, response: 0 });
  await deleteItemFor(template, 'Doomed').click();

  assert.ok(!persistence.get('seat-a'), 'seat-a\'s record is gone, not orphaned');
  assert.ok(!persistence.get('seat-b'), 'seat-b\'s record is gone, not orphaned');
  assert.ok(persistence.get('other'), 'the other workspace\'s record is untouched');
  assert.deepStrictEqual(workspaces.removed, ['ws-1'], 'and the workspace record is removed');

  // No row may keep pointing at a workspace that no longer exists.
  assert.deepStrictEqual(persistence.listForWorkspace('ws-1'), []);
  // The dialog is not allowed to call this case empty.
  const detail = dialogCalls[0].detail;
  // The exact sentence the bug showed in exactly this case.
  assert.ok(!/empty workspace record/.test(detail), `dialog must not call this empty, got: ${detail}`);
  assert.ok(/2 archived or saved sessions/.test(detail), `dialog must count the archived seats, got: ${detail}`);
});

test('cancelling the dialog deletes nothing', async () => {
  const persistence = realPersistence();
  persistence.upsert({ name: 'seat-a', type: 'claude', cwd: '/tmp', workspaceId: 'ws-1', sessionId: 'sid-a' });
  persistence.setArchived('seat-a', true);

  const manager = realManager(persistence);
  const workspaces = fakeWorkspaces([{ id: 'ws-1', name: 'Spared' }]);
  const { template } = trayMenuWith({ manager, workspaces, response: 1 });
  await deleteItemFor(template, 'Spared').click();

  assert.ok(persistence.get('seat-a'), 'the record survives a cancel');
  assert.deepStrictEqual(workspaces.removed, [], 'and so does the workspace');
});

test('purgeWorkspace reports what it dropped', () => {
  const persistence = realPersistence();
  persistence.upsert({ name: 'seat-a', type: 'claude', cwd: '/tmp', workspaceId: 'ws-1' });
  persistence.setArchived('seat-a', true);
  const manager = realManager(persistence);
  const res = manager.purgeWorkspace('ws-1');
  assert.deepStrictEqual(res, { killed: [], dropped: ['seat-a'] });
  assert.deepStrictEqual(manager.purgeWorkspace('ws-1'), { killed: [], dropped: [] }, 'and is idempotent');
});

// ── The copy ────────────────────────────────────────────────────────────────
// The wording is the other half of the finding: a correct deletion behind a
// dialog that understates it is still a trap. Boundary-shaped, not an
// enumeration — the case that mattered is (running 0, saved > 0).

test('the confirm copy names both populations', () => {
  assert.match(deleteWorkspaceDetail(0, 0), /empty workspace record/);
  assert.match(deleteWorkspaceDetail(2, 0), /kill 2 running sessions/);
  assert.ok(!/archived/.test(deleteWorkspaceDetail(2, 0)), 'no archived clause when there are none');

  const savedOnly = deleteWorkspaceDetail(0, 1);
  assert.ok(!/empty workspace record/.test(savedOnly), 'the total-loss case is never called empty');
  assert.match(savedOnly, /1 archived or saved session\b/);

  const both = deleteWorkspaceDetail(1, 3);
  assert.match(both, /kill 1 running session\b/);
  assert.match(both, /3 archived or saved sessions/);
});
