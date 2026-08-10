'use strict';
// plugin-web-parity.test.js — the browser frontend's half of the plugin story
// (plugin-plan.md [internal design doc, not in this repo] §4 W8, GAP G7).
//
// THE ASYMMETRY this pins. The Electron renderer activates a plugin's renderer
// half with `window.require(info.rendererPath)` — an absolute path resolved at
// runtime, legal only because this app runs with `contextIsolation: false` +
// `nodeIntegration: true`. The browser has no require, and esbuild resolves
// imports at BUILD time, so the same call is unimplementable there. The bundle
// therefore carries the modules, keyed by plugin id, in a registry that
// build/build-web.js generates from `plugins/*/manifest.json`.
//
// That generated file is COMMITTED (web-dist is tracked for the same reason), so
// it can go stale exactly the way bin-materialize.js's script list can: add a
// plugin, forget to rebuild, and the desktop app has it while the browser
// silently does not. This file is that staleness a red test at dev time.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'renderer', 'web', 'plugin-registry.js');
const registrySrc = fs.readFileSync(REGISTRY_PATH, 'utf8');

// Every plugin on disk that HAS a renderer half — the set the bundle must carry.
function pluginsWithRendererHalf() {
  const dir = path.join(ROOT, 'plugins');
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, ent.name, 'manifest.json'), 'utf8')); } catch { continue; }
    if (m && m.id === ent.name && m.entry && typeof m.entry.renderer === 'string') out.push(m.id);
  }
  return out.sort();
}

// The ids the committed registry actually requires.
function registeredIds() {
  return [...registrySrc.matchAll(/^\s*"([^"]+)":\s*require\(/gm)].map((m) => m[1]).sort();
}

test('the committed web plugin registry lists every plugin with a renderer half', () => {
  // The staleness gate. Rebuild with `npm run build:web` and commit the result.
  assert.deepStrictEqual(registeredIds(), pluginsWithRendererHalf(),
    'renderer/web/plugin-registry.js is stale — run `npm run build:web` and commit it');
});

test('the registry requires each half by a path INSIDE its own plugin directory', () => {
  // The bundle is the one place a plugin's code is pulled in by something other
  // than the loader, so the no-backdoor property has to be asserted here too:
  // build-web must not be able to bundle a path that escapes plugins/<id>/.
  const specs = [...registrySrc.matchAll(/^\s*"([^"]+)":\s*require\("([^"]+)"\)/gm)];
  assert.ok(specs.length, 'non-vacuity: at least one plugin renderer half is bundled');
  for (const [, id, spec] of specs) {
    const resolved = path.resolve(path.dirname(REGISTRY_PATH), spec);
    const own = path.join(ROOT, 'plugins', id);
    assert.ok(resolved.startsWith(own + path.sep),
      `${id}: bundled module ${spec} escapes plugins/${id}/`);
    assert.ok(fs.existsSync(resolved), `${id}: bundled module ${spec} does not exist`);
  }
});

test('boot.js installs the registry BEFORE renderer.js executes', () => {
  // Ordering is the whole job in boot.js (see its header): renderer.js's module
  // body calls loadPluginRenderers() as it runs, so a registry installed after
  // that require would be consulted by nobody and every plugin would silently
  // be absent from the browser build only.
  const boot = fs.readFileSync(path.join(ROOT, 'renderer', 'web', 'boot.js'), 'utf8');
  const install = boot.indexOf('__CLODEX_PLUGIN_REGISTRY__');
  const exec = boot.indexOf("require('../renderer.js')");
  assert.ok(install > 0, 'boot.js installs the plugin registry');
  assert.ok(exec > 0, 'boot.js executes renderer.js');
  assert.ok(install < exec, 'the registry must be installed before renderer.js runs');
});

test('the renderer resolves a plugin half through the registry OR window.require, never neither', () => {
  // One branch is the entire difference between the two frontends. Pinning it
  // here keeps a future edit from "simplifying" the web path away — which would
  // fail only in the browser, where no unit test runs.
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
  const fn = src.slice(src.indexOf('function requirePluginRenderer'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.match(body, /__CLODEX_PLUGIN_REGISTRY__/, 'the web path consults the build-generated registry');
  assert.match(body, /window\.require\(/, 'the Electron path still requires the runtime path');
});

test('a plugin stylesheet needs NO build step — it crosses as text over the existing transport', () => {
  // Worth pinning because it is the reason W8 is small. The plan reads "the
  // plugin renderer module + CSS via a build-generated registry"; the CSS half
  // was already solved at W1 by sending stylesheet TEXT from `renderer.info`
  // rather than a path, which works identically in the file:// window and the
  // browser. If someone later "fixes" this by emitting a path, the browser build
  // breaks silently — no path resolves there.
  const loader = fs.readFileSync(path.join(ROOT, 'plugin-loader.js'), 'utf8');
  const info = loader.slice(loader.indexOf('function rendererInfo'));
  assert.match(info.slice(0, info.indexOf('\n  }\n')), /readFileSync\(rec\.stylePath, 'utf8'\)/,
    'rendererInfo must send the stylesheet TEXT, not its path');
  assert.ok(!registrySrc.includes('.css'), 'the bundle registry carries modules only — CSS is not its job');
});
