const { ipcRenderer } = require('electron');
const { API_CONTRACT } = require('./api-contract');

// window.api is built by looping the single api-contract table (shared with the
// browser frontend's renderer/web/api-shim.js). Each row becomes one binding:
//   invoke → ipcRenderer.invoke(channel, ...args)  (returns a Promise)
//   send   → ipcRenderer.send(channel, ...args)     (fire-and-forget)
//   on     → ipcRenderer.on(channel, (_e, ...args) => callback(...args))
// `argmap` (invoke/send only) maps caller args to the wire args; absent = pass
// them through unchanged. This is behaviourally identical to the hand-written
// bindings it replaces — adding a method means adding a row in api-contract.js.
const api = {};
for (const { name, kind, channel, argmap } of API_CONTRACT) {
  if (kind === 'invoke') {
    api[name] = (...args) => ipcRenderer.invoke(channel, ...(argmap ? argmap(...args) : args));
  } else if (kind === 'send') {
    api[name] = (...args) => ipcRenderer.send(channel, ...(argmap ? argmap(...args) : args));
  } else if (kind === 'on') {
    api[name] = (callback) => ipcRenderer.on(channel, (_e, ...args) => callback(...args));
  }
}
window.api = api;
