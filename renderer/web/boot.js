'use strict';
// boot.js — the browser bundle's entry point (esbuild builds this into
// web-dist/app.js). Ordering is the whole job: install window.api and open the
// WebSocket, wait for the host's `welcome` (which carries the home directory),
// seed the os shim from it, and only THEN execute renderer.js. Because renderer.js
// touches window.api and require('os').homedir() at parse time, both must be in
// place before its module body runs — which is why it is require()d lazily here,
// inside the welcome continuation, rather than imported at the top.

const shim = require('./api-shim');
const osShim = require('./os-shim');
const menubar = require('./menubar');
// The build-generated id→module map for plugin renderer halves (§4 W8, GAP G7).
// The browser cannot `require()` a runtime path the way the Electron renderer
// does, so the modules are baked in and looked up by id instead.
const pluginRegistry = require('./plugin-registry');

shim.start().then((welcome) => {
  osShim.__setHome(welcome && welcome.home);
  // Installed BEFORE renderer.js's module body runs, for the same reason
  // window.api is: loadPluginRenderers() fires from that body, and a registry
  // that arrived afterwards would be consulted by nobody.
  window.__CLODEX_PLUGIN_REGISTRY__ = pluginRegistry;
  // Executes renderer.js's module body now: window.api is built, the socket is
  // open, and homedir() resolves — so its initWorkspace/restoreSessions IIFEs run
  // against a live transport exactly as the Electron renderer's do post-preload.
  require('../renderer.js');
  // The top menu bar (native app menu has no browser equivalent) — mounted after
  // the renderer has registered its request-* subscribers so the items resolve.
  // Passed the whole shim: emit() drives the local request-* drawer events and
  // invoke() reaches the browser-only app:restart endpoint.
  menubar.mount(shim);
}).catch((err) => {
  // start() only rejects if the ready promise is rejected, which we never do;
  // log defensively so a future change can't fail silently.
  console.error('web boot failed', err);
});
