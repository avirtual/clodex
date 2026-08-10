'use strict';

// Renderer startup smoke test: LOAD renderer/index.html in a real BrowserWindow
// and fail if startup throws or never reaches a rendered sidebar.
//
// Why this exists (v5.5.0, fixed in 111d80f): two overlay divs sat AFTER
// `<script src="renderer.js">`. That script is classic/synchronous, so it ran
// during parse, and report-panel.js / files-popover.js called
// document.getElementById() at module scope, got null, and the TypeError
// aborted renderer startup — shipped app, empty window, no sidebar. The full
// 4669-test suite was green over it, because every one of those tests reasons
// about the renderer as TEXT (regex over source, module-level require) rather
// than loading it, and scripts/electron-smoke.js only imports wire/ — it never
// opens a window. This is the only check in the repo that would have caught it.
// Do not delete it as redundant with the unit suite; the unit suite cannot see
// this class of bug by construction.
//
// Run:  node scripts/renderer-smoke.js       (re-execs under the Electron binary)
// Exits non-zero on the first failure. Wired into scripts/release.sh preflight.
// NOT in `npm test` on purpose: needs an Electron binary and a display.

const path = require('path');
const ROOT = path.join(__dirname, '..');

// Unlike electron-smoke.js, this must NOT set ELECTRON_RUN_AS_NODE: that flag
// makes Electron a plain node process with no app/BrowserWindow, and a window
// is the entire point here.
if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  let electron;
  try {
    electron = require(path.join(ROOT, 'node_modules', 'electron'));
  } catch (e) {
    console.error(`renderer-smoke: cannot resolve the Electron binary (${e.message})`);
    console.error('renderer-smoke: run `npm install` first. NOT skipping — a skip that reads as a pass is the bug this test exists to eliminate.');
    process.exit(1);
  }
  const r = spawnSync(electron, [__filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
const { API_CONTRACT } = require(path.join(ROOT, 'api-contract'));

const TIMEOUT_MS = Number(process.env.RENDERER_SMOKE_TIMEOUT || 45000);
const SMOKE_SESSION = 'renderer-smoke-fixture';

const failures = [];
const fail = (what, detail) => {
  failures.push(what);
  console.error(`FAIL ${what}${detail ? `\n${detail}` : ''}`);
};

// Software rendering: this runs under a release preflight, possibly over ssh
// with no GPU. Hardware acceleration there aborts the whole process rather than
// failing the window creation we could report on.
app.disableHardwareAcceleration();

// The renderer's error hooks must be installed BEFORE any page script parses,
// or the very exceptions this test exists to catch land before anyone listens.
// A preload is the only point that runs earlier than the first inline <script>,
// so this wrapper installs the hooks and then delegates to the app's real
// preload.js (which builds window.api — without it the renderer dies on
// undefined and we would be testing our own stub, not the app).
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-smoke-'));
const shimPath = path.join(shimDir, 'smoke-preload.js');
fs.writeFileSync(shimPath, `'use strict';
const { ipcRenderer } = require('electron');
const send = (kind, message, stack) => {
  try { ipcRenderer.send('__smoke_error', { kind, message: String(message), stack: stack || null }); } catch {}
};
window.addEventListener('error', (e) => {
  send('uncaught exception', (e.error && e.error.message) || e.message,
    (e.error && e.error.stack) || \`  at \${e.filename}:\${e.lineno}:\${e.colno}\`);
}, true);
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  send('unhandled rejection', (r && r.message) || r, (r && r.stack) || null);
});
const realError = console.error.bind(console);
console.error = (...args) => {
  send('console.error', args.map((a) => (a && a.stack) || String(a)).join(' '), null);
  realError(...args);
};
require(${JSON.stringify(path.join(ROOT, 'preload.js'))});
`);

ipcMain.on('__smoke_error', (_e, { kind, message, stack }) => {
  fail(`renderer ${kind}`, `  ${message}\n${stack || '  <no stack>'}`);
});

// Every window.api.* invoke would otherwise reject with "No handler registered",
// and each rejection is indistinguishable from the startup failure we are hunting.
// The channel list is read from API_CONTRACT rather than hand-listed so a new
// binding cannot silently reintroduce that noise. null is the default because
// renderer call sites guard with `res && res.ok`.
const STUBS = {
  // One ARCHIVED entry: the archived branch of the restore loop populates the
  // sidebar without constructing an xterm terminal, so the assertion below
  // measures renderer startup and not the terminal stack.
  'app:restore-sessions': () => ([{
    name: SMOKE_SESSION, type: 'claude', cwd: ROOT, archived: true, archivedAt: Date.now(),
  }]),
  'settings:get': () => ({}),
  'session:list': () => ([]),
  'workspace:list': () => ([]),
};

const seen = new Set();
for (const { kind, channel } of API_CONTRACT) {
  if (kind !== 'invoke' || seen.has(channel)) continue;
  seen.add(channel);
  ipcMain.handle(channel, async (...args) => (STUBS[channel] ? STUBS[channel](...args) : null));
}

async function run() {
  let win;
  try {
    win = new BrowserWindow({
      width: 1400,
      height: 900,
      show: false,
      webPreferences: {
        preload: shimPath,
        // Must mirror createWindow() in main.js: the renderer require()s node
        // modules at module scope, so a different posture here tests a renderer
        // the app never runs.
        nodeIntegration: true,
        contextIsolation: false,
        additionalArguments: ['--workspace-id=renderer-smoke'],
      },
    });
  } catch (e) {
    console.error(`renderer-smoke: could not create a BrowserWindow: ${e.message}`);
    console.error('renderer-smoke: no display available? This is a FAILURE, not a skip.');
    return 1;
  }

  win.webContents.on('render-process-gone', (_e, details) => {
    fail('renderer process gone', `  reason=${details.reason} exitCode=${details.exitCode}`);
  });
  win.webContents.on('preload-error', (_e, p, error) => {
    fail('preload error', `  ${p}\n  ${error && error.stack ? error.stack : error}`);
  });

  try {
    await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  } catch (e) {
    fail('loadFile', `  ${e.stack || e.message}`);
    return 1;
  }
  console.log('ok   renderer/index.html loaded');

  // Startup is async (the restore IIFE awaits IPC), so poll rather than sampling
  // once. #session-list is the assertion target: it is EMPTY in index.html and
  // filled only by renderer.js's restore loop, which is the last thing startup
  // does — a non-empty one proves the script parsed, ran to its final IIFE, and
  // completed the round-trip to main. Every static element in index.html is
  // present even in the v5.5.0 tree that rendered nothing, so none of them can
  // serve as this proof.
  const deadline = Date.now() + TIMEOUT_MS;
  let rows = 0;
  while (Date.now() < deadline) {
    if (failures.length) break;
    rows = await win.webContents.executeJavaScript(
      `(() => { const el = document.getElementById('session-list'); return el ? el.children.length : -1; })()`
    );
    if (rows > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  if (rows > 0) console.log(`ok   sidebar rendered (#session-list has ${rows} row(s))`);
  else if (rows === -1) fail('sidebar rendered', '  #session-list is missing from the document entirely');
  else if (!failures.length) fail('sidebar rendered', `  #session-list is still empty after ${TIMEOUT_MS}ms — renderer startup never reached the restore loop`);

  // Late errors (a rejection settling after the DOM filled) still count.
  await new Promise((r) => setTimeout(r, 500));
  win.destroy();
  return failures.length ? 1 : 0;
}

app.whenReady()
  .then(run)
  .catch((e) => { fail('smoke harness', `  ${e.stack || e.message}`); return 1; })
  .then((code) => {
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
    if (failures.length) console.error(`\nrenderer-smoke: ${failures.length} failure(s): ${failures.join(', ')}`);
    else console.log('\nrenderer-smoke: all green');
    app.exit(code || (failures.length ? 1 : 0));
  });
