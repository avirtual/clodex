'use strict';
// plugin-loader.test.js — discovery, the enabled set, and the failure isolation
// that makes one bad plugin cheap (plugin-plan.md [internal design doc, not in this repo] §3.1, Phase 2 W1).
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

const { createPluginLoader, validateManifest, isNewerVersion } = require('../plugin-loader');
const { HOST_API_VERSION, RESERVED_PLUGIN_IDS, isValidPluginId } = require('../plugin-api');

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
  // Derived, not literal: this constant's job is "a manifest that is otherwise
  // well-formed", so every test below varies ONE field against it. Pinning the
  // version here too would make a bump look like a validation failure in a dozen
  // unrelated tests. The version itself is pinned in exactly one place —
  // plugin-host-engine.test.js's freeze assertion.
  id: 'alpha', name: 'Alpha', version: '1.0.0', hostApi: HOST_API_VERSION,
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
  // "99" rather than a real-looking version: the mismatching value has to be one
  // this host will never serve, or the test starts passing/failing on the bump
  // instead of on the refusal it is about. (It WAS "1" — which the Phase-3 freeze
  // turned into the accepted version, i.e. into a test that asserted a valid
  // manifest is refused.)
  const why = validateManifest({ ...OK_MANIFEST, hostApi: '99' }, 'alpha');
  assert.match(why, /wants hostApi "99"/);
  assert.match(why, new RegExp(`host is "${HOST_API_VERSION}"`));
});

test('validateManifest refuses invalid ids, missing entry, and an empty entry', () => {
  assert.match(validateManifest({ ...OK_MANIFEST, id: 'has space' }, 'has space'), /invalid plugin id/);
  const noEntry = { ...OK_MANIFEST }; delete noEntry.entry;
  assert.match(validateManifest(noEntry, 'alpha'), /entry is missing/);
  assert.match(validateManifest({ ...OK_MANIFEST, entry: {} }, 'alpha'), /neither an engine nor a renderer/);
  assert.match(validateManifest(null, 'alpha'), /not a JSON object/);
});

// ── t8 F4: `enabled` is a RESERVED id, not merely a documented one ──────────
// `uiSettings.plugins` is one object holding per-plugin settings under
// `plugins[<id>]` AND the user's enabled list under `plugins.enabled`. A plugin
// literally named `enabled` writes its settings object over that ARRAY on its
// first host.settings.set; sanitizePlugins coerces the non-array to `[]`;
// enabledSet() reads `[]` as "the user turned everything off" — and every OTHER
// plugin is silently disabled at the next launch. Two comments in this loader
// already called the id reserved and nothing enforced it: PLUGIN_ID_RE accepts
// it, so isValidPluginId('enabled') was true.
test('t8 F4: `enabled` is refused as a plugin id, and the reason says WHY', () => {
  assert.strictEqual(isValidPluginId('enabled'), false,
    'the reservation is in the shared leaf, so both doors inherit it');
  const why = validateManifest({ ...OK_MANIFEST, id: 'enabled' }, 'enabled');
  assert.ok(why, 'a manifest claiming the reserved id is refused');
  assert.match(why, /reserved/, 'the discovery problems row says reserved…');
  assert.match(why, /enabled list/, '…and names what it would overwrite');
  // Ordering matters: the reserved check runs BEFORE the regex one, so the
  // dialog does not tell an author their perfectly-formed id is malformed.
  assert.doesNotMatch(why, /invalid plugin id/);
  // The quarantine shadow needs no entry in the set — the regex already covers
  // it, and this asserts that reasoning rather than restating it in prose.
  assert.strictEqual(isValidPluginId('_failures'), false,
    'PLUGIN_ID_RE forbids a leading underscore, so _failures is collision-proof already');
  assert.ok(!RESERVED_PLUGIN_IDS.has('_failures'),
    'and therefore does NOT need reserving — the set is for regex-LEGAL keys only');
  // A normal id is untouched by any of this.
  assert.strictEqual(validateManifest(OK_MANIFEST, 'alpha'), null);
});

test('t8 F4: a plugin directory named `enabled` is refused at DISCOVERY, with a problems row', () => {
  const root = mkTree({
    alpha: { manifest: OK_MANIFEST },
    enabled: { manifest: { ...OK_MANIFEST, id: 'enabled' } },
  });
  const { loader } = mkLoader(root);
  const s = loader.status();
  assert.deepStrictEqual(s.plugins.map((p) => p.id), ['alpha'],
    'the reserved-id plugin never becomes a catalog row');
  const row = s.problems.find((p) => p.dir === 'enabled');
  assert.ok(row, 'it appears in the Manage Plugins problems list instead of vanishing');
  assert.match(row.why, /reserved/);
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
  // LOAD-BEARING against the constant, not against a literal: the pilot's
  // manifest must track the host it ships with, and a bump that forgets the
  // manifest is exactly the drift this test exists to catch.
  assert.strictEqual(rec.manifest.hostApi, HOST_API_VERSION);
  assert.strictEqual(loader.isEnabled(rec), true, 'the pilot ships enabled (W7)');

  const host = fakeHost();
  assert.strictEqual(loader.activateById('workbench', host).ok, true);
  assert.strictEqual(host.registered.length, 1);
  assert.ok(loader.rendererInfo('workbench').rendererPath.endsWith('renderer.js'));
});

// ── Multi-root discovery (docs/plugin-sources.md §3-§5) ─────────────────────
//
// The user root exists because a PACKAGED install cannot accept a plugin at all:
// `pluginsDir` resolves inside app.asar, which is read-only and replaced
// wholesale by every update. Everything below is therefore about inputs this
// project did not author — the first real user plugin will be the first
// directory in a plugins root that we did not put there ourselves.

function mkMultiLoader(roots, uiState = {}) {
  const ui = fakeUiSettings(uiState);
  const logged = [];
  const loader = createPluginLoader({
    fs, path,
    roots,
    getUiSettings: () => ui.store,
    log: { info: (scope, msg) => logged.push(`${scope}: ${msg}`) },
    requireModule: (p) => require(p),
  });
  return { loader, ui, logged };
}

const engineFile = 'module.exports.activate = () => {};';

test('discovery reads every configured root', () => {
  const core = mkTree({ alpha: { manifest: { ...OK_MANIFEST, id: 'alpha' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const user = mkTree({ beta: { manifest: { ...OK_MANIFEST, id: 'beta' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const { loader } = mkMultiLoader([
    { id: 'core', dir: core, label: 'Built in' },
    { id: 'user', dir: user, label: 'User' },
  ]);
  const ids = loader.discover().map((r) => r.id).sort();
  assert.deepStrictEqual(ids, ['alpha', 'beta']);
  // Each record knows which root it came from, because the Manage Plugins row
  // has to be able to say so.
  const byId = Object.fromEntries(loader.discover().map((r) => [r.id, r.root]));
  assert.deepStrictEqual(byId, { alpha: 'core', beta: 'user' });
});

test('a root that does not exist is a legal, silent state', () => {
  // The app never CREATES ~/.clodex/plugins — its absence is the honest
  // representation of "no user plugins", so it must not be an error or a
  // `problems` row.
  const core = mkTree({ alpha: { manifest: OK_MANIFEST, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const { loader } = mkMultiLoader([
    { id: 'core', dir: core, label: 'Built in' },
    { id: 'user', dir: path.join(os.tmpdir(), 'clodex-no-such-root-' + Date.now()), label: 'User' },
  ]);
  assert.deepStrictEqual(loader.discover().map((r) => r.id), ['alpha']);
  assert.deepStrictEqual(loader.status().problems, []);
  assert.deepStrictEqual(loader.status().shadowed, []);
});

test('CORE WINS: a STALE user copy of a core id is shadowed, not loaded', () => {
  // The precedence decision, and the reason for it: user-wins fails LATE and
  // QUIETLY — a forgotten fork keeps running after an update changed the core it
  // was forked from, with the app reporting health. This asserts the loud
  // failure instead.
  //
  // t21 NARROWED this rule to "core wins unless the user copy is strictly
  // newer", and the fixture moved with it: it used to give the user copy v9.9.9,
  // which contradicted the forgotten-fork story this test is actually about —
  // a fork is by definition NOT newer than the core it was forked from. The
  // stale version below is what the prose always meant.
  const core = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: '2.0.0' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const user = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: '1.4.0' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const { loader } = mkMultiLoader([
    { id: 'core', dir: core, label: 'Built in' },
    { id: 'user', dir: user, label: 'User' },
  ]);
  const recs = loader.discover();
  assert.strictEqual(recs.length, 1, 'exactly one copy is live');
  assert.strictEqual(recs[0].root, 'core');
  assert.strictEqual(recs[0].manifest.version, '2.0.0', 'the CORE copy is the one that runs');
  // Reversing the root order reverses the winner — precedence is the list order
  // and nothing else, so this is what makes "core wins" a configuration rather
  // than a hardcoded rule. Both copies are stale-vs-newer the other way round
  // here, so this is root order acting alone.
  const { loader: flipped } = mkMultiLoader([
    { id: 'user', dir: user, label: 'User' },
    { id: 'core', dir: core, label: 'Built in' },
  ]);
  assert.strictEqual(flipped.discover()[0].manifest.version, '2.0.0', 'core is newer, so it wins from either position');
});

test('EQUAL versions lose: the incumbent root keeps the id', () => {
  // The boundary of the t21 rule, and the direction it must fail in. "Newer" is
  // STRICTLY greater — an identical copy in the user root does not take over,
  // because the case that motivated the rule is a user running a genuine later
  // release and an equal version is not one.
  const core = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: '1.0.0' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const user = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: '1.0.0' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const { loader } = mkMultiLoader([
    { id: 'core', dir: core, label: 'Built in' },
    { id: 'user', dir: user, label: 'User' },
  ]);
  const recs = loader.discover();
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].root, 'core');
  assert.strictEqual(loader.status().shadowed[0].reason, 'precedence', 'it lost to root order, not to a version');
});

test('a shadowed copy is SURFACED, never silently dropped', () => {
  // The failure this prevents: a user editing code that is not the code running.
  // Without a row the plugin is present, enabled and working — and none of their
  // edits do anything, with nothing on screen explaining why.
  const core = mkTree({ alpha: { manifest: OK_MANIFEST, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const user = mkTree({ alpha: { manifest: OK_MANIFEST, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const { loader } = mkMultiLoader([
    { id: 'core', dir: core, label: 'Built in' },
    { id: 'user', dir: user, label: 'User' },
  ]);
  const st = loader.status();
  assert.strictEqual(st.plugins.length, 1);
  assert.strictEqual(st.shadowed.length, 1);
  assert.strictEqual(st.shadowed[0].id, 'alpha');
  assert.strictEqual(st.shadowed[0].root, 'user');
  assert.strictEqual(st.shadowed[0].shadowedBy, 'core');
  // The DIRECTORY is carried, because "which copy is not running" is the one
  // question the row exists to answer and an id alone cannot answer it.
  assert.strictEqual(st.shadowed[0].dir, path.join(user, 'alpha'));
});

// ── Version-aware precedence (t21, docs/plugin-sources.md §4) ───────────────
// The bundled copy is a FLOOR, not a ceiling. Plugins ship inside app.asar,
// which is read-only and replaced wholesale by every update, so without this a
// packaged user could never run a newer plugin than the one their DMG shipped.

test('a NEWER user copy supersedes the built-in one', () => {
  // The whole point of the rule. Core-wins still holds by default; a strictly
  // higher version is the one thing that overturns it.
  const core = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: '1.0.0' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const user = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: '1.1.0' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const { loader } = mkMultiLoader([
    { id: 'core', dir: core, label: 'Built in' },
    { id: 'user', dir: user, label: 'User' },
  ]);
  const recs = loader.discover();
  assert.strictEqual(recs.length, 1, 'still exactly one copy is live');
  assert.strictEqual(recs[0].root, 'user');
  assert.strictEqual(recs[0].manifest.version, '1.1.0');
  // …and the paths follow the winner, not just the id. A record that named the
  // new version but loaded the old directory would be the worst of both.
  assert.strictEqual(recs[0].dir, path.join(user, 'alpha'));
  assert.strictEqual(recs[0].enginePath, path.join(user, 'alpha', 'engine.js'));
});

test('the INVERTED shadow row names the built-in copy as the loser, with both versions', () => {
  // THE DISPLAY IS THE SAFETY MECHANISM. When a user copy wins, the row has to
  // invert: the built-in copy is the one not running. A row that could only say
  // "your copy is shadowed" would be silent in exactly the direction that
  // carries the hazard.
  const core = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: '1.0.0' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const user = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: '2.0.0' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const { loader } = mkMultiLoader([
    { id: 'core', dir: core, label: 'Built in' },
    { id: 'user', dir: user, label: 'User' },
  ]);
  const st = loader.status();
  assert.strictEqual(st.shadowed.length, 1);
  const row = st.shadowed[0];
  assert.strictEqual(row.root, 'core', 'the BUILT-IN copy is the one shadowed');
  assert.strictEqual(row.version, '1.0.0', 'the loser names its version');
  assert.strictEqual(row.shadowedBy, 'user');
  assert.strictEqual(row.shadowedByVersion, '2.0.0', 'and the winner names its version');
  assert.strictEqual(row.reason, 'superseded', 'it lost to a version, not to root order');
  assert.strictEqual(row.dir, path.join(core, 'alpha'));
});

test('the version-99 hazard is not preventable, but it IS visible', () => {
  // The cost of this rule, stated as a test rather than a hope. A user-root copy
  // declaring version 99 wins forever and can never be superseded by any real
  // release — that is the forgotten-fork case in a new outfit. Nothing stops it,
  // so the ONLY thing making it recoverable is a row saying plainly which copy
  // runs and what version each is. This asserts that row exists and carries both
  // numbers, because a user staring at an app that ignores every update has
  // nothing else to go on.
  const core = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: '3.5.0' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const user = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: '99' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const { loader } = mkMultiLoader([
    { id: 'core', dir: core, label: 'Built in' },
    { id: 'user', dir: user, label: 'User' },
  ]);
  assert.strictEqual(loader.discover()[0].root, 'user', 'v99 wins — this is not prevented');
  const row = loader.status().shadowed[0];
  assert.strictEqual(row.root, 'core');
  assert.strictEqual(row.version, '3.5.0');
  assert.strictEqual(row.shadowedByVersion, '99');
  assert.strictEqual(row.reason, 'superseded');
});

test('THE MIRROR: core shipping a newer version reclaims an id a user copy held', () => {
  // The update path, and the reason the rule is safe to make automatic. A user
  // copy that won at v2.0.0 must LOSE once core ships v2.1.0 — otherwise "the
  // bundled copy is a floor" would quietly become "the user copy is permanent".
  const user = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: '2.0.0' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const before = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: '1.0.0' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const after = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: '2.1.0' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const roots = (core) => [
    { id: 'core', dir: core, label: 'Built in' },
    { id: 'user', dir: user, label: 'User' },
  ];
  const { loader: old } = mkMultiLoader(roots(before));
  assert.strictEqual(old.discover()[0].root, 'user', 'the user copy wins against the older core');
  const { loader: updated } = mkMultiLoader(roots(after));
  assert.strictEqual(updated.discover()[0].root, 'core', 'and loses once core ships newer');
  const row = updated.status().shadowed[0];
  assert.strictEqual(row.root, 'user', 'the user copy is now the one shadowed');
  assert.strictEqual(row.version, '2.0.0');
  assert.strictEqual(row.shadowedByVersion, '2.1.0');
});

test('"1.10" beats "1.9" — versions compare NUMERICALLY, not as strings', () => {
  // The bite. String comparison puts "1.10" below "1.9", and the plugin that
  // reaches its tenth patch release is exactly the plugin someone is actively
  // shipping updates for — so a string compare would fail first for the most
  // maintained plugin in the wild.
  assert.strictEqual(isNewerVersion('1.10', '1.9'), true);
  assert.strictEqual(isNewerVersion('1.9', '1.10'), false);
  assert.strictEqual('1.10' > '1.9', false, 'string comparison really does get this backwards');
  // Missing trailing segments are zero, so these TIE — and a tie loses.
  assert.strictEqual(isNewerVersion('1.2', '1.2.0'), false);
  assert.strictEqual(isNewerVersion('1.2.0', '1.2'), false);
  assert.strictEqual(isNewerVersion('1.2.1', '1.2'), true);
});

test('a MALFORMED version never wins and never crashes discovery', () => {
  // `version` was free text until t21 and is still not validated, so junk is a
  // legal input rather than a hypothetical. The rule is that an unparseable
  // version is UNCOMPARABLE, and uncomparable can never out-rank anything — so
  // the failure mode of junk is "nothing changes", which is precisely the
  // pre-t21 behaviour. Both directions, because a malformed version on the
  // INCUMBENT must not let a candidate win by default either.
  for (const junk of [undefined, null, '', 'the good one', '1.0.0-beta', 'v2', '1..2', '1.2.', {}, 3]) {
    assert.strictEqual(isNewerVersion(junk, '1.0.0'), false, `${JSON.stringify(junk)} must not win`);
    assert.strictEqual(isNewerVersion('9.9.9', junk), false, `nothing wins against ${JSON.stringify(junk)}`);
  }
  // SURROUNDING whitespace is not junk — it is a typo in a JSON file, and every
  // other consumer of that string would read the same number. Tolerated on
  // purpose, and pinned here so it reads as a decision rather than an accident
  // of the parse. Interior whitespace is still junk (it is in the list above).
  assert.strictEqual(isNewerVersion(' 2.0.0 ', '1.0.0'), true);
  // And end to end: a user copy with a junk version is shadowed, discovery
  // returns normally, and the row says the version could not be read rather
  // than implying a bump would help.
  const core = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: '1.0.0' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const user = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: 'the good one' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const { loader } = mkMultiLoader([
    { id: 'core', dir: core, label: 'Built in' },
    { id: 'user', dir: user, label: 'User' },
  ]);
  const recs = loader.discover();
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].root, 'core');
  const row = loader.status().shadowed[0];
  assert.strictEqual(row.root, 'user');
  assert.strictEqual(row.comparable, false, 'the row says the version could not be read');
  assert.strictEqual(row.reason, 'precedence');
});

test('a plugin with NO version at all still loads, in either root', () => {
  // `version` is not required by validateManifest and t21 did not make it
  // required — making a decorative field load-bearing must not un-install the
  // manifests that omitted it. This is the regression that would matter most and
  // would be invisible in the two-copy tests above.
  const core = mkTree({ alpha: { manifest: { ...OK_MANIFEST, version: undefined }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const user = mkTree({ beta: { manifest: { ...OK_MANIFEST, id: 'beta', version: undefined }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const { loader } = mkMultiLoader([
    { id: 'core', dir: core, label: 'Built in' },
    { id: 'user', dir: user, label: 'User' },
  ]);
  assert.deepStrictEqual(loader.discover().map((r) => r.id).sort(), ['alpha', 'beta']);
  assert.deepStrictEqual(loader.status().problems, [], 'a missing version is not a problem row');
});

test('a SYMLINKED plugin directory is followed', () => {
  // The first input we did not choose, and it was already broken: readdirSync
  // with withFileTypes reports a symlink-to-directory as isSymbolicLink() and
  // NOT isDirectory(), so the obvious filter skips it — silently, since a
  // directory with no readable manifest is not an error. Symlinking a plugin out
  // of a working checkout is the likeliest thing a developer does in the user
  // root.
  const src = mkTree({ gamma: { manifest: { ...OK_MANIFEST, id: 'gamma' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-userroot-'));
  fs.symlinkSync(path.join(src, 'gamma'), path.join(user, 'gamma'), 'dir');
  const { loader } = mkMultiLoader([{ id: 'user', dir: user, label: 'User' }]);
  const recs = loader.discover();
  assert.strictEqual(recs.length, 1, 'a symlinked plugin directory is discovered');
  assert.strictEqual(recs[0].id, 'gamma');
  // Paths are RESOLVED, so every later check (insideDir, require) compares like
  // with like rather than reasoning about a path that points somewhere else.
  assert.strictEqual(recs[0].dir, fs.realpathSync(path.join(src, 'gamma')));
  assert.ok(recs[0].enginePath.startsWith(recs[0].dir + path.sep));
});

test('a symlink cannot be used to escape the plugin directory', () => {
  // insideDir runs against the RESOLVED dir, so the escape check is not weakened
  // by the symlink following above.
  const src = mkTree({ evil: { manifest: { ...OK_MANIFEST, id: 'evil', entry: { engine: '../../elsewhere.js' } }, files: { 'engine.js': engineFile } } });
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-userroot-'));
  fs.symlinkSync(path.join(src, 'evil'), path.join(user, 'evil'), 'dir');
  const { loader } = mkMultiLoader([{ id: 'user', dir: user, label: 'User' }]);
  assert.deepStrictEqual(loader.discover(), []);
  const why = loader.status().problems.map((p) => p.why).join(' ');
  assert.match(why, /escapes the plugin directory/);
});

test('a broken user manifest is reported against its own root', () => {
  // A problems row has to say WHERE, or a user with the same dirname in both
  // roots cannot tell which copy is broken.
  const core = mkTree({ alpha: { manifest: OK_MANIFEST, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const user = mkTree({ broken: { manifest: '{ not json' } });
  const { loader } = mkMultiLoader([
    { id: 'core', dir: core, label: 'Built in' },
    { id: 'user', dir: user, label: 'User' },
  ]);
  loader.discover();
  const probs = loader.status().problems;
  assert.strictEqual(probs.length, 1);
  assert.strictEqual(probs[0].dir, 'broken');
  assert.strictEqual(probs[0].root, 'user');
});

test('a user directory with no manifest.json is not an error', () => {
  // Unchanged behaviour, asserted across roots: an unrelated subdirectory a user
  // happens to have is not a failed plugin.
  const user = mkTree({ notes: { files: { 'README.md': 'hi' } } });
  const { loader } = mkMultiLoader([{ id: 'user', dir: user, label: 'User' }]);
  assert.deepStrictEqual(loader.discover(), []);
  assert.deepStrictEqual(loader.status().problems, []);
});

test('the legacy single-root `pluginsDir` spelling still works', () => {
  // Every existing caller passes pluginsDir; a list of one is exactly what it
  // always meant, so this must not have become a breaking change.
  const core = mkTree({ alpha: { manifest: OK_MANIFEST, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const { loader } = mkLoader(core);
  assert.deepStrictEqual(loader.discover().map((r) => r.id), ['alpha']);
});

// ── Verb collisions are REFUSED, not PUNISHED (t20) ─────────────────────────
// The defect these pin, found by running the app: a user installed a plugin and
// it took down a DIFFERENT plugin they already had, quarantining it two launches
// later under a message about activation failure that named neither the verb nor
// the other plugin — and Retry could not recover it, because the collision
// reproduces on every attempt.
//
// A host whose register() throws the shaped error intent-registry really throws.
// Shaped rather than the real registry on purpose: what is under test here is the
// LOADER's classification rule, and the registry's own throw is pinned next door
// in intent-registry.test.js.
function verbTakenHost(losers) {
  const registered = [];
  return {
    registered,
    register(id) {
      const conflict = losers[id];
      if (conflict) {
        const e = new Error(`intent verb "${conflict.verb}" is already registered by plugin "${conflict.heldBy}"`);
        e.code = 'EVERBTAKEN';
        e.verb = conflict.verb;
        e.heldBy = conflict.heldBy;
        throw e;
      }
      registered.push(id);
    },
  };
}

test('a verb collision takes NO quarantine strike, however many launches', () => {
  const dir = mkTree({ alpha: { manifest: OK_MANIFEST, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const { loader } = mkLoader(dir);
  const host = verbTakenHost({ alpha: { verb: 'branch', heldBy: 'git-branches' } });

  // Three launches. Under the old behaviour alpha was quarantined at the second.
  for (let i = 0; i < 3; i++) loader.loadAll(host);

  const row = loader.status().plugins.find((p) => p.id === 'alpha');
  assert.strictEqual(row.failCount, 0,
    'a verb collision is a structural refusal, not a malfunction — the strike counter is for plugins that CRASH');
  assert.strictEqual(row.quarantined, false,
    'quarantining here disabled a working plugin because the user installed an unrelated one');
  assert.strictEqual(row.enabled, true, 'the user\'s intent is untouched');
});

test('a verb collision NAMES the verb and the plugin holding it', () => {
  // Target 2. "Disabled automatically: activate() threw" is unactionable — it
  // points at the wrong plugin and never mentions the verb.
  const dir = mkTree({ alpha: { manifest: OK_MANIFEST, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const { loader, logged } = mkLoader(dir);
  const host = verbTakenHost({ alpha: { verb: 'branch', heldBy: 'git-branches' } });

  const results = loader.loadAll(host);
  assert.deepStrictEqual(results[0].verbConflict, { verb: 'branch', heldBy: 'git-branches' },
    'the load result carries the conflict, not just an error string');
  assert.deepStrictEqual(loader.status().plugins[0].verbConflict, { verb: 'branch', heldBy: 'git-branches' },
    'status() is what the settings row renders — the holder must reach it');
  assert.ok(logged.some((l) => /already held by "git-branches"/.test(l) && /No strike/.test(l)),
    'the log names the holder too');
});

test('a plugin that CRASHES still strikes and still quarantines', () => {
  // The other half of the classification: t20 must not have turned the failure
  // machinery off. `boom` throws a plain Error with no code.
  const dir = mkTree({ boom: { manifest: { ...OK_MANIFEST, id: 'boom' }, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const { loader } = mkLoader(dir);
  loader.loadAll(fakeHost());
  loader.loadAll(fakeHost());
  const row = loader.status().plugins.find((p) => p.id === 'boom');
  assert.strictEqual(row.failCount, 2);
  assert.strictEqual(row.quarantined, true);
  assert.strictEqual(row.verbConflict, null, 'a crash is not a verb conflict');
});

test('the conflict clears when the plugin loads — it is per-run, never persisted', () => {
  // Persisting it would reintroduce the staleness this ticket is about: a record
  // outliving the plugin that held the verb. So a load that succeeds after the
  // holder is disabled must leave nothing behind.
  const dir = mkTree({ alpha: { manifest: OK_MANIFEST, files: { 'engine.js': engineFile, 'renderer.js': '', 'style.css': '' } } });
  const { loader, ui } = mkLoader(dir);
  loader.loadAll(verbTakenHost({ alpha: { verb: 'branch', heldBy: 'git-branches' } }));
  assert.ok(loader.status().plugins[0].verbConflict, 'refused first');

  assert.strictEqual(JSON.stringify(ui.read()).includes('branch'), false,
    'the conflict must not be written to uiSettings — it is a fact about this run');

  loader.loadAll(fakeHost()); // the holder is gone this run
  assert.strictEqual(loader.status().plugins[0].verbConflict, null);
});

// ── Re-scan without restarting (t22) ────────────────────────────────────────
// The user root is only worth having if a plugin dropped into it can be reached
// without quitting the app. What makes this subtle is that `require` caches by
// resolved path, so the three things a re-scan can find are NOT symmetric: an
// added plugin genuinely loads, a removed one genuinely goes, and a CHANGED one
// cannot be swapped in-process at all. The tests below pin that asymmetry,
// because the tempting bug is to treat all three as "re-discover and carry on".

// The rescan surface needs more of the host than `register`: it deactivates
// removed plugins and asks which ids are actually running. Separate from
// fakeHost deliberately — the older tests prove the loader does NOT reach past
// register, and widening that fake would silently retire the proof.
function rescanHost() {
  const live = new Map();
  return {
    live,
    register(id, mod, manifest) {
      if (mod && mod.boom) throw new Error('activate exploded');
      live.set(id, { id, mod, manifest });
    },
    deactivate(id) { return live.delete(id); },
    catalog() { return [...live.values()].map((r) => ({ id: r.id, version: r.manifest.version || null })); },
  };
}

// A plugin whose engine file is unique per call, so `require` has no cached
// entry from an earlier test. Without this the require cache leaks ACROSS tests
// and a later test sees a module an earlier one loaded — the same cache
// behaviour under test, biting the test suite itself.
let uniq = 0;
function freshTree(id, version, body = engineFile) {
  uniq += 1;
  return mkTree({
    [id]: {
      manifest: { ...OK_MANIFEST, id, version },
      files: { 'engine.js': `${body}\nmodule.exports.__uniq = ${uniq};`, 'renderer.js': '', 'style.css': '' },
    },
  });
}

test('re-scan picks up a plugin ADDED after startup', () => {
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-plugins-'));
  const { loader } = mkMultiLoader([{ id: 'user', dir: user, label: 'User' }]);
  const host = rescanHost();
  loader.loadAll(host);
  assert.deepStrictEqual(host.catalog().map((p) => p.id), [], 'nothing on disk at boot');

  // Drop a plugin in while the app is "running".
  uniq += 1;
  const dir = path.join(user, 'gamma');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...OK_MANIFEST, id: 'gamma', version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'engine.js'), `${engineFile}\nmodule.exports.__uniq = ${uniq};`);
  fs.writeFileSync(path.join(dir, 'renderer.js'), '');
  fs.writeFileSync(path.join(dir, 'style.css'), '');

  const r = loader.rescan(host);
  assert.deepStrictEqual(r.added, ['gamma']);
  assert.deepStrictEqual(host.catalog().map((p) => p.id), ['gamma'],
    'an added plugin is genuinely registered, not merely discovered');
});

test('re-scan DEACTIVATES a plugin removed from disk', () => {
  const user = freshTree('gamma', '1.0.0');
  const { loader } = mkMultiLoader([{ id: 'user', dir: user, label: 'User' }]);
  const host = rescanHost();
  loader.loadAll(host);
  assert.deepStrictEqual(host.catalog().map((p) => p.id), ['gamma']);

  fs.rmSync(path.join(user, 'gamma'), { recursive: true, force: true });
  const r = loader.rescan(host);
  assert.deepStrictEqual(r.removed, ['gamma']);
  assert.deepStrictEqual(host.catalog().map((p) => p.id), [],
    'the engine half is torn down, not just dropped from discovery');
  assert.deepStrictEqual(loader.status().plugins, [], 'and it is gone from the dialog');
});

test('re-scan marks a CHANGED plugin restart-required and does NOT reload it', () => {
  // THE honest-feature test. require caches by resolved path, so rewriting a
  // running plugin's engine.js cannot take effect this run. The failure this
  // pins is not a crash — it is the row showing the new version beside the old
  // code, which is the badge bug in a new costume.
  const user = freshTree('gamma', '1.0.0');
  const { loader } = mkMultiLoader([{ id: 'user', dir: user, label: 'User' }]);
  const host = rescanHost();
  loader.loadAll(host);
  const loadedMod = host.live.get('gamma').mod;

  fs.writeFileSync(path.join(user, 'gamma', 'manifest.json'),
    JSON.stringify({ ...OK_MANIFEST, id: 'gamma', version: '2.0.0' }));
  const r = loader.rescan(host);

  assert.deepStrictEqual(r.changed, ['gamma']);
  assert.deepStrictEqual(r.added, [], 'a running plugin is not re-added');
  assert.strictEqual(host.live.get('gamma').mod, loadedMod,
    'the ORIGINAL module object is still the one registered');

  const row = loader.status().plugins.find((p) => p.id === 'gamma');
  assert.ok(row.restartRequired, 'the row must say so rather than show 2.0.0 silently');
  assert.strictEqual(row.restartRequired.was, '1.0.0');
  assert.strictEqual(row.restartRequired.now, '2.0.0');
});

test('re-scan takes NO strike when a plugin fails to activate', () => {
  // A re-scan is not a launch (t20's reasoning). The counter exists for plugins
  // that crash on a real activation; a user pressing Re-scan three times must
  // not quarantine a plugin that was half-copied when they pressed it.
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-plugins-'));
  const { loader, ui } = mkMultiLoader([{ id: 'user', dir: user, label: 'User' }]);
  const host = rescanHost();
  loader.loadAll(host);

  uniq += 1;
  const dir = path.join(user, 'gamma');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...OK_MANIFEST, id: 'gamma', version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'engine.js'), `module.exports.boom = true;\nmodule.exports.__uniq = ${uniq};`);
  fs.writeFileSync(path.join(dir, 'renderer.js'), '');
  fs.writeFileSync(path.join(dir, 'style.css'), '');

  loader.rescan(host);
  loader.rescan(host);
  loader.rescan(host);

  const row = loader.status().plugins.find((p) => p.id === 'gamma');
  assert.strictEqual(row.failCount, 0, 'three failed re-scans must not record a single strike');
  assert.strictEqual(row.quarantined, false, 'and must never quarantine');
  assert.strictEqual(JSON.stringify(ui.read()).includes('_failures'), false,
    'nothing is persisted by a re-scan');
});

test('a DISABLED plugin re-scans as loadable, not as restart-required', () => {
  // Defect 1, caught while building. `loadedFrom` remembers which copy we loaded,
  // but "is it running" is the HOST's fact: after a disable the host has
  // deactivated it while our map still holds the entry. Trusting the map would
  // report restart-required for a plugin that is simply off and could be loaded.
  const user = freshTree('gamma', '1.0.0');
  const { loader } = mkMultiLoader([{ id: 'user', dir: user, label: 'User' }]);
  const host = rescanHost();
  loader.loadAll(host);
  host.deactivate('gamma');            // what setEnabled(false) does

  const r = loader.rescan(host);
  assert.deepStrictEqual(r.changed, [], 'nothing changed on disk, so nothing is restart-required');
  assert.deepStrictEqual(r.added, ['gamma'], 'it is simply not running, so load it');
});

test('a disable/enable toggle does NOT clear restart-required', () => {
  // Defect 2, and the one that matters most. An enable does not empty the require
  // cache, so re-activating a plugin whose files changed re-runs the OLD module
  // against the NEW manifest. If the toggle cleared the flag, the row would show
  // the new version with the old code running — silently. That is precisely the
  // disagreement this ticket exists to prevent.
  const user = freshTree('gamma', '1.0.0');
  const { loader } = mkMultiLoader([{ id: 'user', dir: user, label: 'User' }]);
  const host = rescanHost();
  loader.loadAll(host);
  const original = host.live.get('gamma').mod;

  fs.writeFileSync(path.join(user, 'gamma', 'manifest.json'),
    JSON.stringify({ ...OK_MANIFEST, id: 'gamma', version: '2.0.0' }));
  loader.rescan(host);
  assert.ok(loader.status().plugins[0].restartRequired, 'flagged first');

  host.deactivate('gamma');
  loader.activateById('gamma', host);

  assert.strictEqual(host.live.get('gamma').mod, original,
    'the require cache handed back the OLD module — this is why the flag must survive');
  assert.ok(loader.status().plugins[0].restartRequired,
    'a toggle must not launder stale code into looking freshly installed');
});

test('re-scan does not resurrect a QUARANTINED plugin', () => {
  // Quarantine shadows a re-scan for the same reason it shadows a launch: Retry
  // is the explicit, counter-clearing path, and a re-scan that silently activated
  // a quarantined plugin would make Retry meaningless.
  const user = freshTree('gamma', '1.0.0', 'module.exports.boom = true;');
  const { loader } = mkMultiLoader([{ id: 'user', dir: user, label: 'User' }]);
  const host = rescanHost();
  loader.loadAll(host);   // strike 1
  loader.loadAll(host);   // strike 2 → quarantined
  assert.strictEqual(loader.isQuarantined('gamma'), true);

  const r = loader.rescan(host);
  assert.deepStrictEqual(r.added, [], 'quarantine still shadows');
  assert.deepStrictEqual(r.failed, [], 'and it is not even attempted, so it cannot fail again');
});

test('a re-scan can flip which copy of a shadow pair wins', () => {
  // t21's swap on a new trigger. discover() is stateless, so this falls out for
  // free — the test exists because suppressing it would need new state whose only
  // job is making the dialog disagree with the disk.
  const core = freshTree('gamma', '2.0.0');
  const user = freshTree('gamma', '3.0.0');
  const { loader } = mkMultiLoader([
    { id: 'core', dir: core, label: 'Built in' },
    { id: 'user', dir: user, label: 'User' },
  ]);
  assert.strictEqual(loader.discover().find((r) => r.id === 'gamma').root, 'user',
    'the higher user version wins first');

  fs.writeFileSync(path.join(user, 'gamma', 'manifest.json'),
    JSON.stringify({ ...OK_MANIFEST, id: 'gamma', version: '0.9.0' }));

  assert.strictEqual(loader.discover().find((r) => r.id === 'gamma').root, 'core',
    'dropping the user version hands the id back to core mid-run');
  const sh = loader.status().shadowed.find((s) => s.id === 'gamma');
  assert.strictEqual(sh.root, 'user');
  assert.strictEqual(sh.reason, 'precedence', 'and the row flips from superseded to precedence');
});

test('ensureUserRoot creates the directory it reveals', () => {
  // §3 says startup never creates this dir, because its absence is the honest
  // representation of "no user plugins". This is the exception the rule names:
  // the user has explicitly asked to be shown where plugins go, and revealing a
  // path that does not exist is a broken action.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-plugins-'));
  const userDir = path.join(base, 'plugins');
  const { loader } = mkMultiLoader([
    { id: 'core', dir: base, label: 'Built in' },
    { id: 'user', dir: userDir, label: 'User' },
  ]);
  assert.strictEqual(fs.existsSync(userDir), false, 'not created by construction');
  assert.strictEqual(loader.ensureUserRoot(), userDir);
  assert.strictEqual(fs.existsSync(userDir), true, 'created on demand');
});

test('ensureUserRoot returns null when there is no user root', () => {
  // The legacy single-root form. Returning a path here would offer a button that
  // reveals the read-only asar, which is worse than no button.
  const { loader } = mkLoader(mkTree({}));
  assert.strictEqual(loader.ensureUserRoot(), null);
});
