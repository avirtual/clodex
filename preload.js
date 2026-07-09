const { ipcRenderer } = require('electron');

window.api = {
  createSession: (name, type, cwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel, systemPromptFile, appendPromptFiles) =>
    ipcRenderer.invoke('session:create', name, type, cwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel, systemPromptFile, appendPromptFiles),
  listSessions: () =>
    ipcRenderer.invoke('session:list'),
  killSession: (name) =>
    ipcRenderer.invoke('session:kill', name),
  retrySpawnSession: (name) =>
    ipcRenderer.invoke('session:retrySpawn', name),
  forgetSession: (name) =>
    ipcRenderer.invoke('session:forget', name),
  resizeSession: (name, cols, rows) =>
    ipcRenderer.invoke('session:resize', name, cols, rows),
  setSessionLabel: (name, label) =>
    ipcRenderer.invoke('session:setLabel', name, label),
  showSessionContextMenu: (name, cwd) =>
    ipcRenderer.send('session:context-menu', { name, cwd }),
  exportSessionMarkdown: (name) =>
    ipcRenderer.invoke('session:exportMarkdown', name),
  listTemplates: () =>
    ipcRenderer.invoke('templates:list'),
  saveTemplate: (template) =>
    ipcRenderer.invoke('templates:save', template),
  removeTemplate: (id) =>
    ipcRenderer.invoke('templates:remove', id),
  listPrompts: (kind) =>
    ipcRenderer.invoke('prompts:list', kind),
  savePrompt: (kind, name, body) =>
    ipcRenderer.invoke('prompts:save', kind, name, body),
  removePrompt: (kind, name) =>
    ipcRenderer.invoke('prompts:remove', kind, name),
  injectPrompt: (name, body) =>
    ipcRenderer.invoke('prompts:inject', name, body),
  listAgents: () =>
    ipcRenderer.invoke('agents:list'),
  getAgent: (name) =>
    ipcRenderer.invoke('agents:get', name),
  saveAgent: (name, content) =>
    ipcRenderer.invoke('agents:save', name, content),
  removeAgent: (name) =>
    ipcRenderer.invoke('agents:remove', name),

  listSkillLib: () =>
    ipcRenderer.invoke('skilllib:list'),
  getSkillLib: (name) =>
    ipcRenderer.invoke('skilllib:get', name),
  saveSkillLib: (name, content) =>
    ipcRenderer.invoke('skilllib:save', name, content),
  removeSkillLib: (name) =>
    ipcRenderer.invoke('skilllib:remove', name),
  checkForUpdate: () =>
    ipcRenderer.invoke('update:check'),
  getUpdateInfo: () =>
    ipcRenderer.invoke('update:info'),
  openUpdate: () =>
    ipcRenderer.invoke('update:open'),
  getVersion: () =>
    ipcRenderer.invoke('app:getVersion'),
  getDiagnostics: () =>
    ipcRenderer.invoke('diagnostics:get'),
  onUpdateAvailable: (callback) =>
    ipcRenderer.on('update-available', (_e, info) => callback(info)),
  onSessionContextAction: (callback) =>
    ipcRenderer.on('session:context-action', (_e, msg) => callback(msg)),
  writeToSession: (name, data) =>
    ipcRenderer.send('pty-input', name, data),
  selectDirectory: () =>
    ipcRenderer.invoke('dialog:selectDirectory'),
  confirmKill: (name) =>
    ipcRenderer.invoke('dialog:confirmKill', name),
  restoreSessions: () =>
    ipcRenderer.invoke('app:restore-sessions'),

  onPtyData: (callback) =>
    ipcRenderer.on('pty-data', (_e, name, data) => callback(name, data)),
  onSessionExit: (callback) =>
    ipcRenderer.on('session-exit', (_e, name, exitCode) => callback(name, exitCode)),
  onIpcMessage: (callback) =>
    ipcRenderer.on('ipc-message', (_e, msg) => callback(msg)),
  onSessionActivity: (callback) =>
    ipcRenderer.on('session-activity', (_e, name, state) => callback(name, state)),
  onSessionAttention: (callback) =>
    ipcRenderer.on('session-attention', (_e, name, attn) => callback(name, attn)),
  onSessionCtx: (callback) =>
    ipcRenderer.on('session-ctx', (_e, name, pct, tok, size) => callback(name, pct, tok, size)),
  onSessionProxy: (callback) =>
    ipcRenderer.on('session-proxy', (_e, name, payload) => callback(name, payload)),
  onSessionFiles: (callback) =>
    ipcRenderer.on('session-files', (_e, name, files) => callback(name, files)),
  sessionFiles: (name) => ipcRenderer.invoke('session:files', name),
  filePeek: (filePath) => ipcRenderer.invoke('file:peek', filePath),
  fileDiff: (name, filePath) => ipcRenderer.invoke('file:diff', name, filePath),
  fileOpen: (filePath) => ipcRenderer.invoke('file:open', filePath),
  onSessionFileView: (callback) =>
    ipcRenderer.on('session-file-view', (_e, name, filePath) => callback(name, filePath)),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  getProxySnapshot: (name) =>
    ipcRenderer.invoke('proxy:snapshot', name),
  getProxyContext: (name, opts) =>
    ipcRenderer.invoke('proxy:context', name, opts),
  getProxyReport: (name, opts) =>
    ipcRenderer.invoke('proxy:report', name, opts),
  getProxyBust: (name) =>
    ipcRenderer.invoke('proxy:bust', name),
  proxyHold: (name, hours, force) =>
    ipcRenderer.invoke('proxy:hold', name, hours, force),
  wireHold: (name, hours, force) =>
    ipcRenderer.invoke('wire:hold', name, hours, force),
  setStripLevel: (name, level) =>
    ipcRenderer.invoke('proxy:setStripLevel', name, level),
  setAutoCompact: (name, on) =>
    ipcRenderer.invoke('session:setAutoCompact', name, on),
  getProxySubagentDetail: (name, child, maxlen) =>
    ipcRenderer.invoke('proxy:subagentDetail', name, child, maxlen),
  onSessionMention: (callback) =>
    ipcRenderer.on('session-mention', (_e, name, mtype, from) => callback(name, mtype, from)),
  onRequestSwitchSession: (callback) =>
    ipcRenderer.on('request-switch-session', (_e, name) => callback(name)),
  onRequestOpenNewDialog: (callback) =>
    ipcRenderer.on('request-open-new-dialog', () => callback()),
  onRequestRenameWorkspace: (callback) =>
    ipcRenderer.on('request-rename-workspace', () => callback()),
  onRequestOpenPreferences: (callback) =>
    ipcRenderer.on('request-open-preferences', () => callback()),
  onRequestOpenPeersDialog: (callback) =>
    ipcRenderer.on('request-open-peers-dialog', () => callback()),
  onRequestOpenPeerSession: (callback) =>
    ipcRenderer.on('request-open-peer-session', (_e, id, name) => callback(id, name)),
  onRequestOpenAgentsDrawer: (callback) =>
    ipcRenderer.on('request-open-agents-drawer', (_e, name) => callback(name)),
  onRequestOpenSkillsDrawer: (callback) =>
    ipcRenderer.on('request-open-skills-drawer', (_e, name) => callback(name)),
  onRequestOpenPromptsDrawer: (callback) =>
    ipcRenderer.on('request-open-prompts-drawer', () => callback()),
  onRequestOpenIpcLog: (callback) =>
    ipcRenderer.on('request-open-ipc-log', () => callback()),

  // UI settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setTheme: (name) => ipcRenderer.invoke('theme:set', name),
  onSetTheme: (callback) =>
    ipcRenderer.on('set-theme', (_e, name) => callback(name)),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  setDefaultToolDeny: (list) => ipcRenderer.invoke('defaults:setToolDeny', list),

  openWirescope: (url, backgroundColor) => ipcRenderer.invoke('app:openWirescope', url, backgroundColor),

  // wirescope integration (phase-0)
  wirescopeStatus: () => ipcRenderer.invoke('wirescope:status'),
  wirescopeStart: () => ipcRenderer.invoke('wirescope:start'),
  wirescopeStop: () => ipcRenderer.invoke('wirescope:stop'),
  wirescopeRestart: () => ipcRenderer.invoke('wirescope:restart'),
  wirescopePruneInfo: () => ipcRenderer.invoke('wirescope:pruneInfo'),
  wirescopePrune: (opts) => ipcRenderer.invoke('wirescope:prune', opts),

  // Remote access (phone web UI)
  remoteStatus: () => ipcRenderer.invoke('remote:status'),

  // Peer deploy wizard: probe a box, install/update Clodex on it (streams
  // ::marker lines back via onPeerDeployLine).
  peerProbe: (sshHost, port) => ipcRenderer.invoke('peer:probe', sshHost, port),
  peerDeploy: (sshHost, opts) => ipcRenderer.invoke('peer:deploy', sshHost, opts),
  peerDeployFix: (sshHost, port, label, logText) =>
    ipcRenderer.invoke('peer:deployFix', sshHost, port, label, logText),
  onPeerDeployLine: (callback) =>
    ipcRenderer.on('peer-deploy-line', (_e, sshHost, line) => callback(sshHost, line)),

  // Peered Clodexes (attach to sessions on another machine)
  peerList: () => ipcRenderer.invoke('peer:list'),
  peerAttach: (id, name) => ipcRenderer.invoke('peer:attach', id, name),
  peerDetach: (id, name) => ipcRenderer.invoke('peer:detach', id, name),
  peerAttachedNames: () => ipcRenderer.invoke('peer:attachedNames'),
  peerForgetAttached: (id, name) => ipcRenderer.invoke('peer:forgetAttached', id, name),
  peerControlledNames: () => ipcRenderer.invoke('peer:controlledNames'),
  peerForgetControlled: (id, name) => ipcRenderer.invoke('peer:forgetControlled', id, name),
  peerVisible: () => ipcRenderer.invoke('peer:visible'),
  peerSetVisible: (id, names) => ipcRenderer.invoke('peer:setVisible', id, names),
  peerControl: (id, name, on) => ipcRenderer.invoke('peer:control', id, name, on),
  peerResize: (id, name, cols, rows) => ipcRenderer.invoke('peer:resize', id, name, cols, rows),
  peerInput: (id, name, data) => ipcRenderer.send('peer:input', id, name, data),
  peerQuery: (id, name, kind, args) => ipcRenderer.invoke('peer:query', id, name, kind, args),
  peerRestart: (id) => ipcRenderer.invoke('peer:restart', id),
  peerCreateSession: (id, spec) => ipcRenderer.invoke('peer:createSession', id, spec),
  peerKillSession: (id, name) => ipcRenderer.invoke('peer:killSession', id, name),
  peerRestartSession: (id, name, opts) => ipcRenderer.invoke('peer:restartSession', id, name, opts),
  onPeerState: (callback) =>
    ipcRenderer.on('peer-state', (_e, id, status) => callback(id, status)),
  onPeerActivity: (callback) =>
    ipcRenderer.on('peer-activity', (_e, id, name, state) => callback(id, name, state)),
  onPeerReplay: (callback) =>
    ipcRenderer.on('peer-replay', (_e, id, name, info) => callback(id, name, info)),
  onPeerData: (callback) =>
    ipcRenderer.on('peer-data', (_e, id, name, data) => callback(id, name, data)),
  onPeerResize: (callback) =>
    ipcRenderer.on('peer-resize', (_e, id, name, geom) => callback(id, name, geom)),
  onPeerUi: (callback) =>
    ipcRenderer.on('peer-ui', (_e, id, name, evt) => callback(id, name, evt)),
  showPeerContextMenu: (state) => ipcRenderer.send('peer:context-menu', state),
  showPeerHeaderMenu: (state) => ipcRenderer.send('peer:header-menu', state),
  confirmPeerRestart: (label) => ipcRenderer.invoke('dialog:confirmPeerRestart', label),
  confirmPeerUpdate: (label) => ipcRenderer.invoke('dialog:confirmPeerUpdate', label),
  confirmDeployFix: (sshHost) => ipcRenderer.invoke('dialog:confirmDeployFix', sshHost),
  confirmPeerKill: (name, label) => ipcRenderer.invoke('dialog:confirmPeerKill', name, label),
  confirmPeerReload: (name, label) => ipcRenderer.invoke('dialog:confirmPeerReload', name, label),
  onPeerContextAction: (callback) =>
    ipcRenderer.on('peer:context-action', (_e, msg) => callback(msg)),
  onPeerTelemetry: (callback) =>
    ipcRenderer.on('peer-telemetry', (_e, id, name, tele) => callback(id, name, tele)),
  onPeerControlChange: (callback) =>
    ipcRenderer.on('peer-control', (_e, id, name, holder) => callback(id, name, holder)),
  onPeerExit: (callback) =>
    ipcRenderer.on('peer-exit', (_e, id, name, exitCode) => callback(id, name, exitCode)),
  onPeerRemoved: (callback) =>
    ipcRenderer.on('peer-removed', (_e, id) => callback(id)),
  onPeerTunnel: (callback) =>
    ipcRenderer.on('peer-tunnel', (_e, id, status) => callback(id, status)),
  onSessionPeerControl: (callback) =>
    ipcRenderer.on('session-peer-control', (_e, name, holder) => callback(name, holder)),

  // Session args
  getSessionArgs: (name) => ipcRenderer.invoke('session:getArgs', name),
  getSessionHistory: (name) => ipcRenderer.invoke('session:history', name),
  setSessionArgs: (name, extraArgs, restart, proxy, systemPrompt, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, systemPromptFile, appendPromptFiles) => ipcRenderer.invoke('session:setArgs', name, extraArgs, restart, proxy, systemPrompt, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, systemPromptFile, appendPromptFiles),
  restartSession: (name, opts) => ipcRenderer.invoke('session:restart', name, opts),
  setSessionTools: (name, disabledTools) => ipcRenderer.invoke('session:setTools', name, disabledTools),
  setSessionSkills: (name, disabledSkills, injectSkills) => ipcRenderer.invoke('session:setSkills', name, disabledSkills, injectSkills),
  setSessionAgents: (name, agents, denyBuiltins) => ipcRenderer.invoke('session:setAgents', name, agents, denyBuiltins),
  getSkillCatalog: (name) => ipcRenderer.invoke('session:skillCatalog', name),
  getAgentCatalog: (name) => ipcRenderer.invoke('session:agentCatalog', name),
  getSkillCatalogFor: (cwd) => ipcRenderer.invoke('settings:skillCatalogFor', cwd),
  getToolCatalogFor: (cwd) => ipcRenderer.invoke('settings:toolCatalogFor', cwd),

  // Workspaces
  listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  currentWorkspace: () => ipcRenderer.invoke('workspace:current'),
  setWorkspaceName: (name) => ipcRenderer.invoke('workspace:setName', name),
  newWorkspace: () => ipcRenderer.invoke('workspace:new'),
};
