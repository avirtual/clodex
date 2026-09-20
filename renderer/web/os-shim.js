'use strict';
// os-shim.js — browser stand-in for node's `os`, aliased by esbuild (build/
// build-web.js) for the renderer sites that touch node.
// The home directory isn't knowable in the browser, so the web host sends it in
// its `welcome` frame (welcome.home) and boot.js seeds it here BEFORE renderer.js
// executes — so both call sites read the real value on first use.
let home = '/';
module.exports = {
  homedir: () => home,
  // Called once by boot.js from the welcome frame; ignores empty/garbage.
  __setHome: (h) => { if (typeof h === 'string' && h) home = h; },
};
