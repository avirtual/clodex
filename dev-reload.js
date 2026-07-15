// dev-reload.js — DEV-ONLY hot reload. Wired from main.js only when the
// CLODEX_DEV env var is set (via `npm run dev`), so a packaged build never
// loads or runs any of this. Two watchers, two granularities:
//
//   renderer/**            → reload every live BrowserWindow in place (fast;
//                            keeps the main process, sessions, and PTYs alive).
//   main-process *.js      → full app relaunch (app.relaunch + exit) because a
//                            changed main module can't be re-required into a
//                            running process. Sessions are persisted and
//                            --resume on the fresh launch, so this is safe.
//
// fs.watch({recursive:true}) is used — supported on macOS (this app is
// arm64-mac-first) and Windows; on Linux it degrades to non-recursive, which is
// fine for the flat main-process layout and merely misses nested renderer subdirs
// (the top-level renderer/ files still fire). No new dependency.

const fs = require('fs');
const path = require('path');

// Main-process modules live flat at the repo root (main.js, engine.js, …) plus
// the wire/ dir. Editing any of them requires a relaunch. The renderer/ tree is
// handled separately (in-place reload), so it is NOT in this set.
const MAIN_WATCH_DIRS = [__dirname, path.join(__dirname, 'wire')];
const RENDERER_DIR = path.join(__dirname, 'renderer');

// Never relaunch/reload for churn we write ourselves or that isn't source.
const IGNORE_RE = /(^|[/\\])(node_modules|\.git|build|dist|vendor|docker|test|docs|scripts)([/\\]|$)/;
const isSource = (f) => typeof f === 'string' && /\.(js|html|css)$/.test(f) && !IGNORE_RE.test(f);

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// installDevReload({ app, BrowserWindow, onRelaunch }) — start both watchers.
// onRelaunch is the app's own graceful-shutdown hook (engine.shutdown) so PTYs
// tear down cleanly before the process exits and the new one resumes them.
function installDevReload({ app, BrowserWindow, onRelaunch }) {
  const log = (...a) => console.log('[dev-reload]', ...a);
  const watchers = [];

  // --- Renderer: reload windows in place -----------------------------------
  const reloadWindows = debounce(() => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    log(`renderer changed → reloading ${wins.length} window(s)`);
    for (const w of wins) {
      try { w.webContents.reloadIgnoringCache(); } catch {}
    }
  }, 120);

  try {
    watchers.push(fs.watch(RENDERER_DIR, { recursive: true }, (_evt, file) => {
      if (isSource(file)) reloadWindows();
    }));
  } catch (e) {
    log('renderer watch unavailable:', e.message);
  }

  // --- Main process: relaunch the whole app --------------------------------
  let relaunching = false;
  const relaunch = debounce((file) => {
    if (relaunching) return;
    relaunching = true;
    log(`main changed (${file}) → relaunching app`);
    try { onRelaunch && onRelaunch(); } catch (e) { log('shutdown hook threw:', e.message); }
    // Carry the same argv (incl. CLODEX_DEV via env) into the fresh process.
    app.relaunch();
    app.exit(0);
  }, 200);

  for (const dir of MAIN_WATCH_DIRS) {
    try {
      // Non-recursive for the flat root so a renderer/ event doesn't double-fire
      // here; wire/ is shallow enough that recursive vs not doesn't matter.
      const recursive = dir !== __dirname;
      watchers.push(fs.watch(dir, { recursive }, (_evt, file) => {
        if (!isSource(file)) return;
        // The root watch (non-recursive) still surfaces bare filenames only, so a
        // renderer/foo.js edit never reaches here; guard anyway for the wire/ case.
        if (file && file.startsWith('renderer')) return;
        relaunch(file);
      }));
    } catch (e) {
      log(`main watch unavailable for ${dir}:`, e.message);
    }
  }

  log('watching for changes (renderer → reload, main → relaunch)');

  // Tidy up if the app quits for any other reason.
  app.on('before-quit', () => { for (const w of watchers) { try { w.close(); } catch {} } });
}

module.exports = { installDevReload };
