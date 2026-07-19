const { app, BrowserWindow, ipcMain, dialog, Menu, shell, Notification, Tray, nativeImage } = require('electron');
const https = require('https');
const path = require('path');
const { pathToFileURL } = require('url');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { ensureDir } = require('./fs-util');
const { isExternallyOpenable } = require('./external-link');
const { DEFAULT_WORKSPACE_ID, THEME_KEYS } = require('./catalogs');
const { createEngine } = require('./engine');



// Dock/Finder/Launchpad launches on macOS inherit launchd's minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so `claude`/`codex` from ~/.local/bin or
// /opt/homebrew/bin aren't resolvable. Pull PATH from the user's login shell
// and merge it in. Only needed in packaged builds — dev mode inherits the
// shell env already.
// Returns true when the merge was NEEDED but FAILED (the login shell errored /
// timed out) — recorded into engine diagnostics so a silently-broken PATH (the
// usual root cause of "claude/codex not on PATH") surfaces as a banner instead of
// only a console.error. A skipped merge (dev / win32) or a clean merge is false.
function fixPathFromLoginShell() {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return false;
  const userShell = process.env.SHELL || '/bin/bash';
  try {
    const out = execSync(
      `${userShell} -ilc 'printf __CLODEX_PATH__%s__CLODEX_PATH__ "$PATH"'`,
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = out.match(/__CLODEX_PATH__(.*?)__CLODEX_PATH__/);
    if (!m || !m[1]) return false;
    const shellPath = m[1].split(':').filter(Boolean);
    const current = (process.env.PATH || '').split(':').filter(Boolean);
    process.env.PATH = [...new Set([...shellPath, ...current])].join(':');
    return false;
  } catch (e) {
    console.error('fixPathFromLoginShell failed:', e.message);
    return true;
  }
}
// Captured at module load (before the engine exists) and passed into createEngine
// as the `pathMergeFailed` seam so diagnostics can warn on a silently-broken PATH.
const pathMergeFailed = fixPathFromLoginShell();

// Env self-decontamination. If Clodex was launched (or relaunched — including
// app.relaunch() from the remote restart endpoint) from inside a Claude Code
// session, inherited CLAUDE_* markers make PTY-spawned CLIs behave as nested
// child sessions. Scrub semantics + survivor list (OAuth token, a user's own
// ANTHROPIC_BASE_URL) live in claude-env.js; app.relaunch() then carries the
// clean env forward.
require('./claude-env').scrubInheritedClaudeMarkers(process.env);

// Set once a quit is in flight (before-quit / non-darwin window-all-closed).
// Used to suppress node-pty's native teardown throws during shutdown.
let appQuitting = false;

// Last-resort net for node-pty. Its native layer (and internal socket teardown)
// can throw a Napi::Error asynchronously when a PTY fd closes — outside any
// try/catch we control — which otherwise aborts the whole app with SIGABRT.
// During shutdown that throw is benign (everything is being torn down anyway),
// so swallow it; at runtime we still crash loudly so real bugs aren't masked.
process.on('uncaughtException', (err) => {
  const msg = err && (err.message || String(err));
  const isPtyTeardown = /Napi|pty|ioctl|EBADF|read of closed|file descriptor/i.test(msg || '');
  if (appQuitting && isPtyTeardown) {
    console.error('Suppressed PTY teardown error during quit:', msg);
    try { log.warn('crash', `suppressed PTY teardown during quit: ${msg}`); } catch {}
    return;
  }
  try { log.error('crash', `uncaughtException: ${(err && err.stack) || msg}`); } catch {}
  throw err;
});

// Rejections that reach here are unhandled — record them, but keep Node's
// default behaviour (don't swallow) so nothing is masked.
process.on('unhandledRejection', (reason) => {
  try { log.error('crash', `unhandledRejection: ${(reason && reason.stack) || String(reason)}`); } catch {}
});


// Clodex-owned runtime dir: registry, sockets, hook scripts, prompt files,
// jsonl symlinks, spilled messages. Lives in $HOME (not /tmp) so macOS's
// 3-day tmp reaper can't delete files under long-running sessions, and kept
// short because run/{name}/agent.sock must fit the 104-char Unix socket path
// limit (the per-agent run/ dir grammar — clodex-paths.js — costs ~10 chars more
// than the old flat {name}.sock; still within budget for a 64-char name under a
// normal $HOME). Moving here (v0.6.6) ended /tmp/wb-wrap interop with Python
// wb-wrap. Per-agent runtime artifacts live under run/<name>/ (clodex-paths).
const REGISTRY_DIR = path.join(os.homedir(), '.clodex');



// ---------------------------------------------------------------------------
// Persistent ops/error log — Clodex mostly runs headless (tray, no console),
// so errors and lifecycle events otherwise vanish. One rolling plain-text file
// in the (already 0700) runtime dir: `ISO  LEVEL  [tag]  message`. Append-only,
// no dependency, no framework. Rotation is deliberately trivial: one generation
// kept, rotated once at startup when the file passes the cap. Only coarse,
// low-frequency events log here (lifecycle, state-mutating intents, autocompact
// decisions, peer transitions, uncaught errors) — never per-keystroke or
// per-telemetry-frame. `initLog()` runs once at startup (rotation + a header);
// every write self-heals the dir so a call before init still lands.
// ---------------------------------------------------------------------------
const LOG_FILE = path.join(REGISTRY_DIR, 'clodex.log');
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

function initLog() {
  try {
    ensureDir(REGISTRY_DIR);
    const st = fs.statSync(LOG_FILE);
    if (st.size > LOG_ROTATE_BYTES) {
      try { fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch {}
    }
  } catch { /* file absent (first run) or unrotatable — writes create it */ }
}

function writeLog(level, tag, message) {
  try {
    const line = `${new Date().toISOString()}  ${level}  [${tag}]  ${message}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Self-heal a missing dir once, then give up — logging must never throw
    // into a caller (it wraps lifecycle paths, the PTY, and the crash net).
    try { ensureDir(REGISTRY_DIR); fs.appendFileSync(LOG_FILE, `${new Date().toISOString()}  ${level}  [${tag}]  ${message}\n`); } catch {}
  }
}

const log = {
  info: (tag, message) => writeLog('INFO', tag, message),
  warn: (tag, message) => writeLog('WARN', tag, message),
  error: (tag, message) => writeLog('ERROR', tag, message),
};

// ── Engine + the module-scope singletons the retained Electron layer reads ──
// The engine OWNS these now (built in whenReady). main.js keeps thin mirrors it
// assigns ONCE from the engine so the retained helpers (createWindow /
// workspaceOfSender / confirmRestartClodex) and the app-menu getters keep
// referring to plain module names — the whenReady-getter convention that made
// this move survivable. Only the STABLE singletons are mirrored (manager +
// stores, built once); the mutable peer/remote/tunnel singletons are reached
// through engine.get*() each call so live reconciliation stays visible, and the
// full teardown funnels through engine.shutdown().
let engine = null;
let manager = null;
let workspaces, uiSettings, agentLibrary, skillLibrary;



// ---------------------------------------------------------------------------
// Update checker — queries GitHub Releases, notifies if newer version
// ---------------------------------------------------------------------------

const UPDATE_REPO = 'avirtual/clodex';
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

// Update-checker data layer (fetch + semver compare + the sanctioned
// return-values transform) lives in update-checker.js (M3). main.js keeps the
// updateInfo / releasesCache state and every electron side effect below.
const { refreshReleases, fetchLatestUpdate } = require('./update-checker');

let updateInfo = null; // { version, url }
// Newest-first [{tag, published_at}] from GitHub, refreshed on the update-check
// cadence. In-memory only (persisting a release list is overkill) — feeds the
// peer-identity popover's best-effort "released N days ago · N behind" line via
// the update:releases IPC. Empty until the first successful fetch / when offline.
let releasesCache = [];

async function checkForUpdate(silent = true) {
  // Refresh the release list on the same cadence, decoupled from the latest-
  // version logic (a releases failure must not suppress the banner, and vice
  // versa). Fire-and-forget; null means keep the prior cache.
  refreshReleases(UPDATE_REPO).then((rels) => { if (rels) releasesCache = rels; });
  try {
    const { updateInfo: latest, current } = await fetchLatestUpdate(UPDATE_REPO, () => app.getVersion());
    if (latest) {
      updateInfo = latest;
      // Notify the renderer so it can show a banner / menu indicator
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('update-available', updateInfo);
      }
      if (typeof refreshTrayMenu === 'function') refreshTrayMenu();
      // Native notification (only the first time per session, unless user manually checks)
      if (silent && Notification.isSupported()) {
        const n = new Notification({
          title: `Clodex ${latest.version} is available`,
          body: `You have ${current}. Click to view the release.`,
        });
        n.on('click', () => shell.openExternal(updateInfo.url));
        n.show();
      }
    } else if (!silent) {
      // Manual check — confirm we're on the latest
      if (Notification.isSupported()) {
        new Notification({
          title: 'Clodex is up to date',
          body: `You're on the latest version (${current}).`,
        }).show();
      }
    }
  } catch (err) {
    if (!silent) console.error('Update check failed:', err.message);
  }
}

// Full app relaunch — the one code path shared by the phone endpoint, the
// File menu, and the tray. Normal quit lifecycle: sessions --resume on the
// way back, the managed wirescope survives detached, and the fresh launch's
// version check applies any pending vendor bump. Boot-time env sanitize
// keeps the relaunched process clean even when the trigger came from inside
// an agent session.
function restartClodex() {
  setTimeout(() => { app.relaunch(); app.quit(); }, 500);
}

// Menu/tray front door: confirm with the live session count first (the
// remote page fronts its own confirm; direct callers skip none).
async function confirmRestartClodex() {
  const n = Array.from(manager.sessions.values()).filter(s => !s._dead).length;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Restart', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Restart Clodex?',
    detail: n
      ? `${n} running session${n === 1 ? '' : 's'} will be interrupted and resumed after the restart.`
      : 'The app will quit and reopen.',
  });
  if (response === 0) restartClodex();
}

// ---------------------------------------------------------------------------
// Menu bar (tray) + app menu — extracted to app-menus.js (M5). createAppMenus
// returns the tray/menu builders; we destructure them so the ~30 existing call
// sites below stay byte-identical. Electron-heavy by design (app-menus requires
// electron directly). The getter deps cross manager/peerManager/stores/
// updateInfo, none of which are initialized yet at this point in module eval.
// ---------------------------------------------------------------------------
const { createAppMenus } = require('./app-menus');
const {
  buildTrayMenu, initTray, refreshTrayMenu, scheduleTrayRefresh,
  buildAgentsSubmenu, buildSkillsSubmenu, setUiTheme, buildAppMenu,
  refreshAppMenu, scheduleAppMenuRefresh, sendToFocused,
} = createAppMenus({
  // value deps (hoisted fns / early consts — stable at call time)
  DEFAULT_WORKSPACE_ID, LOG_FILE, THEME_KEYS, path,
  checkForUpdate, confirmRestartClodex, createWindow,
  // getter deps (TDZ / whenReady-assigned — lazy)
  getManager: () => manager,
  getPeerManager: () => (engine ? engine.getPeerManager() : null),
  getSandboxManager: () => (engine ? engine.getSandboxManager() : null),
  getUpdateInfo: () => updateInfo,
  getUiSettings: () => uiSettings,
  getWorkspaces: () => workspaces,
  getAgentLibrary: () => agentLibrary,
  getSkillLibrary: () => skillLibrary,
});


function createWindow(workspaceId = DEFAULT_WORKSPACE_ID) {
  // If a window for this workspace already exists, just bring it forward
  const existing = manager.windowForWorkspace(workspaceId);
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }

  // Ensure the workspace record exists
  let ws = workspaces.get(workspaceId);
  if (!ws) {
    ws = {
      id: workspaceId,
      name: workspaceId === DEFAULT_WORKSPACE_ID ? 'Workspace' : 'New Workspace',
      bounds: null,
    };
    workspaces.upsert(ws);
  }

  const bounds = ws.bounds || { width: 1200, height: 800 };

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width || 1200,
    height: bounds.height || 800,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
      // Pass the workspaceId to the renderer via an additional preload argument
      additionalArguments: [`--workspace-id=${workspaceId}`],
    },
  });

  manager.registerWindow(workspaceId, win);

  // External-link hardening (Task 16 / GH#6). This window runs
  // nodeIntegration:true, so a link that opens a child window or navigates the
  // frame away from our index.html would land REMOTE content in a privileged
  // context. Route http/https to the system browser and deny everything else
  // without opening it.
  const ownIndexUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternallyOpenable(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    // Allow reloading our own page (Cmd+R re-navigates to the same file URL);
    // block any navigation away from it and hand http/https to the browser.
    if (url === ownIndexUrl) return;
    e.preventDefault();
    if (isExternallyOpenable(url)) shell.openExternal(url);
  });

  // Save bounds when the user resizes/moves the window
  const saveBounds = () => {
    if (win.isDestroyed()) return;
    workspaces.setBounds(workspaceId, win.getBounds());
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // Track recency for startup ordering + the open-window set for restore.
  workspaces.touch(workspaceId);
  workspaces.setOpen(workspaceId, true);
  win.on('focus', () => workspaces.touch(workspaceId));

  win.on('closed', () => {
    // An EXPLICIT close drops the workspace from the restore set; quit teardown
    // must not (quit closes every window — clearing here would collapse the
    // next launch to one window).
    if (!appQuitting) workspaces.setOpen(workspaceId, false);
    manager.unregisterWindow(workspaceId);
    refreshAppMenu();
    refreshTrayMenu();
  });

  // Electron 35 replaced the positional (event, level, message) args with a
  // single event object; `level` is now a string ('info'|'warning'|'error'|
  // 'debug'), not a numeric index.
  win.webContents.on('console-message', (e) => {
    console.log(`[RENDERER ${String(e.level).toUpperCase()}]`, e.message);
  });

  // Restore the workspace's persisted UI zoom (View-menu zoom items). Zoom is
  // per-webContents and resets on load, so re-apply on every did-finish-load
  // (covers Cmd+R too); the nudge refits xterm to the new CSS-pixel geometry.
  // Read fresh from the store — the factor may have changed since `ws` was
  // snapshotted at window-create time.
  win.webContents.on('did-finish-load', () => {
    const rec = workspaces.get(workspaceId);
    if (rec && typeof rec.zoomFactor === 'number' && rec.zoomFactor !== 1) {
      win.webContents.setZoomFactor(rec.zoomFactor);
      win.webContents.send('zoom-nudge');
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--devtools')) {
    win.webContents.openDevTools({ mode: 'bottom' });
  }
  return win;
}

// A single reusable window that renders a wirescope page (e.g. /_session) with
// clodex-style chrome — "in the middle" between an inline popover and a system
// browser tab. The page content is whatever wirescope serves; we only dress the
// frame (a normal titled title bar so the mac traffic-lights don't float over
// content + the caller's active theme bg) so it sits like a clodex window.
// Hardened webPreferences: this loads REMOTE content, so it must
// NOT inherit the main window's nodeIntegration/contextIsolation:false.
let wirescopeWindow = null;
function openWirescopeWindow(url, backgroundColor) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
  const bg = (typeof backgroundColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(backgroundColor.trim()))
    ? backgroundColor.trim()
    : '#1a1a2e';
  if (wirescopeWindow && !wirescopeWindow.isDestroyed()) {
    wirescopeWindow.setBackgroundColor(bg);
    wirescopeWindow.loadURL(url);
    wirescopeWindow.show();
    wirescopeWindow.focus();
    return;
  }
  wirescopeWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: bg,
    title: 'wirescope',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  // A link inside the remote page should open in the system browser, not a
  // nested child window. No will-navigate guard here: this window is SUPPOSED
  // to navigate between wirescope URLs (unlike the main window, which only ever
  // loads our own index.html).
  wirescopeWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (isExternallyOpenable(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  wirescopeWindow.on('closed', () => { wirescopeWindow = null; });
  wirescopeWindow.loadURL(url);
}

// Find the workspace ID that owns the renderer that sent an IPC event.
function workspaceOfSender(e) {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return DEFAULT_WORKSPACE_ID;
  for (const [wsId, w] of manager.windows) {
    if (w === win) return wsId;
  }
  return DEFAULT_WORKSPACE_ID;
}


// Prevent two Clodex instances from racing on ~/.clodex sockets and
// persistence files. If a second instance launches, focus the existing one.
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Bring the most-recently-used existing window forward
    const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
    if (wins.length > 0) {
      const w = wins[0];
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
  });
}

app.whenReady().then(() => {
  // Rotate the ops log before the engine writes its first line, then stand the
  // engine up with the Electron seams. Everything electron-free — stores,
  // SessionManager, wirescope + watchdog, remote/peer wiring, the reminder
  // scheduler, message/registry cleanup, the legacy sweep — lives in the engine
  // now; main.js layers the window / tray / ipc frontend on top.
  initLog();
  engine = createEngine({
    userDataPath: app.getPath('userData'),
    log,
    seams: {
      openPath: (p) => shell.openPath(p),
      notifyOS: (opts) => {
        try {
          if (Notification.isSupported()) new Notification(opts).show();
        } catch {}
      },
      setAppQuitting: (v) => { appQuitting = v; },
      appVersion: app.getVersion(),
      isPackaged: () => app.isPackaged,
      // Login-shell PATH merge outcome (captured at module load) — diagnostics
      // promotes a failed merge to a banner (Task 12).
      pathMergeFailed,
      // App-menu refresh hooks SessionManager + peer-wiring fire on change.
      // Late-bound forwarders onto the module consts createAppMenus produced at
      // module scope; nothing fires them synchronously during createEngine (the
      // schedulers are async), so manager is always assigned by the time they run.
      refreshAppMenu: (...a) => refreshAppMenu(...a),
      scheduleAppMenuRefresh: (...a) => scheduleAppMenuRefresh(...a),
      refreshTrayMenu: (...a) => refreshTrayMenu(...a),
      scheduleTrayRefresh: (...a) => scheduleTrayRefresh(...a),
      // Phone restart endpoint: full Electron relaunch (headless exits with a
      // documented code so a supervisor relaunches instead).
      restartHost: () => restartClodex(),
    },
  });
  manager = engine.manager;
  ({ workspaces, uiSettings, agentLibrary, skillLibrary } = engine.stores);

  log.info('app', `startup — Clodex ${app.getVersion()} (electron ${process.versions.electron}, pid ${process.pid})`);

  // Update checker — Electron-only surface (renderer banner, tray badge, native
  // notification), so it stays in the adapter, not the engine.
  checkForUpdate(true);
  setInterval(() => checkForUpdate(true), UPDATE_CHECK_INTERVAL);

  initTray();

  // ipc handlers (M5). The engine return is spread in whole — manager,
  // proxyPoller, wirescope, the helper surface, the store accessors — then the
  // stores object, then the node-builtin extras the handlers still need. Unused
  // deps are inert (see ipc-handlers header).
  //
  // ipc-handlers.js is now transport-agnostic (web-frontend Phase 1): it holds
  // NO electron require. The desktop adapter passes the electron-backed transport
  // + native-GUI seams here (the web host will pass WS/browser versions over the
  // same handler map). Each GUI wrapper owns its window resolution internally, so
  // no BrowserWindow crosses the boundary; `e` reaches popupMenu as an opaque
  // sender token that only this adapter (never ipc-handlers) unwraps.
  const { registerIpcHandlers } = require('./ipc-handlers');
  registerIpcHandlers({
    ...engine,
    ...engine.stores,
    // Transport
    handle: (channel, fn) => ipcMain.handle(channel, fn),
    on: (channel, fn) => ipcMain.on(channel, fn),
    // Native-GUI capabilities (electron-backed; the host resolves the window)
    popupMenu: (template, e) =>
      Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(e.sender) }),
    showMessageBox: (opts) => dialog.showMessageBox(BrowserWindow.getFocusedWindow(), opts),
    showSaveDialog: (opts) => dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), opts),
    showOpenDialog: (opts) => dialog.showOpenDialog(opts),
    openExternal: (url) => shell.openExternal(url),
    openPath: (filePath) => shell.openPath(filePath),
    showItemInFolder: (filePath) => shell.showItemInFolder(filePath),
    getAppVersion: () => app.getVersion(),
    getDesktopPath: () => app.getPath('desktop'),
    fs, https, os, path, log,
    UPDATE_REPO, checkForUpdate,
    createWindow, openWirescopeWindow, workspaceOfSender,
    refreshAppMenu, refreshTrayMenu, setUiTheme,
    getUpdateInfo: () => updateInfo,
    getReleasesCache: () => releasesCache,
  });

  buildAppMenu();



  // Restore the window SET that was open at quit (the `open` flags survive
  // quit because the closed handler skips its clear while appQuitting). Open
  // least-recent first so the most recently focused window ends up on top.
  // No flags (fresh install / pre-flag upgrade / all windows were explicitly
  // closed) → IDE-style fallback: just the most recently used workspace.
  const sortedWorkspaces = workspaces.sortedByRecent();
  const toRestore = sortedWorkspaces.filter((w) => w.open);
  if (toRestore.length > 0) {
    for (const w of toRestore.reverse()) createWindow(w.id);
  } else if (sortedWorkspaces.length === 0) {
    createWindow(DEFAULT_WORKSPACE_ID);
  } else {
    createWindow(sortedWorkspaces[0].id);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(DEFAULT_WORKSPACE_ID);
    }
  });

  // Dev-only hot reload — renderer edits reload windows in place; main-process
  // edits relaunch the app (sessions --resume on the fresh launch). Gated on
  // CLODEX_DEV (set by `npm run dev`) and never present in a packaged build.
  if (process.env.CLODEX_DEV && !app.isPackaged) {
    try {
      require('./dev-reload').installDevReload({
        app, BrowserWindow,
        onRelaunch: () => { appQuitting = true; if (engine) engine.shutdown(); },
      });
    } catch (e) {
      console.error('[dev-reload] failed to install:', e.message);
    }
  }
});


// On macOS, apps stay running when all windows are closed (accessible via tray).
// Sessions keep running too — reopen a window via the tray to see them again.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    appQuitting = true;
    if (engine) engine.shutdown();
    app.quit();
  }
});

app.on('before-quit', () => {
  appQuitting = true;
  if (engine) engine.shutdown();
});
