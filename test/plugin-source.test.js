'use strict';
// plugin-source.test.js — the leaf that parses a github plugin-source spec and
// fetches/extracts its tarball (t683, plugins/plugin-sources.md §9). Network
// and system `tar` are both stubbed or, for extractPlugin, driven against a
// REAL tar.gz this file builds in a tmpdir — never the network, never a real
// GitHub repo.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile: realExecFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');

const { createPluginSource, parseSourceSpec } = require('../plugin-source');
const { mkTmpRoot } = require('./lib/tmp-roots');

// ════════════════════════════════════════════════════════════════════════════
// parseSourceSpec — a literal table. Each row carries its OWN expected repo/
// ref/subpath or refusal, never re-derived from the parser's own regex — see
// CLAUDE.md ▸ Tests on why a computed table cannot express an exception.
// ════════════════════════════════════════════════════════════════════════════

const SPEC_ROWS = [
  ['owner/repo', { ok: true, repo: 'owner/repo', ref: null, subpath: null }],
  ['owner/repo@v1.2.3', { ok: true, repo: 'owner/repo', ref: 'v1.2.3', subpath: null }],
  ['owner/repo:plugins/foo', { ok: true, repo: 'owner/repo', ref: null, subpath: 'plugins/foo' }],
  ['owner/repo@main:plugins/foo', { ok: true, repo: 'owner/repo', ref: 'main', subpath: 'plugins/foo' }],
  ['owner/repo.git', { ok: true, repo: 'owner/repo', ref: null, subpath: null }],
  ['https://github.com/owner/repo', { ok: true, repo: 'owner/repo', ref: null, subpath: null }],
  ['https://github.com/owner/repo.git', { ok: true, repo: 'owner/repo', ref: null, subpath: null }],
  ['https://github.com/owner/repo/tree/main/plugins/foo',
    { ok: true, repo: 'owner/repo', ref: 'main', subpath: 'plugins/foo' }],
  ['https://github.com/owner/repo/tree/v1.0.0', { ok: true, repo: 'owner/repo', ref: 'v1.0.0', subpath: null }],
  ['', { ok: false }],
  ['   ', { ok: false }],
  ['git@github.com:owner/repo.git', { ok: false }],
  ['ssh://git@github.com/owner/repo.git', { ok: false }],
  ['https://gitlab.com/owner/repo', { ok: false }],
  ['http://github.com/owner/repo', { ok: false }],
  ['https://github.com/owner', { ok: false }],
  ['owner/repo:/etc/passwd', { ok: false }],
  ['owner/repo:../../etc', { ok: false }],
  ['owner/repo:foo/../bar', { ok: false }],
  ['/repo', { ok: false }],
  ['owner/', { ok: false }],
  ['not a spec at all', { ok: false }],
  ['owner/.', { ok: false }],
  ['owner/..', { ok: false }],
  ['owner/repo@release/1.0', { ok: true, repo: 'owner/repo', ref: 'release/1.0', subpath: null }],
];

test('parseSourceSpec: a literal table of accepted forms and refusals', () => {
  for (const [input, expected] of SPEC_ROWS) {
    const got = parseSourceSpec(input);
    if (expected.ok) {
      assert.deepStrictEqual(got, expected, `spec ${JSON.stringify(input)}`);
    } else {
      assert.strictEqual(got.ok, false, `spec ${JSON.stringify(input)} must be refused`);
      assert.strictEqual(typeof got.error, 'string', `spec ${JSON.stringify(input)} must name why`);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// fetchTarball — an injected https stub. Redirect followed once, over-cap
// aborted, non-2xx refused with the status. Never the real network.
// ════════════════════════════════════════════════════════════════════════════

// fetchTarball counts bytes off `res`'s own 'data' event (so it can abort
// mid-stream before piping finishes), then separately pipes to the output
// file — so the stub must emit 'data' itself, not just hand chunks to pipe().
function mkResponse({ statusCode, headers = {}, chunks = [] }) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = headers;
  res.resume = () => {};
  res.pipe = (dest) => {
    for (const c of chunks) { res.emit('data', c); if (!res.destroyed) dest.write(c); }
    if (!res.destroyed) dest.end();
    return dest;
  };
  res.destroy = () => { res.destroyed = true; };
  return res;
}

// A real Writable's destroy(), called with NO argument, does not emit 'error'
// — only destroy(err) does. plugin-source.js calls it bare on the cap-abort
// path, so a stub that emitted 'error' unconditionally would race its own
// 'finish' handler and resolve with the wrong message.
function mkWriteStream(destPath) {
  const chunks = [];
  const stream = new Writable({
    write(chunk, enc, cb) { chunks.push(chunk); cb(); },
    destroy(err, cb) { cb(err); },
  });
  stream.on('finish', () => fs.writeFileSync(destPath, Buffer.concat(chunks)));
  return stream;
}

test('fetchTarball follows exactly one redirect to the final tarball', async () => {
  const base = mkTmpRoot('clodex-plugin-source-');
  const dest = path.join(base, 'out.tar.gz');
  const calls = [];
  const httpsStub = {
    get(url, opts, cb) {
      calls.push(url);
      const req = new EventEmitter();
      req.setTimeout = () => req;
      if (calls.length === 1) {
        cb(mkResponse({ statusCode: 302, headers: { location: 'https://codeload.example/real.tar.gz' } }));
      } else {
        cb(mkResponse({ statusCode: 200, chunks: [Buffer.from('tarball-bytes')] }));
      }
      return req;
    },
  };
  // fetchTarball uses fs.createWriteStream — stub it in via a scoped fs proxy
  // so the test never depends on a real destination filesystem quirk.
  const fsStub = { ...fs, createWriteStream: () => mkWriteStream(dest) };
  const source = createPluginSource({ fs: fsStub, path, https: httpsStub });
  const r = await source.fetchTarball({ repo: 'owner/repo', ref: 'main' }, dest);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(calls.length, 2, 'exactly one redirect followed');
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'tarball-bytes');
});

test('fetchTarball encodes a ref containing "/" per segment, not as one escaped string (t683 nit e)', async () => {
  const base = mkTmpRoot('clodex-plugin-source-');
  const dest = path.join(base, 'out.tar.gz');
  let calledUrl = null;
  const httpsStub = {
    get(url, opts, cb) {
      calledUrl = url;
      const req = new EventEmitter();
      req.setTimeout = () => req;
      cb(mkResponse({ statusCode: 200, chunks: [Buffer.from('bytes')] }));
      return req;
    },
  };
  const fsStub = { ...fs, createWriteStream: () => mkWriteStream(dest) };
  const source = createPluginSource({ fs: fsStub, path, https: httpsStub });
  await source.fetchTarball({ repo: 'owner/repo', ref: 'release/1.0' }, dest);
  assert.strictEqual(calledUrl, 'https://api.github.com/repos/owner/repo/tarball/release/1.0',
    'each ref segment is its own path segment, not release%2F1.0');
});

test('fetchTarball resolves ok:false rather than throwing on a bad redirect Location (t683 nit c)', async () => {
  // Mimics what a real `https.get` does for a malformed URL: throws
  // SYNCHRONOUSLY out of the call itself, before any callback runs — the
  // exact shape a `.catch`-less `await` cannot see, only a try/catch around
  // the call site.
  const BAD_LOCATION = 'http://[not-a-valid-host';
  let calls = 0;
  const httpsStub = {
    get(url, opts, cb) {
      calls++;
      if (url === BAD_LOCATION) throw new TypeError('Invalid URL');
      const req = new EventEmitter();
      req.setTimeout = () => req;
      cb(mkResponse({ statusCode: 302, headers: { location: BAD_LOCATION } }));
      return req;
    },
  };
  const source = createPluginSource({ fs, path, https: httpsStub });
  const r = await source.fetchTarball({ repo: 'owner/repo', ref: null }, '/dev/null');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /bad redirect location/);
  assert.strictEqual(calls, 2, 'the redirect target was really attempted, and threw');
});

test('fetchTarball refuses a non-2xx status, naming it', async () => {
  const httpsStub = {
    get(url, opts, cb) {
      const req = new EventEmitter();
      cb(mkResponse({ statusCode: 404 }));
      return req;
    },
  };
  const source = createPluginSource({ fs, path, https: httpsStub });
  const r = await source.fetchTarball({ repo: 'owner/repo', ref: null }, '/dev/null');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /404/);
});

test('fetchTarball aborts once the stream exceeds maxBytes', async () => {
  const base = mkTmpRoot('clodex-plugin-source-');
  const dest = path.join(base, 'out.tar.gz');
  const httpsStub = {
    get(url, opts, cb) {
      const req = new EventEmitter();
      cb(mkResponse({ statusCode: 200, chunks: [Buffer.alloc(10), Buffer.alloc(10)] }));
      return req;
    },
  };
  const fsStub = { ...fs, createWriteStream: () => mkWriteStream(dest) };
  const source = createPluginSource({ fs: fsStub, path, https: httpsStub });
  const r = await source.fetchTarball({ repo: 'owner/repo', ref: null }, dest, { maxBytes: 15 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /cap/);
});

// ════════════════════════════════════════════════════════════════════════════
// extractPlugin — a REAL tar.gz built in a tmpdir, extracted with the REAL
// system tar. This is the one subject that touches an actual binary rather
// than a stub, because the extraction logic (finding the single top-level
// dir, reading the sha out of its name) is the thing under test.
// ════════════════════════════════════════════════════════════════════════════

function execFileReal(...args) {
  return new Promise((resolve) => {
    realExecFile(...args, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

async function buildTarball(topDirName, files) {
  const stageRoot = mkTmpRoot('clodex-plugin-source-stage-');
  const topDir = path.join(stageRoot, topDirName);
  fs.mkdirSync(topDir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(topDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  const tarFile = path.join(stageRoot, 'out.tar.gz');
  const { err, stderr } = await execFileReal('tar', ['-czf', tarFile, '-C', stageRoot, topDirName]);
  assert.ok(!err, `ENTER: the fixture's own tar built cleanly — ${stderr}`);
  return tarFile;
}

test('extractPlugin finds the single top-level dir and reads its sha', async () => {
  const tarFile = await buildTarball('owner-repo-abc1234', {
    'manifest.json': '{"id":"demo"}',
  });
  const workDir = path.join(mkTmpRoot('clodex-plugin-source-work-'), 'x');
  const source = createPluginSource({ fs, path, execFile: realExecFile });
  const r = await source.extractPlugin(tarFile, workDir, null);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.commit, 'abc1234');
  assert.strictEqual(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'), '{"id":"demo"}');
});

test('extractPlugin joins a subpath under the top-level dir', async () => {
  const tarFile = await buildTarball('owner-repo-deadbee', {
    'plugins/foo/manifest.json': '{"id":"foo"}',
    'plugins/bar/manifest.json': '{"id":"bar"}',
  });
  const workDir = path.join(mkTmpRoot('clodex-plugin-source-work-'), 'x');
  const source = createPluginSource({ fs, path, execFile: realExecFile });
  const r = await source.extractPlugin(tarFile, workDir, 'plugins/foo');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'), '{"id":"foo"}');
});

test('extractPlugin refuses a tarball with more than one top-level dir', async () => {
  const stageRoot = mkTmpRoot('clodex-plugin-source-stage-');
  fs.mkdirSync(path.join(stageRoot, 'first'), { recursive: true });
  fs.mkdirSync(path.join(stageRoot, 'second'), { recursive: true });
  fs.writeFileSync(path.join(stageRoot, 'first', 'f.txt'), 'x');
  fs.writeFileSync(path.join(stageRoot, 'second', 'f.txt'), 'x');
  const tarFile = path.join(stageRoot, 'out.tar.gz');
  const { err } = await execFileReal('tar', ['-czf', tarFile, '-C', stageRoot, 'first', 'second']);
  assert.ok(!err, 'ENTER: fixture tar with two top-level dirs built cleanly');
  const workDir = path.join(mkTmpRoot('clodex-plugin-source-work-'), 'x');
  const source = createPluginSource({ fs, path, execFile: realExecFile });
  const r = await source.extractPlugin(tarFile, workDir, null);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /exactly one/);
});

test('extractPlugin refuses a subpath that escapes the extracted directory', async () => {
  const tarFile = await buildTarball('owner-repo-abc1234', { 'f.txt': 'x' });
  const workDir = path.join(mkTmpRoot('clodex-plugin-source-work-'), 'x');
  const source = createPluginSource({ fs, path, execFile: realExecFile });
  const r = await source.extractPlugin(tarFile, workDir, '../../etc');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /escapes/);
});

// ════════════════════════════════════════════════════════════════════════════
// readSidecar / writeSidecar
// ════════════════════════════════════════════════════════════════════════════

test('writeSidecar then readSidecar round-trips, and a missing sidecar reads as null', () => {
  const dir = mkTmpRoot('clodex-plugin-source-sidecar-');
  const source = createPluginSource({ fs, path });
  assert.strictEqual(source.readSidecar(dir), null, 'no sidecar yet');
  const meta = { source: 'github', repo: 'owner/repo', ref: 'main', subpath: null, commit: 'abc123', commitFull: true, fetchedAt: 1 };
  source.writeSidecar(dir, meta);
  assert.deepStrictEqual(source.readSidecar(dir), meta);
});

test('readSidecar returns null for unreadable or non-JSON content, never throws', () => {
  const dir = mkTmpRoot('clodex-plugin-source-sidecar-');
  fs.writeFileSync(path.join(dir, '.clodex-source.json'), 'not json');
  const source = createPluginSource({ fs, path });
  assert.strictEqual(source.readSidecar(dir), null);
});

// ════════════════════════════════════════════════════════════════════════════
// sameTree — the byte compare resolveUpdate uses to tell "the repo head moved"
// from "the plugin's own files moved". Real temp dirs, never a stubbed fs: the
// walk's whole job is to be right about what is on disk. Each row carries its
// own literal true/false — see CLAUDE.md ▸ Tests on computed tables.
// ════════════════════════════════════════════════════════════════════════════

function mkTree(spec) {
  const root = mkTmpRoot('clodex-plugin-source-tree-');
  for (const [rel, body] of Object.entries(spec)) {
    const full = path.join(root, rel);
    if (body === DIR) { fs.mkdirSync(full, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (body && body.symlinkTo != null) fs.symlinkSync(body.symlinkTo, full);
    else fs.writeFileSync(full, body);
  }
  return root;
}

const DIR = Symbol('a directory, not a file');

const SAME_TREE_ROWS = [
  ['identical trees', { 'manifest.json': '{"id":"demo"}', 'engine.js': 'x' },
    { 'manifest.json': '{"id":"demo"}', 'engine.js': 'x' }, true],
  ['one differing byte', { 'engine.js': 'aaa' }, { 'engine.js': 'aab' }, false],
  ['an extra file on side A', { 'engine.js': 'x', 'extra.txt': 'y' }, { 'engine.js': 'x' }, false],
  ['an extra file on side B', { 'engine.js': 'x' }, { 'engine.js': 'x', 'extra.txt': 'y' }, false],
  ['a nested subdirectory difference', { 'lib/deep/a.js': 'one' }, { 'lib/deep/a.js': 'two' }, false],
  ['a nested file present on one side only', { 'lib/deep/a.js': 'one' }, { 'lib/deep/a.js': 'one', 'lib/deep/b.js': 'two' }, false],
  ['a sidecar on side A only', { 'engine.js': 'x', '.clodex-source.json': '{"commit":"abc1234"}' },
    { 'engine.js': 'x' }, true],
  ['a sidecar nested under a subdirectory, one side only',
    { 'engine.js': 'x', 'lib/a.js': 'y', 'lib/.clodex-source.json': '{"commit":"abc1234"}' },
    { 'engine.js': 'x', 'lib/a.js': 'y' }, true],
  ['a directory holding only an ignored sidecar is still a directory one side lacks',
    { 'engine.js': 'x', 'lib/.clodex-source.json': '{"commit":"abc1234"}' }, { 'engine.js': 'x' }, false],
  ['a file on one side, a directory of the same name on the other', { 'thing': 'x' }, { 'thing': DIR }, false],
  ['identical symlink targets', { 'link': { symlinkTo: 'engine.js' }, 'engine.js': 'x' },
    { 'link': { symlinkTo: 'engine.js' }, 'engine.js': 'x' }, true],
  ['differing symlink targets', { 'link': { symlinkTo: 'a.js' }, 'a.js': 'x', 'b.js': 'x' },
    { 'link': { symlinkTo: 'b.js' }, 'a.js': 'x', 'b.js': 'x' }, false],
  ['a symlink on one side, a real file of the same bytes on the other',
    { 'link': { symlinkTo: 'engine.js' }, 'engine.js': 'x' }, { 'link': 'x', 'engine.js': 'x' }, false],
  ['two empty trees', {}, {}, true],
];

test('sameTree: a literal table over real temp directories', () => {
  const source = createPluginSource({ fs, path });
  for (const [label, specA, specB, expected] of SAME_TREE_ROWS) {
    const a = mkTree(specA);
    const b = mkTree(specB);
    assert.strictEqual(source.sameTree(a, b), expected, label);
  }
});

test('sameTree returns false when either directory cannot be read', () => {
  const source = createPluginSource({ fs, path });
  const real = mkTree({ 'engine.js': 'x' });
  const missing = path.join(mkTmpRoot('clodex-plugin-source-tree-'), 'never-created');
  assert.strictEqual(fs.existsSync(real), true, 'ENTER: the real side is on disk, so a false below is about the missing side');
  assert.strictEqual(fs.existsSync(missing), false, 'ENTER: the missing side really is absent');
  assert.strictEqual(source.sameTree(real, missing), false, 'a tree you cannot read is not provably the same');
  assert.strictEqual(source.sameTree(missing, real), false, 'and the same in the other order');
  assert.strictEqual(source.sameTree(missing, missing), false, 'two absent trees are not "the same tree" either');
});

// ════════════════════════════════════════════════════════════════════════════
// fetchLibraryCatalog — the catalog over ONE tarball of the library repo. The
// https stub serves a REAL tar.gz built here, so the enumeration runs against a
// genuinely extracted tree rather than a stubbed readdir. What it must get
// right is the SKIP set: `_template` is a scaffold, a directory with no
// manifest is anything else the repo carries (docs/, .github/), and both would
// otherwise become rows offering an install that cannot succeed.
// ════════════════════════════════════════════════════════════════════════════

function mkLibraryHttps(tarBytes) {
  return {
    get(url, opts, cb) {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      res.resume = () => {};
      res.pipe = (dest) => { res.emit('data', tarBytes); dest.write(tarBytes); dest.end(); return dest; };
      setImmediate(() => cb(res));
      return req;
    },
  };
}

async function buildLibraryTarball(sha, dirs) {
  const stage = mkTmpRoot('clodex-library-stage-');
  const topDirName = `avirtual-clodex-plugins-${sha}`;
  for (const [dirName, files] of Object.entries(dirs)) {
    const d = path.join(stage, topDirName, dirName);
    fs.mkdirSync(d, { recursive: true });
    for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(d, rel), body);
  }
  const tarFile = path.join(stage, 'out.tar.gz');
  const { err, stderr } = await execFileReal('tar', ['-czf', tarFile, '-C', stage, topDirName]);
  assert.ok(!err, `ENTER: the library fixture tar built cleanly — ${stderr}`);
  return fs.readFileSync(tarFile);
}

test('fetchLibraryCatalog lists only the top-level dirs holding a valid manifest', async () => {
  // `_template`'s manifest carries a VALID id on purpose. The scaffold in the
  // real repo is a working plugin skeleton, so its id passes isValidPluginId and
  // the id rule cannot be what keeps it out — only the skip by NAME can. A
  // fixture that gave it an underscore id would be rejected by the id check and
  // stay green with the name skip deleted, which is exactly what it must catch.
  const bytes = await buildLibraryTarball('abc1234', {
    _template: { 'manifest.json': '{"id":"template-plugin","name":"Template","version":"0.0.0"}' },
    notes: { 'manifest.json': '{"id":"notes","name":"Notes","version":"1.2.0","announce":"Takes notes."}' },
    docs: { 'README.md': 'not a plugin' },
    '.github': { 'CODEOWNERS': 'not a plugin either' },
  });
  const source = createPluginSource({ fs, path, os, execFile: realExecFile, https: mkLibraryHttps(bytes) });
  const r = await source.fetchLibraryCatalog({ repo: 'avirtual/clodex-plugins' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(r.plugins.some((p) => p.id === 'notes'),
    'ENTER: the one valid plugin survived the enumeration, so the absences below are about the skips');
  assert.deepStrictEqual(r.plugins, [{
    id: 'notes', name: 'Notes', version: '1.2.0', subpath: 'notes', announce: 'Takes notes.',
  }], 'the scaffold is skipped by name even though its manifest is installable, and docs/ and .github/ carry none');
  assert.strictEqual(r.commit, 'abc1234');
  assert.strictEqual(r.repo, 'avirtual/clodex-plugins');
});

test('fetchLibraryCatalog names the folder as the subpath, not the manifest id', async () => {
  // installFromSource fetches `repo:<subpath>` — the PATH in the repo. A row
  // that carried the id instead would install fine only while every folder
  // happens to be named after its plugin, and 404 the day one is not.
  const bytes = await buildLibraryTarball('deadbee', {
    'notes-pack': { 'manifest.json': '{"id":"notes","name":"Notes","version":"2.0.0"}' },
  });
  const source = createPluginSource({ fs, path, os, execFile: realExecFile, https: mkLibraryHttps(bytes) });
  const r = await source.fetchLibraryCatalog({});
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.plugins, [{
    id: 'notes', name: 'Notes', version: '2.0.0', subpath: 'notes-pack', announce: null,
  }]);
});

test('fetchLibraryCatalog fetches ONE tarball and leaves no fetch directory behind', async () => {
  const bytes = await buildLibraryTarball('abc1234', {
    notes: { 'manifest.json': '{"id":"notes","name":"Notes","version":"1.0.0"}' },
    tasks: { 'manifest.json': '{"id":"tasks","name":"Tasks","version":"1.0.0"}' },
  });
  const urls = [];
  const https = mkLibraryHttps(bytes);
  const counting = { get(url, opts, cb) { urls.push(url); return https.get(url, opts, cb); } };
  // Its OWN tmp root, not the shared one: node --test runs test files in
  // parallel processes, so a scan of $TMPDIR for the library prefix attributes
  // another process's live fetch dir to this subject (t742, seen on the
  // identical scan in test/plugin-loader-source.test.js).
  const fetchRoot = mkTmpRoot('clodex-plugin-source-library-');
  let fetchRootAsks = 0;
  const source = createPluginSource({
    fs, path, execFile: realExecFile, https: counting,
    os: { tmpdir: () => { fetchRootAsks++; return fetchRoot; } },
  });
  const r = await source.fetchLibraryCatalog({});
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.plugins.length, 2, 'ENTER: two plugins were enumerated off the ONE fetch below');
  assert.deepStrictEqual(urls, ['https://api.github.com/repos/avirtual/clodex-plugins/tarball'],
    'one tarball for the whole catalog — a per-plugin request would be N calls against an unauthenticated rate limit');
  // An empty root proves cleanup only if the fetch dir was minted UNDER it —
  // without this the assertion below passes vacuously against a source that
  // never asked, which is the same green-for-nothing the global scan gave.
  assert.ok(fetchRootAsks > 0, 'ENTER: the fetch dir was minted under this subject\'s own tmp root');
  assert.deepStrictEqual(fs.readdirSync(fetchRoot), [],
    'the fetch dir holds a copy of every plugin in the library and must not outlive the call');
});

test('fetchLibraryCatalog refuses a repo that is not on github.com, exactly as parseSourceSpec does', async () => {
  const source = createPluginSource({ fs, path, os, execFile: realExecFile, https: mkLibraryHttps(Buffer.alloc(0)) });
  const r = await source.fetchLibraryCatalog({ repo: 'https://gitlab.com/owner/repo' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r, parseSourceSpec('https://gitlab.com/owner/repo'),
    'the refusal is the parser\'s own — a second host check here would drift from the one the install path uses');
});
