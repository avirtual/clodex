const { ipcRenderer } = require('electron');

window.api = {
  createSession: (name, type, cwd, extraArgs, systemPromptBody) =>
    ipcRenderer.invoke('session:create', name, type, cwd, extraArgs, systemPromptBody),
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
  checkForUpdate: () =>
    ipcRenderer.invoke('update:check'),
  getUpdateInfo: () =>
    ipcRenderer.invoke('update:info'),
  openUpdate: () =>
    ipcRenderer.invoke('update:open'),
  getVersion: () =>
    ipcRenderer.invoke('app:getVersion'),
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
  onRequestSwitchSession: (callback) =>
    ipcRenderer.on('request-switch-session', (_e, name) => callback(name)),
  onRequestOpenNewDialog: (callback) =>
    ipcRenderer.on('request-open-new-dialog', () => callback()),
  onRequestRenameWorkspace: (callback) =>
    ipcRenderer.on('request-rename-workspace', () => callback()),
  onRequestOpenPreferences: (callback) =>
    ipcRenderer.on('request-open-preferences', () => callback()),

  // UI settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),

  // Workspaces
  listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  currentWorkspace: () => ipcRenderer.invoke('workspace:current'),
  setWorkspaceName: (name) => ipcRenderer.invoke('workspace:setName', name),
  newWorkspace: () => ipcRenderer.invoke('workspace:new'),
};
