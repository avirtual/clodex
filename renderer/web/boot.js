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
// The build-generated id→module map for plugin renderer halves.
// The browser cannot `require()` a runtime path the way the Electron renderer
// does, so the modules are baked in and looked up by id instead.
const pluginRegistry = require('./plugin-registry');

// The engine's version, in the sidebar footer (t28). The browser has no About
// panel and no other route to it, so on a headless box this line is the only way
// to tell what is actually deployed — which makes it a fleet-operations fact,
// not chrome, and it earns being visible at a glance rather than behind a click.
//
// The string comes from the welcome frame via the shim's getter, i.e. from the
// running ENGINE. That is the point: `web-dist/index.html` is tracked, so a
// git-deployed box receives a new bundle from a plain `git pull`, and a version
// re-derived inside that bundle would only ever confirm itself.
//
// WORDING follows the desktop's peer-info dialog (peers-ui.js:1410), which
// answers this same question about a remote box: "Clodex v<version>". Same
// question, same vocabulary — no reason for two frontends to name one fact
// differently.
//
// What it deliberately does NOT copy is that dialog's comparison half. There the
// value is in "(you run vX)" — two Clodexes measured against each other, which is
// what `versionSeverity` / `updateApplies` exist for. A browser is a CLIENT, not
// a Clodex: there is no second version, so there is nothing to compare and no
// severity to tint. Inventing a client-side version to compare against would be
// manufacturing the very self-confirming number the paragraph above rejects.
function mountVersion() {
  const footer = document.getElementById('sidebar-footer');
  const v = shim.appVersion();
  if (!footer || !v) return; // no version on the wire → say nothing rather than guess
  const el = document.createElement('div');
  el.id = 'sidebar-version';
  el.textContent = `Clodex v${v}`;
  el.title = 'Version of the Clodex engine serving this page';
  footer.appendChild(el);
}

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
  mountVersion();
}).catch((err) => {
  // start() only rejects if the ready promise is rejected, which we never do;
  // log defensively so a future change can't fail silently.
  console.error('web boot failed', err);
});
