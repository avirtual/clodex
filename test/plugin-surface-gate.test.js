'use strict';
// plugin-surface-gate.test.js — a plugin method that mutates the filesystem or
// the repo must not be reachable from an authenticated WEB connection, and the
// gate cannot be the one `enableDrawerServices` uses.
//
// WHY A SECOND MECHANISM WAS NEEDED. The drawer's services are denied on the web
// surface by never registering their channels — web-host builds its handler map
// from the same registrar and dispatches any registered channel BY NAME, so
// absence IS the capability boundary (test/drawer-services-seam.test.js pins it,
// keyed on the `ctl:`/`wterm:`/`drawer:` prefixes). `plugin:invoke` cannot work
// that way: it is ONE multiplexed channel carrying every method of every plugin,
// and it must stay registered because the web renderer's plugin UI rides it. A
// prefix test is therefore structurally blind here — `fs.write` and `fs.read`
// arrive on the same channel name.
//
// So the surface rides the CALL: each transport supplies `surfaceOfSender`
// (main.js → 'desktop', web-host.js → 'web'), `plugin:invoke` passes it to
// `host.dispatch`, and the host refuses a method the manifest has not marked
// `"any"`. Unlisted means desktop-only, so a plugin that says nothing gets the
// restrictive treatment.
//
// THE SHAPE THIS FILE COMMITS TO. Every denial assertion here is paired with the
// same call succeeding on the desktop surface, through the SAME registrar and
// the SAME host. An absence on its own is equally true of a build where the
// method was deleted, renamed, or gated on a flag that is never true anywhere —
// which is the failure mode whose symptom is silence.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PLUGIN_SURFACES, PLUGIN_METHOD_SURFACES, DEFAULT_METHOD_SURFACE,
  methodSurfaceOf, surfaceAllows, NO_SUCH_METHOD, NOT_ON_THIS_SURFACE,
} = require('../plugin-api');
const { validateManifest } = require('../plugin-loader');
const { createPluginLoader } = require('../plugin-loader');
const { createPluginHostEngine } = require('../plugin-host-engine');
const { registerIpcHandlers } = require('../ipc-handlers');

const ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

// ════════════════════════════════════════════════════════════════════════════
// The leaf: two vocabularies, and the untrusted default
// ════════════════════════════════════════════════════════════════════════════

test('a caller surface and a method requirement are different vocabularies', () => {
  // Kept apart on purpose. If a method could require `"web"`, a manifest could
  // declare something the DESKTOP may not call — a shape nothing wants, which
  // would read as a grant to whoever wrote it.
  assert.deepStrictEqual([...PLUGIN_SURFACES], ['desktop', 'web']);
  assert.deepStrictEqual([...PLUGIN_METHOD_SURFACES], ['desktop', 'any']);
  assert.ok(!PLUGIN_METHOD_SURFACES.includes('web'), 'no method may be web-only');
  assert.strictEqual(DEFAULT_METHOD_SURFACE, 'desktop', 'the default is the restrictive one');
});

test('methodSurfaceOf: anything a manifest does not mark "any" is desktop-only', () => {
  const m = { surfaces: { 'fs.read': 'any' } };
  assert.strictEqual(methodSurfaceOf(m, 'fs.read'), 'any', 'ENTER: the table is read at all');
  assert.strictEqual(methodSurfaceOf(m, 'fs.write'), 'desktop', 'a method the table omits');
  assert.strictEqual(methodSurfaceOf({}, 'fs.read'), 'desktop', 'a manifest with no table');
  assert.strictEqual(methodSurfaceOf(undefined, 'fs.read'), 'desktop', 'no manifest at all');
  // A method NAMED like the wrong vocabulary is not a grant. Only the exact
  // string 'any' opens a method, so a typo'd or hostile value fails closed.
  assert.strictEqual(methodSurfaceOf({ surfaces: { x: 'web' } }, 'x'), 'desktop');
  assert.strictEqual(methodSurfaceOf({ surfaces: { x: true } }, 'x'), 'desktop');
  assert.strictEqual(methodSurfaceOf({ surfaces: { x: 'ANY' } }, 'x'), 'desktop');
  // `surfaces` is read as a plain lookup table, so an inherited Object.prototype
  // key must not answer for a method nobody declared.
  assert.strictEqual(methodSurfaceOf({ surfaces: {} }, 'constructor'), 'desktop');
  assert.strictEqual(methodSurfaceOf({ surfaces: {} }, 'toString'), 'desktop');
});

test('surfaceAllows: an unknown caller is untrusted, not trusted', () => {
  // The defect being fixed IS "the caller is unknown, so let it through" —
  // dispatch used to discard the caller entirely. A transport that forgets to
  // declare itself must land in the restricted branch.
  assert.strictEqual(surfaceAllows('desktop', 'desktop'), true);
  assert.strictEqual(surfaceAllows('desktop', 'any'), true);
  assert.strictEqual(surfaceAllows('web', 'any'), true, 'ENTER: web is not denied wholesale');
  assert.strictEqual(surfaceAllows('web', 'desktop'), false);
  for (const bogus of [undefined, null, '', 'DESKTOP', 'local', 0, true, {}]) {
    assert.strictEqual(surfaceAllows(bogus, 'desktop'), false,
      `caller ${JSON.stringify(bogus)} must not reach a desktop-only method`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// The manifest field is validated at LOAD time
// ════════════════════════════════════════════════════════════════════════════

test('a malformed `surfaces` is refused by name rather than silently ignored', () => {
  const base = { id: 'demo', hostApi: '1', entry: { engine: 'engine.js' } };
  assert.strictEqual(validateManifest({ ...base }, 'demo'), null,
    'ENTER: the base manifest is otherwise valid, so the failures below are the field');
  assert.strictEqual(validateManifest({ ...base, surfaces: { 'a.b': 'any' } }, 'demo'), null,
    'a well-formed table loads');
  // A typo fails CLOSED — the method quietly stops working on the web surface.
  // A named refusal at load time is the only thing that reaches the author.
  assert.match(validateManifest({ ...base, surfaces: { 'a.b': 'web' } }, 'demo') || '',
    /invalid surface for method "a\.b"/);
  assert.match(validateManifest({ ...base, surfaces: { 'a.b': true } }, 'demo') || '',
    /invalid surface for method/);
  assert.match(validateManifest({ ...base, surfaces: ['a.b'] }, 'demo') || '',
    /must be an object/, 'an array is not a table');
  assert.match(validateManifest({ ...base, surfaces: 'any' }, 'demo') || '',
    /must be an object/, 'nor is a bare string');
});

// ════════════════════════════════════════════════════════════════════════════
// End to end: the REAL plugins, the REAL registrar, both surfaces
// ════════════════════════════════════════════════════════════════════════════

// The two transports differ in exactly one dep. Everything else — the registrar,
// the plugin host, the loader, the session — is shared, so a difference in
// outcome below can only come from the surface.
//
// `enabled` is seeded rather than left to `enabledByDefault`, so a plugin the
// operator would have to switch on (memory-viewer, tickets-viewer) still loads
// here — the annotation audit below has to see every shipped plugin's rows, not
// only the default-on ones.
function bootBothSurfaces() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-surface-gate-'));
  const cwd = path.join(dir, 'seat-cwd');
  fs.mkdirSync(cwd, { recursive: true });

  // Intent rows live in a MODULE-level table, so a plugin that contributes a
  // verb (git-branches) fails to activate on the second boot in this file with
  // EVERBTAKEN — and would then be silently missing from the dispatch map every
  // assertion below reads. Same sweep plugin-kill-switch.test.js uses.
  const { unregisterSource } = require('../intent-registry');
  const pluginIds = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  for (const id of pluginIds) unregisterSource(id);

  let ui = { plugins: { enabled: pluginIds } };
  const getUiSettings = () => ({ get: () => ui, set: (patch) => { ui = { ...ui, ...patch }; } });
  const seat = { name: 'seat', type: 'claude', cwd, workspaceId: 'ws-1' };
  const sessions = new Map([[seat.name, seat]]);
  const manager = {
    sessions,
    list: () => [...sessions.values()],
    listForWorkspace: () => [...sessions.values()],
    _broadcast: () => {}, _sendToSession: () => {}, windowForWorkspace: () => null,
    _injectText: () => {},
  };
  const loader = createPluginLoader({
    fs, path,
    pluginsDir: PLUGINS_DIR,
    getUiSettings,
    log: { info: () => {} },
    requireModule: (p) => require(p),
  });
  const host = createPluginHostEngine({
    manager, getUiSettings, log: { info: () => {} },
    userDataPath: dir, fs, path,
    gitWorktree: {
      listWorktrees: () => ({ ok: true, worktrees: [] }),
      removeWorktree: () => ({ ok: true }),
      createWorktree: () => ({ ok: true }),
    },
    telemetrySnapshot: () => null,
    getLoader: () => loader,
  });
  const loaded = loader.loadAll(host);
  const failed = loaded.filter((r) => !r.ok || r.skipped);
  assert.deepStrictEqual(failed, [],
    `every shipped plugin must activate here, or the audit below reads a truncated dispatch map: ${JSON.stringify(failed)}`);

  // One registrar, run twice, differing ONLY in surfaceOfSender — the same
  // construction the two real transports use.
  const registrarFor = (surface) => {
    const handlers = new Map();
    const stub = () => () => {};
    const deps = new Proxy({
      handle: (ch, fn) => handlers.set(ch, fn),
      on: (ch, fn) => handlers.set(ch, fn),
      getPluginHost: () => host,
      surfaceOfSender: () => surface,
      log: { info() {}, error() {} },
    }, { get(t, p) { return p in t ? t[p] : stub(); } });
    registerIpcHandlers(deps);
    return (pluginId, method, args) => handlers.get('plugin:invoke')({}, pluginId, method, args);
  };

  return {
    cwd,
    host,
    desktop: registrarFor('desktop'),
    web: registrarFor('web'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('an authenticated web connection cannot write a file through the workbench', async () => {
  const b = bootBothSurfaces();
  try {
    assert.ok(b.host._dispatchKeys().includes('workbench:fs.write'),
      'ENTER: the workbench really loaded and fs.write is in the dispatch map — otherwise the refusal below is about nothing');

    const target = path.join(b.cwd, 'owned.txt');
    const denied = await b.web('workbench', 'fs.write', ['seat', 'owned.txt', 'from the web']);
    assert.deepStrictEqual(denied, { ok: false, error: NOT_ON_THIS_SURFACE },
      'the web surface is refused, in the existing envelope shape');
    assert.ok(!fs.existsSync(target), 'and nothing was written — the refusal is before the handler, not after');

    // The other half, and it is not optional: the absence above is also true of
    // a build where fs.write was deleted or was gated on a flag nothing sets.
    const allowed = await b.desktop('workbench', 'fs.write', ['seat', 'owned.txt', 'from the desktop']);
    assert.deepStrictEqual(allowed, { ok: true, size: Buffer.byteLength('from the desktop') },
      'the SAME registrar and host serve the write on the desktop surface');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'from the desktop',
      'the file really exists, so the denial above denied something real');
  } finally { b.cleanup(); }
});

test('every mutating workbench method is denied on web and served on desktop', async () => {
  // Per method, not spot-checked: one unguarded row is the whole defect, and a
  // sample would not find it. Args are shaped enough to reach the handler; what
  // is asserted about the desktop call is only that it is NOT the surface
  // refusal — the rows' own behaviour is pinned in workbench-plugin.test.js.
  const MUTATORS = [
    ['fs.write', ['seat', 'x.txt', 'x']],
    ['scm.stage', ['seat', ['x.txt']]],
    ['scm.unstage', ['seat', ['x.txt']]],
    ['scm.discard', ['seat', 'x.txt']],
    ['scm.commit', ['seat', 'msg']],
    ['scm.checkout', ['seat', 'main']],
    ['scm.remote', ['seat', 'push']],
    ['wt.create', ['/repo', 'feature']],
    ['wt.remove', ['/repo/wt']],
    ['wt.apply', ['seat', null]],
  ];
  const b = bootBothSurfaces();
  try {
    const keys = b.host._dispatchKeys();
    for (const [method, args] of MUTATORS) {
      assert.ok(keys.includes(`workbench:${method}`),
        `ENTER: workbench:${method} is registered, so the pair below is real`);
      assert.deepStrictEqual(await b.web('workbench', method, args),
        { ok: false, error: NOT_ON_THIS_SURFACE }, `${method} must be denied on the web surface`);
      const onDesktop = await b.desktop('workbench', method, args);
      assert.notDeepStrictEqual(onDesktop, { ok: false, error: NOT_ON_THIS_SURFACE },
        `${method} must still be served on the desktop surface`);
    }
  } finally { b.cleanup(); }
});

test('the read-only workbench methods still serve the web renderer', async () => {
  // The gate is not "web gets no plugins". Without this, deleting the `surfaces`
  // table entirely — breaking the web workbench outright — would pass every
  // denial assertion in this file.
  const b = bootBothSurfaces();
  try {
    const listed = await b.web('workbench', 'fs.list', ['seat', '']);
    assert.strictEqual(listed.ok, true, 'fs.list is marked "any" and answers on the web surface');
    const read = await b.web('workbench', 'scm.status', ['seat']);
    assert.notDeepStrictEqual(read, { ok: false, error: NOT_ON_THIS_SURFACE },
      'scm.status reaches its handler (whatever git then says about a non-repo)');
  } finally { b.cleanup(); }
});

test('the refusal is not an oracle: an unknown method answers NO_SUCH_METHOD on both surfaces', async () => {
  // The surface check sits AFTER the existence check for this reason. If it did
  // not, the two refusals would differ for a method that does not exist, and the
  // web surface could enumerate the desktop-only method names by probing.
  const b = bootBothSurfaces();
  try {
    for (const call of [b.web, b.desktop]) {
      assert.deepStrictEqual(await call('workbench', 'fs.wriite', ['seat']),
        { ok: false, error: NO_SUCH_METHOD }, 'a near-miss of a gated name');
      assert.deepStrictEqual(await call('workbench', 'fs.destroyEverything', []),
        { ok: false, error: NO_SUCH_METHOD });
      assert.deepStrictEqual(await call('no-such-plugin', 'fs.write', []),
        { ok: false, error: NO_SUCH_METHOD });
    }
  } finally { b.cleanup(); }
});

test('the _host pseudo-plugin stays reachable from the web surface', async () => {
  // Deliberately ungated: this is the plugin SUBSYSTEM's own plumbing, and the
  // web renderer's plugin UI cannot activate a single plugin without it. Pinned
  // so the exemption is a decision on the record rather than an oversight.
  const b = bootBothSurfaces();
  try {
    const status = await b.web('_host', 'plugins.status', []);
    assert.strictEqual(status.ok, true, 'plugins.status answers');
    const info = await b.web('_host', 'renderer.info', ['workbench']);
    assert.strictEqual(info.ok, true, 'and so does the renderer half + stylesheet read');
  } finally { b.cleanup(); }
});

test('_host exempts exactly these eight methods, and no ninth by inheritance', () => {
  // The exemption is a WHOLE-TABLE early return, so a method added to
  // hostMethods is web-reachable the moment it is written, with nothing to edit
  // and nothing to notice. Same argument as the workbench `"any"` literal below:
  // the dangerous direction is widening, so widening must touch a test.
  const HOST_UNGATED = [
    'plugins.listUserRoot', 'plugins.rescan', 'plugins.status', 'plugins.userRoot',
    'renderer.info', 'renderer.report',
    'settings.get', 'settings.set',
  ];
  const b = bootBothSurfaces();
  try {
    const names = b.host._hostMethodNames().slice().sort();
    assert.deepStrictEqual(names, HOST_UNGATED,
      'a new _host method is reachable from an authenticated browser — argue for it here');
  } finally { b.cleanup(); }
});

// ════════════════════════════════════════════════════════════════════════════
// The transports supply the value — the gate is worthless if they do not
// ════════════════════════════════════════════════════════════════════════════

test('web-host hands the registrar surfaceOfSender → "web"', () => {
  const { createWebHost } = require('../web-host');
  let seen = null;
  const host = createWebHost({
    engine: { stores: {} },
    log: { info() {}, warn() {}, error() {} },
    port: 0,
    host: '127.0.0.1',
    userDataPath: os.tmpdir(),
    registerHandlers: (deps) => { seen = deps; },
  });
  try {
    assert.ok(seen, 'registerHandlers ran — otherwise every assertion below is vacuous');
    assert.ok('surfaceOfSender' in seen, 'the dep must be present, not absent');
    assert.strictEqual(typeof seen.surfaceOfSender, 'function');
    assert.strictEqual(seen.surfaceOfSender({}), 'web', 'and it must not claim the desktop');
  } finally { host.close(); }
});

test('main.js hands the registrar surfaceOfSender → "desktop"', () => {
  // main.js needs an app, a window and a PTY, so its dep is pinned at source —
  // the same treatment test/plugin-kill-switch.test.js gives engine.js's
  // bootstrap branch. Without it, a desktop that supplies nothing would fail
  // closed and silently break the workbench in the real app while every
  // assertion above stayed green.
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(src, /surfaceOfSender:\s*\(\)\s*=>\s*'desktop'/,
    'main.js must declare its registrar as the desktop surface');
});

// ════════════════════════════════════════════════════════════════════════════
// The permissive set is a literal, in the direction that can go wrong
// ════════════════════════════════════════════════════════════════════════════

function manifestOf(id) {
  return JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, id, 'manifest.json'), 'utf8'));
}

test('the workbench opens exactly these methods to the web surface', () => {
  // Pinned as a literal because the DANGEROUS edit is widening, not omitting: a
  // new method that nobody annotates is desktop-only already, so it needs no
  // guard, while a new `"any"` row hands the web surface reach and is exactly
  // the change that should have to edit a test to land.
  const WEB_REACHABLE = [
    'fs.find', 'fs.list', 'fs.read',
    'scm.branches', 'scm.diff', 'scm.status',
    'wt.list', 'wt.selected',
  ];
  const surfaces = manifestOf('workbench').surfaces || {};
  const open = Object.entries(surfaces).filter(([, v]) => v === 'any').map(([k]) => k).sort();
  assert.deepStrictEqual(open, WEB_REACHABLE,
    'a change here widens or narrows what an authenticated browser can call — say so in the changelog');
});

test('no manifest opens a method that does not exist', () => {
  // A typo in the table fails CLOSED, which is safe and therefore silent: the
  // author sees a method that mysteriously does not work on the web. Checked
  // against the REAL dispatch map, so it cannot drift from what loaded.
  const b = bootBothSurfaces();
  try {
    const keys = new Set(b.host._dispatchKeys());
    assert.ok(keys.size > 10, `ENTER: ${keys.size} dispatch keys — the map is real`);
    const bogus = [];
    for (const ent of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      let m;
      try { m = manifestOf(ent.name); } catch { continue; }
      for (const method of Object.keys(m.surfaces || {})) {
        if (!keys.has(`${m.id}:${method}`)) bogus.push(`${m.id}:${method}`);
      }
    }
    assert.deepStrictEqual(bogus, [],
      'a manifest names a method the plugin never registers — a typo that silently denies it on the web');
  } finally { b.cleanup(); }
});
