'use strict';
// headless-main.js — the plain-Node entrypoint (`node headless-main.js`), the
// second host of engine.js (main.js being the Electron one). No Electron, no
// Xvfb: for the Linux spokes / future k8s. It resolves userDataPath + the
// electron seams (as log-only / real closures), stands the engine up, restores
// the persisted sessions, and wires SIGTERM/SIGINT to a clean shutdown. There is
// deliberately NO update-checker, NO app-menus/tray, NO ipc-handlers, NO windows
// — those are Electron-frontend concerns the engine does not need to run.
//
// Exit codes: 0 = clean SIGTERM/SIGINT teardown · 1 = another headless instance
// already holds the pidfile · 64 = restart requested (the phone-restart endpoint
// via the restartHost seam) — a supervisor (systemd Restart=always) does the
// actual relaunch; a manual run just exits with the reason logged.
//
// node-pty ABI caveat: the dev checkout's node-pty is built against Electron's
// ABI, so `node headless-main.js` in THIS tree fails to load it. Run it on a
// scratch clone with `npm rebuild` (Node ABI) or on a spoke — never rebuild
// node_modules in the working checkout (it breaks `npm start`).

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { ensureDir } = require('./fs-util');
const { createEngine } = require('./engine');
const { DEFAULT_WORKSPACE_ID } = require('./catalogs');

// ── userDataPath ── CLODEX_DATA_DIR wins; otherwise the platform default that
// `app.getPath('userData')` resolves to for a NON-packaged run of this codebase
// — the LOWERCASE dev name `clodex` (from package.json `name`), NOT the packaged
// productName `Clodex`. The Xvfb spokes launch via `xvfb-run npm start`
// (= `electron .`, dev mode), never the packaged bundle, so Electron derives
// userData from `name`; see the CLAUDE.md "userData rename" gotcha ("npm start
// uses lowercase clodex"). Matching it lets a bare `node headless-main.js`
// auto-adopt an existing Xvfb spoke's sessions.json unchanged. Do NOT "correct"
// this to capital-C to match productName — that points at an empty dir and
// silently loses every session on the first migration. To migrate from a
// PACKAGED build (e.g. a mac Clodex.app, capital-C) set CLODEX_DATA_DIR
// explicitly. Lowercase on all three platforms for the same reason: dev-Electron
// resolves to `~/Library/Application Support/clodex` / `%APPDATA%/clodex` too.
function defaultUserDataPath() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'clodex');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'clodex');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'clodex');
}
const userDataPath = process.env.CLODEX_DATA_DIR || defaultUserDataPath();
ensureDir(userDataPath);

// ── Ops log ── ~/.clodex/clodex.log (same file the Electron host uses), plus a
// mirror to stdout/stderr so `journalctl -u clodex` / `docker logs` capture it.
const REGISTRY_DIR = path.join(os.homedir(), '.clodex');
const LOG_FILE = path.join(REGISTRY_DIR, 'clodex.log');
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
function initLog() {
  try {
    ensureDir(REGISTRY_DIR);
    const st = fs.statSync(LOG_FILE);
    if (st.size > LOG_ROTATE_BYTES) { try { fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch {} }
  } catch { /* first run / unrotatable — writes create it */ }
}
function writeLog(level, tag, message) {
  const line = `${new Date().toISOString()}  ${level}  [${tag}]  ${message}\n`;
  try { fs.appendFileSync(LOG_FILE, line); }
  catch { try { ensureDir(REGISTRY_DIR); fs.appendFileSync(LOG_FILE, line); } catch {} }
  (level === 'ERROR' ? process.stderr : process.stdout).write(line);
}
const log = {
  info: (tag, message) => writeLog('INFO', tag, message),
  warn: (tag, message) => writeLog('WARN', tag, message),
  error: (tag, message) => writeLog('ERROR', tag, message),
};

// ── Login-shell PATH ── a service launcher (systemd, docker) inherits a minimal
// PATH, so `claude`/`codex` from ~/.local/bin aren't resolvable. Always run
// (cheap, idempotent) — unlike the Electron host there is no isPackaged gate.
function fixPathFromLoginShell() {
  if (process.platform === 'win32') return;
  const userShell = process.env.SHELL || '/bin/bash';
  try {
    const out = execSync(
      `${userShell} -ilc 'printf __CLODEX_PATH__%s__CLODEX_PATH__ "$PATH"'`,
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = out.match(/__CLODEX_PATH__(.*?)__CLODEX_PATH__/);
    if (!m || !m[1]) return;
    const shellPath = m[1].split(':').filter(Boolean);
    const current = (process.env.PATH || '').split(':').filter(Boolean);
    process.env.PATH = [...new Set([...shellPath, ...current])].join(':');
  } catch (e) { log.warn('startup', `fixPathFromLoginShell failed: ${e.message}`); }
}
fixPathFromLoginShell();

// ── Env self-decontamination ── strip inherited CLAUDE_* markers and an
// agent-scoped ANTHROPIC_BASE_URL so PTY-spawned CLIs don't behave as nested
// child sessions (which silently blinds transcript writes). The OAuth token
// survives — in the sandbox it arrives via the seeded container env (M4) and
// sessions must inherit it. Semantics live in claude-env.js.
require('./claude-env').scrubInheritedClaudeMarkers(process.env);

// ── PTY-teardown crash net ── node-pty's native layer can throw a Napi error
// asynchronously as a PTY fd closes; benign during shutdown, loud otherwise.
let appQuitting = false;
process.on('uncaughtException', (err) => {
  const msg = err && (err.message || String(err));
  const isPtyTeardown = /Napi|pty|ioctl|EBADF|read of closed|file descriptor/i.test(msg || '');
  if (appQuitting && isPtyTeardown) { log.warn('crash', `suppressed PTY teardown during quit: ${msg}`); return; }
  log.error('crash', `uncaughtException: ${(err && err.stack) || msg}`);
  throw err;
});
process.on('unhandledRejection', (reason) => {
  log.error('crash', `unhandledRejection: ${(reason && reason.stack) || String(reason)}`);
});

// ── Single-instance lock ── a pidfile under userDataPath, with stale-pid
// detection: kill(pid, 0) throwing ESRCH means the previous holder is gone.
const PID_FILE = path.join(userDataPath, 'headless.pid');
function acquirePidLock() {
  try {
    const prev = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (prev && prev !== process.pid) {
      let alive = false;
      try { process.kill(prev, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
      if (alive) {
        log.error('startup', `another Clodex headless instance is running (pid ${prev}); refusing to start`);
        process.exit(1);
      }
      log.warn('startup', `stale pidfile (pid ${prev} not running) — taking over`);
    }
  } catch { /* no pidfile / unreadable — first owner */ }
  fs.writeFileSync(PID_FILE, String(process.pid));
}
function releasePidLock() {
  try {
    const cur = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (cur === process.pid) fs.unlinkSync(PID_FILE);
  } catch {}
}
acquirePidLock();

// ── Engine ── the whole electron-free bootstrap, with headless seams.
initLog();
log.info('app', `startup — Clodex headless (pid ${process.pid}, dataDir ${userDataPath})`);
const engine = createEngine({
  userDataPath,
  log,
  seams: {
    // No desktop to open files on / no notification center — log-only so the
    // action stays traceable.
    openPath: (p) => log.info('seam', `openPath (headless no-op): ${p}`),
    notifyOS: (opts) => log.info('notify', `${(opts && opts.title) || ''}${opts && opts.body ? ` — ${opts.body}` : ''}`),
    setAppQuitting: (v) => { appQuitting = v; },
    // App-menu / tray refresh hooks default to no-ops (there is no menu here).
    // restartHost: shut down cleanly and exit 64 so a supervisor relaunches.
    restartHost: () => {
      log.info('app', 'restart requested — shutting down, exit 64 for supervisor relaunch');
      if (webHost) { try { webHost.close(); } catch {} }
      try { engine.shutdown(); } catch {}
      releasePidLock();
      process.exit(64);
    },
  },
});

// ── Restore persisted sessions ── single-workspace by convention
// (peering/README.md); CLODEX_WORKSPACES (comma-separated ids) for the general
// case. Best-effort per workspace so one bad row can't abort the boot.
const workspaceIds = (process.env.CLODEX_WORKSPACES || DEFAULT_WORKSPACE_ID)
  .split(',').map((s) => s.trim()).filter(Boolean);
(async () => {
  for (const wsId of workspaceIds) {
    try {
      const rows = await engine.restoreSessionsForWorkspace(wsId);
      const failed = (rows || []).filter((r) => r && r.failed).length;
      log.info('app', `restored workspace ${wsId}: ${(rows || []).length} entr${(rows || []).length === 1 ? 'y' : 'ies'}${failed ? `, ${failed} failed` : ''}`);
    } catch (e) {
      log.error('app', `restore ${wsId} failed: ${e && e.message}`);
    }
  }
})();

// ── Web host ── the browser frontend (web-frontend Phase 3). Opt-in via
// CLODEX_WEB_PORT: a plain-Node HTTP+WS server that serves the renderer bundle
// and speaks the window.api contract over WS onto the same engine. Electron never
// loads this — it's the headless host's job. Optional CLODEX_WEB_TOKEN gates every
// route + the WS upgrade + the hello frame; absent = localhost-trust (Phase 4).
let webHost = null;
const webPort = parseInt(process.env.CLODEX_WEB_PORT || '', 10);
if (Number.isInteger(webPort) && webPort > 0) {
  try {
    const { createWebHost } = require('./web-host');
    webHost = createWebHost({
      engine, log, port: webPort,
      token: process.env.CLODEX_WEB_TOKEN || null,
      userDataPath,
    });
  } catch (e) { log.error('app', `web host failed to start: ${e && e.message}`); }
}

// ── Signals ── SIGTERM/SIGINT → engine.shutdown() (kills PTYs, stops
// remote/peer/tunnel + timers) → exit 0. Replaces the Electron before-quit.
let terminating = false;
function terminate(sig) {
  if (terminating) return;
  terminating = true;
  log.info('app', `${sig} — engine.shutdown(), killing all sessions`);
  if (webHost) { try { webHost.close(); } catch (e) { log.error('app', `web host close error: ${e && e.message}`); } }
  try { engine.shutdown(); } catch (e) { log.error('app', `shutdown error: ${e && e.message}`); }
  releasePidLock();
  process.exit(0);
}
process.on('SIGTERM', () => terminate('SIGTERM'));
process.on('SIGINT', () => terminate('SIGINT'));
