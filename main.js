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
const { writeHostStamp } = require('./host-stamp');



// Packaged macOS launches (Dock/Finder/Launchpad) inherit launchd's minimal PATH,
// so `claude`/`codex` from ~/.local/bin or /opt/homebrew/bin aren't resolvable.
// Returns true only when the merge was needed but the login shell failed.
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
const pathMergeFailed = fixPathFromLoginShell();

// Inherited CLAUDE_* markers make PTY-spawned CLIs behave as nested child
// sessions. app.relaunch() then carries the clean env forward.
require('./claude-env').scrubInheritedClaudeMarkers(process.env);

// Set this BEFORE engine.shutdown() on every quit path. Shutdown closes the
// windows, and `win.on('closed')` reads this flag to decide whether the close
// was explicit: still false there and quit drops each workspace from the restore
// set, collapsing the next launch to a single window.
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

process.on('unhandledRejection', (reason) => {
  try { log.error('crash', `unhandledRejection: ${(reason && reason.stack) || String(reason)}`); } catch {}
});


// Must stay in $HOME, not /tmp: macOS's 3-day tmp reaper would delete files under
// long-running sessions. Kept short because run/{name}/agent.sock must fit the
// 104-char Unix socket path limit.
const REGISTRY_DIR = path.join(os.homedir(), '.clodex');



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
    try { ensureDir(REGISTRY_DIR); fs.appendFileSync(LOG_FILE, `${new Date().toISOString()}  ${level}  [${tag}]  ${message}\n`); } catch {}
  }
}

const log = {
  info: (tag, message) => writeLog('INFO', tag, message),
  warn: (tag, message) => writeLog('WARN', tag, message),
  error: (tag, message) => writeLog('ERROR', tag, message),
  // Callers guard with `log.debug && log.debug(...)`, so omitting this does not
  // throw — it silently discards the diagnostic. hint-arm's entire trace was a
  // no-op in production because of that: armed, failed-to-arm and
  // never-attempted all wrote nothing and read identically.
  debug: (tag, message) => writeLog('DEBUG', tag, message),
};

// Mirror only the STABLE engine singletons (manager + stores, built once); reach
// mutable peer/remote/tunnel singletons through engine.get*() on every call, or
// live reconciliation stops being visible here.
let engine = null;
let manager = null;
let workspaces, uiSettings, agentLibrary, skillLibrary, envScopes;




const UPDATE_REPO = 'avirtual/clodex';
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

const { refreshReleases, fetchLatestUpdate } = require('./update-checker');

let updateInfo = null; // { version, url }
let releasesCache = [];

async function checkForUpdate(silent = true) {
  refreshReleases(UPDATE_REPO).then((rels) => { if (rels) releasesCache = rels; });
  try {
    const { updateInfo: latest, current } = await fetchLatestUpdate(UPDATE_REPO, () => app.getVersion());
    if (latest) {
      updateInfo = latest;
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('update-available', updateInfo);
      }
      if (typeof refreshTrayMenu === 'function') refreshTrayMenu();
      if (silent && Notification.isSupported()) {
        const n = new Notification({
          title: `Clodex ${latest.version} is available`,
          body: `You have ${current}. Click to view the release.`,
        });
        n.on('click', () => shell.openExternal(updateInfo.url));
        n.show();
      }
    } else if (!silent) {
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

function restartClodex() {
  setTimeout(() => { app.relaunch(); app.quit(); }, 500);
}

const { classifyRestart, createIdleWaiter, giveUpBody } = require('./restart-waiter');
const idleWaiter = createIdleWaiter({
  getSessions: () => Array.from(manager.sessions.values()),
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h),
  restart: () => restartClodex(),
  notify: (asked) => {
    try {
      if (Notification.isSupported()) new Notification({
        // "canceled" would be false on every render: this is the ONLY notify call
        // site and it is the cap's give-up. An operator cancel does not notify at
        // all — they pressed the button.
        title: 'Restart dropped',
        body: giveUpBody(asked),
      }).show();
    } catch {}
  },
});

// "Running" here means MID-TURN, not merely alive: idle seats --resume cleanly.
async function confirmRestartClodex() {
  if (idleWaiter.isArmed()) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Restart Now', 'Cancel Pending Restart', 'Keep Waiting'],
      defaultId: 2,
      cancelId: 2,
      message: 'A restart is already pending.',
      detail: 'Clodex will restart once every session is idle. Restart now anyway, cancel the pending restart, or keep waiting?',
    });
    if (response === 0) { idleWaiter.disarm(); restartClodex(); }
    // "Restart Now" above disarms silently — the pending request is fulfilled by
    // the restart it takes. Cancelling is the one exit that owes every agent
    // waiting on this restart the news that it is not coming.
    else if (response === 1) idleWaiter.disarm({ abandoned: true });
    return;
  }

  const { busy, idle } = classifyRestart(Array.from(manager.sessions.values()));

  if (busy === 0) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Restart', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'Restart Clodex?',
      detail: idle
        // "restored", not "resume": the idle count includes bash panes, which
        // reopen as fresh shells — only agent seats resume with context.
        ? `${idle} idle session${idle === 1 ? '' : 's'} will be restored after the restart.`
        : 'The app will quit and reopen.',
    });
    if (response === 0) restartClodex();
    return;
  }

  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Restart When Idle', 'Restart Now', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: 'Restart Clodex?',
    detail: `${busy} session${busy === 1 ? ' is' : 's are'} mid-turn`
      + (idle ? `; ${idle} idle session${idle === 1 ? '' : 's'} will be restored cleanly` : '')
      + '. Restart When Idle waits until work settles; Restart Now interrupts.',
  });
  if (response === 0) idleWaiter.arm();
  else if (response === 1) restartClodex();
}

const { createAppMenus } = require('./app-menus');
const {
  buildTrayMenu, initTray, refreshTrayMenu, scheduleTrayRefresh,
  buildAgentsSubmenu, buildSkillsSubmenu, setUiTheme, buildAppMenu,
  refreshAppMenu, scheduleAppMenuRefresh, sendToFocused,
} = createAppMenus({
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
  getEnvScopes: () => envScopes,
  getPluginHost: () => (engine ? engine.getPluginHost() : null),
  getTeams: () => (engine ? { listTeams: engine.listTeams, loadManifest: engine.loadManifest } : null),
});


function createWindow(workspaceId = DEFAULT_WORKSPACE_ID) {
  const existing = manager.windowForWorkspace(workspaceId);
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }

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

  const saveBounds = () => {
    if (win.isDestroyed()) return;
    workspaces.setBounds(workspaceId, win.getBounds());
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  workspaces.touch(workspaceId);
  workspaces.setOpen(workspaceId, true);
  win.on('focus', () => workspaces.touch(workspaceId));

  win.on('closed', () => {
    // An EXPLICIT close drops the workspace from the restore set; quit teardown
    // must not (quit closes every window — clearing here would collapse the
    // next launch to one window).
    if (!appQuitting) workspaces.setOpen(workspaceId, false);
    // A workbench terminal belongs to its window and has no record to resume
    // from, so it dies with the window — unlike sessions, which survive a close
    // detached and replay their buffered output on reattach.
    if (engine) { const w = engine.getDrawerPtys(); if (w) w.kill(workspaceId); }
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

  // Zoom is per-webContents and resets on load, so re-apply on every
  // did-finish-load (covers Cmd+R); the nudge refits xterm.
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

// Loads REMOTE content: must not inherit the main window's
// nodeIntegration/contextIsolation:false.
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
  // Not mergeable with createWindow's BrowserWindow: the webPreferences below
  // are its exact inverse, and deliberately. This one loads REMOTE wirescope
  // pages, so it is sandboxed with no preload; the main window loads our own
  // index.html and needs nodeIntegration for the renderer's require(). Factoring
  // out a shared builder converges the two postures and hands remote content the
  // privileged one.
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

function workspaceOfSender(e) {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return DEFAULT_WORKSPACE_ID;
  for (const [wsId, w] of manager.windows) {
    if (w === win) return wsId;
  }
  return DEFAULT_WORKSPACE_ID;
}

// Same resolution WITHOUT the default-workspace fallback: null when the sender's
// window is gone. Only the wterm:* handlers use this — an in-flight keystroke
// from a closing window must not land in the default workspace's shell, whereas
// every other handler wants the fallback and would break without it.
function workspaceOfSenderStrict(e) {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return null;
  for (const [wsId, w] of manager.windows) {
    if (w === win) return wsId;
  }
  return null;
}


// Prevent two Clodex instances from racing on ~/.clodex sockets and
// persistence files. If a second instance launches, focus the existing one.
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
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
  initLog();
  engine = createEngine({
    userDataPath: app.getPath('userData'),
    log,
    seams: {
      openPath: (p) => shell.openPath(p),
      openExternal: (url) => shell.openExternal(url),
      notifyOS: (opts) => {
        try {
          if (Notification.isSupported()) new Notification(opts).show();
        } catch {}
      },
      setAppQuitting: (v) => { appQuitting = v; },
      appVersion: app.getVersion(),
      isPackaged: () => app.isPackaged,
      pathMergeFailed,
      // App-menu refresh hooks SessionManager + peer-wiring fire on change.
      // Late-bound forwarders onto the module consts createAppMenus produced at
      // module scope; nothing fires them synchronously during createEngine (the
      // schedulers are async), so manager is always assigned by the time they run.
      refreshAppMenu: (...a) => refreshAppMenu(...a),
      scheduleAppMenuRefresh: (...a) => scheduleAppMenuRefresh(...a),
      refreshTrayMenu: (...a) => refreshTrayMenu(...a),
      scheduleTrayRefresh: (...a) => scheduleTrayRefresh(...a),
      restartHost: () => restartClodex(),
      // [agent:reboot] must NOT quit under the requesting seat: the intent is
      // scanned mid-turn, so an immediate relaunch destroys the turn boundary the
      // reboot notice is delivered across. Arming the same waiter the menu uses
      // holds the restart until every seat — the requester included — has been
      // idle for a sustained window. Never restartClodex() directly here.
      restartHostWhenIdle: (opts) => {
        idleWaiter.arm({ onAbandon: opts && opts.onAbandon, requester: opts && opts.requester });
      },
    },
  });
  manager = engine.manager;
  ({ workspaces, uiSettings, agentLibrary, skillLibrary, envScopes } = engine.stores);

  log.info('app', `startup — Clodex ${app.getVersion()} (electron ${process.versions.electron}, pid ${process.pid})`);

  writeHostStamp(path.join(REGISTRY_DIR, 'run'), __dirname);

  checkForUpdate(true);
  setInterval(() => checkForUpdate(true), UPDATE_CHECK_INTERVAL);

  initTray();

  // ipc-handlers.js holds no electron require — the electron-backed transport and
  // GUI seams are passed from here. No BrowserWindow crosses the boundary; `e` is
  // an opaque sender token only this adapter unwraps.
  const { registerIpcHandlers } = require('./ipc-handlers');
  registerIpcHandlers({
    ...engine,
    ...engine.stores,
    handle: (channel, fn) => ipcMain.handle(channel, fn),
    on: (channel, fn) => ipcMain.on(channel, fn),
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
    createWindow, openWirescopeWindow, workspaceOfSender, workspaceOfSenderStrict,
    // The desktop registrar's half of the plugin surface gate. A constant
    // because this registrar only ever serves BrowserWindows; the value is
    // supplied per-transport, exactly like workspaceOfSender, so a transport
    // that supplies nothing lands in the restricted branch by default.
    surfaceOfSender: () => 'desktop',
    refreshAppMenu, refreshTrayMenu, setUiTheme,
    getUpdateInfo: () => updateInfo,
    getReleasesCache: () => releasesCache,
  });

  buildAppMenu();



  // Open least-recent first so the most recently focused window ends up on top.
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


app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    appQuitting = true;
    if (engine) engine.shutdown();
    app.quit();
  }
});

app.on('before-quit', () => {
  appQuitting = true;
  idleWaiter.disarm(); // T32: don't let a pending idle-wait poll outlive the app
  if (engine) engine.shutdown();
});
