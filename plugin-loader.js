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

const { isValidPluginId, HOST_API_VERSION, RESERVED_PLUGIN_IDS } = require('./plugin-api');

// A manifest is refused rather than half-honoured. A plugin that loads with a
// silently-defaulted id or entry point is worse than one that visibly fails:
// the failure is a five-line log entry, the silent default is a mystery three
// releases later.
function validateManifest(m, dirName) {
  if (!m || typeof m !== 'object') return 'manifest is not a JSON object';
  // Reserved BEFORE malformed, so the discovery `problems` row the Manage
  // Plugins dialog renders says WHY rather than "invalid id" for a string that
  // looks perfectly valid to its author. See plugin-api's RESERVED_PLUGIN_IDS
  // for what such a plugin would destroy on its first settings write.
  if (typeof m.id === 'string' && RESERVED_PLUGIN_IDS.has(m.id)) {
    return `plugin id ${JSON.stringify(m.id)} is reserved — it is a key in uiSettings.plugins, so a plugin of that name would overwrite the enabled list`;
  }
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

  // ── Failure record + quarantine ───────────────────────────────────────────
  // BEST EFFORT, not a rescue system. A broken plugin is an annoyance — the code
  // is on disk and a CLI in that cwd can read the diff and revert it — so this is
  // a try/catch and a counter, matching the posture `deactivate()` already sets
  // ("best-effort; the honest full-unload is the restart boundary").
  //
  // THE RULE THIS FILE EXISTS TO KEEP: quarantine NEVER writes
  // `uiSettings.plugins.enabled`. That array is the USER'S INTENT, and flipping
  // it to disable a misbehaving plugin destroys the record of what the user
  // asked for — a later fix would leave the plugin off with nothing saying why.
  // The counter below lives under its OWN key and SHADOWS intent instead, so a
  // settings row can say "disabled automatically … — Retry" with intent intact.
  //
  // `_failures` is collision-proof by construction: PLUGIN_ID_RE forbids a
  // leading underscore, so no plugin can ever own this key and it needs no
  // reservation. (`enabled` is not so lucky — the regex accepts it, so it is
  // reserved EXPLICITLY in plugin-api's RESERVED_PLUGIN_IDS and refused at both
  // doors, validateManifest and register. Before t8 the reservation was a
  // comment with nothing enforcing it.)
  const FAILURES_KEY = '_failures';
  // The SECOND consecutive failure, not the first: one throw is often transient
  // (a half-written file, a missing dir on first run), and quarantining on it
  // turns a blip into a plugin the user has to go re-enable.
  const QUARANTINE_AFTER = 2;

  function failureRecord() {
    let plugins;
    try { plugins = getUiSettings().get().plugins; } catch { plugins = null; }
    const f = plugins && plugins[FAILURES_KEY];
    return (f && typeof f === 'object') ? f : {};
  }

  function writeFailureRecord(next) {
    try {
      const ui = getUiSettings();
      const all = ui.get().plugins || {};
      ui.set({ plugins: { ...all, [FAILURES_KEY]: next } });
    } catch (e) { logIt(`could not persist plugin failure record: ${e && e.message}`); }
  }

  // One strike. Returns the new count so the caller can log the quarantine edge.
  function recordFailure(id, why) {
    const key = String(id);
    const rec = failureRecord();
    const prev = Number(rec[key] && rec[key].count) || 0;
    const count = prev + 1;
    writeFailureRecord({ ...rec, [key]: { count, error: String(why || 'activation failed'), at: Date.now() } });
    logIt(count >= QUARANTINE_AFTER
      ? `${key}: strike ${count} — QUARANTINED (Preferences ▸ Plugins offers Retry; your enabled setting is untouched)`
      : `${key}: strike ${count} of ${QUARANTINE_AFTER} — ${why}`);
    return count;
  }

  // Any successful activation wipes the slate. Consecutive means consecutive.
  function clearFailures(id) {
    const key = String(id);
    const rec = failureRecord();
    if (!(key in rec)) return false;
    const next = { ...rec };
    delete next[key];
    writeFailureRecord(next);
    return true;
  }

  function failureFor(id) { return failureRecord()[String(id)] || null; }

  function isQuarantined(id) {
    const f = failureFor(id);
    return Number(f && f.count) >= QUARANTINE_AFTER;
  }

  // The RENDERER rule (my choice, flagged): a renderer half activates once per
  // BrowserWindow, so N windows would otherwise mean N strikes per launch and a
  // three-window user would quarantine on the FIRST bad launch. So only the
  // FIRST activation report per app run counts — a strike is per launch, not per
  // window, and "consistent failure across activations" reads as "it failed the
  // first time this launch tried it". The simple rule with a clear message,
  // chosen over per-window tallying, per the best-effort calibration.
  const rendererReportedThisRun = new Set();
  function noteRendererActivation(id, ok, error) {
    const key = String(id);
    if (rendererReportedThisRun.has(key)) return { counted: false };
    rendererReportedThisRun.add(key);
    if (ok) { clearFailures(key); return { counted: true, ok: true }; }
    return { counted: true, ok: false, count: recordFailure(key, `renderer activate() threw: ${error || 'unknown error'}`) };
  }

  // ── Discovery (§3.1) ──────────────────────────────────────────────────────
  // Scans `plugins/*/manifest.json` and NOTHING else. `~/.clodex/plugins/` (BYO)
  // is Phase 5 and deliberately absent: a scan path is a trust boundary, and
  // widening it is a decision, never a convenience.
  // Directories that LOOK like a plugin (they have a manifest.json) but were
  // refused, so the settings section can say so instead of the plugin merely
  // being absent. Not persisted and not counted as a strike: there is no id to
  // key a counter by when the manifest itself is the thing that is broken, and a
  // malformed manifest is already fully inert — nothing of it ever ran.
  let discoveryProblems = [];

  function discover() {
    let entries;
    try {
      entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    } catch {
      discoveryProblems = [];
      return []; // no plugins/ dir at all is a legal, silent state
    }
    const problems = [];
    const note = (dir, why) => { problems.push({ dir, why: String(why) }); };
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
        if (fs.existsSync(manifestPath)) {
          logIt(`skipping ${ent.name}: unreadable manifest — ${e && e.message}`);
          note(ent.name, `unreadable manifest — ${(e && e.message) || e}`);
        }
        continue;
      }
      const why = validateManifest(manifest, ent.name);
      if (why) { logIt(`skipping ${ent.name}: ${why}`); note(ent.name, why); continue; }
      const entry = manifest.entry || {};
      for (const half of ['engine', 'renderer']) {
        if (entry[half] && !insideDir(path, dir, entry[half])) {
          logIt(`skipping ${ent.name}: entry.${half} escapes the plugin directory`);
          note(ent.name, `entry.${half} escapes the plugin directory`);
          manifest = null;
          break;
        }
      }
      if (!manifest) continue;
      if (manifest.style && !insideDir(path, dir, manifest.style)) {
        logIt(`skipping ${ent.name}: style escapes the plugin directory`);
        note(ent.name, 'style escapes the plugin directory');
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
    discoveryProblems = problems;
    return out;
  }

  // ── The enabled set (§3.1: `uiSettings.plugins.enabled`) ──────────────────
  // Shape: an ARRAY of ids under `uiSettings.plugins.enabled`, sitting beside
  // the per-plugin settings objects `uiSettings.plugins[<id>]` that §2.5 already
  // writes. Sharing one object is why `enabled` has to be a reserved ID and not
  // merely a key name: a plugin called `enabled` would write its settings object
  // straight over the user's list. `isValidPluginId` now refuses it (t8 F4) —
  // this const is the key, plugin-api's RESERVED_PLUGIN_IDS is the enforcement.
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
  // `require` and `activate(host)` both run inside this try. The engine half
  // activates in createEngine's bootstrap, BEFORE any window exists, so an
  // uncaught throw here would kill startup with no window at all — the user
  // could not even open a session to repair the plugin. That is the whole
  // motivation for the catch, and why it is this broad.
  function loadOne(rec, pluginHost, { count = true } = {}) {
    try {
      const mod = rec.enginePath ? requireModule(rec.enginePath) : {};
      pluginHost.register(rec.id, mod, rec.manifest);
      logIt(`loaded ${rec.id} v${rec.manifest.version || '?'}`);
      if (count) clearFailures(rec.id); // a success clears the slate, always
      return { ok: true };
    } catch (e) {
      const error = String((e && e.message) || e);
      logIt(`FAILED to load ${rec.id}: ${error}`);
      const strikes = count ? recordFailure(rec.id, `engine activate() threw: ${error}`) : 0;
      return { ok: false, error, ...(strikes >= QUARANTINE_AFTER ? { quarantined: true } : {}) };
    }
  }

  // Called once from the createEngine tail, right after the host is built.
  function loadAll(pluginHost) {
    const results = [];
    for (const rec of discover()) {
      if (!isEnabled(rec)) { results.push({ id: rec.id, ok: true, skipped: 'disabled' }); continue; }
      // Quarantine SHADOWS enabled — it does not replace it. The plugin stays in
      // the user's enabled list and simply is not activated this run, so the
      // settings row can offer Retry against intent that was never overwritten.
      if (isQuarantined(rec.id)) {
        results.push({ id: rec.id, ok: true, skipped: 'quarantined' });
        logIt(`${rec.id}: skipped — quarantined after ${QUARANTINE_AFTER} consecutive failed activations (Preferences ▸ Plugins ▸ Retry)`);
        continue;
      }
      results.push({ id: rec.id, ...loadOne(rec, pluginHost) });
    }
    return results;
  }

  // The seam plugin-host-engine's setEnabled(id, true) calls — the honest other
  // half of Phase 1's disable-only story. An explicit enable is also the Retry
  // button: it clears the counter FIRST, so a user who fixed the plugin is not
  // refused by a stale strike, and a still-broken one starts its count over.
  function activateById(id, pluginHost) {
    const rec = discover().find((r) => r.id === String(id));
    if (!rec) return { ok: false, error: `no such plugin: ${id}` };
    clearFailures(rec.id);
    rendererReportedThisRun.delete(String(id));
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

  // What the §2.5 settings section renders: one row per DISCOVERED plugin —
  // present on disk, whatever its state — plus the directories that failed
  // validation. A plugin that is quarantined must still appear, otherwise the
  // only UI that could clear it is the one that hides it.
  function status() {
    const recs = discover();
    const failures = failureRecord();
    return {
      plugins: recs.map((rec) => {
        const f = failures[rec.id] || null;
        return {
          id: rec.id,
          name: rec.manifest.name || rec.id,
          version: rec.manifest.version || null,
          description: rec.manifest.announce || null,
          // The user's INTENT, read straight off the enabled set / manifest
          // default — never overwritten by quarantine.
          enabled: isEnabled(rec),
          quarantined: isQuarantined(rec.id),
          failCount: Number(f && f.count) || 0,
          lastError: (f && f.error) || null,
        };
      }),
      problems: discoveryProblems.slice(),
    };
  }

  return {
    discover, isEnabled, enabledSet, setEnabledInSettings,
    loadAll, activateById, rendererInfo,
    // Fail-safe / quarantine surface. `noteRendererActivation` is what a WINDOW
    // reports its renderer half's outcome through; the rest is the settings
    // section's data and the Retry path.
    status, noteRendererActivation, clearFailures, isQuarantined,
    // Test/introspection seam — the validator, so its refusals are directly
    // assertable rather than only observable as a missing plugin.
    _validateManifest: validateManifest,
    _quarantineAfter: QUARANTINE_AFTER,
  };
}

module.exports = { createPluginLoader, validateManifest };
