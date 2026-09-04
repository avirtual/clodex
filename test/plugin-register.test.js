'use strict';
// plugin-register.test.js — registering a plugin that lives anywhere on disk
// (t651). Registration writes a SYMLINK into the user root; unregistering
// removes only that link. Both halves touch the user's real filesystem, so
// every subject here runs against a real temp tree — a mocked fs would pass a
// registrar that cannot tell a symlink from a directory, which is the single
// distinction the refusals are built on.
//
// The refusals are the substance. A registrar that only works is a registrar
// that will one day delete a directory a user spent a week on, so each refusal
// asserts BOTH the shaped error and that the thing it protects is still on disk.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createPluginLoader } = require('../plugin-loader');
const { HOST_API_VERSION } = require('../plugin-api');
const { mkTmpRoot } = require('./lib/tmp-roots');

const engineFile = 'module.exports.activate = () => {};';

function manifestFor(id, extra = {}) {
  return {
    id, name: `${id} plugin`, version: '1.0.0', hostApi: HOST_API_VERSION,
    entry: { engine: 'engine.js' }, ...extra,
  };
}

// A plugin sitting somewhere that is NOT a discovery root — the case the whole
// feature exists for (a plugin in its own git checkout).
function mkCandidate(id, { manifest = manifestFor(id), dirName = id } = {}) {
  const base = mkTmpRoot('clodex-candidate-');
  const dir = path.join(base, dirName);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) {
    fs.writeFileSync(path.join(dir, 'manifest.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  }
  fs.writeFileSync(path.join(dir, 'engine.js'), engineFile);
  return dir;
}

function mkLoaderWithUserRoot({ core = null } = {}) {
  const base = mkTmpRoot('clodex-userroot-');
  const userDir = path.join(base, 'plugins');
  const coreDir = path.join(base, 'core');
  fs.mkdirSync(coreDir, { recursive: true });
  if (core) {
    const d = path.join(coreDir, core);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(manifestFor(core)));
    fs.writeFileSync(path.join(d, 'engine.js'), engineFile);
  }
  let ui = {};
  const loader = createPluginLoader({
    fs, path,
    roots: [
      { id: 'core', dir: coreDir, label: 'Built in' },
      { id: 'user', dir: userDir, label: 'User' },
    ],
    getUiSettings: () => ({ get: () => ui, set: (patch) => { ui = { ...ui, ...patch }; } }),
    log: { info: () => {} },
    requireModule: (p) => require(p),
  });
  return { loader, userDir, coreDir };
}

// ════════════════════════════════════════════════════════════════════════════
// validateCandidate — the same validator discovery uses, run before any write
// ════════════════════════════════════════════════════════════════════════════

test('validateCandidate accepts a well-formed folder and reports what it found', () => {
  const dir = mkCandidate('alpha', {
    manifest: manifestFor('alpha', { entry: { engine: 'engine.js', renderer: 'renderer.js' }, scope: 'session' }),
  });
  const { loader } = mkLoaderWithUserRoot();
  assert.deepStrictEqual(loader.validateCandidate(dir), {
    ok: true,
    id: 'alpha',
    name: 'alpha plugin',
    version: '1.0.0',
    entry: { engine: 'engine.js', renderer: 'renderer.js' },
    scope: 'session',
    hasRenderer: true,
  });
});

test('validateCandidate refuses a path that is not a directory', () => {
  const dir = mkCandidate('alpha');
  const { loader } = mkLoaderWithUserRoot();
  const r = loader.validateCandidate(path.join(dir, 'manifest.json'));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /is not a directory/);
});

test('validateCandidate says WHICH failed: missing file vs unparseable JSON', () => {
  // Two different repairs. "manifest.json is missing" sends the user to create
  // one; "not valid JSON" sends them to fix a comma. One shared message would
  // send half of them to the wrong place.
  const { loader } = mkLoaderWithUserRoot();
  const empty = mkCandidate('alpha', { manifest: undefined });
  fs.rmSync(path.join(empty, 'manifest.json'), { force: true });
  const missing = loader.validateCandidate(empty);
  assert.strictEqual(missing.ok, false);
  assert.match(missing.error, /could not read .*manifest\.json/);

  const broken = mkCandidate('alpha', { manifest: '{ not json' });
  const bad = loader.validateCandidate(broken);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /is not valid JSON/);
});

test('a folder whose name is not the plugin id is refused with the rename to make', () => {
  // The one failure a user hits by accident: they cloned `my-plugin` and its id
  // is `notes`. validateManifest's own message names both but not the repair.
  const dir = mkCandidate('notes', { dirName: 'my-plugin' });
  const { loader } = mkLoaderWithUserRoot();
  const r = loader.validateCandidate(dir);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /does not match its directory/, 'the validator\'s own message survives');
  assert.match(r.error, /rename "my-plugin" to "notes"/, 'and it says what to do');
});

test('validateCandidate does not invent a second validator', () => {
  // A manifest the SHIPPED validateManifest refuses must be refused here in its
  // own words, or the dialog and discovery disagree about what loads.
  const dir = mkCandidate('alpha', { manifest: manifestFor('alpha', { hostApi: '99' }) });
  const { loader } = mkLoaderWithUserRoot();
  const r = loader.validateCandidate(dir);
  assert.deepStrictEqual(r, { ok: false, error: 'wants hostApi "99" but this host is "1"' });
});

// ════════════════════════════════════════════════════════════════════════════
// registerUserPlugin — a link, and the four refusals before it
// ════════════════════════════════════════════════════════════════════════════

test('registering links the folder into the user root and discovery loads it', () => {
  const dir = mkCandidate('alpha');
  const { loader, userDir } = mkLoaderWithUserRoot();
  const r = loader.registerUserPlugin(dir);
  assert.strictEqual(r.ok, true, `register failed: ${r.error}`);
  assert.strictEqual(r.id, 'alpha');
  assert.strictEqual(r.dir, path.join(userDir, 'alpha'));
  assert.strictEqual(r.target, fs.realpathSync(dir));

  const link = path.join(userDir, 'alpha');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'a LINK, not a copy — the source stays the only copy');
  assert.strictEqual(fs.realpathSync(link), fs.realpathSync(dir));

  const found = loader.discover().filter((rec) => rec.id === 'alpha');
  assert.strictEqual(found.length, 1, 'ENTER: the registered plugin really is discoverable now');
  assert.strictEqual(found[0].root, 'user');
});

test('a registered plugin\'s status row carries where it points; a copied one does not', () => {
  // The renderer must tell a link from a real directory without stat-ing
  // anything, so the distinction has to ride the status row.
  const dir = mkCandidate('alpha');
  const { loader, userDir } = mkLoaderWithUserRoot();
  assert.strictEqual(loader.registerUserPlugin(dir).ok, true);
  fs.mkdirSync(path.join(userDir, 'beta'), { recursive: true });
  fs.writeFileSync(path.join(userDir, 'beta', 'manifest.json'), JSON.stringify(manifestFor('beta')));
  fs.writeFileSync(path.join(userDir, 'beta', 'engine.js'), engineFile);

  const rows = loader.status().plugins;
  assert.deepStrictEqual(rows.map((p) => p.id).sort(), ['alpha', 'beta'],
    'ENTER: both rows are present, so the linkedFrom difference below is between two real rows');
  const byId = Object.fromEntries(rows.map((p) => [p.id, p]));
  assert.strictEqual(byId.alpha.linkedFrom, fs.realpathSync(dir));
  assert.strictEqual(byId.beta.linkedFrom, null, 'a copied-in plugin is not registered and gets no Unregister button');
});

test('registering something already inside the plugins folder is refused', () => {
  const { loader, userDir } = mkLoaderWithUserRoot();
  const inside = path.join(userDir, 'alpha');
  fs.mkdirSync(inside, { recursive: true });
  fs.writeFileSync(path.join(inside, 'manifest.json'), JSON.stringify(manifestFor('alpha')));
  fs.writeFileSync(path.join(inside, 'engine.js'), engineFile);
  const r = loader.registerUserPlugin(inside);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /already inside the plugins folder/);
  assert.ok(fs.statSync(inside).isDirectory(), 'and the directory is untouched — not replaced by a link to itself');
});

test('a second registration of the same id says it is already registered, and where it points', () => {
  const first = mkCandidate('alpha');
  const second = mkCandidate('alpha');
  const { loader, userDir } = mkLoaderWithUserRoot();
  assert.strictEqual(loader.registerUserPlugin(first).ok, true);
  const r = loader.registerUserPlugin(second);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /already registered/);
  assert.ok(r.error.includes(fs.realpathSync(first)),
    'the message names the EXISTING target — otherwise a user cannot tell which copy is live');
  assert.strictEqual(fs.realpathSync(path.join(userDir, 'alpha')), fs.realpathSync(first),
    'the first link still stands; a re-register does not silently repoint it');
});

test('a real directory in the way is a different refusal from an existing link', () => {
  // Distinct on purpose: "already registered" is fixed with Unregister, a real
  // directory in the way is fixed in Finder. One message for both would send the
  // user to a button that refuses them.
  const dir = mkCandidate('alpha');
  const { loader, userDir } = mkLoaderWithUserRoot();
  const squatter = path.join(userDir, 'alpha');
  fs.mkdirSync(squatter, { recursive: true });
  fs.writeFileSync(path.join(squatter, 'keep.txt'), 'not mine to delete');
  const r = loader.registerUserPlugin(dir);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /already exists and is a real directory/);
  assert.ok(!/already registered/.test(r.error), 'and it is NOT the already-registered wording');
  assert.strictEqual(fs.readFileSync(path.join(squatter, 'keep.txt'), 'utf8'), 'not mine to delete');
});

test('an id that collides with a built-in plugin is refused, not merely warned', () => {
  const dir = mkCandidate('alpha');
  const { loader, userDir } = mkLoaderWithUserRoot({ core: 'alpha' });
  assert.ok(loader.discover().some((rec) => rec.id === 'alpha' && rec.root === 'core'),
    'ENTER: the core copy really is discoverable, so the collision below is a real one');
  const r = loader.registerUserPlugin(dir);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /built into Clodex/);
  assert.ok(!fs.existsSync(path.join(userDir, 'alpha')), 'nothing was linked');
});

// ════════════════════════════════════════════════════════════════════════════
// unregisterUserPlugin — removes a link, never a directory
// ════════════════════════════════════════════════════════════════════════════

test('unregistering removes the link and leaves the plugin\'s own folder alone', () => {
  const dir = mkCandidate('alpha');
  const { loader, userDir } = mkLoaderWithUserRoot();
  assert.strictEqual(loader.registerUserPlugin(dir).ok, true);
  assert.deepStrictEqual(loader.unregisterUserPlugin('alpha'), { ok: true, id: 'alpha' });
  assert.ok(!fs.existsSync(path.join(userDir, 'alpha')), 'the link is gone');
  assert.ok(fs.statSync(dir).isDirectory(), 'and the source folder is still there');
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), 'with its contents');
  assert.deepStrictEqual(loader.discover().map((rec) => rec.id), [], 'and it is no longer discovered');
});

test('unregistering a REAL directory is refused and deletes nothing', () => {
  // The irreversible one. A user who copied a plugin in rather than registering
  // it must not lose it to a button, so the guard is lstat, not stat.
  const { loader, userDir } = mkLoaderWithUserRoot();
  const real = path.join(userDir, 'alpha');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'manifest.json'), JSON.stringify(manifestFor('alpha')));
  fs.writeFileSync(path.join(real, 'engine.js'), engineFile);
  assert.ok(loader.discover().some((rec) => rec.id === 'alpha'),
    'ENTER: it is a loadable plugin, i.e. exactly what the dialog would offer a button for');
  const r = loader.unregisterUserPlugin('alpha');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /is a real directory, not a registered link/);
  assert.ok(r.error.includes(real), 'the message names the path so the user can move it by hand');
  assert.ok(fs.existsSync(path.join(real, 'engine.js')), 'and the directory is still on disk');
});

test('unregistering something that is not there, or is not a legal id, is refused', () => {
  const { loader, userDir } = mkLoaderWithUserRoot();
  const absent = loader.unregisterUserPlugin('alpha');
  assert.strictEqual(absent.ok, false);
  assert.match(absent.error, /nothing to unregister/);
  // A traversing id must be refused BEFORE it is joined onto the root, or the
  // unlink below the guard is aimed at whatever the caller named.
  const evil = loader.unregisterUserPlugin('../../etc');
  assert.deepStrictEqual(evil, { ok: false, error: 'invalid plugin id: "../../etc"' });
  assert.ok(fs.existsSync(path.dirname(userDir)), 'the tree above the root is untouched');
});
