// Boundary guard for the engine-extraction arc: `require('electron')` may appear
// ONLY in the host-adapter layer. engine.js and the ~43 modules it bootstraps are
// plain Node — that is what lets a second host (headless-main.js, `node
// headless-main.js`) stand the same engine up with no Electron at all. A stray
// electron require creeping back into an engine-side module would re-couple the
// two and break the headless host silently (it only explodes when that code path
// runs under Node). This test walks the root *.js files and fails if any file
// outside the allowed set imports electron.
//
// Detection strips comments first: engine.js legitimately MENTIONS
// `require('electron')` in a prose comment explaining why session-manager.js
// never needs it — that is not an import and must not trip the guard.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// The host-adapter layer — the only root modules allowed to import electron.
// main.js is the desktop host; app-menus.js is its tray/menu surface; preload.js
// is the renderer bridge. Everything else at the root is engine-side and must
// stay electron-free. ipc-handlers.js LEFT this set in web-frontend Phase 1: its
// transport (ipcMain) and native-GUI calls are now injected seams the host
// backs, so the same handler map can also serve a browser over WS.
//
// SHRINKING this set is welcome — it means more of the tree went electron-free.
// GROWING it re-couples an engine module to Electron and needs a documented
// ruling (docs/engine-extraction-plan.md or docs/web-frontend-plan.md), not just
// an edit here.
const ALLOWED = new Set([
  'main.js',
  'app-menus.js',
  'preload.js',
]);

function stripComments(src) {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// True if `src` actually imports electron (comments already removed, so a prose
// mention like the one in engine.js does not count). String contents are left
// intact deliberately — an import is code, and no root file carries the literal
// `require('electron')` inside a string.
const ELECTRON_REQUIRE = /require\s*\(\s*['"]electron['"]\s*\)/;
function importsElectron(src) {
  return ELECTRON_REQUIRE.test(stripComments(src));
}

function rootJsFiles() {
  return fs.readdirSync(ROOT)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => fs.statSync(path.join(ROOT, f)).isFile());
}

test('require(electron) appears only in the host-adapter layer', () => {
  const violators = rootJsFiles()
    .filter((f) => !ALLOWED.has(f))
    .filter((f) => importsElectron(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    .sort();
  assert.deepStrictEqual(
    violators, [],
    `engine-side module(s) import electron — move the electron use behind a seam `
    + `(see docs/engine-extraction-plan.md), or, with a documented ruling, add to `
    + `ALLOWED: ${violators.join(', ')}`,
  );
});

// The guard's whole value is that it FIRES on a real import while NOT firing on a
// prose mention — the engine.js false-positive class. Lock both directions so a
// future regex "simplification" can't quietly blind it.
test('importsElectron fires on a real import, not a commented mention', () => {
  assert.ok(importsElectron("const { app } = require('electron');"),
    'a real import was not detected');
  assert.ok(importsElectron('const x = require("electron");'),
    'a double-quoted import was not detected');
  assert.ok(!importsElectron("// ...never require('electron')."),
    'a line-comment mention was wrongly flagged');
  assert.ok(!importsElectron("/*\n * lets it never require('electron')\n */"),
    'a block-comment mention was wrongly flagged');
});
