'use strict';
// plugins/workbench/engine.js — the workbench pilot's ENGINE half
// (docs/plugin-plan.md §4, steps W1-W6).
//
// W1 is the scaffold: this file activates against the Phase-1 host and does
// nothing else. W5 moves the fourteen fs:/scm:/worktree: data rows here, each
// one's first line `host.sessions.fsScope(name)` so the locality refusal is a
// HOST guarantee and not this plugin's code to get right (MUST-FIX 5).
//
// Electron-free by contract (test/electron-boundary.test.js walks this file) and
// backdoor-free (test/plugin-boundary.test.js: only node builtins and requires
// that stay inside this directory — core is reachable ONLY through `host`).

module.exports.activate = (host) => {
  // W5 fills this in. Kept as a named no-op rather than an absent export so the
  // loader's register() path is exercised for real from W1 onward — a scaffold
  // that isn't actually loaded proves nothing.
  host.log.info('workbench engine activated (W1 scaffold — data rows land in W5)');
};

module.exports.deactivate = () => {
  // The host tears down every dispatch entry, hook and registry row it handed
  // out on this plugin's behalf regardless of what happens here (§3.1: teardown
  // never trusts the plugin). Nothing of our own to release yet.
};
