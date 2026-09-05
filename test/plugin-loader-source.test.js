'use strict';
// plugin-loader-source.test.js — resolveSource/installFromSource/resolveUpdate/
// applyUpdate/removeSourcePlugin (t683, plugins/plugin-sources.md §9), driven
// through the REAL loader against a tmp user root and a tmp core root. The
// network is stubbed (an injected `https` that serves a REAL tarball this file
// builds with system tar); `execFile` is the REAL child_process one, since
// exercising `tar -xzf` itself is the point of extractPlugin. The operator's
// real ~/.clodex/plugins is never touched — every root here is a fresh tmpdir.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFile: realExecFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

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

// Builds a real .tar.gz whose single top-level dir is `owner-repo-<sha>` and
// whose content is the given plugin manifest/files — the exact shape a GitHub
// tarball has. Returns the tarball's bytes.
function buildTarballBytes(sha, id, extraFiles = {}) {
  const stage = mkTmpRoot('clodex-loader-source-stage-');
  const topDirName = `owner-repo-${sha}`;
  const topDir = path.join(stage, topDirName);
  fs.mkdirSync(topDir, { recursive: true });
  fs.writeFileSync(path.join(topDir, 'manifest.json'), JSON.stringify(manifestFor(id)));
  fs.writeFileSync(path.join(topDir, 'engine.js'), engineFile);
  for (const [rel, body] of Object.entries(extraFiles)) {
    const full = path.join(topDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  const tarFile = path.join(stage, 'out.tar.gz');
  const r = require('node:child_process').execFileSync('tar', ['-czf', tarFile, '-C', stage, topDirName]);
  void r;
  return fs.readFileSync(tarFile);
}

// Same shape, but the plugin sits under `subpathRel` inside the top-level dir
// — the clodex-plugins collection-repo case, where one repo holds many plugin
// folders and the spec names one with `owner/repo:sub/path`.
function buildCollectionTarballBytes(sha, subpathRel, id) {
  const stage = mkTmpRoot('clodex-loader-source-stage-');
  const topDirName = `owner-repo-${sha}`;
  const pluginDir = path.join(stage, topDirName, subpathRel);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifestFor(id)));
  fs.writeFileSync(path.join(pluginDir, 'engine.js'), engineFile);
  const tarFile = path.join(stage, 'out.tar.gz');
  require('node:child_process').execFileSync('tar', ['-czf', tarFile, '-C', stage, topDirName]);
  return fs.readFileSync(tarFile);
}

// A caller-supplied SCRIPT of what each successive tarball fetch should
// return, so a test can drive resolveSource then installFromSource then a
// resolveUpdate with a DIFFERENT sha, in sequence. commitSha (the
// `commits/<ref>` API call) is stubbed to fail (resolve null) unless a script
// step opts in — most subjects don't need the full-sha path, only that
// `commitFull` is honestly false when it is unavailable.
function mkHttpsStub(script, commitsUrls) {
  let i = 0;
  return {
    get(url, opts, cb) {
      const req = new EventEmitter();
      req.on = req.on.bind(req);
      req.setTimeout = () => req;
      if (/\/commits\//.test(url)) {
        if (Array.isArray(commitsUrls)) commitsUrls.push(url);
        // No commits API stub configured — behave like an offline/failed
        // lookup, which fetchCommitSha treats as "keep the abbreviated sha".
        const res = new EventEmitter();
        res.statusCode = 404;
        res.resume = () => {};
        setImmediate(() => cb(res));
        return req;
      }
      const step = script[Math.min(i, script.length - 1)];
      i++;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      res.resume = () => {};
      res.pipe = (dest) => {
        dest.write(step.bytes);
        dest.end();
        return dest;
      };
      setImmediate(() => cb(res));
      return req;
    },
  };
}

function mkSourceLoader({ script, coreIds = [], commitsUrls } = {}) {
  const base = mkTmpRoot('clodex-loader-source-');
  const coreDir = path.join(base, 'core');
  const userDir = path.join(base, 'plugins');
  fs.mkdirSync(coreDir, { recursive: true });
  for (const id of coreIds) {
    const d = path.join(coreDir, id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(manifestFor(id)));
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
    https: mkHttpsStub(script, commitsUrls),
    execFile: realExecFile,
  });
  return { loader, userDir, coreDir, getUi: () => ui };
}

// ════════════════════════════════════════════════════════════════════════════
// resolveSource — network + temp writes only, never touches <userRoot>/<id>
// ════════════════════════════════════════════════════════════════════════════

test('resolveSource fetches and validates without writing to the user root', async () => {
  const bytes = buildTarballBytes('abc1234', 'demo');
  const { loader, userDir } = mkSourceLoader({ script: [{ bytes }] });
  const r = await loader.resolveSource('owner/repo');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.repo, 'owner/repo');
  assert.strictEqual(r.commit, 'abc1234');
  assert.strictEqual(r.commitFull, false, 'the commits API was not stubbed, so only the abbreviated sha is known');
  assert.strictEqual(r.manifest.id, 'demo');
  assert.ok(!fs.existsSync(userDir), 'resolveSource never creates the user root');
});

test('resolveSource refuses a spec parseSourceSpec refuses, before any network call', async () => {
  const { loader } = mkSourceLoader({ script: [] });
  const r = await loader.resolveSource('not a spec');
  assert.strictEqual(r.ok, false);
});

test('resolveSource asks the commits API for the EXTRACTED commit, never the caller ref (t683 nit a)', async () => {
  const bytes = buildTarballBytes('abc1234', 'demo');
  const commitsUrls = [];
  const { loader } = mkSourceLoader({ script: [{ bytes }], commitsUrls });
  const r = await loader.resolveSource('owner/repo@main');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(commitsUrls.length, 1);
  assert.ok(commitsUrls[0].endsWith('/commits/abc1234'),
    `expected the commits lookup to use the extracted sha abc1234, got ${commitsUrls[0]}`);
});

test('installFromSource follows a collection-repo subpath to the right plugin folder', async () => {
  const bytes = buildCollectionTarballBytes('cc00001', 'plugins/foo', 'foo');
  const { loader, userDir } = mkSourceLoader({ script: [{ bytes }] });
  const r = await loader.installFromSource('owner/repo:plugins/foo');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.id, 'foo');
  assert.ok(fs.existsSync(path.join(userDir, 'foo', 'manifest.json')));
  const sidecar = JSON.parse(fs.readFileSync(path.join(userDir, 'foo', '.clodex-source.json'), 'utf8'));
  assert.strictEqual(sidecar.subpath, 'plugins/foo');
});

// ════════════════════════════════════════════════════════════════════════════
// installFromSource
// ════════════════════════════════════════════════════════════════════════════

test('installFromSource writes the sidecar, registers DISABLED, and rescans', async () => {
  const bytes = buildTarballBytes('abc1234', 'demo');
  const { loader, userDir, getUi } = mkSourceLoader({ script: [{ bytes }] });
  const r = await loader.installFromSource('owner/repo@main');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.id, 'demo');
  assert.strictEqual(r.commit, 'abc1234');
  assert.ok(fs.existsSync(path.join(userDir, 'demo', 'manifest.json')), 'the plugin dir was placed');
  const sidecar = JSON.parse(fs.readFileSync(path.join(userDir, 'demo', '.clodex-source.json'), 'utf8'));
  assert.strictEqual(sidecar.repo, 'owner/repo');
  assert.strictEqual(sidecar.ref, 'main');
  assert.strictEqual(sidecar.commit, 'abc1234');
  assert.strictEqual(sidecar.hostVersion, HOST_API_VERSION, 't683 nit f: the sidecar names the host version');
  // Registered DISABLED regardless of enabledByDefault (the manifest here has
  // no enabledByDefault at all, so it defaults true — installFromSource must
  // override that, not merely leave it unset).
  assert.deepStrictEqual(getUi().plugins.enabled, [], 'the enabled list now explicitly excludes the new plugin');
  const discovered = loader.discover().find((rec) => rec.id === 'demo');
  assert.ok(discovered, 'ENTER: discovery really sees the installed plugin');
  assert.strictEqual(loader.isEnabled(discovered), false);
});

test('installFromSource removes the placed dir and never enables it when writeSidecar fails (t683 MUST-FIX 3)', async () => {
  const bytes = buildTarballBytes('abc1234', 'demo');
  const { loader, userDir, getUi } = mkSourceLoader({ script: [{ bytes }] });
  const target = path.join(userDir, 'demo');
  const sidecarFile = path.join(target, '.clodex-source.json');
  const realWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function patched(file, ...rest) {
    if (String(file).startsWith(`${sidecarFile}.tmp-`)) {
      throw new Error('injected sidecar-write failure');
    }
    return realWriteFileSync(file, ...rest);
  };
  let r;
  try {
    r = await loader.installFromSource('owner/repo@main');
  } finally {
    fs.writeFileSync = realWriteFileSync;
  }
  assert.strictEqual(r.ok, false);
  assert.ok(!fs.existsSync(target), 'the placed dir was rolled back, not left live with no sidecar');
  const enabled = (getUi().plugins || {}).enabled;
  assert.ok(!Array.isArray(enabled) || !enabled.includes('demo'),
    'the plugin was never added to the enabled list — it cannot come back ENABLED at next restart');
});

test('installFromSource refuses a core id and leaves the user root untouched', async () => {
  const bytes = buildTarballBytes('abc1234', 'workbench');
  const { loader, userDir } = mkSourceLoader({ script: [{ bytes }], coreIds: ['workbench'] });
  const r = await loader.installFromSource('owner/repo');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /built into Clodex/);
  assert.ok(!fs.existsSync(path.join(userDir, 'workbench')), 'nothing was written to the user root');
});

test('installFromSource refuses an existing real directory without a sidecar, byte-identical after', async () => {
  const bytes = buildTarballBytes('abc1234', 'demo');
  const { loader, userDir } = mkSourceLoader({ script: [{ bytes }] });
  fs.mkdirSync(path.join(userDir, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(userDir, 'demo', 'manifest.json'), JSON.stringify(manifestFor('demo', { version: '9.9.9' })));
  fs.writeFileSync(path.join(userDir, 'demo', 'engine.js'), 'module.exports.activate = () => { throw new Error("mine"); };');
  const before = fs.readFileSync(path.join(userDir, 'demo', 'engine.js'), 'utf8');
  const r = await loader.installFromSource('owner/repo');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not from a source/);
  assert.strictEqual(fs.readFileSync(path.join(userDir, 'demo', 'engine.js'), 'utf8'), before,
    'the user directory is untouched, byte for byte');
});

test('installFromSource refuses a symlinked id, naming it as registered', async () => {
  const bytes = buildTarballBytes('abc1234', 'demo');
  const { loader, userDir } = mkSourceLoader({ script: [{ bytes }] });
  const elsewhere = mkTmpRoot('clodex-loader-source-elsewhere-');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.symlinkSync(elsewhere, path.join(userDir, 'demo'), 'dir');
  const r = await loader.installFromSource('owner/repo');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /registered link/);
});

test('installFromSource refuses on a candidate that fails validateCandidate, leaving no temp dir behind', async () => {
  const stage = mkTmpRoot('clodex-loader-source-stage-');
  const topDir = path.join(stage, 'owner-repo-bad0001');
  fs.mkdirSync(topDir, { recursive: true });
  fs.writeFileSync(path.join(topDir, 'manifest.json'), '{ not json');
  const tarFile = path.join(stage, 'out.tar.gz');
  require('node:child_process').execFileSync('tar', ['-czf', tarFile, '-C', stage, 'owner-repo-bad0001']);
  const bytes = fs.readFileSync(tarFile);
  const { loader, userDir } = mkSourceLoader({ script: [{ bytes }] });
  const before = fs.readdirSync(require('node:os').tmpdir())
    .filter((n) => n.startsWith('clodex-plugin-fetch-'));
  const r = await loader.installFromSource('owner/repo');
  assert.strictEqual(r.ok, false);
  assert.ok(!fs.existsSync(userDir) || fs.readdirSync(userDir).length === 0, 'nothing landed in the user root');
  const after = fs.readdirSync(require('node:os').tmpdir())
    .filter((n) => n.startsWith('clodex-plugin-fetch-'));
  assert.deepStrictEqual(after.filter((n) => !before.includes(n)), [], 'the temp fetch dir was removed on failure');
});

// ════════════════════════════════════════════════════════════════════════════
// resolveUpdate / applyUpdate
// ════════════════════════════════════════════════════════════════════════════

test('resolveUpdate refuses without a sidecar', async () => {
  const { loader, userDir } = mkSourceLoader({ script: [] });
  fs.mkdirSync(path.join(userDir, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(userDir, 'demo', 'manifest.json'), JSON.stringify(manifestFor('demo')));
  const r = await loader.resolveUpdate('demo');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not installed from a source/);
});

test('resolveUpdate re-fetches at the SIDECAR ref and reports both shas', async () => {
  const installBytes = buildTarballBytes('abc1234', 'demo');
  const updateBytes = buildTarballBytes('def5678', 'demo');
  const { loader } = mkSourceLoader({ script: [{ bytes: installBytes }, { bytes: updateBytes }] });
  const installed = await loader.installFromSource('owner/repo@main');
  assert.strictEqual(installed.ok, true, JSON.stringify(installed));
  const r = await loader.resolveUpdate('demo');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.previousCommit, 'abc1234');
  assert.strictEqual(r.commit, 'def5678');
  assert.strictEqual(r.changed, true);
});

test('resolveUpdate treats an abbreviated sha as unchanged against its own full sha (t683 nit a)', async () => {
  // Install with the commits API failing (sidecar keeps the ABBREVIATED sha),
  // then resolveUpdate against a commits API that this time succeeds and
  // reports the FULL sha of the very same commit — a naive `!==` would call
  // this "changed" on length alone.
  const FULL = 'abc1234567890123456789012345678901234567';
  const bytes = buildTarballBytes('abc1234', 'demo');
  let commitsCall = 0;
  const httpsStub = {
    get(url, opts, cb) {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      if (/\/commits\//.test(url)) {
        commitsCall++;
        const res = new EventEmitter();
        res.resume = () => {};
        if (commitsCall === 1) {
          res.statusCode = 404;
          setImmediate(() => cb(res));
        } else {
          res.statusCode = 200;
          setImmediate(() => {
            cb(res);
            res.emit('data', Buffer.from(JSON.stringify({ sha: FULL })));
            res.emit('end');
          });
        }
        return req;
      }
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      res.resume = () => {};
      res.pipe = (dest) => { dest.write(bytes); dest.end(); return dest; };
      setImmediate(() => cb(res));
      return req;
    },
  };
  const base = mkTmpRoot('clodex-loader-source-');
  const userDir = path.join(base, 'plugins');
  let ui = {};
  const loader = createPluginLoader({
    fs, path,
    roots: [{ id: 'user', dir: userDir, label: 'User' }],
    getUiSettings: () => ({ get: () => ui, set: (patch) => { ui = { ...ui, ...patch }; } }),
    log: { info: () => {} },
    requireModule: (p) => require(p),
    https: httpsStub,
    execFile: realExecFile,
  });
  const installed = await loader.installFromSource('owner/repo@main');
  assert.strictEqual(installed.ok, true, JSON.stringify(installed));
  assert.strictEqual(installed.commit, 'abc1234', 'ENTER: install kept the abbreviated sha');
  const r = await loader.resolveUpdate('demo');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.commit, FULL);
  assert.strictEqual(r.changed, false, 'the full sha is the same commit as the abbreviated one — not changed');
});

test('applyUpdate refuses a sha mismatch against the commit the caller accepted', async () => {
  const installBytes = buildTarballBytes('abc1234', 'demo');
  const updateBytes = buildTarballBytes('def5678', 'demo');
  const { loader, userDir } = mkSourceLoader({ script: [{ bytes: installBytes }, { bytes: updateBytes }] });
  await loader.installFromSource('owner/repo@main');
  const before = fs.readFileSync(path.join(userDir, 'demo', 'manifest.json'), 'utf8');
  const r = await loader.applyUpdate('demo', 'not-the-real-sha');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not the.*you accepted/);
  assert.strictEqual(fs.readFileSync(path.join(userDir, 'demo', 'manifest.json'), 'utf8'), before,
    'the installed copy is untouched by a refused update');
});

test('applyUpdate accepts an abbreviated-vs-full commit match, not just an exact string (t683 r2 nit)', async () => {
  const installBytes = buildTarballBytes('abc1234', 'demo');
  const updateBytes = buildTarballBytes('def5678', 'demo');
  const { loader } = mkSourceLoader({ script: [{ bytes: installBytes }, { bytes: updateBytes }] });
  await loader.installFromSource('owner/repo@main');
  // Accept the FULL-length form of the same commit the fetch will resolve to
  // the abbreviated 'def5678' — a strict !== would wrongly refuse this.
  const full = 'def5678900000000000000000000000000000000';
  const r = await loader.applyUpdate('demo', full);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('applyUpdate replaces the copy in place, keeps enable state, and updates the sidecar', async () => {
  const installBytes = buildTarballBytes('abc1234', 'demo');
  const updateBytes = buildTarballBytes('def5678', 'demo', { 'NEWFILE.txt': 'v2' });
  const { loader, userDir } = mkSourceLoader({ script: [{ bytes: installBytes }, { bytes: updateBytes }] });
  await loader.installFromSource('owner/repo@main');
  const resolved = await loader.resolveUpdate('demo');
  const r = await loader.applyUpdate('demo', resolved.commit);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.previousCommit, 'abc1234');
  assert.strictEqual(r.commit, 'def5678');
  assert.ok(fs.existsSync(path.join(userDir, 'demo', 'NEWFILE.txt')), 'the new copy is in place');
  const sidecar = JSON.parse(fs.readFileSync(path.join(userDir, 'demo', '.clodex-source.json'), 'utf8'));
  assert.strictEqual(sidecar.commit, 'def5678');
  const discovered = loader.discover().find((rec) => rec.id === 'demo');
  assert.strictEqual(loader.isEnabled(discovered), false, 'update never flips enable state either way');
  const leftovers = fs.readdirSync(userDir).filter((n) => n.startsWith('.old-demo-'));
  assert.deepStrictEqual(leftovers, [], 'the moved-aside old copy was removed after success');
});

test('applyUpdate restores the old copy when the swap fails after move-aside', async () => {
  const installBytes = buildTarballBytes('abc1234', 'demo');
  const { loader, userDir } = mkSourceLoader({ script: [{ bytes: installBytes }, { bytes: installBytes }] });
  await loader.installFromSource('owner/repo@main');
  const before = fs.readFileSync(path.join(userDir, 'demo', 'manifest.json'), 'utf8');
  const target = path.join(userDir, 'demo');
  // Force ONLY the rename-in leg to fail: the one whose destination is the
  // final target path itself (the manifest-id rename inside fetchAndValidate
  // renames INTO the fetch tmp dir, never to `target`, so it is unaffected).
  const realRename = fs.renameSync;
  fs.renameSync = function patched(from, to) {
    if (to === target && String(from).includes('clodex-plugin-fetch-')) {
      throw new Error('injected failure');
    }
    return realRename(from, to);
  };
  try {
    const resolved = await loader.resolveUpdate('demo');
    const r = await loader.applyUpdate('demo', resolved.commit);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /old copy was restored/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.strictEqual(fs.readFileSync(path.join(userDir, 'demo', 'manifest.json'), 'utf8'), before,
    'the old copy is back in place, byte for byte');
  const leftovers = fs.readdirSync(userDir).filter((n) => n.startsWith('.old-demo-'));
  assert.deepStrictEqual(leftovers, [], 'no stray moved-aside directory left behind');
});

test('applyUpdate restores the old copy when writeSidecar fails AFTER the rename-in succeeds', async () => {
  // Distinct from the rename-in failure above: here the new copy has already
  // landed at `target` (rename-in succeeded) before the failure hits, so the
  // catch must first clear the occupied target before renaming the old copy
  // back — the exact ENOTEMPTY hole review round 1 found. The install and
  // update tarballs must differ (a marker file), or "the old manifest is
  // back" cannot tell the old copy from the new one — only the `.old-*`
  // leftover assertion would carry the red.
  const installBytes = buildTarballBytes('abc1234', 'demo');
  const updateBytes = buildTarballBytes('def5678', 'demo', { 'NEWFILE.txt': 'v2' });
  const { loader, userDir } = mkSourceLoader({ script: [{ bytes: installBytes }, { bytes: updateBytes }] });
  await loader.installFromSource('owner/repo@main');
  const before = fs.readFileSync(path.join(userDir, 'demo', 'manifest.json'), 'utf8');
  const target = path.join(userDir, 'demo');
  const sidecarFile = path.join(target, '.clodex-source.json');
  const realWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function patched(file, ...rest) {
    if (String(file).startsWith(`${sidecarFile}.tmp-`)) {
      throw new Error('injected sidecar-write failure');
    }
    return realWriteFileSync(file, ...rest);
  };
  try {
    const resolved = await loader.resolveUpdate('demo');
    const r = await loader.applyUpdate('demo', resolved.commit);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /old copy was restored/);
  } finally {
    fs.writeFileSync = realWriteFileSync;
  }
  assert.ok(fs.existsSync(target), 'the old copy is back at target');
  assert.strictEqual(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'), before,
    'the old manifest is back, byte for byte');
  assert.ok(!fs.existsSync(path.join(target, 'NEWFILE.txt')),
    'the new copy did not win — its marker file is absent');
  const leftovers = fs.readdirSync(userDir).filter((n) => n.startsWith('.old-demo-'));
  assert.deepStrictEqual(leftovers, [], 'no stray moved-aside directory left behind');
});

function fakePluginHost() {
  const live = new Set();
  const updateBundleCalls = [];
  return {
    updateBundleCalls,
    register(id) { live.add(String(id)); },
    catalog() { return [...live].map((id) => ({ id })); },
    deactivate(id) { live.delete(String(id)); },
    updateBundle(...args) { updateBundleCalls.push(args); },
  };
}

test('applyUpdate on a loaded plugin leaves it restart-required even at the SAME version (t683 r2 MUST-FIX)', async () => {
  // A commit-pinned update very often carries the SAME manifest.version — the
  // whole reason the design pins by sha rather than version (a branch moves
  // without a bump). rescan's moved-dir/moved-version check alone would miss
  // this and pair fresh skills with the stale require-cached engine.
  const installBytes = buildTarballBytes('abc1234', 'demo');
  const updateBytes = buildTarballBytes('def5678', 'demo'); // same version, different commit
  const { loader, getUi } = mkSourceLoader({ script: [{ bytes: installBytes }, { bytes: updateBytes }] });
  await loader.installFromSource('owner/repo@main');
  loader.setEnabledInSettings('demo', true);
  assert.ok((getUi().plugins.enabled || []).includes('demo'), 'ENTER: demo is explicitly enabled');
  const pluginHost = fakePluginHost();
  const activated = loader.activateById('demo', pluginHost);
  assert.strictEqual(activated.ok, true, JSON.stringify(activated));

  const resolved = await loader.resolveUpdate('demo');
  const applied = await loader.applyUpdate('demo', resolved.commit);
  assert.strictEqual(applied.ok, true, JSON.stringify(applied));

  const r = loader.rescan(pluginHost);
  assert.deepStrictEqual(r.changed, ['demo'], 'the same-version, same-dir update must still be reported changed');
  assert.deepStrictEqual(pluginHost.updateBundleCalls, [],
    'updateBundle must NOT run for a plugin flagged restart-required — that would pair fresh content with the stale engine');
  const row = loader.status().plugins.find((p) => p.id === 'demo');
  assert.ok(row && row.restartRequired, 'the settings row carries restartRequired');
});

// ════════════════════════════════════════════════════════════════════════════
// removeSourcePlugin
// ════════════════════════════════════════════════════════════════════════════

test('removeSourcePlugin refuses a directory with no sidecar, leaving it untouched', async () => {
  const { loader, userDir } = mkSourceLoader({ script: [] });
  fs.mkdirSync(path.join(userDir, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(userDir, 'demo', 'manifest.json'), JSON.stringify(manifestFor('demo')));
  const r = loader.removeSourcePlugin('demo');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not installed from a source/);
  assert.ok(fs.existsSync(path.join(userDir, 'demo', 'manifest.json')), 'the directory is untouched');
});

test('removeSourcePlugin removes a fetched directory', async () => {
  const bytes = buildTarballBytes('abc1234', 'demo');
  const { loader, userDir } = mkSourceLoader({ script: [{ bytes }] });
  await loader.installFromSource('owner/repo');
  assert.ok(fs.existsSync(path.join(userDir, 'demo')), 'ENTER: it really installed');
  const r = loader.removeSourcePlugin('demo');
  assert.strictEqual(r.ok, true);
  assert.ok(!fs.existsSync(path.join(userDir, 'demo')));
});

test('removeSourcePlugin refuses a symlinked id rather than deleting the link target (t683 nit d)', async () => {
  const { loader, userDir } = mkSourceLoader({ script: [] });
  const elsewhere = mkTmpRoot('clodex-loader-source-elsewhere-');
  fs.writeFileSync(path.join(elsewhere, 'canary.txt'), 'do not delete me');
  fs.mkdirSync(userDir, { recursive: true });
  fs.symlinkSync(elsewhere, path.join(userDir, 'demo'), 'dir');
  const r = loader.removeSourcePlugin('demo');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /registered link/);
  assert.ok(fs.existsSync(path.join(elsewhere, 'canary.txt')), 'the link target survives, untouched');
});

// ════════════════════════════════════════════════════════════════════════════
// isValidPluginId gating (t683 nit d)
// ════════════════════════════════════════════════════════════════════════════

test('resolveUpdate/applyUpdate/removeSourcePlugin refuse an invalid id before touching the filesystem', async () => {
  const { loader, userDir } = mkSourceLoader({ script: [] });
  const bad = '../escape';
  const ru = await loader.resolveUpdate(bad);
  assert.strictEqual(ru.ok, false);
  assert.match(ru.error, /invalid plugin id/);
  const au = await loader.applyUpdate(bad, 'whatever');
  assert.strictEqual(au.ok, false);
  assert.match(au.error, /invalid plugin id/);
  const rm = loader.removeSourcePlugin(bad);
  assert.strictEqual(rm.ok, false);
  assert.match(rm.error, /invalid plugin id/);
  assert.ok(!fs.existsSync(userDir) || fs.readdirSync(userDir).length === 0,
    'nothing outside the user root was ever touched');
});
