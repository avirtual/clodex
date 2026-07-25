'use strict';
// plugin-loader.test.js — discovery, the enabled set, and the failure isolation
// that makes one bad plugin cheap (docs/plugin-plan.md §3.1, Phase 2 W1).
//
// The loader is the half Phase 1 deliberately omitted. Everything it decides is
// a trust or a persistence decision — which directories are scanned, which
// manifests are honoured, what "the user has never chosen" means — so each of
// those gets a test rather than a comment.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPluginLoader, validateManifest } = require('../plugin-loader');

// A real temp plugins/ tree. Real fs rather than a mock because the thing under
// test IS filesystem interpretation — a mocked readdir would pass a loader that
// cannot read a directory.
function mkTree(plugins) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-plugins-'));
  for (const [name, spec] of Object.entries(plugins)) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    if (spec.manifest !== undefined) {
      fs.writeFileSync(path.join(dir, 'manifest.json'),
        typeof spec.manifest === 'string' ? spec.manifest : JSON.stringify(spec.manifest));
    }
    for (const [file, body] of Object.entries(spec.files || {})) {
      fs.writeFileSync(path.join(dir, file), body);
    }
  }
  return root;
}

function fakeUiSettings(initial = {}) {
  let state = { ...initial };
  return {
    store: {
      get: () => state,
      set: (patch) => { state = { ...state, ...patch }; },
    },
    read: () => state,
  };
}

function mkLoader(pluginsDir, uiState = {}, overrides = {}) {
  const ui = fakeUiSettings(uiState);
  const logged = [];
  const loader = createPluginLoader({
    fs, path,
    pluginsDir,
    getUiSettings: () => ui.store,
    log: { info: (scope, msg) => logged.push(`${scope}: ${msg}`) },
    requireModule: overrides.requireModule || ((p) => require(p)),
  });
  return { loader, ui, logged };
}

const OK_MANIFEST = {
  id: 'alpha', name: 'Alpha', version: '1.0.0', hostApi: '0',
  entry: { engine: 'engine.js', renderer: 'renderer.js' }, style: 'style.css',
};

// A stand-in for plugin-host-engine's `register` surface — the loader must reach
// the host through exactly the same methods ipc-handlers does, so a fake with
// only those methods proves it isn't quietly using more.
function fakeHost() {
  const registered = [];
  return {
    registered,
    register(id, mod, manifest) {
      if (id === 'boom') throw new Error('activate exploded');
      registered.push({ id, mod, manifest });
    },
  };
}

// ── Manifest validation ─────────────────────────────────────────────────────

test('validateManifest accepts a well-formed manifest', () => {
  assert.strictEqual(validateManifest(OK_MANIFEST, 'alpha'), null);
});

test('validateManifest refuses a manifest whose id does not match its directory', () => {
  const why = validateManifest({ ...OK_MANIFEST, id: 'beta' }, 'alpha');
  assert.match(why, /does not match its directory/);
});

test('validateManifest refuses a hostApi mismatch by name', () => {
  // §3.1: a mismatch REFUSES rather than half-activating against a surface the
  // plugin predates. The error names both versions so the log says what to fix.
  const why = validateManifest({ ...OK_MANIFEST, hostApi: '1' }, 'alpha');
  assert.match(why, /wants hostApi "1"/);
  assert.match(why, /host is "0"/);
});

test('validateManifest refuses invalid ids, missing entry, and an empty entry', () => {
  assert.match(validateManifest({ ...OK_MANIFEST, id: 'has space' }, 'has space'), /invalid plugin id/);
  const noEntry = { ...OK_MANIFEST }; delete noEntry.entry;
  assert.match(validateManifest(noEntry, 'alpha'), /entry is missing/);
  assert.match(validateManifest({ ...OK_MANIFEST, entry: {} }, 'alpha'), /neither an engine nor a renderer/);
  assert.match(validateManifest(null, 'alpha'), /not a JSON object/);
});

// ── Discovery ───────────────────────────────────────────────────────────────

test('discover reads plugins/*/manifest.json and resolves entry paths', () => {
  const root = mkTree({ alpha: { manifest: OK_MANIFEST, files: { 'style.css': 'x{}' } } });
  const { loader } = mkLoader(root);
  const recs = loader.discover();
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].id, 'alpha');
  assert.strictEqual(recs[0].enginePath, path.join(root, 'alpha', 'engine.js'));
  assert.strictEqual(recs[0].rendererPath, path.join(root, 'alpha', 'renderer.js'));
  assert.strictEqual(recs[0].stylePath, path.join(root, 'alpha', 'style.css'));
});

test('discover returns [] when plugins/ does not exist', () => {
  const { loader } = mkLoader(path.join(os.tmpdir(), 'clodex-no-such-dir-' + Date.now()));
  assert.deepStrictEqual(loader.discover(), []);
});

test('discover skips a directory with no manifest silently, but LOGS a broken one', () => {
  const root = mkTree({
    notaplugin: { files: { 'readme.md': 'hi' } },
    broken: { manifest: '{ this is not json' },
  });
  const { loader, logged } = mkLoader(root);
  assert.deepStrictEqual(loader.discover(), []);
  assert.ok(logged.some((l) => /broken.*unreadable manifest/.test(l)), 'a broken manifest is reported');
  assert.ok(!logged.some((l) => /notaplugin/.test(l)), 'a non-plugin directory is not noise');
});

test('discover refuses an entry path that escapes the plugin directory', () => {
  // The runtime twin of the static no-backdoor lint: the lint reads requires
  // inside plugins/, this refuses a manifest that POINTS OUT of the dir, which
  // no static require scan could ever see.
  const root = mkTree({
    evil: { manifest: { ...OK_MANIFEST, id: 'evil', entry: { engine: '../../session-manager.js' } } },
  });
  const { loader, logged } = mkLoader(root);
  assert.deepStrictEqual(loader.discover(), []);
  assert.ok(logged.some((l) => /entry\.engine escapes/.test(l)));
});

test('discover refuses a style path that escapes the plugin directory', () => {
  const root = mkTree({
    evil: { manifest: { ...OK_MANIFEST, id: 'evil', style: '../../renderer/styles.css' } },
  });
  const { loader, logged } = mkLoader(root);
  assert.deepStrictEqual(loader.discover(), []);
  assert.ok(logged.some((l) => /style escapes/.test(l)));
});

test('discover is deterministic (sorted) across plugins', () => {
  const root = mkTree({
    zeta: { manifest: { ...OK_MANIFEST, id: 'zeta' } },
    alpha: { manifest: OK_MANIFEST },
    mid: { manifest: { ...OK_MANIFEST, id: 'mid' } },
  });
  const { loader } = mkLoader(root);
  assert.deepStrictEqual(loader.discover().map((r) => r.id), ['alpha', 'mid', 'zeta']);
});

// ── The enabled set ─────────────────────────────────────────────────────────

test('a plugin with no settings entry falls back to its manifest default', () => {
  const root = mkTree({
    on: { manifest: { ...OK_MANIFEST, id: 'on', enabledByDefault: true } },
    off: { manifest: { ...OK_MANIFEST, id: 'off', enabledByDefault: false } },
    unsaid: { manifest: { ...OK_MANIFEST, id: 'unsaid' } },
  });
  const { loader } = mkLoader(root);
  const by = Object.fromEntries(loader.discover().map((r) => [r.id, loader.isEnabled(r)]));
  // Absent `enabledByDefault` means ON: the pilot ships enabled (W7) without
  // writing a settings entry into every existing install.
  assert.deepStrictEqual(by, { off: false, on: true, unsaid: true });
});

test('an explicit enabled list overrides manifest defaults in BOTH directions', () => {
  const root = mkTree({
    on: { manifest: { ...OK_MANIFEST, id: 'on', enabledByDefault: true } },
    off: { manifest: { ...OK_MANIFEST, id: 'off', enabledByDefault: false } },
  });
  const { loader } = mkLoader(root, { plugins: { enabled: ['off'] } });
  const by = Object.fromEntries(loader.discover().map((r) => [r.id, loader.isEnabled(r)]));
  assert.deepStrictEqual(by, { off: true, on: false });
});

test('the FIRST toggle materializes the current effective set before mutating', () => {
  // The bug this pins: writing `['b']` on the first-ever enable of `b` would
  // silently DISABLE every default-on plugin, because absence means "defaults"
  // and a one-element array means "only this one". The user clicked one switch;
  // three things must not change.
  const root = mkTree({
    a: { manifest: { ...OK_MANIFEST, id: 'a' } },                          // default on
    b: { manifest: { ...OK_MANIFEST, id: 'b', enabledByDefault: false } }, // default off
    c: { manifest: { ...OK_MANIFEST, id: 'c' } },                          // default on
  });
  const { loader, ui } = mkLoader(root);
  const next = loader.setEnabledInSettings('b', true);
  assert.deepStrictEqual([...next].sort(), ['a', 'b', 'c']);
  assert.deepStrictEqual([...ui.read().plugins.enabled].sort(), ['a', 'b', 'c']);
});

test('disabling removes exactly one id and leaves per-plugin settings untouched', () => {
  const root = mkTree({ a: { manifest: OK_MANIFEST }, b: { manifest: { ...OK_MANIFEST, id: 'b' } } });
  const { loader, ui } = mkLoader(root, { plugins: { enabled: ['a', 'b'], a: { pref: 1 } } });
  assert.deepStrictEqual(loader.setEnabledInSettings('a', false), ['b']);
  // §2.5's per-plugin settings live alongside the enabled list under the same
  // `plugins` key — a disable must not eat them, or turning a plugin off and on
  // again silently resets its configuration.
  assert.deepStrictEqual(ui.read().plugins.a, { pref: 1 });
});

test('enabledSet distinguishes "never chosen" (null) from "chosen empty" ([])', () => {
  const root = mkTree({ a: { manifest: OK_MANIFEST } });
  assert.strictEqual(mkLoader(root).loader.enabledSet(), null);
  assert.deepStrictEqual(mkLoader(root, { plugins: { enabled: [] } }).loader.enabledSet(), []);
});

// ── Loading ─────────────────────────────────────────────────────────────────

test('loadAll registers enabled engine halves and skips disabled ones', () => {
  const root = mkTree({
    alpha: { manifest: OK_MANIFEST, files: { 'engine.js': 'module.exports.activate = () => {};' } },
    beta: {
      manifest: { ...OK_MANIFEST, id: 'beta', enabledByDefault: false },
      files: { 'engine.js': 'module.exports.activate = () => {};' },
    },
  });
  const { loader } = mkLoader(root);
  const host = fakeHost();
  const results = loader.loadAll(host);
  assert.deepStrictEqual(host.registered.map((r) => r.id), ['alpha']);
  assert.deepStrictEqual(results.find((r) => r.id === 'beta').skipped, 'disabled');
});

test('loadAll ISOLATES a failing plugin — the others still load', () => {
  // The whole point of per-plugin try/catch: one bad plugin costs its own
  // features, never the app's. `boom` throws inside register (i.e. inside
  // activate, from the host's point of view).
  const src = 'module.exports.activate = () => {};';
  const root = mkTree({
    alpha: { manifest: OK_MANIFEST, files: { 'engine.js': src } },
    boom: { manifest: { ...OK_MANIFEST, id: 'boom' }, files: { 'engine.js': src } },
    zeta: { manifest: { ...OK_MANIFEST, id: 'zeta' }, files: { 'engine.js': src } },
  });
  const { loader, logged } = mkLoader(root);
  const host = fakeHost();
  const results = loader.loadAll(host);
  assert.deepStrictEqual(host.registered.map((r) => r.id), ['alpha', 'zeta']);
  assert.strictEqual(results.find((r) => r.id === 'boom').ok, false);
  assert.ok(logged.some((l) => /FAILED to load boom/.test(l)), 'the failure is loud');
});

test('a plugin whose engine file is missing fails alone, not the run', () => {
  const root = mkTree({
    alpha: { manifest: OK_MANIFEST, files: { 'engine.js': 'module.exports.activate = () => {};' } },
    ghost: { manifest: { ...OK_MANIFEST, id: 'ghost' } }, // manifest names engine.js; file absent
  });
  const { loader } = mkLoader(root);
  const host = fakeHost();
  const results = loader.loadAll(host);
  assert.deepStrictEqual(host.registered.map((r) => r.id), ['alpha']);
  assert.strictEqual(results.find((r) => r.id === 'ghost').ok, false);
});

test('activateById loads one plugin on demand and names an unknown id', () => {
  const root = mkTree({
    alpha: { manifest: OK_MANIFEST, files: { 'engine.js': 'module.exports.activate = () => {};' } },
  });
  const { loader } = mkLoader(root);
  const host = fakeHost();
  assert.strictEqual(loader.activateById('alpha', host).ok, true);
  assert.deepStrictEqual(host.registered.map((r) => r.id), ['alpha']);
  assert.match(loader.activateById('nope', host).error, /no such plugin/);
});

// ── rendererInfo (what a window needs to activate a renderer half) ──────────

test('rendererInfo returns the renderer path and the stylesheet TEXT', () => {
  const root = mkTree({
    alpha: { manifest: OK_MANIFEST, files: { 'style.css': '.wb-x { color: red }' } },
  });
  const { loader } = mkLoader(root);
  const info = loader.rendererInfo('alpha');
  assert.strictEqual(info.rendererPath, path.join(root, 'alpha', 'renderer.js'));
  // TEXT, not a path: §2.6's per-plugin <style> works identically in the
  // file:// Electron window and the built web bundle, where no path resolves.
  assert.strictEqual(info.css, '.wb-x { color: red }');
});

test('rendererInfo tolerates a manifest style that names a missing file', () => {
  const root = mkTree({ alpha: { manifest: OK_MANIFEST } });
  const info = mkLoader(root).loader.rendererInfo('alpha');
  assert.strictEqual(info.css, null);
  assert.ok(info.rendererPath, 'a missing stylesheet does not cost the renderer half');
});

test('rendererInfo returns null for an unknown plugin', () => {
  const root = mkTree({ alpha: { manifest: OK_MANIFEST } });
  assert.strictEqual(mkLoader(root).loader.rendererInfo('nope'), null);
});

// ── Fail-safe + quarantine (W7's follow-on) ─────────────────────────────────
//
// The posture is BEST EFFORT: a try/catch and a counter, not a rescue system.
// What these pin is the ONE rule that would be expensive to get wrong — that
// quarantine shadows the user's intent instead of overwriting it.

const BOOM_TREE = () => mkTree({
  alpha: { manifest: OK_MANIFEST, files: { 'engine.js': 'module.exports.activate = () => {};' } },
  boom: { manifest: { ...OK_MANIFEST, id: 'boom' }, files: { 'engine.js': 'module.exports.activate = () => {};' } },
});

test('a failed activation is RECORDED, not merely logged', () => {
  const { loader, ui } = mkLoader(BOOM_TREE());
  loader.loadAll(fakeHost());
  const rec = ui.read().plugins._failures.boom;
  assert.strictEqual(rec.count, 1);
  assert.match(rec.error, /activate\(\) threw/);
  assert.ok(!('_failures' in (ui.read().plugins.enabled || {})), 'failures are their own key');
});

test('ONE failure is not quarantine — a single throw is often transient', () => {
  const { loader } = mkLoader(BOOM_TREE());
  loader.loadAll(fakeHost());
  assert.strictEqual(loader.isQuarantined('boom'), false);
  assert.strictEqual(loader.status().plugins.find((p) => p.id === 'boom').failCount, 1);
});

test('the SECOND consecutive failure quarantines — and the plugin is then SKIPPED', () => {
  const root = BOOM_TREE();
  const { loader } = mkLoader(root);
  loader.loadAll(fakeHost());
  loader.loadAll(fakeHost());
  assert.strictEqual(loader.isQuarantined('boom'), true);

  // Third run: the host is never asked to register it at all, and alpha is
  // unaffected — the app boots regardless, which is the whole requirement.
  const host = fakeHost();
  const results = loader.loadAll(host);
  assert.deepStrictEqual(host.registered.map((r) => r.id), ['alpha']);
  assert.strictEqual(results.find((r) => r.id === 'boom').skipped, 'quarantined');
});

test('QUARANTINE NEVER TOUCHES uiSettings.plugins.enabled — intent survives', () => {
  // THE rule. The enabled array is the user's decision; flipping it to hold a
  // plugin back destroys the record of what they asked for, and a later fix
  // would leave the plugin off with nothing saying why.
  const { loader, ui } = mkLoader(BOOM_TREE(), { plugins: { enabled: ['alpha', 'boom'] } });
  loader.loadAll(fakeHost());
  loader.loadAll(fakeHost());
  assert.strictEqual(loader.isQuarantined('boom'), true);
  assert.deepStrictEqual(ui.read().plugins.enabled, ['alpha', 'boom'], 'intent intact');
  const row = loader.status().plugins.find((p) => p.id === 'boom');
  assert.strictEqual(row.enabled, true, 'the settings checkbox still shows the user their choice');
  assert.strictEqual(row.quarantined, true, 'the quarantine shadows it rather than replacing it');
});

test('any successful activation clears the counter — consecutive means consecutive', () => {
  const root = mkTree({
    flaky: { manifest: { ...OK_MANIFEST, id: 'flaky' }, files: { 'engine.js': 'module.exports.activate = () => {};' } },
  });
  // A host that fails the first time and succeeds after — one strike, then a
  // clean run, must NOT add up to quarantine on the next failure.
  let failNext = true;
  const host = {
    registered: [],
    register(id, mod, manifest) {
      if (failNext) { failNext = false; throw new Error('transient'); }
      host.registered.push({ id, mod, manifest });
    },
  };
  const { loader, ui } = mkLoader(root);
  loader.loadAll(host);
  assert.strictEqual(loader.status().plugins[0].failCount, 1);
  loader.loadAll(host);
  assert.strictEqual(loader.status().plugins[0].failCount, 0);
  assert.deepStrictEqual(ui.read().plugins._failures, {});
});

test('Retry (activateById) clears the strike count before trying again', () => {
  const root = BOOM_TREE();
  const { loader } = mkLoader(root);
  loader.loadAll(fakeHost());
  loader.loadAll(fakeHost());
  assert.strictEqual(loader.isQuarantined('boom'), true);
  // Still broken ⇒ it fails again, but from a CLEARED count: one strike, not
  // three. A user who actually fixed the plugin is never refused by a stale one.
  const r = loader.activateById('boom', fakeHost());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(loader.status().plugins.find((p) => p.id === 'boom').failCount, 1);
  assert.strictEqual(loader.isQuarantined('boom'), false);
});

test('the RENDERER rule: only the FIRST activation report per run counts', () => {
  // A renderer half activates once per BrowserWindow. Counting every window
  // would quarantine a three-window user on their FIRST bad launch, so a strike
  // is per LAUNCH, not per window. Simple rule, clear message — flagged (n).
  const { loader } = mkLoader(BOOM_TREE());
  assert.strictEqual(loader.noteRendererActivation('boom', false, 'kaboom').counted, true);
  assert.strictEqual(loader.noteRendererActivation('boom', false, 'kaboom').counted, false);
  assert.strictEqual(loader.noteRendererActivation('boom', false, 'kaboom').counted, false);
  assert.strictEqual(loader.status().plugins.find((p) => p.id === 'boom').failCount, 1,
    'three windows, one launch, one strike');
});

test('a renderer half that succeeds clears an engine-half strike', () => {
  const { loader } = mkLoader(BOOM_TREE());
  loader.loadAll(fakeHost());
  assert.strictEqual(loader.status().plugins.find((p) => p.id === 'boom').failCount, 1);
  loader.noteRendererActivation('boom', true);
  assert.strictEqual(loader.status().plugins.find((p) => p.id === 'boom').failCount, 0);
});

test('status() lists every plugin ON DISK plus the directories that were refused', () => {
  // Not catalog(): catalog lists what successfully registered, which by
  // definition excludes the plugin the settings section exists to let you fix.
  const root = mkTree({
    alpha: { manifest: OK_MANIFEST, files: { 'engine.js': 'module.exports.activate = () => {};' } },
    off: { manifest: { ...OK_MANIFEST, id: 'off', enabledByDefault: false } },
    junk: { manifest: '{ not json' },
    mismatch: { manifest: { ...OK_MANIFEST, id: 'other' } },
  });
  const { loader } = mkLoader(root);
  const s = loader.status();
  assert.deepStrictEqual(s.plugins.map((p) => p.id), ['alpha', 'off']);
  assert.strictEqual(s.plugins.find((p) => p.id === 'off').enabled, false);
  assert.deepStrictEqual(s.problems.map((p) => p.dir).sort(), ['junk', 'mismatch']);
  assert.match(s.problems.find((p) => p.dir === 'junk').why, /unreadable manifest/);
  assert.match(s.problems.find((p) => p.dir === 'mismatch').why, /does not match its directory/);
});

// ── Packaging (GAP G8) ──────────────────────────────────────────────────────

test('electron-builder SHIPS plugins/ — otherwise the DMG has no workbench at all', () => {
  // GAP G8, resolved at W7. `discover()` scans `path.join(__dirname, 'plugins')`,
  // which is the app.asar root when packaged — correct, but only if the packer
  // put the directory there. `build.files` is an ALLOWLIST: everything not named
  // is excluded, so an unlisted plugins/ means `readdirSync` throws, discover
  // returns [] (its legal silent state), and the shipped app silently has no
  // workbench while dev has one. The failure mode is invisible in every test
  // that runs from a checkout, which is why it is pinned here.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('plugins/**/*'),
    'package.json build.files must list plugins/**/* or the packaged app ships none');
});

// ── The real workbench plugin (W1 scaffold) ─────────────────────────────────

test('the in-repo workbench plugin is discovered and loads its engine half', () => {
  // Against the REAL plugins/ directory, not a fixture: this is the test that
  // fails the day the pilot's manifest drifts from what the loader accepts.
  const { loader } = mkLoader(path.join(__dirname, '..', 'plugins'));
  const rec = loader.discover().find((r) => r.id === 'workbench');
  assert.ok(rec, 'plugins/workbench is discoverable');
  assert.strictEqual(rec.manifest.hostApi, '0');
  assert.strictEqual(loader.isEnabled(rec), true, 'the pilot ships enabled (W7)');

  const host = fakeHost();
  assert.strictEqual(loader.activateById('workbench', host).ok, true);
  assert.strictEqual(host.registered.length, 1);
  assert.ok(loader.rendererInfo('workbench').rendererPath.endsWith('renderer.js'));
});
