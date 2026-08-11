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
// A benign startup console.error added later would turn the release red with no
// way to proceed, and the likely response is deleting the hook wholesale rather
// than narrowing it. A regex here suppresses a known-benign message and nothing
// else. Empty (the default) reports every console.error.
const ALLOWED_CONSOLE_ERROR = process.env.RENDERER_SMOKE_ALLOW_CONSOLE_ERROR || '';

// TIMEOUT_MS bounds only the poll loop below. If whenReady() or loadFile() never
// settles — a stalled subresource, a compositor that never comes up over ssh —
// nothing else stops this process, and release.sh has no timeout either, so the
// release WEDGES instead of failing. Measured precedent: a 13h47m suite wedge.
// unref'd so it can never hold a healthy run open.
setTimeout(() => {
  console.error(`renderer-smoke: hung before reaching a verdict (${TIMEOUT_MS * 2}ms)`);
  cleanup();
  app.exit(1);
}, TIMEOUT_MS * 2).unref();

const failures = [];
const fail = (what, detail) => {
  failures.push(what);
  console.error(`FAIL ${what}${detail ? `\n${detail}` : ''}`);
};

// Software rendering: this runs under a release preflight, possibly over ssh
// with no GPU. Hardware acceleration there aborts the whole process rather than
// failing the window creation we could report on.
app.disableHardwareAcceleration();

// A throwaway userData dir, set BEFORE whenReady() because the path is read as
// the app initializes. Without it the smoke boots the operator's LIVE profile —
// the same dir a dev `npm start` uses — and both directions are wrong at release
// time: renderer/themes.js reads a real `clodex-theme` and drawer-host.js a real
// TALL_KEY, so the gate runs WARM and a startup regression that only bites an
// empty profile (exactly the "new user opens the app and sees nothing" shape
// this exists to catch) passes here; and a second Chromium on a userData dir a
// running Clodex already owns is unsupported, on the operator's real profile.
const PROFILE_PREFIX = 'renderer-smoke-profile-';
// Sweep leftovers from previous runs BEFORE claiming ours (see the cleanup note
// below: the dir cannot be removed reliably on the way out, so it is removed on
// the way in, where nothing is racing us). Anything under 1h old may belong to a
// concurrent run and is left alone.
try {
  const cutoff = Date.now() - 3600_000;
  for (const e of fs.readdirSync(os.tmpdir())) {
    if (!e.startsWith(PROFILE_PREFIX)) continue;
    const p = path.join(os.tmpdir(), e);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
    } catch {}
  }
} catch {}
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
app.setPath('userData', profileDir);

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
  // The listener is CAPTURING, so a resource that failed to load (a <script src>
  // that 404s on file://) arrives here too — but such events carry no e.error,
  // no e.message and no filename/lineno, so the naive report reads
  // "undefined at undefined:undefined:undefined". Still red, but the diagnosis
  // is gone for a failure mode adjacent to the one this exists for.
  if (!e.error && e.target && e.target !== window) {
    send('resource failed to load', e.target.src || e.target.href || e.target.tagName, null);
    return;
  }
  send('uncaught exception', (e.error && e.error.message) || e.message,
    (e.error && e.error.stack) || \`  at \${e.filename}:\${e.lineno}:\${e.colno}\`);
}, true);
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  send('unhandled rejection', (r && r.message) || r, (r && r.stack) || null);
});
const realError = console.error.bind(console);
const allowed = ${JSON.stringify(ALLOWED_CONSOLE_ERROR)};
const allowedRe = allowed ? new RegExp(allowed) : null;
console.error = (...args) => {
  const text = args.map((a) => (a && a.stack) || String(a)).join(' ');
  if (!allowedRe || !allowedRe.test(text)) send('console.error', text, null);
  realError(...args);
};
require(${JSON.stringify(path.join(ROOT, 'preload.js'))});
`);

// Called from both exit paths: the watchdog above leaves the normal cleanup
// below unreached. Measured: it does not fully win there — Chromium recreates
// the profile dir while it is still initializing — but a hang is a
// human-investigated failure, not a thing that recurs unnoticed.
function cleanup() {
  for (const dir of [shimDir, profileDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// Chromium keeps writing the profile until the process is actually gone, so
// cleanup() removes a dir that is then recreated on the way out — measured, one
// leaked dir per run, on the normal path as well as the watchdog's. A
// process.on('exit') second pass does NOT fix it either (app.exit is a hard
// exit): measured, still +1 per run. So sweep at START instead, where nothing
// is racing us. Skips any dir a concurrent run owns by leaving today's alone
// only if it is ours — there is no lock here, and a smoke run is short.

ipcMain.on('__smoke_error', (_e, { kind, message, stack }) => {
  fail(`renderer ${kind}`, `  ${message}\n${stack || '  <no stack>'}`);
});

// Every window.api.* invoke would otherwise reject with "No handler registered",
// and each rejection is indistinguishable from the startup failure we are hunting.
// The channel list is read from API_CONTRACT rather than hand-listed so a new
// binding cannot silently reintroduce that noise. null is the default because
// renderer call sites guard with `res && res.ok`.
const STUBS = {
  // One ARCHIVED entry: this is the `.session-item` the assertion below counts.
  // Archived on purpose — that branch of the restore loop builds the row without
  // constructing an xterm, so a failure means renderer startup broke, not the
  // terminal stack. Emptying this array must turn the run red; if it does not,
  // the assertion has stopped discriminating (it once counted the empty-state
  // note as a row).
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
  // once.
  //
  // Count `.session-item`, NEVER `#session-list`'s children: refreshSidebarView
  // appends a `.session-empty-note` div when nothing is visible, so the child
  // count is 1 whether or not a session was ever restored, and a child-count
  // check passes with the restore stub returning []. Only `.session-item` (the
  // class refreshSidebarView itself selects rows by) discriminates.
  //
  // Pinned to the FIXTURE's data-name, not any `.session-item`: index.html ships
  // #session-list empty today, but refreshSidebarView already filters
  // `[data-peer-ui]` / `.peer-item` / `.session-child` out of its own row set, so
  // other row types are an anticipated future and an unpinned count would start
  // passing on one of them instead.
  //
  // A row proves the script parsed, ran to its final restore IIFE, and completed
  // the round-trip to main. No static element in index.html can prove that —
  // every one of them is present in the v5.5.0 tree that rendered nothing.
  const deadline = Date.now() + TIMEOUT_MS;
  let state = { list: false, rows: 0, note: false, children: 0 };
  while (Date.now() < deadline) {
    if (failures.length) break;
    state = await win.webContents.executeJavaScript(
      `(() => {
         const el = document.getElementById('session-list');
         if (!el) return { list: false, rows: 0, note: false, children: 0 };
         return {
           list: true,
           rows: el.querySelectorAll('.session-item[data-name="${SMOKE_SESSION}"]').length,
           note: !!el.querySelector('.session-empty-note'),
           children: el.children.length,
         };
       })()`
    );
    if (state.rows > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  if (failures.length) {
    // The loop breaks on the first renderer error WITHOUT measuring, so `state`
    // is still its initial value here. Reporting a sidebar verdict from it would
    // print an unmeasured claim ("#session-list is missing") next to the real
    // stack. The thrown error is the diagnosis; say nothing further.
  } else if (state.rows > 0 && state.note) {
    // Both at once means the row exists in the DOM but refreshSidebarView filtered
    // it out of view, so the operator sees "No sessions yet." over a restored
    // session. Counting rows alone would call that a pass.
    fail('sidebar rendered', `  ${state.rows} .session-item present but the empty-state note is showing — the row was built and then filtered out of view`);
  } else if (state.rows > 0) {
    console.log(`ok   sidebar rendered (${state.rows} session row(s), empty-note=${state.note})`);
  } else if (!state.list) {
    fail('sidebar rendered', '  #session-list is missing from the document entirely');
  } else {
    fail('sidebar rendered', `  #session-list has no .session-item after ${TIMEOUT_MS}ms `
      + `(children=${state.children}, empty-note=${state.note}) — renderer startup never built the row for the restored session`);
  }

  // Late errors (a rejection settling after the DOM filled) still count.
  await new Promise((r) => setTimeout(r, 500));
  win.destroy();
  return failures.length ? 1 : 0;
}

app.whenReady()
  .then(run)
  .catch((e) => { fail('smoke harness', `  ${e.stack || e.message}`); return 1; })
  .then((code) => {
    cleanup();
    if (failures.length) console.error(`\nrenderer-smoke: ${failures.length} failure(s): ${failures.join(', ')}`);
    else console.log('\nrenderer-smoke: all green');
    app.exit(code || (failures.length ? 1 : 0));
  });
