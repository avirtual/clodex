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
  writeToSession: (name, data) =>
    ipcRenderer.send('pty-input', name, data),
  selectDirectory: () =>
    ipcRenderer.invoke('dialog:selectDirectory'),
  restoreSessions: () =>
    ipcRenderer.invoke('app:restore-sessions'),

  onPtyData: (callback) =>
    ipcRenderer.on('pty-data', (_e, name, data) => callback(name, data)),
  onSessionExit: (callback) =>
    ipcRenderer.on('session-exit', (_e, name, exitCode) => callback(name, exitCode)),
  onIpcMessage: (callback) =>
    ipcRenderer.on('ipc-message', (_e, msg) => callback(msg)),
};
