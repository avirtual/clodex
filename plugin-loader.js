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

// ── Version comparison (docs/plugin-sources.md §4) ─────────────────────────
// `version` was DECORATIVE until t21 — validateManifest never mentioned it, and
// the loader used it only in a log line and a status() passthrough. Making a
// user copy able to out-rank the bundled one is the only thing that gives a
// packaged (app.asar) install any way to run a newer plugin, so the field
// becomes load-bearing. Two rules keep that from being a new hazard:
//
//   1. A version we can compare is dot-separated runs of DIGITS, compared
//      NUMERICALLY. String comparison puts "1.10" below "1.9", which is exactly
//      backwards for the plugin most likely to be shipping updates.
//   2. Anything else — absent, non-string, `1.0.0-beta`, `the good one` — is
//      UNCOMPARABLE, and an uncomparable version can never out-rank anything.
//
// Rule 2 is the safe branch by construction: "uncomparable" collapses to the
// pre-t21 behaviour (core wins, user copy shadowed), so a malformed version can
// only ever fail to change something. It cannot crash discovery either — the
// parse is total and returns null for every shape of junk including null itself.
// Semver pre-release ordering is deliberately NOT implemented: getting
// `1.0.0-beta < 1.0.0` right needs the whole grammar, nothing here needs it, and
// a tag that loses VISIBLY is a fair trade for one that ties silently.
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const parts = v.trim().split('.');
  if (!parts.length || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.map(Number);
}

// True only when BOTH sides parse and `a` is strictly greater. Both, not one:
// if the incumbent's version is junk we cannot say the candidate is newer than
// it, and the safe answer to "cannot say" is that the incumbent keeps its place.
// Missing trailing segments are 0, so "1.2" and "1.2.0" tie — and a tie loses.
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
    pluginsDir,        // legacy single-root form; equivalent to roots: [{ dir }]
    roots: rootsIn,    // [{ id, dir, label }] in PRECEDENCE order — docs/plugin-sources.md §3
    getUiSettings,     // getter: the store seam, assigned in the bootstrap
    log,
    requireModule,     // seam: node's require, injectable so tests load fakes
  } = deps;

  // Both spellings are accepted because `pluginsDir` is the older one and every
  // existing caller passes it; a list of one is exactly what it always meant.
  const roots = (Array.isArray(rootsIn) && rootsIn.length
    ? rootsIn
    : [{ id: 'core', dir: pluginsDir, label: 'Built in' }]
  ).filter((r) => r && r.dir);

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
  // Verb collisions seen THIS APP RUN — id -> { verb, heldBy }. Deliberately in
  // memory and never in uiSettings, unlike the failure record: a collision is a
  // fact about which plugins are loaded right now, and persisting it would let a
  // record survive the removal of the plugin that caused it (t20).
  const verbConflicts = new Map();

  // What a re-scan CANNOT undo (t22). `require` caches by resolved path, so once
  // an engine half has been required this run, re-requiring the same path hands
  // back the SAME module object — the old code keeps running no matter what is on
  // disk. Proven by probe, not assumed: rewriting a plugin's engine.js and
  // re-requiring it returned the original export.
  //
  // A copy at a DIFFERENT path is a different cache key and would load — but
  // swapping it in for a LIVE plugin means deactivating the running one and
  // registering the new one, which is a much larger change than this buys and is
  // explicitly out of scope. So any change to a plugin that is already running is
  // restart-required, and the row SAYS so rather than showing the new version
  // beside the old code. In memory, never persisted, exactly like verbConflicts:
  // it is a fact about this app run, and a persisted copy would outlive the
  // restart that resolves it.
  const restartRequired = new Map(); // id -> { was, now, dirChanged }
  // Entry paths this run has already handed to `requireModule`, with the manifest
  // version they carried at the time. The CACHE KEY is the path, so this is the
  // one place that can answer "would a require of this path return fresh code?"
  // — and the answer is no for anything already in here. Keyed by path rather
  // than by id deliberately: two copies of an id at two paths are two cache
  // entries, which is exactly why a superseding user copy CAN load.
  const requiredPaths = new Map(); // enginePath -> version first required
  // Where each live engine half was loaded FROM, so a re-scan can tell "the same
  // copy is still there" from "a different copy now wins". The loader is the
  // producer of this fact; nothing else can reconstruct it once discover() has
  // moved on.
  const loadedFrom = new Map(); // id -> { dir, version }

  const rendererReportedThisRun = new Set();
  function noteRendererActivation(id, ok, error) {
    const key = String(id);
    if (rendererReportedThisRun.has(key)) return { counted: false };
    rendererReportedThisRun.add(key);
    if (ok) { clearFailures(key); return { counted: true, ok: true }; }
    return { counted: true, ok: false, count: recordFailure(key, `renderer activate() threw: ${error || 'unknown error'}`) };
  }

  // ── Discovery (§3.1, extended to MULTIPLE ROOTS by docs/plugin-sources.md) ──
  // Scans `<root>/*/manifest.json` for each configured root, in PRECEDENCE
  // order, and nothing else. A scan path is a trust boundary, so the roots are
  // injected rather than discovered — widening the set is a decision at the
  // bootstrap, never a convenience here.
  //
  // Directories that LOOK like a plugin (they have a manifest.json) but were
  // refused, so the settings section can say so instead of the plugin merely
  // being absent. Not persisted and not counted as a strike: there is no id to
  // key a counter by when the manifest itself is the thing that is broken, and a
  // malformed manifest is already fully inert — nothing of it ever ran.
  let discoveryProblems = [];
  // Copies of an id that a higher-precedence root already claimed. Surfaced, not
  // dropped: the failure mode a silent drop produces is a user editing code that
  // is not the code running (plugin-sources.md §4).
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

  // A losing copy, shaped for the settings row. Named on BOTH sides: which copy
  // is not running and at what version, and which one won and at what version.
  // Under version-aware precedence the loser can be the BUILT-IN copy, so a row
  // that named only one side would be unreadable in the inverted direction — and
  // the inverted direction is precisely the one carrying the hazard (a user copy
  // declaring version 99 wins forever). This row is the only thing that makes
  // that recoverable, so it is a safety mechanism, not a label.
  //
  // `reason` is stamped HERE rather than inferred in the renderer from a version
  // diff, because that inference is wrong in the one case that matters: a copy
  // with an unparseable version loses as UNCOMPARABLE, not as lower, and a row
  // reading "superseded by a higher version" would send its author looking for a
  // version bump that can never help them. `comparable` says the version could
  // not be read at all, which is the actionable fact.
  //   'precedence' — root order held (core wins; the default, pre-t21 behaviour)
  //   'superseded' — the winner's version was strictly higher
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
        // A directory without a readable manifest is not a plugin. Only complain
        // if a manifest.json exists but is broken — an unrelated subdirectory is
        // not an error.
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
      // PRECEDENCE. Built last, so a shadowed row can only ever describe
      // something that would otherwise have been a working plugin — every
      // refusal above produces a `problems` row instead, and the two must not
      // be confused.
      //
      // The earlier root still owns the id BY DEFAULT (core wins, t16), and the
      // one thing that overturns it is a STRICTLY HIGHER version (t21). That
      // narrows core-wins without giving up what it protected: the forgotten
      // experimental fork core-wins existed to stop is by definition not newer
      // than the core it was forked from, so it still loses. What changes is
      // only the case where the user copy is a genuine later release — which is
      // the ONLY way a packaged install can ever run a newer plugin, since its
      // core copies live in a read-only asar.
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
      // Stale-code check BEFORE the require, because the require is what makes it
      // unanswerable afterwards. If this exact path was required earlier this run
      // under a different version, the module object coming back is the old code
      // and the manifest beside it is the new metadata. Recording that here is
      // what stops `status()` showing a version the running code does not match.
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
      // Remember WHICH copy is live, for the re-scan's changed-vs-same test.
      loadedFrom.set(rec.id, { dir: rec.dir, version: rec.manifest.version || null });
      if (count) clearFailures(rec.id); // a success clears the slate, always
      return { ok: true };
    } catch (e) {
      const error = String((e && e.message) || e);
      // REFUSED, NOT PUNISHED (t20). A verb collision is a knowable structural
      // refusal — this plugin is not broken, another plugin holds the verb — and
      // the strike counter exists for plugins that CRASH. Striking here quarantined
      // a working plugin two launches after the user installed an unrelated one,
      // with Retry unable to recover it because the collision reproduces every
      // time. Recorded for the settings row instead, and NOT persisted: a stale
      // ownership record outliving the plugin that held the verb is the failure
      // mode this whole ticket is about.
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
    verbConflicts.delete(String(id));
    rendererReportedThisRun.delete(String(id));
    // NOT cleared here: `restartRequired` is a fact about the require cache, and
    // an enable does not empty the cache. Re-enabling a plugin whose files changed
    // re-runs activate() on the module object the cache still holds — the OLD
    // code, against the NEW manifest. loadOne re-derives the flag from the cache
    // itself, so a toggle cannot launder a stale copy into looking fresh.
    return loadOne(rec, pluginHost);
  }

  // ── Re-scan (t22) ─────────────────────────────────────────────────────────
  // Discovery ran once at boot, so a plugin dropped into ~/.clodex/plugins while
  // the app was running was invisible until a restart — which made the user root
  // reachable in principle and not in practice. `discover()` is stateless and
  // re-reads disk every call, so the SCAN is free; what this function is really
  // about is being honest about the three different things a scan can find.
  //
  //   ADDED    — never required this run, so no cache entry: it genuinely loads.
  //   REMOVED  — deactivated. The engine half's ledger tears down its dispatch
  //              entries, hooks and intent rows; the renderer half goes when the
  //              `plugin-state` hint reaches each window.
  //   CHANGED  — the id is already RUNNING. Cannot be reloaded (see
  //              restartRequired above). Recorded and reported, never faked.
  //
  // NO STRIKES. `loadOne`'s dormant `{ count }` parameter gets its first caller
  // here, and it is passed false deliberately: the strike counter exists for
  // plugins that crash on a real activation, and a user pressing Re-scan three
  // times must not quarantine a plugin that was merely half-copied when they did.
  // Same reasoning as t20's verb collision — refused is not punished.
  function rescan(pluginHost) {
    // "Is this id RUNNING?" is the host's fact, not ours — it is the thing that
    // holds the registrations. `loadedFrom` answers only the narrower "which copy
    // did we load", and trusting it alone would be wrong the moment a user
    // disables a plugin: the host deactivates it, our map still holds the entry,
    // and a re-scan would report restart-required for a plugin that is not
    // running and could simply be loaded. Producer over reconstruction.
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
        // Already running. The ONLY honest thing available is to notice that the
        // copy on disk is no longer the copy in memory and say restart.
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
      // Quarantine still shadows: a re-scan is not a Retry, and silently
      // activating a quarantined plugin would make Retry meaningless.
      if (isQuarantined(rec.id)) continue;
      const r = loadOne(rec, pluginHost, { count: false });
      if (r.ok) added.push(rec.id);
      else failed.push({ id: rec.id, error: r.error, ...(r.verbConflict ? { verbConflict: r.verbConflict } : {}) });
    }

    // Gone from disk. Deactivated rather than left running — a plugin whose
    // directory a user deleted is one they have asked to be rid of, and the
    // engine-half teardown is exactly what deactivate() already does well.
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

  // The directory a user drops a plugin INTO, created on demand (t22).
  //
  // §3's rule is that the app never creates this directory, because "a directory
  // that exists only because we made it teaches a user nothing, and its absence
  // is the honest representation of no user plugins". Creating it HERE does not
  // break that rule, it is the exception the rule already names: this runs only
  // when a user explicitly asks to be shown where plugins go, and revealing a
  // path that does not exist is a broken action on every platform. Startup still
  // never creates it.
  //
  // Returns null when there is no user root configured at all (the legacy
  // single-root form), so the caller can hide the affordance rather than offer a
  // button that reveals the read-only asar.
  function ensureUserRoot() {
    const root = roots.find((r) => r.id === 'user');
    if (!root) return null;
    try { fs.mkdirSync(root.dir, { recursive: true }); } catch (e) {
      // Report the path anyway: a reveal that fails in Finder is a better
      // diagnostic than a button that silently does nothing.
      logIt(`could not create the user plugins dir: ${e && e.message}`);
    }
    return root.dir;
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
          // Refused this run because another plugin holds its verb (t20). A
          // per-plugin field rather than a top-level list like `shadowed`: unlike a
          // shadowed copy this plugin is genuinely installed and keeps its toggle —
          // disabling the holder is exactly how a user resolves it.
          verbConflict: verbConflicts.get(rec.id) || null,
          // The disk copy changed under a plugin that is already running (t22).
          // Reported so the row can say "restart to pick this up" instead of
          // showing the new version beside the old code still running — that
          // silent disagreement is the failure this whole ticket exists to
          // avoid, and it is the same shape as the badge bug and the verb
          // quarantine: a consumer displaying something the producer never
          // confirmed.
          restartRequired: restartRequired.get(rec.id) || null,
          root: rec.root || null,
          rootLabel: rec.rootLabel || null,
        };
      }),
      problems: discoveryProblems.slice(),
      // Copies losing to a higher-precedence root. A row with no toggle, so a
      // user editing a shadowed copy is told rather than left to wonder why
      // their edits do nothing (plugin-sources.md §4).
      shadowed: discoveryShadowed.slice(),
    };
  }

  return {
    discover, isEnabled, enabledSet, setEnabledInSettings,
    loadAll, activateById, rescan, ensureUserRoot, rendererInfo,
    // Fail-safe / quarantine surface. `noteRendererActivation` is what a WINDOW
    // reports its renderer half's outcome through; the rest is the settings
    // section's data and the Retry path.
    status, noteRendererActivation, clearFailures, isQuarantined,
    // Test/introspection seam — the validator, so its refusals are directly
    // assertable rather than only observable as a missing plugin. Same for the
    // version comparison: "malformed never wins" is a claim about inputs no
    // fixture would think to build, so it deserves to be assertable directly.
    _validateManifest: validateManifest,
    _isNewerVersion: isNewerVersion,
    _quarantineAfter: QUARANTINE_AFTER,
  };
}

module.exports = { createPluginLoader, validateManifest, isNewerVersion };
