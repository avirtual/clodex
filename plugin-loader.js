'use strict';

const os = require('os');
const {
  isValidPluginId, HOST_API_VERSION, RESERVED_PLUGIN_IDS, PLUGIN_SCOPES, scopeOf,
  PLUGIN_METHOD_SURFACES,
} = require('./plugin-api');
const { AGENT_NAME_RE } = require('./catalogs');
const { createPluginSource } = require('./plugin-source');

function validateManifest(m, dirName, hasBundle = false) {
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
  // Same refusal logic as `scope`, and for a sharper reason: `methodSurfaceOf`
  // resolves anything unrecognized to `desktop`, so a typo here fails CLOSED —
  // the plugin loads and the method silently stops working on the web surface.
  // A named refusal at load time is the only way that reaches the author.
  if (m.surfaces != null) {
    if (typeof m.surfaces !== 'object' || Array.isArray(m.surfaces)) {
      return 'manifest.surfaces must be an object mapping method name to surface';
    }
    for (const [method, want] of Object.entries(m.surfaces)) {
      if (!PLUGIN_METHOD_SURFACES.includes(want)) {
        return `invalid surface for method ${JSON.stringify(method)}: ${JSON.stringify(want)} — must be ${PLUGIN_METHOD_SURFACES.map((s) => JSON.stringify(s)).join(' or ')}`;
      }
    }
  }
  if (!m.entry || typeof m.entry !== 'object') return 'manifest.entry is missing';
  if (m.entry.engine && typeof m.entry.engine !== 'string') return 'manifest.entry.engine must be a string';
  if (m.entry.renderer && typeof m.entry.renderer !== 'string') return 'manifest.entry.renderer must be a string';
  if (!m.entry.engine && !m.entry.renderer && !hasBundle) {
    return 'manifest.entry names neither an engine nor a renderer half, and the directory carries no skills/, agents/, prompts/ or templates/ entry';
  }
  return null;
}

const BUNDLE_PROMPT_KINDS = ['system', 'append'];

function namespaceTemplateRefs(tpl, pluginId) {
  const qualify = (stem) => (typeof stem === 'string' && stem && !stem.includes(':')
    ? `${pluginId}:${stem}` : stem);
  const out = { ...tpl };
  if (out.systemPromptFile) out.systemPromptFile = qualify(out.systemPromptFile);
  if (Array.isArray(out.appendPromptFiles)) out.appendPromptFiles = out.appendPromptFiles.map(qualify);
  const held = Array.isArray(out.plugins) ? out.plugins.map(String) : [];
  out.plugins = [...new Set([...held, String(pluginId)])];
  return out;
}

function readBundle(fs, path, dir, onSkip, pluginId) {
  const skip = typeof onSkip === 'function' ? onSkip : () => {};
  let unreadable = false;
  const listing = (sub) => {
    try { return fs.readdirSync(path.join(dir, sub), { withFileTypes: true }); }
    catch (e) {
      const code = e && e.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        unreadable = true;
        skip(sub, `unreadable directory — ${(e && e.message) || e}`);
      }
      return [];
    }
  };
  const skills = [];
  for (const ent of listing('skills')) {
    if (!ent.isDirectory()) continue;
    if (!AGENT_NAME_RE.test(ent.name)) { skip(`skills/${ent.name}`, 'not a legal skill name'); continue; }
    let content;
    try { content = fs.readFileSync(path.join(dir, 'skills', ent.name, 'SKILL.md'), 'utf8'); }
    catch (e) {
      if (e && e.code !== 'ENOENT') unreadable = true;
      skip(`skills/${ent.name}`, `no readable SKILL.md — ${(e && e.message) || e}`);
      continue;
    }
    skills.push({ name: ent.name, content });
  }
  const agents = [];
  for (const ent of listing('agents')) {
    if (!ent.isFile() && !ent.isSymbolicLink()) continue;
    if (!ent.name.endsWith('.md')) continue;
    const name = ent.name.slice(0, -3);
    if (!AGENT_NAME_RE.test(name)) { skip(`agents/${ent.name}`, 'not a legal agent name'); continue; }
    let content;
    try { content = fs.readFileSync(path.join(dir, 'agents', ent.name), 'utf8'); }
    catch (e) {
      if (e && e.code !== 'ENOENT') unreadable = true;
      skip(`agents/${ent.name}`, `unreadable — ${(e && e.message) || e}`);
      continue;
    }
    agents.push({ name, content });
  }
  const prompts = [];
  for (const kind of BUNDLE_PROMPT_KINDS) {
    for (const ent of listing(path.join('prompts', kind))) {
      if (!ent.isFile() && !ent.isSymbolicLink()) continue;
      if (!ent.name.endsWith('.md')) continue;
      const name = ent.name.slice(0, -3);
      if (!AGENT_NAME_RE.test(name)) { skip(`prompts/${kind}/${ent.name}`, 'not a legal prompt name'); continue; }
      let body;
      try { body = fs.readFileSync(path.join(dir, 'prompts', kind, ent.name), 'utf8'); }
      catch (e) {
        if (e && e.code !== 'ENOENT') unreadable = true;
        skip(`prompts/${kind}/${ent.name}`, `unreadable — ${(e && e.message) || e}`);
        continue;
      }
      prompts.push({ name, kind, body });
    }
  }
  const templates = [];
  for (const ent of listing('templates')) {
    if (!ent.isFile() && !ent.isSymbolicLink()) continue;
    if (!ent.name.endsWith('.json')) continue;
    const name = ent.name.slice(0, -'.json'.length);
    if (!AGENT_NAME_RE.test(name)) { skip(`templates/${ent.name}`, 'not a legal template name'); continue; }
    let raw;
    try { raw = fs.readFileSync(path.join(dir, 'templates', ent.name), 'utf8'); }
    catch (e) {
      if (e && e.code !== 'ENOENT') unreadable = true;
      skip(`templates/${ent.name}`, `unreadable — ${(e && e.message) || e}`);
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      skip(`templates/${ent.name}`, `not valid JSON — ${(e && e.message) || e}`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skip(`templates/${ent.name}`, 'not a JSON object');
      continue;
    }
    templates.push({ name, body: namespaceTemplateRefs(parsed, pluginId || path.basename(dir)) });
  }
  skills.sort((a, b) => (a.name < b.name ? -1 : 1));
  agents.sort((a, b) => (a.name < b.name ? -1 : 1));
  prompts.sort((a, b) => (a.name < b.name ? -1 : 1));
  templates.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { skills, agents, prompts, templates, unreadable };
}

function bundleIsEmpty(bundle) {
  return !(bundle.skills.length || bundle.agents.length
    || bundle.prompts.length || bundle.templates.length);
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
    https, execFile,
  } = deps;

  const roots = (Array.isArray(rootsIn) && rootsIn.length
    ? rootsIn
    : [{ id: 'core', dir: pluginsDir, label: 'Built in' }]
  ).filter((r) => r && r.dir);

  const source = createPluginSource({ fs, path, https, execFile });

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
      const bundle = readBundle(fs, path, dir, (what, reason) => {
        logIt(`${ent.name}: skipping ${what} — ${reason}`);
      }, manifest && manifest.id);
      // The dirname compared is the one in the ROOT, not the symlink target's:
      // what the user named the directory is what they meant the id to be.
      const why = validateManifest(manifest, ent.name, !bundleIsEmpty(bundle));
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
        isLink: ent.isSymbolicLink(),
        root: root.id,
        rootLabel: root.label || root.id,
        manifest,
        enginePath: entry.engine ? path.join(dir, entry.engine) : null,
        rendererPath: entry.renderer ? path.join(dir, entry.renderer) : null,
        stylePath: manifest.style ? path.join(dir, manifest.style) : null,
        skills: bundle.skills,
        agents: bundle.agents,
        prompts: bundle.prompts,
        templates: bundle.templates,
        editable: root.id === 'user',
        bundleUnreadable: bundle.unreadable,
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
      pluginHost.register(rec.id, mod, rec.manifest, {
        shipped: rec.root === 'core',
        skills: rec.skills || [],
        agents: rec.agents || [],
        prompts: rec.prompts || [],
        templates: rec.templates || [],
        editable: rec.editable === true,
        dir: rec.dir,
      });
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
        if (!movedDir && !movedVersion && !rec.bundleUnreadable && !restartRequired.has(rec.id)
            && typeof pluginHost.updateBundle === 'function') {
          try {
            pluginHost.updateBundle(rec.id, rec.skills, rec.agents, rec.prompts, rec.templates);
          } catch {}
        }
        if (movedDir || movedVersion) {
          restartRequired.set(rec.id, {
            was: live.version, now: rec.manifest.version || null, dirChanged: movedDir,
          });
        }
        if (movedDir || movedVersion || restartRequired.has(rec.id)) changed.push(rec.id);
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
  // cannot be influenced by the caller, so this one answers every surface. The
  // three below DO take a caller-supplied path and are desktop-gated in dispatch.
  function listUserRoot() {
    const dir = ensureUserRoot();
    if (!dir) return null;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .map((d) => ({
          name: d.name, isDir: d.isDirectory(),
          source: d.isDirectory() ? source.readSidecar(path.join(dir, d.name)) : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      logIt(`could not read the user plugins dir: ${e && e.message}`);
      return { dir, entries: null, error: String((e && e.message) || e) };
    }
    return { dir, entries };
  }

  function validateCandidate(dir) {
    const abs = String(dir || '');
    if (!abs || !path.isAbsolute(abs)) {
      return { ok: false, error: 'a plugin folder must be given as an absolute path' };
    }
    let st;
    try { st = fs.statSync(abs); } catch (e) {
      return { ok: false, error: `cannot read ${abs} — ${(e && e.message) || e}` };
    }
    if (!st.isDirectory()) {
      return { ok: false, error: `${abs} is not a directory — pick the plugin's own folder, the one holding its manifest.json` };
    }
    const manifestPath = path.join(abs, 'manifest.json');
    let raw;
    try { raw = fs.readFileSync(manifestPath, 'utf8'); } catch (e) {
      return { ok: false, error: `could not read ${manifestPath} — ${(e && e.message) || e}` };
    }
    let manifest;
    try { manifest = JSON.parse(raw); } catch (e) {
      return { ok: false, error: `${manifestPath} is not valid JSON — ${(e && e.message) || e}` };
    }
    const dirName = path.basename(abs);
    const bundle = readBundle(fs, path, abs, null, manifest && manifest.id);
    const why = validateManifest(manifest, dirName, !bundleIsEmpty(bundle));
    if (why) {
      if (manifest && typeof manifest === 'object' && isValidPluginId(manifest.id)
          && !RESERVED_PLUGIN_IDS.has(manifest.id) && manifest.id !== dirName) {
        return {
          ok: false,
          error: `${why} — a plugin's folder must be named for its id, so rename "${dirName}" to "${manifest.id}" and pick it again`,
        };
      }
      return { ok: false, error: why };
    }
    const entry = manifest.entry || {};
    return {
      ok: true,
      id: manifest.id,
      name: manifest.name || manifest.id,
      version: manifest.version || null,
      entry: { engine: entry.engine || null, renderer: entry.renderer || null },
      scope: scopeOf(manifest),
      hasRenderer: !!entry.renderer,
    };
  }

  function registerUserPlugin(dir) {
    const v = validateCandidate(dir);
    if (!v.ok) return v;
    const root = ensureUserRoot();
    if (!root) return { ok: false, error: 'no user plugin root configured' };
    let target;
    try { target = fs.realpathSync(String(dir)); } catch { target = String(dir); }
    let rootReal;
    try { rootReal = fs.realpathSync(root); } catch { rootReal = root; }
    if (target === rootReal || target.startsWith(rootReal + path.sep)) {
      return { ok: false, error: `${target} is already inside the plugins folder ${root} — it needs no registering, press Re-scan instead` };
    }
    const link = path.join(root, v.id);
    let lst = null;
    try { lst = fs.lstatSync(link); } catch { lst = null; }
    if (lst) {
      if (lst.isSymbolicLink()) {
        let points = null;
        try { points = fs.readlinkSync(link); } catch { points = null; }
        return {
          ok: false,
          error: `"${v.id}" is already registered: ${link} is a link to ${points || 'a target that cannot be read'}. Unregister it first to point it somewhere else.`,
        };
      }
      return {
        ok: false,
        error: `${link} already exists and is ${lst.isDirectory() ? 'a real directory' : 'a file'}, not a registered link — Clodex will not touch it. Move or remove it by hand first.`,
      };
    }
    const core = discover().find((r) => r.id === v.id && r.root === 'core');
    if (core) {
      return {
        ok: false,
        error: `"${v.id}" is the id of a plugin built into Clodex, and only one copy of an id can run — which one is decided by version precedence, not by you. Give your plugin a different id and rename its folder to match.`,
      };
    }
    try {
      fs.symlinkSync(target, link, 'dir');
    } catch (e) {
      return { ok: false, error: `could not link ${link} to ${target} — ${(e && e.message) || e}` };
    }
    logIt(`registered ${v.id}: ${link} -> ${target}`);
    return { ok: true, id: v.id, dir: link, target };
  }

  function nonce() { return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
  function mkFetchDir() {
    const dir = path.join(os.tmpdir(), `clodex-plugin-fetch-${nonce()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  function rmQuiet(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

  function renameOrCopy(from, to) {
    try {
      fs.renameSync(from, to);
    } catch (e) {
      if (!e || e.code !== 'EXDEV') throw e;
      fs.cpSync(from, to, { recursive: true });
      rmQuiet(from);
    }
  }

  async function fetchAndValidate({ repo, ref, subpath }) {
    const work = mkFetchDir();
    const fail = (error) => { rmQuiet(work); return { ok: false, error }; };
    try {
      const tarFile = path.join(work, 'src.tar.gz');
      const fetched = await source.fetchTarball({ repo, ref }, tarFile);
      if (!fetched.ok) return fail(fetched.error);
      const extracted = await source.extractPlugin(tarFile, path.join(work, 'x'), subpath);
      if (!extracted.ok) return fail(extracted.error);
      const full = await source.fetchCommitSha({ repo, ref: extracted.commit });
      const commit = full || extracted.commit;
      const commitFull = !!full;
      if (!commit) return fail('could not determine the fetched commit');
      let dir = extracted.dir;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        if (raw && isValidPluginId(raw.id)) {
          const renamed = path.join(path.dirname(dir), raw.id);
          fs.renameSync(dir, renamed);
          dir = renamed;
        }
      } catch {}
      const v = validateCandidate(dir);
      if (!v.ok) return fail(v.error);
      return { ok: true, dir, work, commit, commitFull, manifest: v };
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  }

  async function resolveSource(spec) {
    const parsed = source.parseSourceSpec(spec);
    if (!parsed.ok) return parsed;
    const r = await fetchAndValidate(parsed);
    if (!r.ok) return r;
    rmQuiet(r.work);
    return {
      ok: true,
      repo: parsed.repo,
      ref: parsed.ref,
      subpath: parsed.subpath,
      commit: r.commit,
      commitFull: r.commitFull,
      id: r.manifest.id,
      manifest: {
        id: r.manifest.id,
        name: r.manifest.name,
        version: r.manifest.version,
        announce: (r.manifest.announce != null ? r.manifest.announce : null),
      },
    };
  }

  async function installFromSource(spec) {
    const parsed = source.parseSourceSpec(spec);
    if (!parsed.ok) return parsed;
    const r = await fetchAndValidate(parsed);
    if (!r.ok) return r;
    const id = r.manifest.id;
    const root = ensureUserRoot();
    if (!root) { rmQuiet(r.work); return { ok: false, error: 'no user plugin root configured' }; }
    const core = discover().find((rec) => rec.id === id && rec.root === 'core');
    if (core) {
      rmQuiet(r.work);
      return { ok: false, error: `"${id}" is the id of a plugin built into Clodex — give the source plugin a different id.` };
    }
    const target = path.join(root, id);
    let lst = null;
    try { lst = fs.lstatSync(target); } catch { lst = null; }
    if (lst) {
      rmQuiet(r.work);
      if (lst.isSymbolicLink()) {
        return { ok: false, error: `"${id}" is a registered link, not a directory from a source — unregister it first.` };
      }
      const existingSidecar = source.readSidecar(target);
      return existingSidecar
        ? { ok: false, error: `"${id}" is already installed from a source — use update instead of installing again.` }
        : { ok: false, error: `"${id}" already exists in your plugins folder and is not from a source — that folder is yours, not from a source.` };
    }
    setEnabledInSettings(id, false);
    try {
      renameOrCopy(r.dir, target);
    } catch (e) {
      rmQuiet(r.work);
      return { ok: false, error: `could not place ${target} — ${(e && e.message) || e}` };
    }
    rmQuiet(r.work);
    try {
      source.writeSidecar(target, {
        source: 'github', repo: parsed.repo, ref: parsed.ref, subpath: parsed.subpath,
        commit: r.commit, commitFull: r.commitFull, fetchedAt: Date.now(), hostVersion: HOST_API_VERSION,
      });
    } catch (e) {
      rmQuiet(target);
      return { ok: false, error: `could not write the source sidecar for ${id} — ${(e && e.message) || e}` };
    }
    logIt(`installed ${id} from ${parsed.repo}@${parsed.ref || 'default'} at ${r.commit}`);
    return { ok: true, id, dir: target, commit: r.commit };
  }

  function commitsMatch(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.length < b.length ? b.startsWith(a) : a.startsWith(b);
  }

  async function resolveUpdate(id) {
    if (!isValidPluginId(String(id || ''))) return { ok: false, error: `invalid plugin id: ${JSON.stringify(id)}` };
    const root = ensureUserRoot();
    if (!root) return { ok: false, error: 'no user plugin root configured' };
    const dir = path.join(root, String(id || ''));
    const sidecar = source.readSidecar(dir);
    if (!sidecar) return { ok: false, error: `"${id}" is not installed from a source` };
    const r = await fetchAndValidate({ repo: sidecar.repo, ref: sidecar.ref, subpath: sidecar.subpath });
    if (!r.ok) return r;
    rmQuiet(r.work);
    return {
      ok: true,
      id: r.manifest.id,
      previousCommit: sidecar.commit,
      commit: r.commit,
      changed: !commitsMatch(sidecar.commit, r.commit),
      manifest: {
        id: r.manifest.id, name: r.manifest.name, version: r.manifest.version,
        announce: (r.manifest.announce != null ? r.manifest.announce : null),
      },
    };
  }

  async function applyUpdate(id, commit) {
    if (!isValidPluginId(String(id || ''))) return { ok: false, error: `invalid plugin id: ${JSON.stringify(id)}` };
    const root = ensureUserRoot();
    if (!root) return { ok: false, error: 'no user plugin root configured' };
    const target = path.join(root, String(id || ''));
    const sidecar = source.readSidecar(target);
    if (!sidecar) return { ok: false, error: `"${id}" is not installed from a source` };
    const r = await fetchAndValidate({ repo: sidecar.repo, ref: sidecar.ref, subpath: sidecar.subpath });
    if (!r.ok) return r;
    if (!commitsMatch(r.commit, commit)) {
      rmQuiet(r.work);
      return { ok: false, error: `the source now resolves to ${r.commit}, not the ${commit} you accepted — resolve the update again` };
    }
    const aside = path.join(root, `.old-${id}-${nonce()}`);
    try {
      fs.renameSync(target, aside);
    } catch (e) {
      rmQuiet(r.work);
      return { ok: false, error: `could not move the old copy aside — ${(e && e.message) || e}` };
    }
    try {
      renameOrCopy(r.dir, target);
      rmQuiet(r.work);
      source.writeSidecar(target, {
        source: 'github', repo: sidecar.repo, ref: sidecar.ref, subpath: sidecar.subpath,
        commit: r.commit, commitFull: r.commitFull, fetchedAt: Date.now(), hostVersion: HOST_API_VERSION,
      });
      rmQuiet(aside);
      const live = loadedFrom.get(id);
      if (live) restartRequired.set(id, { was: live.version, now: r.manifest.version || null, dirChanged: false });
      logIt(`updated ${id}: ${sidecar.commit} -> ${r.commit}`);
      return { ok: true, id, previousCommit: sidecar.commit, commit: r.commit };
    } catch (e) {
      rmQuiet(r.work);
      rmQuiet(target);
      let restored = false;
      try { fs.renameSync(aside, target); restored = true; } catch {}
      return {
        ok: false,
        error: restored
          ? `update failed and the old copy was restored — ${(e && e.message) || e}`
          : `update failed and the old copy could not be restored to ${target} — it is at ${aside} — ${(e && e.message) || e}`,
      };
    }
  }

  function removeSourcePlugin(id) {
    if (!isValidPluginId(String(id || ''))) return { ok: false, error: `invalid plugin id: ${JSON.stringify(id)}` };
    const root = ensureUserRoot();
    if (!root) return { ok: false, error: 'no user plugin root configured' };
    const target = path.join(root, String(id || ''));
    let lst = null;
    try { lst = fs.lstatSync(target); } catch { lst = null; }
    if (lst && lst.isSymbolicLink()) {
      return { ok: false, error: `"${id}" is a registered link, not a directory from a source — unregister it instead.` };
    }
    const sidecar = source.readSidecar(target);
    if (!sidecar) return { ok: false, error: `"${id}" is not installed from a source` };
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, error: `could not remove ${target} — ${(e && e.message) || e}` };
    }
    logIt(`removed source plugin ${id}`);
    return { ok: true, id };
  }

  function unregisterUserPlugin(id) {
    const name = String(id || '');
    if (!isValidPluginId(name)) return { ok: false, error: `invalid plugin id: ${JSON.stringify(name)}` };
    const root = ensureUserRoot();
    if (!root) return { ok: false, error: 'no user plugin root configured' };
    const link = path.join(root, name);
    let lst;
    try { lst = fs.lstatSync(link); } catch (e) {
      return { ok: false, error: `nothing to unregister at ${link} — ${(e && e.message) || e}` };
    }
    if (!lst.isSymbolicLink()) {
      return {
        ok: false,
        error: `${link} is ${lst.isDirectory() ? 'a real directory' : 'a real file'}, not a registered link — it was copied in, not registered, so removing it here would delete it. Move it out by hand instead.`,
      };
    }
    try {
      fs.unlinkSync(link);
    } catch (e) {
      return { ok: false, error: `could not remove ${link} — ${(e && e.message) || e}` };
    }
    logIt(`unregistered ${name}: removed the link at ${link}`);
    return { ok: true, id: name };
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

  const BUNDLE_FILE_PATHS = {
    skills: (stem) => ['skills', stem, 'SKILL.md'],
    agents: (stem) => ['agents', `${stem}.md`],
    'prompts/system': (stem) => ['prompts', 'system', `${stem}.md`],
    'prompts/append': (stem) => ['prompts', 'append', `${stem}.md`],
    templates: (stem) => ['templates', `${stem}.json`],
  };

  function writeBundleFile(id, kind, stem, body) {
    const rel = BUNDLE_FILE_PATHS[String(kind)];
    if (!rel) return { ok: false, error: `unknown bundle kind: ${kind}` };
    const name = String(stem || '');
    if (!AGENT_NAME_RE.test(name)) return { ok: false, error: `invalid name: ${JSON.stringify(stem)}` };
    const rec = discover().find((r) => r.id === String(id));
    if (!rec) return { ok: false, error: `no such plugin: ${id}` };
    if (!rec.editable) {
      return {
        ok: false,
        error: `"${rec.id}" comes from ${rec.rootLabel || rec.root} and is read-only here — only a plugin in your own plugins folder can be edited in the app.`,
      };
    }
    const parts = rel(name);
    const relPath = path.join(...parts);
    if (!insideDir(path, rec.dir, relPath)) {
      return { ok: false, error: `${relPath} escapes the plugin directory` };
    }
    const file = path.join(rec.dir, relPath);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(body ?? ''), { mode: 0o600 });
    } catch (e) {
      return { ok: false, error: `could not write ${file} — ${(e && e.message) || e}` };
    }
    logIt(`${rec.id}: wrote ${relPath}`);
    return { ok: true, id: rec.id, file };
  }

  // What the settings Plugins section renders: one row per DISCOVERED plugin —
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
          linkedFrom: rec.root === 'user' && rec.isLink ? rec.dir : null,
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
    validateCandidate, registerUserPlugin, unregisterUserPlugin, writeBundleFile,
    status, noteRendererActivation, clearFailures, isQuarantined,
    resolveSource, installFromSource, resolveUpdate, applyUpdate, removeSourcePlugin,
    _validateManifest: validateManifest,
    _isNewerVersion: isNewerVersion,
    _quarantineAfter: QUARANTINE_AFTER,
  };
}

module.exports = {
  createPluginLoader, validateManifest, isNewerVersion,
  readBundle, namespaceTemplateRefs, BUNDLE_PROMPT_KINDS,
};
