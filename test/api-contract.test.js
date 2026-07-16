'use strict';
// api-contract.test.js — pins the window.api surface across the api-contract
// refactor (web-frontend Phase 3b). preload.js and renderer/web/api-shim.js both
// build window.api by looping api-contract.js; these tests prove the table is
// well-formed, unambiguous, and covers EXACTLY the surface the hand-written
// preload exposed at commit ffe1161 — so the refactor is provably shape-preserving
// — and that every invoke channel actually has a registered handler.

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const { API_CONTRACT } = require('../api-contract');

// The 165 window.api method names as they existed in the hand-written preload.js
// immediately BEFORE the table refactor (git ffe1161). Kept literal and separate
// from api-contract.js on purpose: if a change drops, renames, or adds a method
// this list must be updated deliberately, and the mismatch is caught here.
const PINNED_NAMES = [
  'createSession', 'listSessions', 'killSession', 'archiveSession',
  'unarchiveSession', 'flushPending',
  'retrySpawnSession', 'forgetSession', 'resizeSession', 'setSessionLabel',
  'showSessionContextMenu', 'exportSessionMarkdown', 'listTemplates', 'saveTemplate',
  'saveTemplateByName', 'removeTemplate', 'exportTemplate', 'listPrompts',
  'savePrompt', 'removePrompt', 'injectPrompt', 'listAgents',
  'getAgent', 'saveAgent', 'removeAgent', 'listSkillLib',
  'getSkillLib', 'saveSkillLib', 'removeSkillLib', 'listExecCommands',
  'getExecCommand', 'saveExecCommand', 'removeExecCommand', 'listNotifications',
  'markNotificationRead', 'markAllNotificationsRead', 'removeNotification', 'notificationUnreadCount',
  'checkForUpdate', 'getUpdateInfo', 'getReleases', 'openUpdate',
  'getVersion', 'getDiagnostics', 'onUpdateAvailable', 'onSessionContextAction',
  'writeToSession', 'selectDirectory', 'confirmKill', 'restoreSessions',
  'onPtyData', 'onSessionExit', 'onIpcMessage', 'onSessionActivity',
  'onPendingCount', 'onSessionAttention', 'onSessionCtx', 'onSessionProxy',
  'onSessionFiles', 'sessionFiles', 'filePeek', 'fileDiff',
  'fileOpen', 'onSessionFileView', 'openExternal', 'getProxySnapshot',
  'getProxyContext', 'getProxyReport', 'getProxyBust', 'proxyHold',
  'wireHold', 'setStripLevel', 'setAutoCompact', 'getProxySubagentDetail',
  'onSessionMention', 'onRequestSwitchSession', 'onRequestOpenNewDialog', 'onRequestOpenDiscovery', 'onRequestRenameWorkspace',
  'onRequestOpenPreferences', 'onRequestOpenPeersDialog', 'onRequestOpenPeerSession', 'onRequestOpenAgentsDrawer',
  'onRequestOpenSkillsDrawer', 'onRequestOpenExecDrawer', 'onRequestOpenInboxDrawer', 'onRequestOpenPromptsDrawer',
  'onRequestOpenTemplatesDrawer', 'onRequestOpenIpcLog', 'getSettings', 'setTheme',
  'onSetTheme', 'setSettings', 'onZoomNudge', 'setDefaultToolDeny',
  'openWirescope', 'wirescopeStatus', 'wirescopeStart', 'wirescopeStop',
  'wirescopeRestart', 'wirescopePruneInfo', 'wirescopePrune', 'remoteStatus',
  'remoteSetToken',
  'peerProbe', 'peerDeploy', 'peerDeployConfig', 'peerDeployFix',
  'onPeerDeployLine', 'peerList', 'peerAttach', 'peerDetach',
  'peerAttachedNames', 'peerForgetAttached', 'peerSetDisabled', 'peerSetRelayAllowed',
  'peerControlledNames', 'peerForgetControlled', 'peerVisible', 'peerSetVisible',
  'peerControl', 'peerResize', 'peerInput', 'peerQuery',
  'peerRestart', 'peerCreateSession', 'peerCatalogs', 'peerKillSession', 'peerRestartSession',
  'peerSessionArgs', 'peerSetSessionArgs', 'peerSkillCatalog', 'peerSetSessionSkills',
  'onPeerState', 'onPeerActivity', 'onPeerReplay', 'onPeerData',
  'onPeerResize', 'onPeerUi', 'showPeerContextMenu', 'showPeerHeaderMenu',
  'confirmPeerRestart', 'confirmPeerUpdate', 'confirmDeployFix', 'confirmPeerKill',
  'confirmPeerReload', 'onPeerContextAction', 'onPeerTelemetry', 'onPeerControlChange',
  'onPeerExit', 'onPeerRemoved', 'onPeerDisabled', 'onPeerTunnel',
  'onSessionPeerControl', 'getSessionArgs', 'getSessionHistory', 'discoverSessions', 'setSessionArgs',
  'restartSession', 'setSessionTools', 'setSessionSkills', 'setSessionAgents',
  'setSessionIntents', 'getSkillCatalog', 'getAgentCatalog', 'getSkillCatalogFor',
  'getToolCatalogFor', 'listWorkspaces', 'currentWorkspace', 'setWorkspaceName',
  'newWorkspace',
  // Managed Docker sandbox (docs/sandbox-plan.md M2) — appended deliberately as
  // the surface grew past the ffe1161 snapshot; the count below moved with it.
  'sandboxDetect', 'sandboxStatus', 'sandboxGetConfig', 'sandboxSetConfig',
  'sandboxTranslatePath',
  'sandboxUp', 'sandboxRebuild', 'sandboxDown', 'sandboxLogsTail', 'sandboxSetToken',
  'sandboxClearToken', 'sandboxListBoxes', 'sandboxCreateBox', 'sandboxDeleteBox',
  'onRequestOpenSandboxDialog',
  // Boiling pot (docs/boiling-pot-plan.md) — cross-agent file-heat snapshot.
  'potSnapshot',
  // Opt-in git worktree at session spawn + New Session working-directory
  // suggestions (recent MRU + popular). Appended deliberately as the surface grew.
  'createWorktree', 'worktreeInfo', 'markSessionWorktree',
  'cwdSuggestions', 'noteCwd',
  // Sidebar organization: per-session meta (timestamps + git/PR status) +
  // per-workspace view-state persistence (group/sort/filter/search).
  'sidebarMeta', 'getSidebarView', 'setSidebarView',
  // Workbench popover: source control, worktree management, file explorer/editor,
  // plus its single View-menu / toolbar open event.
  'scmStatus', 'scmDiff', 'scmStage', 'scmUnstage', 'scmDiscard', 'scmCommit',
  'scmBranches', 'scmCheckout', 'scmRemote', 'worktreeList', 'worktreeRemove',
  'fsList', 'fsRead', 'fsWrite',
  'onRequestOpenWorkbench',
];

test('table is well-formed: every row has name, valid kind, non-empty channel', () => {
  for (const row of API_CONTRACT) {
    assert.equal(typeof row.name, 'string', `name is a string: ${JSON.stringify(row)}`);
    assert.ok(row.name.length, `name non-empty: ${JSON.stringify(row)}`);
    assert.ok(['invoke', 'send', 'on'].includes(row.kind), `kind valid for ${row.name}: ${row.kind}`);
    assert.equal(typeof row.channel, 'string', `channel is a string for ${row.name}`);
    assert.ok(row.channel.length, `channel non-empty for ${row.name}`);
    if ('argmap' in row) {
      assert.equal(typeof row.argmap, 'function', `argmap (if present) is a function for ${row.name}`);
      assert.notEqual(row.kind, 'on', `argmap only on invoke/send, not on (${row.name})`);
    }
  }
});

test('no duplicate names and no duplicate channels', () => {
  const names = API_CONTRACT.map((r) => r.name);
  const channels = API_CONTRACT.map((r) => r.channel);
  assert.equal(new Set(names).size, names.length, 'names are unique');
  assert.equal(new Set(channels).size, channels.length, 'channels are unique');
});

test('contract covers exactly the pinned 210-method surface', () => {
  assert.equal(PINNED_NAMES.length, 210, 'pinned list is the full 210-method surface');
  const contractNames = new Set(API_CONTRACT.map((r) => r.name));
  const pinned = new Set(PINNED_NAMES);
  const missing = [...pinned].filter((n) => !contractNames.has(n));
  const extra = [...contractNames].filter((n) => !pinned.has(n));
  assert.deepEqual(missing, [], `methods present in ffe1161 but missing from the table: ${missing}`);
  assert.deepEqual(extra, [], `methods in the table but not in the pinned surface: ${extra}`);
});

test('preload builds exactly the pinned window.api surface by looping the table', () => {
  // Exercise the REAL preload loop with electron stubbed and a bare window, so
  // this asserts the generated object — not just the table it reads from.
  const fakeIpc = { invoke() {}, send() {}, on() {} };
  const origLoad = Module._load;
  const prevWindow = global.window;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { ipcRenderer: fakeIpc };
    return origLoad.call(this, request, ...rest);
  };
  global.window = {};
  try {
    delete require.cache[require.resolve('../preload.js')];
    require('../preload.js');
    const generated = Object.keys(global.window.api);
    assert.equal(generated.length, 210, 'window.api has exactly 210 methods');
    assert.deepEqual(new Set(generated), new Set(PINNED_NAMES), 'generated surface === pinned surface');
    for (const name of generated) {
      assert.equal(typeof global.window.api[name], 'function', `${name} is a function`);
    }
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../preload.js')];
    if (prevWindow === undefined) delete global.window; else global.window = prevWindow;
  }
});

test('every invoke channel has a registered handler in ipc-handlers', () => {
  // Register with capturing transport seams (as main.js/web-host do) onto a
  // Proxy of inert stubs, so registration runs without electron or real deps —
  // registration only calls handle()/on(); handler bodies never execute here.
  const registered = new Set();
  const capture = {
    handle: (ch) => registered.add(ch),
    on: (ch) => registered.add(ch),
  };
  const stub = () => () => {};
  const deps = new Proxy(capture, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // Any dep the registration touches at top level: a callable that also
      // indexes to callables, harmless since no handler body runs.
      return stub();
    },
  });
  const { registerIpcHandlers } = require('../ipc-handlers');
  registerIpcHandlers(deps);

  const invokeChannels = API_CONTRACT.filter((r) => r.kind === 'invoke').map((r) => r.channel);
  const missing = invokeChannels.filter((ch) => !registered.has(ch));
  assert.deepEqual(missing, [], `invoke channels with no registered handler: ${missing}`);
});
