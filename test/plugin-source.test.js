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
