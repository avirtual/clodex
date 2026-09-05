'use strict';
// api-contract.js — the single source of truth for the `window.api` surface:
// one row per endpoint, `{ name, kind, channel, argmap? }`. Both frontends build
// their `window.api` by looping this table so the two are provably the same shape:
//
//   • preload.js (Electron)  — each row → an ipcRenderer.invoke/send/on binding.
//   • renderer/web/api-shim.js (browser) — each row → a WS request/frame/subscription.
//
// `kind` is one of:
//   'invoke' → returns a Promise of the handler's result (request/reply).
//   'send'   → fire-and-forget renderer→main message, returns undefined.
//   'on'     → subscribe: takes a callback, invoked with the event args (no event
//              object) each time the channel fires.
//
// `argmap` (optional, invoke/send only) maps the caller's positional arguments to
// the wire arguments array. Absent = passthrough (the caller's args ARE the wire
// args). Only non-passthrough wrappers need it; today that is exactly one endpoint
// (showSessionContextMenu, which bundles its two args into a single object).
//
// This is a pure leaf: no requires, no side effects, no environment assumptions —
// safe to load in the Electron preload, in a plain Node test, and in the browser
// bundle. Adding a `window.api` method means adding a row HERE, nowhere else.

const API_CONTRACT = [
  { name: 'createSession', kind: 'invoke', channel: 'session:create' },
  // Teams front door: write the team manifest, then spawn.
  // teamCreate adopts the new session as lead; teamJoin adds a role + spawns a seat.
  { name: 'teamCreate', kind: 'invoke', channel: 'team:create' },
  { name: 'teamJoin', kind: 'invoke', channel: 'team:join' },
  // t288: the manifest write WITHOUT a spawn — the Teams menu's Create Team…,
  // where there is no session to adopt as lead. Separate from teamCreate because
  // that one is indivisible by design (write, then spawn the lead in one step).
  { name: 'teamCreateBare', kind: 'invoke', channel: 'team:createBare' },
  // Does a cwd already resolve to a team? Drives the dialog's create-vs-join mode.
  { name: 'teamForCwd', kind: 'invoke', channel: 'team:forCwd' },
  // Existing team names for the create-mode duplicate pre-check.
  { name: 'teamNames', kind: 'invoke', channel: 'team:names' },
  // Rail-filtered role-prompt picker source for the join flow (stock clodex-team-*
  // deltas + library prompts whose front matter declares rail: append).
  { name: 'teamRolePrompts', kind: 'invoke', channel: 'team:rolePrompts' },
  // Team-management GUI (T29 Layer A Slice 3): read the full manifest, and the
  // metadata mutators the management popover drives. addRole owns the C1/C4
  // guards; set/remove/rename/watchdog are the Slice-2 backend handlers.
  { name: 'teamGet', kind: 'invoke', channel: 'team:get' },
  { name: 'teamAddRole', kind: 'invoke', channel: 'team:addRole' },
  { name: 'teamSetRole', kind: 'invoke', channel: 'team:setRole' },
  { name: 'teamRemoveRole', kind: 'invoke', channel: 'team:removeRole' },
  { name: 'teamRenameRole', kind: 'invoke', channel: 'team:renameRole' },
  { name: 'teamSetWatchdog', kind: 'invoke', channel: 'team:setWatchdog' },
  // Which SEAT is the team's lead (t420) — the manifest's top-level pointer, not
  // the reserved `lead` ROLE (that stays locked). The only door to a team whose
  // lead names a seat that was never created.
  { name: 'teamSetLead', kind: 'invoke', channel: 'team:setLead' },
  // What this team's manifest names that resolves to nothing (missing role
  // prompts, templates, exec scripts, append stems), as findings the roles
  // popover renders per role. Read-only and OFF the hot path — it stats files
  // and parses template/exec JSON, so it belongs to a popover open or a team
  // create, never to a roster render.
  { name: 'teamPreflight', kind: 'invoke', channel: 'team:preflight' },
  // Opt-in git worktree at spawn + working-dir suggestions for the New Session
  // dialog. createWorktree/worktreeInfo/markSessionWorktree drive the worktree
  // row; cwdSuggestions/noteCwd feed the working-directory MRU datalist.
  { name: 'createWorktree', kind: 'invoke', channel: 'worktree:create' },
  { name: 'worktreeInfo', kind: 'invoke', channel: 'worktree:info' },
  { name: 'markSessionWorktree', kind: 'invoke', channel: 'session:markWorktree' },
  { name: 'cwdSuggestions', kind: 'invoke', channel: 'session:cwdSuggestions' },
  { name: 'noteCwd', kind: 'invoke', channel: 'session:noteCwd' },
  // The workbench's fourteen rows (scm:* ×9, worktree:list/remove, fs:* ×3) were
  // here until it moved out. The workbench is a PLUGIN now: it registers
  // those rows itself and they ride the one multiplexed plugin
  // transport, so the contract shrank by fourteen instead of growing by them.
  // That is the whole point of the pilot — the surface a feature costs core
  // should go to zero when the feature moves out, not stay as a permanent tax.
  { name: 'listSessions', kind: 'invoke', channel: 'session:list' },
  { name: 'reservedSessionNames', kind: 'invoke', channel: 'session:reservedNames' },
  { name: 'killSession', kind: 'invoke', channel: 'session:kill' },
  { name: 'archiveSession', kind: 'invoke', channel: 'session:archive' },
  { name: 'unarchiveSession', kind: 'invoke', channel: 'session:unarchive' },
  { name: 'flushPending', kind: 'invoke', channel: 'session:flushPending' },
  { name: 'peekPending', kind: 'invoke', channel: 'session:peekPending' },
  { name: 'retrySpawnSession', kind: 'invoke', channel: 'session:retrySpawn' },
  { name: 'forgetSession', kind: 'invoke', channel: 'session:forget' },
  { name: 'resizeSession', kind: 'invoke', channel: 'session:resize' },
  { name: 'setSessionLabel', kind: 'invoke', channel: 'session:setLabel' },
  { name: 'showSessionContextMenu', kind: 'send', channel: 'session:context-menu', argmap: (name, cwd) => [{ name, cwd }] },
  { name: 'exportSessionMarkdown', kind: 'invoke', channel: 'session:exportMarkdown' },
  { name: 'listTemplates', kind: 'invoke', channel: 'templates:list' },
  { name: 'saveTemplate', kind: 'invoke', channel: 'templates:save' },
  { name: 'saveTemplateByName', kind: 'invoke', channel: 'templates:saveByName' },
  { name: 'removeTemplate', kind: 'invoke', channel: 'templates:remove' },
  { name: 'exportTemplate', kind: 'invoke', channel: 'templates:exportFromSession' },
  { name: 'listPrompts', kind: 'invoke', channel: 'prompts:list' },
  { name: 'savePrompt', kind: 'invoke', channel: 'prompts:save' },
  { name: 'removePrompt', kind: 'invoke', channel: 'prompts:remove' },
  { name: 'injectPrompt', kind: 'invoke', channel: 'prompts:inject' },
  { name: 'listAgents', kind: 'invoke', channel: 'agents:list' },
  { name: 'getAgent', kind: 'invoke', channel: 'agents:get' },
  { name: 'saveAgent', kind: 'invoke', channel: 'agents:save' },
  { name: 'removeAgent', kind: 'invoke', channel: 'agents:remove' },
  { name: 'listSkillLib', kind: 'invoke', channel: 'skilllib:list' },
  { name: 'getSkillLib', kind: 'invoke', channel: 'skilllib:get' },
  { name: 'saveSkillLib', kind: 'invoke', channel: 'skilllib:save' },
  { name: 'removeSkillLib', kind: 'invoke', channel: 'skilllib:remove' },
  { name: 'listExecCommands', kind: 'invoke', channel: 'exec:list' },
  { name: 'getExecCommand', kind: 'invoke', channel: 'exec:get' },
  { name: 'saveExecCommand', kind: 'invoke', channel: 'exec:save' },
  { name: 'removeExecCommand', kind: 'invoke', channel: 'exec:remove' },
  { name: 'listNotifications', kind: 'invoke', channel: 'notifications:list' },
  { name: 'markNotificationRead', kind: 'invoke', channel: 'notifications:markRead' },
  { name: 'markAllNotificationsRead', kind: 'invoke', channel: 'notifications:markAllRead' },
  { name: 'removeNotification', kind: 'invoke', channel: 'notifications:remove' },
  { name: 'notificationUnreadCount', kind: 'invoke', channel: 'notifications:unreadCount' },
  { name: 'checkForUpdate', kind: 'invoke', channel: 'update:check' },
  { name: 'getUpdateInfo', kind: 'invoke', channel: 'update:info' },
  { name: 'getReleases', kind: 'invoke', channel: 'update:releases' },
  { name: 'openUpdate', kind: 'invoke', channel: 'update:open' },
  { name: 'getVersion', kind: 'invoke', channel: 'app:getVersion' },
  { name: 'getDiagnostics', kind: 'invoke', channel: 'diagnostics:get' },
  { name: 'toolsCheck', kind: 'invoke', channel: 'tools:check' },
  { name: 'invalidateToolCache', kind: 'invoke', channel: 'tools:invalidate' },
  { name: 'onUpdateAvailable', kind: 'on', channel: 'update-available' },
  { name: 'onSessionContextAction', kind: 'on', channel: 'session:context-action' },
  // Is the operator mid-line in this session? Asked before a newly created
  // session is allowed to take the keyboard (renderer/lib/focus-policy.js).
  // The answer comes from the same main-side draft state the inject queue gates
  // on, so focus and delivery cannot disagree about who is typing.
  { name: 'draftOpen', kind: 'invoke', channel: 'session:draftOpen' },
  { name: 'writeToSession', kind: 'send', channel: 'pty-input' },
  { name: 'selectDirectory', kind: 'invoke', channel: 'dialog:selectDirectory' },
  { name: 'confirmKill', kind: 'invoke', channel: 'dialog:confirmKill' },
  { name: 'restoreSessions', kind: 'invoke', channel: 'app:restore-sessions' },
  { name: 'onPtyData', kind: 'on', channel: 'pty-data' },
  { name: 'onSessionExit', kind: 'on', channel: 'session-exit' },
  { name: 'onIpcMessage', kind: 'on', channel: 'ipc-message' },
  { name: 'onSessionActivity', kind: 'on', channel: 'session-activity' },
  // The seat's queued drawer attachments went out with a submit. The status
  // line claims a delivery BEFORE it happens (the queue is drained by the CLI's
  // own hook, which the app cannot observe directly), so this is what makes
  // that claim stop.
  { name: 'onSelectionSent', kind: 'on', channel: 'selection-sent' },
  { name: 'onPendingCount', kind: 'on', channel: 'pending-count' },
  { name: 'onSessionTicket', kind: 'on', channel: 'session-ticket' },
  { name: 'onSessionAttention', kind: 'on', channel: 'session-attention' },
  { name: 'onSessionCtx', kind: 'on', channel: 'session-ctx' },
  { name: 'onSessionProxy', kind: 'on', channel: 'session-proxy' },
  // Account plan quota off our own wire's response headers. Window-wide and
  // session-less by nature — the figure is the whole account's, and it arrives
  // on a forwarded turn rather than on a poll.
  { name: 'onWireQuota', kind: 'on', channel: 'wire-quota' },
  // The startup read of the same figure: the broadcast above only fires on a
  // forwarded turn, so a restored reading needs a pull to reach a new window.
  { name: 'getWireQuota', kind: 'invoke', channel: 'wire:quota' },
  { name: 'onSessionFiles', kind: 'on', channel: 'session-files' },
  { name: 'sessionFiles', kind: 'invoke', channel: 'session:files' },
  { name: 'filePeek', kind: 'invoke', channel: 'file:peek' },
  { name: 'fileDiff', kind: 'invoke', channel: 'file:diff' },
  // The peek's Edit tab. The only WRITE row in the file family, and deliberately
  // not reachable through peerQuery — a peer's file rows are all reads, and a
  // write kind there would be remote file-write authority with no per-request
  // authorization behind it.
  { name: 'fileWrite', kind: 'invoke', channel: 'file:write' },
  // Read-only: answers whether a displayed string names a real file, and where.
  { name: 'fileResolve', kind: 'invoke', channel: 'file:resolve' },
  { name: 'fileOpen', kind: 'invoke', channel: 'file:open' },
  // Reveal in the OS file manager, as distinct from opening the file itself.
  // An ordinary capability row, NOT part of the frozen five-row plugin transport
  // — its first caller is Manage Plugins (t22), pointing a user at
  // ~/.clodex/plugins, which is a dot-directory Finder hides by default and the
  // single largest obstacle to a packaged user installing a plugin at all.
  { name: 'fileReveal', kind: 'invoke', channel: 'file:reveal' },
  { name: 'writePluginBundleFile', kind: 'invoke', channel: 'plugins:writeBundleFile' },
  { name: 'onSessionFileView', kind: 'on', channel: 'session-file-view' },
  { name: 'openExternal', kind: 'invoke', channel: 'app:openExternal' },
  { name: 'sessionInfo', kind: 'invoke', channel: 'session:info' },
  { name: 'getProxySnapshot', kind: 'invoke', channel: 'proxy:snapshot' },
  { name: 'getProxyContext', kind: 'invoke', channel: 'proxy:context' },
  { name: 'getProxyReport', kind: 'invoke', channel: 'proxy:report' },
  { name: 'getProxyBust', kind: 'invoke', channel: 'proxy:bust' },
  { name: 'proxyHold', kind: 'invoke', channel: 'proxy:hold' },
  { name: 'wireHold', kind: 'invoke', channel: 'wire:hold' },
  { name: 'setStripLevel', kind: 'invoke', channel: 'proxy:setStripLevel' },
  { name: 'setAutoCompact', kind: 'invoke', channel: 'session:setAutoCompact' },
  { name: 'getSubagentFeed', kind: 'invoke', channel: 'proxy:subagentFeed' },
  { name: 'onSessionMention', kind: 'on', channel: 'session-mention' },
  { name: 'onRequestSwitchSession', kind: 'on', channel: 'request-switch-session' },
  { name: 'onRequestOpenNewDialog', kind: 'on', channel: 'request-open-new-dialog' },
  { name: 'onRequestOpenDiscovery', kind: 'on', channel: 'request-open-discovery' },
  { name: 'onRequestRenameWorkspace', kind: 'on', channel: 'request-rename-workspace' },
  { name: 'onRequestOpenPreferences', kind: 'on', channel: 'request-open-preferences' },
  { name: 'onRequestOpenPeersDialog', kind: 'on', channel: 'request-open-peers-dialog' },
  // T5: the Plugins menu's "Manage Plugins…". A core menu→renderer open request,
  // exactly like the peers row above — NOT a plugin transport row (the plugin
  // transport is the five plugin:* rows, frozen; a plugin never sees this
  // channel).
  { name: 'onRequestOpenPluginsDialog', kind: 'on', channel: 'request-open-plugins-dialog' },
  // t288: the Teams menu's two menu→renderer open requests. The popover and the
  // create dialog are renderer-side surfaces, so the menu can only ask for them.
  { name: 'onRequestOpenTeamRoles', kind: 'on', channel: 'request-open-team-roles' },
  { name: 'onRequestOpenTeamCreate', kind: 'on', channel: 'request-open-team-create' },
  { name: 'onRequestOpenPeerSession', kind: 'on', channel: 'request-open-peer-session' },
  { name: 'onRequestOpenAgentsDrawer', kind: 'on', channel: 'request-open-agents-drawer' },
  { name: 'onRequestOpenSkillsDrawer', kind: 'on', channel: 'request-open-skills-drawer' },
  { name: 'onRequestOpenExecDrawer', kind: 'on', channel: 'request-open-exec-drawer' },
  { name: 'onRequestOpenInboxDrawer', kind: 'on', channel: 'request-open-inbox-drawer' },
  { name: 'onRequestOpenPromptsDrawer', kind: 'on', channel: 'request-open-prompts-drawer' },
  { name: 'onRequestOpenTemplatesDrawer', kind: 'on', channel: 'request-open-templates-drawer' },
  { name: 'onRequestOpenIpcLog', kind: 'on', channel: 'request-open-ipc-log' },
  { name: 'getSettings', kind: 'invoke', channel: 'settings:get' },
  { name: 'setTheme', kind: 'invoke', channel: 'theme:set' },
  { name: 'onSetTheme', kind: 'on', channel: 'set-theme' },
  { name: 'setSettings', kind: 'invoke', channel: 'settings:set' },
  // Playback of a spoken reply started or ended, box-wide. The re-arm lives in
  // the renderer and the `say` child in main, so this is the only way the
  // recorder can be held off until the narration it would otherwise transcribe
  // has finished.
  { name: 'onSpeakerBusy', kind: 'on', channel: 'speaker-busy' },
  { name: 'onZoomNudge', kind: 'on', channel: 'zoom-nudge' },
  { name: 'setDefaultToolDeny', kind: 'invoke', channel: 'defaults:setToolDeny' },
  { name: 'openWirescope', kind: 'invoke', channel: 'app:openWirescope' },
  { name: 'wirescopeStatus', kind: 'invoke', channel: 'wirescope:status' },
  { name: 'wirescopeStart', kind: 'invoke', channel: 'wirescope:start' },
  { name: 'wirescopeStop', kind: 'invoke', channel: 'wirescope:stop' },
  { name: 'wirescopeRestart', kind: 'invoke', channel: 'wirescope:restart' },
  { name: 'wirescopePruneInfo', kind: 'invoke', channel: 'wirescope:pruneInfo' },
  { name: 'wirescopePrune', kind: 'invoke', channel: 'wirescope:prune' },
  // The drawer's clodexctl REPL (t214). Present in the contract on BOTH
  // surfaces because the contract is a binding table, not a permission list —
  // the web build's `ctl:run` binding simply has no handler to reach, since
  // registration is gated on enableDrawerServices (ipc-handlers.js). `consoleRead` rides the same story.
  { name: 'ctlRun', kind: 'invoke', channel: 'ctl:run' },
  { name: 'ctlContext', kind: 'invoke', channel: 'ctl:context' },
  { name: 'ctlHelp', kind: 'invoke', channel: 'ctl:help' },
  { name: 'consoleRead', kind: 'invoke', channel: 'console:read' },
  { name: 'consoleLive', kind: 'invoke', channel: 'console:live' },
  // The drawer's selection → wirescope tail hint. Under the SAME gate as the
  // rest of the drawer family and for a sharper reason than either: it puts
  // caller-supplied text into an agent's next request, so an ungated
  // registration is a prompt-injection channel for any authenticated web
  // connection.
  { name: 'drawerArmSelection', kind: 'invoke', channel: 'drawer:armSelection' },
  { name: 'drawerReleaseSelection', kind: 'invoke', channel: 'drawer:releaseSelection' },
  { name: 'drawerInspectSelection', kind: 'invoke', channel: 'drawer:inspectSelection' },
  // The drawer's terminal tenant (t215). NOT the same reasoning as the rows
  // above, since t227: these four have handlers on BOTH surfaces. `wterm:spawn`
  // is `$SHELL` on the host the caller is already talking to, which
  // `session:create` (ungated, no drawer flag) also hands out as a `type:
  // 'bash'` session — so the gate protected a tab, not a capability. Their seam
  // is `enableLocalTerminal`.
  { name: 'wtermSpawn', kind: 'invoke', channel: 'wterm:spawn' },
  { name: 'wtermWrite', kind: 'invoke', channel: 'wterm:write' },
  { name: 'wtermResize', kind: 'invoke', channel: 'wterm:resize' },
  { name: 'onWtermData', kind: 'on', channel: 'wterm:data' },
  { name: 'sandboxDetect', kind: 'invoke', channel: 'sandbox:detect' },
  { name: 'sandboxStatus', kind: 'invoke', channel: 'sandbox:status' },
  { name: 'sandboxGetConfig', kind: 'invoke', channel: 'sandbox:getConfig' },
  { name: 'sandboxSetConfig', kind: 'invoke', channel: 'sandbox:setConfig' },
  { name: 'sandboxTranslatePath', kind: 'invoke', channel: 'sandbox:translatePath' },
  { name: 'sandboxUp', kind: 'invoke', channel: 'sandbox:up' },
  { name: 'sandboxRebuild', kind: 'invoke', channel: 'sandbox:rebuild' },
  { name: 'sandboxDown', kind: 'invoke', channel: 'sandbox:down' },
  { name: 'sandboxLogsTail', kind: 'invoke', channel: 'sandbox:logsTail' },
  { name: 'sandboxSetToken', kind: 'invoke', channel: 'sandbox:setToken' },
  { name: 'sandboxClearToken', kind: 'invoke', channel: 'sandbox:clearToken' },
  // Box registry CRUD (M6b P2).
  { name: 'sandboxListBoxes', kind: 'invoke', channel: 'sandbox:listBoxes' },
  { name: 'sandboxCreateBox', kind: 'invoke', channel: 'sandbox:createBox' },
  { name: 'sandboxDeleteBox', kind: 'invoke', channel: 'sandbox:deleteBox' },
  { name: 'onRequestOpenSandboxDialog', kind: 'on', channel: 'request-open-sandbox-dialog' },
  { name: 'remoteStatus', kind: 'invoke', channel: 'remote:status' },
  { name: 'remoteSetToken', kind: 'invoke', channel: 'remote:setToken' },
  { name: 'peerProbe', kind: 'invoke', channel: 'peer:probe' },
  { name: 'peerDeploy', kind: 'invoke', channel: 'peer:deploy' },
  { name: 'peerDeployConfig', kind: 'invoke', channel: 'peer:deployConfig' },
  { name: 'peerDeployFix', kind: 'invoke', channel: 'peer:deployFix' },
  { name: 'onPeerDeployLine', kind: 'on', channel: 'peer-deploy-line' },
  { name: 'peerList', kind: 'invoke', channel: 'peer:list' },
  // contexts→peers import (t32 step 4). Preview returns token STATE only and
  // apply takes context NAMES, not records — the imported token value never
  // crosses this boundary (see the handlers in ipc-handlers.js).
  { name: 'peerImportPreview', kind: 'invoke', channel: 'peer:importPreview' },
  { name: 'peerImportApply', kind: 'invoke', channel: 'peer:importApply' },
  { name: 'peerAttach', kind: 'invoke', channel: 'peer:attach' },
  { name: 'peerDetach', kind: 'invoke', channel: 'peer:detach' },
  { name: 'peerAttachedNames', kind: 'invoke', channel: 'peer:attachedNames' },
  { name: 'peerForgetAttached', kind: 'invoke', channel: 'peer:forgetAttached' },
  { name: 'peerSetDisabled', kind: 'invoke', channel: 'peer:setDisabled' },
  { name: 'peerSetRelayAllowed', kind: 'invoke', channel: 'peer:setRelayAllowed' },
  { name: 'peerSetShellAllowed', kind: 'invoke', channel: 'peer:setShellAllowed' },
  { name: 'peerControlledNames', kind: 'invoke', channel: 'peer:controlledNames' },
  { name: 'peerForgetControlled', kind: 'invoke', channel: 'peer:forgetControlled' },
  { name: 'peerVisible', kind: 'invoke', channel: 'peer:visible' },
  { name: 'peerSetVisible', kind: 'invoke', channel: 'peer:setVisible' },
  { name: 'peerControl', kind: 'invoke', channel: 'peer:control' },
  { name: 'peerResize', kind: 'invoke', channel: 'peer:resize' },
  { name: 'peerInput', kind: 'send', channel: 'peer:input' },
  { name: 'peerQuery', kind: 'invoke', channel: 'peer:query' },
  { name: 'peerRestart', kind: 'invoke', channel: 'peer:restart' },
  { name: 'peerCreateSession', kind: 'invoke', channel: 'peer:createSession' },
  { name: 'peerCatalogs', kind: 'invoke', channel: 'peer:catalogs' },
  { name: 'peerKillSession', kind: 'invoke', channel: 'peer:killSession' },
  { name: 'peerRestartSession', kind: 'invoke', channel: 'peer:restartSession' },
  { name: 'peerSessionArgs', kind: 'invoke', channel: 'peer:sessionArgs' },
  { name: 'peerSetSessionArgs', kind: 'invoke', channel: 'peer:setSessionArgs' },
  { name: 'peerSkillCatalog', kind: 'invoke', channel: 'peer:skillCatalog' },
  { name: 'peerSetSessionSkills', kind: 'invoke', channel: 'peer:setSessionSkills' },
  // A terminal tab pointed at a peer seat's shell (t219). These take the
  // renderer's COMPOSITE `name@peerId` key, unlike every peer row above, which
  // takes (id, name) separately — the split happens once, in the main-side
  // handler, so the `@` cannot reach the wire.
  { name: 'peerWtermOpen', kind: 'invoke', channel: 'peer:wtermOpen' },
  { name: 'peerWtermResize', kind: 'invoke', channel: 'peer:wtermResize' },
  { name: 'peerWtermClose', kind: 'invoke', channel: 'peer:wtermClose' },
  { name: 'peerWtermInput', kind: 'send', channel: 'peer:wtermInput' },
  { name: 'onPeerWtermReplay', kind: 'on', channel: 'peer-wterm-replay' },
  { name: 'onPeerWtermData', kind: 'on', channel: 'peer-wterm-data' },
  { name: 'onPeerWtermExit', kind: 'on', channel: 'peer-wterm-exit' },
  { name: 'onPeerWtermClosed', kind: 'on', channel: 'peer-wterm-closed' },
  // The other DIRECTION of t219: seats on THIS box a peer is watching right
  // now. Not the grant — the grant is a setting and peers-ui reads it from
  // settings — but live attachment, which is the thing an operator must never
  // have on their box unannounced.
  { name: 'onServedTerminals', kind: 'on', channel: 'served-terminals' },
  // The GRANT changed in some window. Payload-free on purpose: the listener
  // re-reads settings, so every window derives the chip the same way.
  { name: 'onPeerShellAllowed', kind: 'on', channel: 'peer-shell-allowed' },
  { name: 'onPeerState', kind: 'on', channel: 'peer-state' },
  { name: 'onPeerActivity', kind: 'on', channel: 'peer-activity' },
  { name: 'onPeerReplay', kind: 'on', channel: 'peer-replay' },
  { name: 'onPeerData', kind: 'on', channel: 'peer-data' },
  { name: 'onPeerResize', kind: 'on', channel: 'peer-resize' },
  { name: 'onPeerUi', kind: 'on', channel: 'peer-ui' },
  { name: 'showPeerContextMenu', kind: 'send', channel: 'peer:context-menu' },
  { name: 'showPeerHeaderMenu', kind: 'send', channel: 'peer:header-menu' },
  { name: 'confirmPeerRestart', kind: 'invoke', channel: 'dialog:confirmPeerRestart' },
  { name: 'confirmPeerUpdate', kind: 'invoke', channel: 'dialog:confirmPeerUpdate' },
  { name: 'confirmDeployFix', kind: 'invoke', channel: 'dialog:confirmDeployFix' },
  { name: 'confirmPeerKill', kind: 'invoke', channel: 'dialog:confirmPeerKill' },
  { name: 'confirmPeerReload', kind: 'invoke', channel: 'dialog:confirmPeerReload' },
  { name: 'onPeerContextAction', kind: 'on', channel: 'peer:context-action' },
  { name: 'onPeerTelemetry', kind: 'on', channel: 'peer-telemetry' },
  { name: 'onPeerControlChange', kind: 'on', channel: 'peer-control' },
  { name: 'onPeerExit', kind: 'on', channel: 'peer-exit' },
  { name: 'onPeerRemoved', kind: 'on', channel: 'peer-removed' },
  { name: 'onPeerDisabled', kind: 'on', channel: 'peer-disabled' },
  { name: 'onPeerTunnel', kind: 'on', channel: 'peer-tunnel' },
  // Peer web view (t30b): the on-demand ssh forward to a peer's browser
  // frontend, and its live state. Separate from the wire tunnel above — that one
  // exists for every ssh peer, this one only while someone is looking.
  { name: 'peerOpenWeb', kind: 'invoke', channel: 'peer:openWeb' },
  { name: 'peerCloseWeb', kind: 'invoke', channel: 'peer:closeWeb' },
  { name: 'onPeerWebTunnel', kind: 'on', channel: 'peer-web-tunnel' },
  { name: 'onSessionPeerControl', kind: 'on', channel: 'session-peer-control' },
  { name: 'getSessionArgs', kind: 'invoke', channel: 'session:getArgs' },
  { name: 'getSessionHistory', kind: 'invoke', channel: 'session:history' },
  { name: 'discoverSessions', kind: 'invoke', channel: 'discovery:scan' },
  // Sidebar organization: per-session meta (timestamps + git/PR status) for
  // group/sort/filter, and per-workspace view-state persistence.
  { name: 'sidebarMeta', kind: 'invoke', channel: 'sidebar:meta' },
  { name: 'getSidebarView', kind: 'invoke', channel: 'workspace:getView' },
  { name: 'setSidebarView', kind: 'invoke', channel: 'workspace:setView' },
  { name: 'setSessionArgs', kind: 'invoke', channel: 'session:setArgs' },
  { name: 'restartSession', kind: 'invoke', channel: 'session:restart' },
  { name: 'setSessionTools', kind: 'invoke', channel: 'session:setTools' },
  { name: 'setSessionSkills', kind: 'invoke', channel: 'session:setSkills' },
  { name: 'setSessionAgents', kind: 'invoke', channel: 'session:setAgents' },
  { name: 'setSessionIntents', kind: 'invoke', channel: 'session:setIntents' },
  { name: 'setSessionPlugins', kind: 'invoke', channel: 'session:setPlugins' },
  { name: 'getSkillCatalog', kind: 'invoke', channel: 'session:skillCatalog' },
  { name: 'getAgentCatalog', kind: 'invoke', channel: 'session:agentCatalog' },
  { name: 'getSkillCatalogFor', kind: 'invoke', channel: 'settings:skillCatalogFor' },
  { name: 'getToolCatalogFor', kind: 'invoke', channel: 'settings:toolCatalogFor' },
  // The box-wide voice-input mode the CLI persists, read and written. The write
  // is a direct settings-file write, NOT an injection: it needs no session, so
  // both surfaces work with zero Claude seats open.
  { name: 'getVoiceMode', kind: 'invoke', channel: 'settings:voiceMode' },
  { name: 'setVoiceMode', kind: 'invoke', channel: 'settings:setVoiceMode' },
  // t572: mark the hands-free submit about to happen as voice-originated. A
  // SEND, not an invoke, and that is the contract: the marker must never put a
  // round trip in front of the operator's Enter, so there is no result to wait
  // for and a failure costs the annotation alone.
  { name: 'markVoiceOrigin', kind: 'send', channel: 'voice:markOrigin' },
  // The deferred submit that marker was armed for stood down, so the marker is
  // withdrawn before an unrelated turn takes it. A SEND on the same rule as its
  // neighbour: the paths that abandon a submit are keystroke paths too.
  { name: 'unmarkVoiceOrigin', kind: 'send', channel: 'voice:unmarkOrigin' },
  // The operator is dictating RIGHT NOW — the recording indicator is lit on
  // this seat — so the inject quiet-gate must defer as it does for typing.
  //
  // A SEND for the same reason as its neighbour, and REPEATED rather than
  // paired with an off: main expires the stamp, so a renderer that stops
  // sending (window closed, seat switched, crashed mid-utterance) releases the
  // deferral by itself. An off-frame that never arrives would strand delivery
  // to the seat permanently, which is worse than the bug this fixes.
  { name: 'noteVoiceRecording', kind: 'send', channel: 'voice:recording' },
  { name: 'noteVoiceDraft', kind: 'send', channel: 'voice:draft' },
  // Which seat the operator is LOOKING at. Main has no other way to know: the
  // renderer owns `activeSession` and only WINDOW-level focus crosses today.
  // Read by the external voice tap, which has to pick a seat when the caller
  // named none.
  //
  // NOT derivable from `lastUserInputTs`, and that is the whole reason this row
  // exists: that stamp is written for TYPED bytes only, so a dictating operator
  // never moves it and a trigger routed by it would land on the seat he is not
  // talking to.
  //
  // A SEND, like its voice neighbours above: nothing waits on the answer, and a
  // dropped report is corrected by the next switch.
  { name: 'noteFocusedSession', kind: 'send', channel: 'session:focused' },
  // The external tap reached this seat — write the trigger key if, and only if,
  // this terminal's own screen says that is safe. The DECISION is the
  // renderer's because only it can read the recorder; main routes.
  { name: 'onVoiceTap', kind: 'on', channel: 'voice-tap' },
  // WHICH SEAT HOLDS THE MICROPHONE, box-wide. Main owns the answer for the
  // reason it owns the speaker flag above: `activeSession` is PER-WINDOW, so
  // with two workspace windows open two seats are each active in their own and
  // a locally-evaluated "am I allowed to arm?" answers yes in both.
  //
  // Broadcast to every window rather than sent to the holder, because the
  // windows that LOST it are the ones that have to stop arming.
  { name: 'onMicTarget', kind: 'on', channel: 'mic-target' },
  // The pull that pairs with it. A window opened or reloaded mid-dictation has
  // missed the broadcast, and the target does not change again while he keeps
  // talking to the seat he already picked — so without this read the new
  // window's seat could never arm, however long he waited.
  { name: 'micTarget', kind: 'invoke', channel: 'voice:micTarget' },
  // Whether CLODEX is the frontmost APPLICATION — the second condition on the
  // automatic re-arm, independent of the target above. A renderer cannot answer
  // it: `document.hasFocus()` is about the WINDOW, and a window can be the
  // focused window of an app sitting behind a browser, which is the case that
  // transcribed video audio into a composer.
  //
  // Broadcast plus catch-up pull, the same pair and for the same reason as the
  // target: a window that opened while the app was already frontmost missed the
  // edge, and there is no poll to correct it.
  { name: 'onAppFocused', kind: 'on', channel: 'app-focused' },
  { name: 'appFocused', kind: 'invoke', channel: 'voice:appFocused' },
  { name: 'listWorkspaces', kind: 'invoke', channel: 'workspace:list' },
  { name: 'currentWorkspace', kind: 'invoke', channel: 'workspace:current' },
  { name: 'setWorkspaceName', kind: 'invoke', channel: 'workspace:setName' },
  { name: 'newWorkspace', kind: 'invoke', channel: 'workspace:new' },
  // Scoped env vars for wrapper PTYs (T46). get returns secrets MASKED
  // ({ key, secret:true, hasValue:true } — never the value); set/delete mutate
  // the global-or-workspace scope store. scope arg is 'global' or a workspaceId.
  { name: 'envScopesGet', kind: 'invoke', channel: 'envScopes:get' },
  { name: 'envScopesSet', kind: 'invoke', channel: 'envScopes:set' },
  { name: 'envScopesDelete', kind: 'invoke', channel: 'envScopes:delete' },
  { name: 'envDefaultsGet', kind: 'invoke', channel: 'envDefaults:get' },
  { name: 'envDefaultsRestore', kind: 'invoke', channel: 'envDefaults:restore' },
  // Plugin transport. EXACTLY these five rows —
  // the whole plugin surface, for every plugin, forever. `pluginInvoke` is ONE
  // multiplexed channel over an engine-owned dispatch Map: the injected
  // transport has no removeHandler, so per-plugin channels could never be
  // unregistered and `dispose()` would be a lie at every level of the API.
  // Enable/disable/dispose mutate the Map instead; no Electron-level
  // unregistration ever happens. Because both frontends build window.api from
  // this one table, the browser frontend inherits the plugin transport free.
  { name: 'pluginInvoke', kind: 'invoke', channel: 'plugin:invoke' },
  { name: 'pluginCatalog', kind: 'invoke', channel: 'plugin:catalog' },
  { name: 'pluginSetEnabled', kind: 'invoke', channel: 'plugin:setEnabled' },
  { name: 'onPluginEvent', kind: 'on', channel: 'plugin-event' },
  // The intent catalog served over IPC rather than statically required by the
  // renderer: once plugins can register verbs, a renderer
  // that reads its own frozen copy of intent-catalog.js is reading a stale
  // catalog — and the web bundle's copy is frozen at build time.
  { name: 'getIntentCatalog', kind: 'invoke', channel: 'intents:catalog' },
  // Three separate channels — plugins, intents, grants — written by three UI
  // blocks. Folding any two together lets a save that drew only one of them
  // silently clear the other.
  { name: 'getSessionPluginGrants', kind: 'invoke', channel: 'session:pluginGrants' },
  { name: 'setSessionPluginGrants', kind: 'invoke', channel: 'session:setPluginGrants' },
];

module.exports = { API_CONTRACT };
