'use strict';
// plugins/workbench/renderer.js — the workbench pilot's RENDERER half
// (docs/plugin-plan.md §4, steps W1-W4).
//
// Activated ONCE PER BrowserWindow (§3.3 law 1): per-window state lives in this
// activation closure and dies with the window, and "disable" fans out because
// the fan-out is the host's, not ours.
//
// W1 is the scaffold. W2 moves the `#workbench-overlay` DOM here (built inside
// `mount(rootEl)`, all interior DOM ours); W3 brings the CSS; W4 registers the
// sidebar footer button that replaces core's `#btn-workbench`.
//
// No `window.api` anywhere in this file, ever — `rhost.invoke()` is the only
// door to the engine, and test/plugin-boundary.test.js enforces it.

module.exports.activate = (rhost) => {
  rhost.log.info('workbench renderer activated (W1 scaffold — surface lands in W2)');
  // W2 returns a dispose() from here if this half acquires anything the host's
  // own teardown cannot reach. Everything registered THROUGH rhost (overlay,
  // footer button, wrapped timers/listeners) is already host-owned.
};
