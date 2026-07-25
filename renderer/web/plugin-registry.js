'use strict';
// plugin-registry.js — the browser bundle's id→module map for plugin renderer
// halves (plugin-plan.md [internal design doc, not in this repo] §4 W8, GAP G7).
//
// THE PROBLEM this solves, and ONLY this. The Electron renderer activates a
// plugin's renderer half with `window.require(info.rendererPath)` — an absolute
// path, resolved at runtime, which works because `contextIsolation: false` +
// `nodeIntegration: true` give the renderer a real `require`. A browser has
// neither, and esbuild resolves every import at BUILD time, so a runtime path
// cannot be turned into a module there. The bundle therefore needs the modules
// baked in, keyed by plugin id.
//
// What it does NOT solve, because nothing needs it to: the STYLESHEET. A
// plugin's CSS arrives as TEXT over the existing `plugin:invoke` transport
// (`_host` `renderer.info` reads it with fs, engine-side, where the files are)
// and the renderer host injects a per-plugin `<style>`. That is identical in
// both frontends and needed no build step at all — the W1 decision to ship css
// as text rather than a path is what bought it. (The plan's W8 line reads "the
// plugin renderer module + CSS via a build-generated registry"; the CSS half was
// already handled. Flagged as (o).)
//
// GENERATED, NOT HAND-WRITTEN — the `require` calls below are written by
// build/build-web.js from `plugins/*/manifest.json` at every `npm run
// build:web`. Do not edit the marked block; add a plugin and rebuild.
//
// The COMMITTED version is whatever the last `npm run build:web` generated —
// today the two shipped plugins below, not an empty map (it was empty until the
// first renderer half landed, and this comment claimed so long after it stopped
// being true). Checked into the tree it keeps the file requireable outside a
// build (tests, the Electron path that never consults it); a build overwrites
// it. An empty map remains the honest fallback shape, and `test/plugin-web-
// parity.test.js` is what fails if the committed file drifts from `plugins/`.

// Only the ENABLED-BY-DEFAULT question is the engine's; the bundle carries every
// discovered plugin's module and lets `plugin:catalog` decide what activates. A
// disabled plugin costs bundle size and nothing else — the alternative, baking
// the enabled set in at build time, would freeze a user setting into an artifact.
const MODULES = {
  // <<< BUILD-GENERATED PLUGIN MODULES — build/build-web.js rewrites this block
  "git-branches": require("../../plugins/git-branches/renderer.js"),
  "workbench": require("../../plugins/workbench/renderer.js"),
  // >>> END BUILD-GENERATED PLUGIN MODULES
};

// Shape mirrors a Map's `get`, which is what renderer.js's `requirePluginRenderer`
// probes for — so the Electron path (no registry on window) and the web path
// (this, installed by boot.js) differ in exactly one branch.
const registry = {
  get(id) { return MODULES[String(id)] || null; },
  ids() { return Object.keys(MODULES); },
};

module.exports = registry;
