const { ipcRenderer } = require('electron');

window.api = {
  createSession: (name, type, cwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel) =>
    ipcRenderer.invoke('session:create', name, type, cwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel),
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
  broadcast: (body) =>
    ipcRenderer.invoke('ui:broadcast', body),
  exportSessionMarkdown: (name) =>
    ipcRenderer.invoke('session:exportMarkdown', name),
  listTemplates: () =>
    ipcRenderer.invoke('templates:list'),
  saveTemplate: (template) =>
    ipcRenderer.invoke('templates:save', template),
  removeTemplate: (id) =>
    ipcRenderer.invoke('templates:remove', id),
  listPrompts: () =>
    ipcRenderer.invoke('prompts:list'),
  savePrompt: (prompt) =>
    ipcRenderer.invoke('prompts:save', prompt),
  removePrompt: (id) =>
    ipcRenderer.invoke('prompts:remove', id),
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
  onSessionCtx: (callback) =>
    ipcRenderer.on('session-ctx', (_e, name, pct, tok, size) => callback(name, pct, tok, size)),
  onSessionProxy: (callback) =>
    ipcRenderer.on('session-proxy', (_e, name, payload) => callback(name, payload)),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  getProxySnapshot: (name) =>
    ipcRenderer.invoke('proxy:snapshot', name),
  getProxyContext: (name, opts) =>
    ipcRenderer.invoke('proxy:context', name, opts),
  getProxyReport: (name, opts) =>
    ipcRenderer.invoke('proxy:report', name, opts),
  proxyHold: (name, hours, force) =>
    ipcRenderer.invoke('proxy:hold', name, hours, force),
  setStripLevel: (name, level) =>
    ipcRenderer.invoke('proxy:setStripLevel', name, level),
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

  // Session args
  getSessionArgs: (name) => ipcRenderer.invoke('session:getArgs', name),
  getSessionHistory: (name) => ipcRenderer.invoke('session:history', name),
  setSessionArgs: (name, extraArgs, restart, proxy, systemPrompt, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills) => ipcRenderer.invoke('session:setArgs', name, extraArgs, restart, proxy, systemPrompt, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills),
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
