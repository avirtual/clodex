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
  // Teams front door (teams-design.md [internal design doc, not in this repo]) — added with the front-door build.
  'teamCreate', 'teamCreateBare', 'teamJoin', 'teamForCwd', 'teamNames', 'teamRolePrompts',
  // Team-management GUI (T29 Layer A Slice 3).
  'teamGet', 'teamAddRole', 'teamSetRole', 'teamRemoveRole', 'teamRenameRole', 'teamSetWatchdog',
  // Which SEAT is the team's lead (t420) — the manifest pointer, not the role.
  'teamSetLead',
  // The manifest preflight the roles popover renders as a per-role checklist (t414).
  'teamPreflight',
  'createSession', 'listSessions', 'reservedSessionNames', 'killSession', 'archiveSession',
  'unarchiveSession', 'flushPending', 'peekPending',
  'retrySpawnSession', 'forgetSession', 'resizeSession', 'setSessionLabel',
  'showSessionContextMenu', 'exportSessionMarkdown', 'listTemplates', 'saveTemplate',
  'saveTemplateByName', 'removeTemplate', 'exportTemplate', 'listPrompts',
  'savePrompt', 'removePrompt', 'injectPrompt', 'listAgents',
  'getAgent', 'saveAgent', 'removeAgent', 'listSkillLib',
  'getSkillLib', 'saveSkillLib', 'removeSkillLib', 'listExecCommands',
  'getExecCommand', 'saveExecCommand', 'removeExecCommand', 'listNotifications',
  'markNotificationRead', 'markAllNotificationsRead', 'removeNotification', 'notificationUnreadCount',
  'checkForUpdate', 'getUpdateInfo', 'getReleases', 'openUpdate',
  'getVersion', 'getDiagnostics', 'toolsCheck', 'invalidateToolCache', 'onUpdateAvailable', 'onSessionContextAction',
  // t412: the focus decision's read of main-side draft state.
  'draftOpen',
  'writeToSession', 'selectDirectory', 'confirmKill', 'restoreSessions',
  'onPtyData', 'onSessionExit', 'onIpcMessage', 'onSessionActivity',
  // Retires the drawer status line's claim about a delivery that had not
  // happened yet — the CLI's own hook drains the queue, so the app cannot
  // observe it directly.
  'onSelectionSent',
  'onPendingCount', 'onSessionTicket', 'onSessionAttention', 'onSessionCtx', 'onSessionProxy',
  // t418: account plan quota read off our own wire's response headers, window-wide,
  // plus the startup pull that surfaces a restored reading before the first turn.
  'onWireQuota', 'getWireQuota',
  'onSessionFiles', 'sessionFiles', 'filePeek', 'fileDiff', 'fileWrite', 'fileResolve',
  // fileReveal added by t22 — reveal-in-file-manager for Manage Plugins' "Open
  // Plugins Folder", distinct from fileOpen (which opens the file itself).
  'fileOpen', 'fileReveal', 'onSessionFileView', 'openExternal',
  // sessionInfo added with the sidebar ⓘ panel — on-demand session stats
  // (compactions, the four cost scopes, transcript size).
  'sessionInfo', 'getProxySnapshot',
  'getProxyContext', 'getProxyReport', 'getProxyBust', 'proxyHold',
  'wireHold', 'setStripLevel', 'setAutoCompact',
  'onSessionMention', 'onRequestSwitchSession', 'onRequestOpenNewDialog', 'onRequestOpenDiscovery', 'onRequestRenameWorkspace',
  'onRequestOpenPreferences', 'onRequestOpenPeersDialog', 'onRequestOpenPeerSession', 'onRequestOpenAgentsDrawer',
  'onRequestOpenSkillsDrawer', 'onRequestOpenExecDrawer', 'onRequestOpenInboxDrawer', 'onRequestOpenPromptsDrawer',
  'onRequestOpenTemplatesDrawer', 'onRequestOpenIpcLog', 'getSettings', 'setTheme',
  'onSetTheme', 'setSettings', 'onZoomNudge', 'setDefaultToolDeny',
  // t598: playback of a spoken reply started/ended, so the renderer's turn-end
  // re-arm can wait the narration out instead of transcribing it.
  'onSpeakerBusy',
  'openWirescope', 'wirescopeStatus', 'wirescopeStart', 'wirescopeStop',
  'wirescopeRestart', 'wirescopePruneInfo', 'wirescopePrune', 'remoteStatus',
  'remoteSetToken',
  'peerProbe', 'peerDeploy', 'peerDeployConfig', 'peerDeployFix',
  'onPeerDeployLine', 'peerList', 'peerAttach', 'peerDetach',
  // t32 step 4: the contexts→peers import. Preview returns token STATE and apply
  // takes context NAMES — no token value crosses this surface, which is why both
  // halves are IPC calls rather than a dialog that imports rows itself.
  'peerImportPreview', 'peerImportApply',
  'peerAttachedNames', 'peerForgetAttached', 'peerSetDisabled', 'peerSetRelayAllowed',
  // The peer-terminal grant (t219). UNGATED, unlike the peer:wterm* channels
  // below: this writes a setting on THIS box, it does not open a shell.
  'peerSetShellAllowed',
  'peerControlledNames', 'peerForgetControlled', 'peerVisible', 'peerSetVisible',
  'peerControl', 'peerResize', 'peerInput', 'peerQuery',
  'peerRestart', 'peerCreateSession', 'peerCatalogs', 'peerKillSession', 'peerRestartSession',
  'peerSessionArgs', 'peerSetSessionArgs', 'peerSkillCatalog', 'peerSetSessionSkills',
  // Peer terminal (t219). The four calls take the composite `name@peerId` key;
  // the four listeners carry the bare seat back, since that is what the wire
  // used. Registered behind enableDrawerServices — and since t227 that is NO
  // LONGER the same gate the local wterm family uses: this one opens a shell on
  // a third machine, which no local session channel can reach.
  'peerWtermOpen', 'peerWtermResize', 'peerWtermClose', 'peerWtermInput',
  'onPeerWtermReplay', 'onPeerWtermData', 'onPeerWtermExit', 'onPeerWtermClosed',
  // The serving side of the same feature: which of OUR seats a peer is watching.
  'onServedTerminals', 'onPeerShellAllowed',
  'onPeerState', 'onPeerActivity', 'onPeerReplay', 'onPeerData',
  'onPeerResize', 'onPeerUi', 'showPeerContextMenu', 'showPeerHeaderMenu',
  'confirmPeerRestart', 'confirmPeerUpdate', 'confirmDeployFix', 'confirmPeerKill',
  'confirmPeerReload', 'onPeerContextAction', 'onPeerTelemetry', 'onPeerControlChange',
  'onPeerExit', 'onPeerRemoved', 'onPeerDisabled', 'onPeerTunnel',
  // Peer web view (t30b): open/close the on-demand ssh forward to a peer's
  // browser frontend, plus its live state.
  'peerOpenWeb', 'peerCloseWeb', 'onPeerWebTunnel',
  'onSessionPeerControl', 'getSessionArgs', 'getSessionHistory', 'discoverSessions', 'setSessionArgs',
  'restartSession', 'setSessionTools', 'setSessionSkills', 'setSessionAgents',
  'setSessionIntents', 'getSkillCatalog', 'getAgentCatalog', 'getSkillCatalogFor',
  'getToolCatalogFor', 'listWorkspaces', 'currentWorkspace', 'setWorkspaceName',
  // The voice-mode selector's read of ~/.claude/settings.json, and the direct
  // write beside it. Box-wide: neither takes a session name, and the write is
  // the reason both surfaces work with no Claude session open.
  'getVoiceMode',
  'setVoiceMode',
  'markVoiceOrigin',
  // The withdrawal of that marker when the submit it was armed for stands down.
  // A send like its neighbour: the abandon paths are keystroke paths too.
  'unmarkVoiceOrigin',
  // The renderer telling main the CLI's recorder is lit, so the inject
  // quiet-gate defers while the operator is DICTATING as it already does while
  // he types. A send and repeated on the level, so main can expire it.
  'noteVoiceRecording',
  // The same seat's dictated draft still sitting unsent after the recorder went
  // dark — a second level report, because the recorder's answers a different
  // question and expires far sooner.
  'noteVoiceDraft',
  // Which seat the renderer is showing, and the external ensure-on tap that
  // routes by it. Main knows the focused WINDOW and never the focused pane, so
  // a trigger arriving from outside the app had no seat to aim at.
  'noteFocusedSession',
  'onVoiceTap',
  // Which seat holds the microphone, box-wide. The broadcast plus the pull a
  // window that opened mid-dictation needs, since the target does not move
  // again while the operator keeps talking to the seat he already picked.
  'onMicTarget', 'micTarget',
  // Whether Clodex is the frontmost APPLICATION — the second condition on the
  // automatic re-arm. Same broadcast-plus-pull pair, and it cannot be answered
  // in the renderer: a window reports focus while the app sits behind a browser.
  'onAppFocused', 'appFocused',
  'newWorkspace',
  // Managed Docker sandbox (sandbox-plan.md [internal design doc, not in this repo] M2) — appended deliberately as
  // the surface grew past the ffe1161 snapshot; the count below moved with it.
  'sandboxDetect', 'sandboxStatus', 'sandboxGetConfig', 'sandboxSetConfig',
  'sandboxTranslatePath',
  'sandboxUp', 'sandboxRebuild', 'sandboxDown', 'sandboxLogsTail', 'sandboxSetToken',
  'sandboxClearToken', 'sandboxListBoxes', 'sandboxCreateBox', 'sandboxDeleteBox',
  'onRequestOpenSandboxDialog',
  // Opt-in git worktree at session spawn + New Session working-directory
  // suggestions (recent MRU + popular). Appended deliberately as the surface grew.
  'createWorktree', 'worktreeInfo', 'markSessionWorktree',
  'cwdSuggestions', 'noteCwd',
  // Sidebar organization: per-session meta (timestamps + git/PR status) +
  // per-workspace view-state persistence (group/sort/filter/search).
  'sidebarMeta', 'getSidebarView', 'setSidebarView',
  // No workbench rows: it is a PLUGIN (plugins/workbench/) and owns its own
  // fifteen, dispatched over the plugin transport's five rows below. The
  // migration took this list 235 -> 220 — a feature leaving core took its API
  // surface with it, which is the pilot's whole claim.
  // Scoped env vars for wrapper PTYs (T46) — global/workspace editor +
  // New Session dialog. get masks secret values.
  'envScopesGet', 'envScopesSet', 'envScopesDelete',
  // Plugin transport (plugin-plan.md [internal design doc, not in this repo] §1) — the five rows that carry EVERY
  // plugin, present and future, plus the intent catalog moving from a static
  // renderer require to an IPC read (§2.3 R-INT-4).
  'pluginInvoke', 'pluginCatalog', 'pluginSetEnabled', 'onPluginEvent',
  'getIntentCatalog',
  // t190: per-session plugin capability grants. NOT part of the five-row plugin
  // transport — these are core chrome editing a core persistence field, the same
  // shape as setIntents, and no plugin can reach them.
  'getSessionPluginGrants', 'setSessionPluginGrants',
  // T5: the Plugins menu's "Manage Plugins…" open request. Core chrome opening
  // a core dialog — the same shape as onRequestOpenPeersDialog — so it does NOT
  // widen the plugin transport, which is still exactly the five rows above.
  'onRequestOpenPluginsDialog',
  'onRequestOpenTeamRoles', 'onRequestOpenTeamCreate',
  // t209: the wire-fed subagent Activity feed, which REPLACED the proxy-polled
  // `getProxySubagentDetail` on this surface rather than joining it — it reads a
  // per-session ring Clodex fills from its own tee, so it needs no wirescope
  // link. Net zero rows, which is why the count below is unchanged.
  'getSubagentFeed',
  // t214: the drawer's clodexctl REPL. These two rows are on the surface for
  // BOTH hosts, which is not the same as being reachable on both — the contract
  // is a binding table, and `ctl:*` registration is gated on
  // enableDrawerServices (test/drawer-services-seam.test.js asserts the web-host
  // map has neither). So the web build binds `ctlRun` to a channel with no
  // handler behind it, deliberately.
  'ctlRun', 'ctlContext', 'ctlHelp',
  // t645: the Bash console's pull. Same gated-registration story as `ctl:*` —
  // bound on both surfaces, registered only where drawer services are granted.
  'consoleRead',
  // t650: its in-flight half. Same story again — the live preview of a Bash
  // call that has not finished, registered behind the same drawer-services gate.
  'consoleLive',
  // These four ARE reachable on both hosts (t227) — the exception to the
  // paragraph above, not another instance of it. Their gate is
  // `enableLocalTerminal`, which the web host grants, because a web client
  // can already spawn the same shell through `session:create`.
  'wtermSpawn', 'wtermWrite', 'wtermResize', 'onWtermData',
  // The drawer selection as a wirescope tail hint. Same gated-registration
  // story as the two families above, with a sharper reason for the gate: this
  // is the only drawer channel that writes caller-supplied text into an
  // agent's next request rather than running something on the host.
  'drawerArmSelection', 'drawerReleaseSelection', 'drawerInspectSelection',
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

test('contract covers exactly the pinned 275-method surface', () => {
  assert.equal(PINNED_NAMES.length, 275, 'pinned list is the full 275-method surface');
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
    assert.equal(generated.length, 275, 'window.api has exactly 275 methods');
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

// Register with capturing transport seams (as main.js/web-host do) onto a Proxy
// of inert stubs, so registration runs without electron or real deps —
// registration only calls handle()/on(); handler bodies never execute here.
function captureRegistrations() {
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
  return registered;
}

// Main→renderer pushes, so they are NOT ipcMain registrations and must be
// excluded from both directions below. `kind: 'on'` names a renderer-side
// subscription; `deps.on` is ipcMain.on, which carries `kind: 'send'`. Same
// word, opposite direction — comparing registrations against all 239 rows
// would report every one of these as missing.
const CALLABLE_KINDS = ['invoke', 'send'];

test('every invoke channel has a registered handler in ipc-handlers', () => {
  const registered = captureRegistrations();
  const invokeChannels = API_CONTRACT.filter((r) => r.kind === 'invoke').map((r) => r.channel);
  const missing = invokeChannels.filter((ch) => !registered.has(ch));
  assert.deepEqual(missing, [], `invoke channels with no registered handler: ${missing}`);
});

// The inverse of the test above, and the one that matters for surface control:
// that one proves the table's rows are all backed by handlers, which says
// nothing about a handler registered outside the table. An uncontracted channel
// is invisible to preload and api-shim (both build window.api by looping the
// table) yet fully live over web-host, which dispatches any registered channel
// by name without consulting the contract. So the gap it closes is exactly the
// one nothing else can see: reachable, unreviewed, and unreferenced by the
// surface definition. `session:listAll` sat here handing an authenticated
// connection every workspace's sessions while bound to one.
test('every registered ipc-handlers channel appears in the contract', () => {
  const registered = captureRegistrations();
  const contracted = new Set(
    API_CONTRACT.filter((r) => CALLABLE_KINDS.includes(r.kind)).map((r) => r.channel),
  );
  const uncontracted = [...registered].filter((ch) => !contracted.has(ch));
  assert.deepEqual(uncontracted, [], `channels registered in ipc-handlers but absent from api-contract.js: ${uncontracted}`);
});

// Channels web-host registers on TOP of registerIpcHandlers, each with the
// reason it is not in the contract. An entry here is a deliberate exemption;
// anything else web-host adds fails the test below until it is listed or
// contracted.
const WEB_HOST_ONLY = {
  // web-host.js:218-219 — "Deliberately absent from api-contract: reached by a
  // raw invoke, so the desktop surface stays untouched." Restart is meaningful
  // only for a browser client whose host process it re-execs.
  'app:restart': 'browser-only; reached by raw invoke so the desktop surface stays untouched',
};

test('web-host registers nothing uncontracted beyond its allowlist', () => {
  // The real createWebHost, with registerIpcHandlers stubbed out: this isolates
  // what web-host adds ITSELF, so the assertion cannot be satisfied by a channel
  // that merely happens to be contracted elsewhere.
  const { createWebHost } = require('../web-host');
  const host = createWebHost({
    engine: { stores: {} },
    log: { info() {}, warn() {}, error() {} },
    port: 0,
    host: '127.0.0.1',
    userDataPath: require('node:os').tmpdir(),
    registerHandlers: () => {},
  });
  try {
    const own = [...host._handlers.keys()];
    const unexpected = own.filter((ch) => !(ch in WEB_HOST_ONLY));
    assert.deepEqual(unexpected, [], `web-host channels neither contracted nor allowlisted: ${unexpected}`);
    // The allowlist decays into a comment if nothing proves its entries are
    // live: an entry for a channel web-host no longer registers would sit here
    // exempting nothing.
    for (const ch of Object.keys(WEB_HOST_ONLY)) {
      assert.ok(host._handlers.has(ch), `allowlisted channel ${ch} is no longer registered by web-host — drop the entry`);
    }
  } finally {
    host.close();
  }
});
