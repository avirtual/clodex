'use strict';

const { isValidPluginId, HOST_API_VERSION, RESERVED_PLUGIN_IDS, PLUGIN_SCOPES, scopeOf } = require('./plugin-api');

function validateManifest(m, dirName) {
  if (!m || typeof m !== 'object') return 'manifest is not a JSON object';
  if (typeof m.id === 'string' && RESERVED_PLUGIN_IDS.has(m.id)) {
    return `plugin id ${JSON.stringify(m.id)} is reserved — it is a key in uiSettings.plugins, so a plugin of that name would overwrite the enabled list`;
  }
  if (!isValidPluginId(m.id)) return `invalid plugin id: ${JSON.stringify(m.id)}`;
  if (m.id !== dirName) return `manifest id "${m.id}" does not match its directory "${dirName}"`;
  const want = String(m.hostApi ?? '');
  if (want !== HOST_API_VERSION) return `wants hostApi "${want}" but this host is "${HOST_API_VERSION}"`;
  // REFUSED rather than defaulted: `scopeOf` resolves anything unrecognized to
  // `global`, so a typo'd scope on a plugin meant to be invisible would load it
  // for every session — the exact failure the field exists to prevent, and
  // silent. An absent scope is legal and means global.
  if (m.scope != null && !PLUGIN_SCOPES.includes(m.scope)) {
    return `invalid scope: ${JSON.stringify(m.scope)} — must be ${PLUGIN_SCOPES.map((s) => JSON.stringify(s)).join(' or ')}`;
  }
  if (!m.entry || typeof m.entry !== 'object') return 'manifest.entry is missing';
  if (m.entry.engine && typeof m.entry.engine !== 'string') return 'manifest.entry.engine must be a string';
  if (m.entry.renderer && typeof m.entry.renderer !== 'string') return 'manifest.entry.renderer must be a string';
  if (!m.entry.engine && !m.entry.renderer) return 'manifest.entry names neither an engine nor a renderer half';
  return null;
}

// Comparable versions are dot-separated runs of digits, compared NUMERICALLY
// (string order puts "1.10" below "1.9"). Semver pre-release ordering is
// deliberately not implemented: `1.0.0-beta` is uncomparable and simply loses.
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const parts = v.trim().split('.');
  if (!parts.length || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.map(Number);
}

function isNewerVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// Runtime twin of the static no-backdoor lint in test/plugin-boundary.test.js:
// a static scanner cannot see a path assembled in a manifest, so neither is redundant.
function insideDir(path, dir, rel) {
  const resolved = path.resolve(dir, rel);
  return resolved === dir || resolved.startsWith(dir + path.sep);
}

function createPluginLoader(deps) {
  const {
    fs, path,
    pluginsDir,        // legacy single-root form; equivalent to roots: [{ dir }]
    roots: rootsIn,    // [{ id, dir, label }] in PRECEDENCE order — plugins/plugin-sources.md §3
    getUiSettings,     // getter: the store seam, assigned in the bootstrap
    log,
    requireModule,     // seam: node's require, injectable so tests load fakes
  } = deps;

  const roots = (Array.isArray(rootsIn) && rootsIn.length
    ? rootsIn
    : [{ id: 'core', dir: pluginsDir, label: 'Built in' }]
  ).filter((r) => r && r.dir);

  const logIt = (msg) => { try { log.info('plugin', String(msg)); } catch {} };

  // Quarantine must NEVER write uiSettings.plugins.enabled — that array is the
  // user's intent; this counter shadows it instead. `_failures` needs no
  // reservation: a plugin id may not begin with an underscore (`enabled` may, so
  // it is reserved explicitly in plugin-api).
  const FAILURES_KEY = '_failures';
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

  // Only the FIRST renderer activation report per app run counts a strike: a
  // renderer half activates once per BrowserWindow, so per-window counting would
  // quarantine on the first bad launch of a multi-window user. verbConflicts stays
  // in memory — a persisted row would outlive the plugin that held the verb.
  const verbConflicts = new Map();

  // `require` caches by resolved path, so re-requiring an engine half already
  // loaded this run hands back the OLD module object: a changed plugin cannot be
  // hot-reloaded, only restart-required. In memory only — a persisted copy would
  // outlive the restart that resolves it.
  const restartRequired = new Map(); // id -> { was, now, dirChanged }
  const requiredPaths = new Map(); // enginePath -> version first required
  const loadedFrom = new Map(); // id -> { dir, version }

  const rendererReportedThisRun = new Set();
  function noteRendererActivation(id, ok, error) {
    const key = String(id);
    if (rendererReportedThisRun.has(key)) return { counted: false };
    rendererReportedThisRun.add(key);
    if (ok) { clearFailures(key); return { counted: true, ok: true }; }
    return { counted: true, ok: false, count: recordFailure(key, `renderer activate() threw: ${error || 'unknown error'}`) };
  }

  let discoveryProblems = [];
  let discoveryShadowed = [];

  // A symlinked plugin directory is FOLLOWED. readdirSync(withFileTypes) reports
  // a symlink-to-directory as isSymbolicLink() and NOT isDirectory(), so the
  // obvious filter skips it — and skips it silently, since a directory with no
  // readable manifest is not an error. Symlinking a plugin out of a working
  // checkout is the most likely thing a developer does in the user root, so that
  // silence would be the first thing a real user hit. The resolved path is what
  // every later check runs against (see resolveDir).
  function isCandidateDir(rootDir, ent) {
    if (ent.isDirectory()) return true;
    if (!ent.isSymbolicLink()) return false;
    try { return fs.statSync(path.join(rootDir, ent.name)).isDirectory(); } catch { return false; }
  }

  // The directory a plugin's paths are judged against. A SYMLINKED entry is
  // collapsed so `insideDir` compares like with like — otherwise an entry inside
  // a symlinked plugin resolves through the link target and fails a prefix test
  // against the link path, or worse passes one it should not.
  //
  // Only symlinks are resolved, deliberately. Calling realpathSync on every
  // directory also rewrites paths that contain no link at all — on macOS
  // /var/... becomes /private/var/... — which changes the `dir`, `enginePath`
  // and `rendererPath` every existing caller already sees. Caught by an existing
  // rendererInfo test, which is the whole reason this is conditional.
  function resolveDir(dir, isLink) {
    if (!isLink) return dir;
    try { return fs.realpathSync(dir); } catch { return dir; }
  }

  // `reason` is stamped here rather than inferred downstream from a version diff:
  // a copy with an unparseable version loses as UNCOMPARABLE, not as lower, and a
  // row reading "superseded" would send its author chasing a version bump that
  // cannot help. Both sides are named because the loser can be the built-in copy.
  function shadowRow(loser, winner, reason) {
    return {
      id: loser.manifest.id,
      dir: loser.dir,
      root: loser.root,
      rootLabel: loser.rootLabel,
      version: loser.manifest.version || null,
      comparable: !!parseVersion(loser.manifest.version),
      reason,
      shadowedBy: winner.root,
      shadowedByLabel: winner.rootLabel,
      shadowedByVersion: winner.manifest.version || null,
    };
  }

  function discoverRoot(root, claimed, problems, shadowed, out) {
    let entries;
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      return; // a root that does not exist is a legal, silent state
    }
    const note = (dir, why) => { problems.push({ dir, why: String(why), root: root.id }); };
    for (const ent of entries.filter((d) => isCandidateDir(root.dir, d)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const dir = resolveDir(path.join(root.dir, ent.name), ent.isSymbolicLink());
      const manifestPath = path.join(dir, 'manifest.json');
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        if (fs.existsSync(manifestPath)) {
          logIt(`skipping ${ent.name}: unreadable manifest — ${e && e.message}`);
          note(ent.name, `unreadable manifest — ${(e && e.message) || e}`);
        }
        continue;
      }
      // The dirname compared is the one in the ROOT, not the symlink target's:
      // what the user named the directory is what they meant the id to be.
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
      const rec = {
        id: manifest.id,
        dir,
        root: root.id,
        rootLabel: root.label || root.id,
        manifest,
        enginePath: entry.engine ? path.join(dir, entry.engine) : null,
        rendererPath: entry.renderer ? path.join(dir, entry.renderer) : null,
        stylePath: manifest.style ? path.join(dir, manifest.style) : null,
      };
      const held = claimed.get(manifest.id);
      if (held) {
        if (isNewerVersion(manifest.version, held.rec.manifest.version)) {
          logIt(`${manifest.id}: the ${rec.rootLabel} copy v${manifest.version} supersedes the ${held.rec.rootLabel} copy v${held.rec.manifest.version || '?'}`);
          shadowed.push(shadowRow(held.rec, rec, 'superseded'));
          out[held.index] = rec;               // the winner takes the incumbent's slot
          claimed.set(manifest.id, { rec, index: held.index });
        } else {
          logIt(`skipping ${ent.name} in ${root.id}: shadowed by the ${held.rec.rootLabel} copy`);
          shadowed.push(shadowRow(rec, held.rec, 'precedence'));
        }
        continue;
      }
      claimed.set(manifest.id, { rec, index: out.length });
      out.push(rec);
    }
  }

  function discover() {
    const problems = [];
    const shadowed = [];
    const claimed = new Map(); // id -> { rec, index } — the copy currently winning
    const out = [];
    for (const root of roots) discoverRoot(root, claimed, problems, shadowed, out);
    discoveryProblems = problems;
    discoveryShadowed = shadowed;
    return out;
  }

  const RESERVED_SETTINGS_KEY = 'enabled';

  function enabledSet() {
    let plugins;
    try { plugins = getUiSettings().get().plugins; } catch { plugins = null; }
    const list = plugins && plugins[RESERVED_SETTINGS_KEY];
    return Array.isArray(list) ? list.map(String) : null; // null = "never chosen"
  }

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

  function loadOne(rec, pluginHost, { count = true } = {}) {
    try {
      // Must run BEFORE the require: once the path is in the require cache, which
      // version the running code came from is no longer answerable.
      const priorVersion = rec.enginePath ? requiredPaths.get(rec.enginePath) : undefined;
      const nowVersion = rec.manifest.version || null;
      if (priorVersion !== undefined && priorVersion !== nowVersion) {
        restartRequired.set(rec.id, { was: priorVersion, now: nowVersion, dirChanged: false });
      }
      const mod = rec.enginePath ? requireModule(rec.enginePath) : {};
      if (rec.enginePath && priorVersion === undefined) requiredPaths.set(rec.enginePath, nowVersion);
      pluginHost.register(rec.id, mod, rec.manifest);
      logIt(`loaded ${rec.id} v${rec.manifest.version || '?'}`);
      verbConflicts.delete(rec.id);
      loadedFrom.set(rec.id, { dir: rec.dir, version: rec.manifest.version || null });
      if (count) clearFailures(rec.id); // a success clears the slate, always
      return { ok: true };
    } catch (e) {
      const error = String((e && e.message) || e);
      // No strike for a verb collision: it reproduces on every launch, so a counter
      // would quarantine a working plugin with Retry unable to recover it. Recorded
      // for the settings row and deliberately not persisted.
      if (e && e.code === 'EVERBTAKEN') {
        verbConflicts.set(rec.id, { verb: e.verb, heldBy: e.heldBy });
        logIt(`${rec.id}: NOT loaded — intent verb "${e.verb}" is already held by "${e.heldBy}". No strike; disable one of the two.`);
        return { ok: false, error, verbConflict: { verb: e.verb, heldBy: e.heldBy } };
      }
      logIt(`FAILED to load ${rec.id}: ${error}`);
      const strikes = count ? recordFailure(rec.id, `engine activate() threw: ${error}`) : 0;
      return { ok: false, error, ...(strikes >= QUARANTINE_AFTER ? { quarantined: true } : {}) };
    }
  }

  function loadAll(pluginHost) {
    const results = [];
    for (const rec of discover()) {
      if (!isEnabled(rec)) { results.push({ id: rec.id, ok: true, skipped: 'disabled' }); continue; }
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
    verbConflicts.delete(String(id));
    rendererReportedThisRun.delete(String(id));
    // restartRequired is deliberately NOT cleared here: an enable does not empty the
    // require cache, so a toggle must not launder stale code into looking fresh.
    return loadOne(rec, pluginHost);
  }

  // count:false below is deliberate — pressing Re-scan must not quarantine a plugin
  // that happened to be half-copied at the moment of the scan.
  function rescan(pluginHost) {
    // "Is this id running?" is the host's fact, not loadedFrom's: loadedFrom keeps
    // its entry after a disable, so trusting it alone would report restart-required
    // for a plugin that is not running and could simply be loaded.
    const running = new Set((pluginHost.catalog() || []).map((p) => p.id));
    const before = new Set([...loadedFrom.keys()].filter((id) => running.has(id)));
    const recs = discover();
    const seen = new Set();
    const added = [];
    const failed = [];
    const changed = [];

    for (const rec of recs) {
      seen.add(rec.id);
      const live = running.has(rec.id) ? loadedFrom.get(rec.id) : null;
      if (live) {
        const movedDir = live.dir !== rec.dir;
        const movedVersion = (live.version || null) !== (rec.manifest.version || null);
        if (movedDir || movedVersion) {
          restartRequired.set(rec.id, {
            was: live.version, now: rec.manifest.version || null, dirChanged: movedDir,
          });
          changed.push(rec.id);
        }
        continue;
      }
      if (!isEnabled(rec)) continue;
      if (isQuarantined(rec.id)) continue;
      const r = loadOne(rec, pluginHost, { count: false });
      if (r.ok) added.push(rec.id);
      else failed.push({ id: rec.id, error: r.error, ...(r.verbConflict ? { verbConflict: r.verbConflict } : {}) });
    }

    const removed = [];
    for (const id of before) {
      if (seen.has(id)) continue;
      try { pluginHost.deactivate(id); } catch {}
      loadedFrom.delete(id);
      restartRequired.delete(id);
      rendererReportedThisRun.delete(id);
      removed.push(id);
      logIt(`${id}: removed from disk — deactivated`);
    }

    logIt(`re-scan: ${added.length} added, ${removed.length} removed, ${changed.length} changed (restart required), ${failed.length} failed`);
    return { added, removed, changed, failed };
  }

  // Startup must never create the user plugins root — its absence is the honest
  // representation of no user plugins. Created here only because this runs when a
  // user explicitly asks to be shown the path, and revealing a path that does not
  // exist is a broken action on every platform.
  function ensureUserRoot() {
    const root = roots.find((r) => r.id === 'user');
    if (!root) return null;
    try { fs.mkdirSync(root.dir, { recursive: true }); } catch (e) {
      logIt(`could not create the user plugins dir: ${e && e.message}`);
    }
    return root.dir;
  }

  // No path argument, no recursion, no writes: the root comes from `roots` and
  // cannot be influenced by the caller. A caller-supplied path would make this a
  // remote file browser, which is a different feature with a security review.
  function listUserRoot() {
    const dir = ensureUserRoot();
    if (!dir) return null;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      logIt(`could not read the user plugins dir: ${e && e.message}`);
      return { dir, entries: null, error: String((e && e.message) || e) };
    }
    return { dir, entries };
  }

  // css TEXT, not a path: the renderer injects a per-plugin <style> element, and no
  // path resolves in the built web bundle.
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
          enabled: isEnabled(rec),
          quarantined: isQuarantined(rec.id),
          failCount: Number(f && f.count) || 0,
          lastError: (f && f.error) || null,
          verbConflict: verbConflicts.get(rec.id) || null,
          restartRequired: restartRequired.get(rec.id) || null,
          root: rec.root || null,
          rootLabel: rec.rootLabel || null,
          scope: scopeOf(rec.manifest),
        };
      }),
      problems: discoveryProblems.slice(),
      shadowed: discoveryShadowed.slice(),
    };
  }

  return {
    discover, isEnabled, enabledSet, setEnabledInSettings,
    loadAll, activateById, rescan, ensureUserRoot, listUserRoot, rendererInfo,
    status, noteRendererActivation, clearFailures, isQuarantined,
    _validateManifest: validateManifest,
    _isNewerVersion: isNewerVersion,
    _quarantineAfter: QUARANTINE_AFTER,
  };
}

module.exports = { createPluginLoader, validateManifest, isNewerVersion };
