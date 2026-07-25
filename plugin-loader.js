'use strict';
// plugin-loader.js — DISCOVERY + the enabled set (docs/plugin-plan.md §3.1).
//
// Phase 1 built the host but deliberately no loader: `setEnabled(id, true)`
// returned "enabling requires the plugin loader (Phase 2)" because there was
// nothing to load FROM. This file is that missing half, and it is what makes
// Phase 2's W4 possible at all — the moment core stops owning `#btn-workbench`,
// something has to put the workbench plugin's footer button there instead.
//
// Electron-free and fs/path-injected, the same shape as every other M3 module,
// for the same reason: the headless host stands the engine up with no Electron,
// and a plugin's engine half inherits that constraint (test/electron-boundary).
//
// ── What this file is NOT ──────────────────────────────────────────────────
// It does not activate renderer halves. A renderer half is per-BrowserWindow
// (§3.3 law 1), so the renderer's own plugin-host island loads it, once per
// window, from the manifest rows this file publishes through `catalog()`. The
// engine half is per-app-run; the renderer half is per-window; conflating them
// is exactly the multi-window blind spot §3.3 exists to prevent.

const { isValidPluginId, HOST_API_VERSION } = require('./plugin-api');

// A manifest is refused rather than half-honoured. A plugin that loads with a
// silently-defaulted id or entry point is worse than one that visibly fails:
// the failure is a five-line log entry, the silent default is a mystery three
// releases later.
function validateManifest(m, dirName) {
  if (!m || typeof m !== 'object') return 'manifest is not a JSON object';
  if (!isValidPluginId(m.id)) return `invalid plugin id: ${JSON.stringify(m.id)}`;
  // The directory name IS the id. Allowing them to diverge means two names for
  // one plugin — one in settings, one on disk — and every later "which one is
  // it?" bug follows from that.
  if (m.id !== dirName) return `manifest id "${m.id}" does not match its directory "${dirName}"`;
  const want = String(m.hostApi ?? '');
  if (want !== HOST_API_VERSION) return `wants hostApi "${want}" but this host is "${HOST_API_VERSION}"`;
  if (!m.entry || typeof m.entry !== 'object') return 'manifest.entry is missing';
  if (m.entry.engine && typeof m.entry.engine !== 'string') return 'manifest.entry.engine must be a string';
  if (m.entry.renderer && typeof m.entry.renderer !== 'string') return 'manifest.entry.renderer must be a string';
  if (!m.entry.engine && !m.entry.renderer) return 'manifest.entry names neither an engine nor a renderer half';
  return null;
}

// Refuse any entry path that escapes the plugin's own directory. This is the
// runtime twin of test/plugin-boundary.test.js's static no-backdoor lint: the
// lint reads requires inside plugins/, this refuses a manifest that points its
// entry at `../../session-manager` in the first place. Neither alone is enough
// — a static scanner cannot see a path assembled in a manifest, and a runtime
// check cannot see a require buried three files deep.
function insideDir(path, dir, rel) {
  const resolved = path.resolve(dir, rel);
  return resolved === dir || resolved.startsWith(dir + path.sep);
}

function createPluginLoader(deps) {
  const {
    fs, path,
    pluginsDir,        // <repo>/plugins — §3.1 scans exactly this, Phases 1-3
    getUiSettings,     // getter: the store seam, assigned in the bootstrap
    log,
    requireModule,     // seam: node's require, injectable so tests load fakes
  } = deps;

  const logIt = (msg) => { try { log.info('plugin', String(msg)); } catch {} };

  // ── Discovery (§3.1) ──────────────────────────────────────────────────────
  // Scans `plugins/*/manifest.json` and NOTHING else. `~/.clodex/plugins/` (BYO)
  // is Phase 5 and deliberately absent: a scan path is a trust boundary, and
  // widening it is a decision, never a convenience.
  function discover() {
    let entries;
    try {
      entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    } catch {
      return []; // no plugins/ dir at all is a legal, silent state
    }
    const out = [];
    for (const ent of entries.filter((d) => d.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const dir = path.join(pluginsDir, ent.name);
      const manifestPath = path.join(dir, 'manifest.json');
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        // A directory without a readable manifest is not a plugin. Only complain
        // if a manifest.json exists but is broken — an unrelated subdirectory is
        // not an error.
        if (fs.existsSync(manifestPath)) logIt(`skipping ${ent.name}: unreadable manifest — ${e && e.message}`);
        continue;
      }
      const why = validateManifest(manifest, ent.name);
      if (why) { logIt(`skipping ${ent.name}: ${why}`); continue; }
      const entry = manifest.entry || {};
      for (const half of ['engine', 'renderer']) {
        if (entry[half] && !insideDir(path, dir, entry[half])) {
          logIt(`skipping ${ent.name}: entry.${half} escapes the plugin directory`);
          manifest = null;
          break;
        }
      }
      if (!manifest) continue;
      if (manifest.style && !insideDir(path, dir, manifest.style)) {
        logIt(`skipping ${ent.name}: style escapes the plugin directory`);
        continue;
      }
      out.push({
        id: manifest.id,
        dir,
        manifest,
        enginePath: entry.engine ? path.join(dir, entry.engine) : null,
        rendererPath: entry.renderer ? path.join(dir, entry.renderer) : null,
        stylePath: manifest.style ? path.join(dir, manifest.style) : null,
      });
    }
    return out;
  }

  // ── The enabled set (§3.1: `uiSettings.plugins.enabled`) ──────────────────
  // Shape: an ARRAY of ids under `uiSettings.plugins.enabled`, sitting beside
  // the per-plugin settings objects `uiSettings.plugins[<id>]` that §2.5 already
  // writes. `enabled` is therefore a reserved id — rejected by isValidPluginId's
  // caller? No: it is a legal id string, so it is explicitly reserved here.
  const RESERVED_SETTINGS_KEY = 'enabled';

  function enabledSet() {
    let plugins;
    try { plugins = getUiSettings().get().plugins; } catch { plugins = null; }
    const list = plugins && plugins[RESERVED_SETTINGS_KEY];
    return Array.isArray(list) ? list.map(String) : null; // null = "never chosen"
  }

  // A plugin the user has never made a decision about falls back to its own
  // manifest `enabledByDefault`. That is what lets the workbench pilot ship
  // enabled (W7) without writing a settings entry into every existing install —
  // and it keeps "the user turned this off" distinguishable from "the user has
  // never seen this", which a bare boolean in settings would erase.
  function isEnabled(rec) {
    const list = enabledSet();
    if (list) return list.includes(rec.id);
    return rec.manifest.enabledByDefault !== false;
  }

  function setEnabledInSettings(id, enabled) {
    const ui = getUiSettings();
    const all = ui.get().plugins || {};
    // Materialize the CURRENT effective set before mutating it, so the first
    // ever toggle doesn't silently disable every default-on plugin by writing a
    // one-element array over an absent list.
    const current = enabledSet() || discover().filter(isEnabled).map((r) => r.id);
    const next = enabled
      ? [...new Set([...current, String(id)])]
      : current.filter((x) => x !== String(id));
    ui.set({ plugins: { ...all, [RESERVED_SETTINGS_KEY]: next } });
    return next;
  }

  // ── Loading the ENGINE half ───────────────────────────────────────────────
  // One plugin's failure is its own. A throwing `require` or `activate` must
  // leave the app running without that plugin — the same degrade-loudly rule the
  // host construction itself follows in engine.js.
  function loadOne(rec, pluginHost) {
    try {
      const mod = rec.enginePath ? requireModule(rec.enginePath) : {};
      pluginHost.register(rec.id, mod, rec.manifest);
      logIt(`loaded ${rec.id} v${rec.manifest.version || '?'}`);
      return { ok: true };
    } catch (e) {
      logIt(`FAILED to load ${rec.id}: ${e && e.message}`);
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // Called once from the createEngine tail, right after the host is built.
  function loadAll(pluginHost) {
    const results = [];
    for (const rec of discover()) {
      if (!isEnabled(rec)) { results.push({ id: rec.id, ok: true, skipped: 'disabled' }); continue; }
      results.push({ id: rec.id, ...loadOne(rec, pluginHost) });
    }
    return results;
  }

  // The seam plugin-host-engine's setEnabled(id, true) calls — the honest other
  // half of Phase 1's disable-only story.
  function activateById(id, pluginHost) {
    const rec = discover().find((r) => r.id === String(id));
    if (!rec) return { ok: false, error: `no such plugin: ${id}` };
    return loadOne(rec, pluginHost);
  }

  // What the renderer needs to activate a renderer half, published through the
  // EXISTING `plugin:catalog` row — no new api-contract row, because §1 freezes
  // the plugin surface at five rows for every plugin forever. The css TEXT (not
  // a path) rides along deliberately: the renderer host injects a per-plugin
  // <style> element (§2.6), and a text payload works identically in the file://
  // Electron window and the built web bundle, where no path resolves.
  function rendererInfo(id) {
    const rec = discover().find((r) => r.id === String(id));
    if (!rec) return null;
    let css = null;
    if (rec.stylePath) {
      try { css = fs.readFileSync(rec.stylePath, 'utf8'); } catch { css = null; }
    }
    return { rendererPath: rec.rendererPath, css };
  }

  return {
    discover, isEnabled, enabledSet, setEnabledInSettings,
    loadAll, activateById, rendererInfo,
    // Test/introspection seam — the validator, so its refusals are directly
    // assertable rather than only observable as a missing plugin.
    _validateManifest: validateManifest,
  };
}

module.exports = { createPluginLoader, validateManifest };
