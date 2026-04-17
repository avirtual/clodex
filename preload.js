const { ipcRenderer } = require('electron');

window.api = {
  createSession: (name, type, cwd, extraArgs) =>
    ipcRenderer.invoke('session:create', name, type, cwd, extraArgs),
  listSessions: () =>
    ipcRenderer.invoke('session:list'),
  killSession: (name) =>
    ipcRenderer.invoke('session:kill', name),
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
};
