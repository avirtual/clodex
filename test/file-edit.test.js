'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { vetFileWrite, PEEK_MAX_BYTES } = require('../file-edit');

// A fixture filesystem: `files` maps a realpath to its stat-ish facts, `links`
// maps a pre-realpath path to where it actually lands. Everything the policy
// touches is injected, so nothing here goes near a real disk.
function fsFixture({ files = {}, links = {}, dirs = ['/repo'] } = {}) {
  const realpath = (p) => {
    const target = links[p] || p;
    if (!files[target] && !dirs.includes(target)) throw new Error(`ENOENT ${p}`);
    return target;
  };
  return {
    resolve: path.resolve,
    realpath,
    stat: (p) => {
      const f = files[p];
      if (!f) throw new Error(`ENOENT ${p}`);
      return { isFile: () => f.dir !== true, size: f.size == null ? 10 : f.size, mtimeMs: f.mtimeMs == null ? 1000 : f.mtimeMs };
    },
    readHead: (p) => Buffer.from((files[p] && files[p].head) || 'text'),
  };
}

const base = (over = {}) => ({
  filePath: '/repo/src/a.js', cwd: '/repo', content: 'new bytes', expectMtime: null,
  ...fsFixture({ files: { '/repo/src/a.js': {} } }),
  ...over,
});

test('accepts a regular file inside the session cwd and returns its realpath', () => {
  assert.deepStrictEqual(vetFileWrite(base()), { ok: true, path: '/repo/src/a.js' });
});

test('accepts a relative path resolved against the cwd', () => {
  assert.deepStrictEqual(vetFileWrite(base({ filePath: 'src/a.js' })), { ok: true, path: '/repo/src/a.js' });
});

test('refuses a path that resolves outside the session cwd', () => {
  const r = vetFileWrite(base({
    filePath: '../elsewhere/b.js',
    ...fsFixture({ files: { '/elsewhere/b.js': {} } }),
  }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /outside the session directory/);
});

// The lexical-prefix version of this check passes: the SYMLINK's path starts
// with '/repo/'. Only comparing the REALPATH catches it, which is the one thing
// this policy does that the workbench editor's safeResolve does not.
test('refuses a symlink inside the cwd whose target is outside it', () => {
  const r = vetFileWrite(base({
    filePath: '/repo/link.js',
    ...fsFixture({ files: { '/etc/passwd': {} }, links: { '/repo/link.js': '/etc/passwd' } }),
  }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /outside the session directory/);
});

// A cwd whose realpath differs from its literal path (macOS /tmp -> /private/tmp
// is the everyday case) must still accept its own children — comparing the
// resolved file against the UNRESOLVED root would reject every one of them.
test('accepts a child when the cwd itself is a symlink', () => {
  const r = vetFileWrite(base({
    cwd: '/tmp/ws', filePath: 'a.js',
    ...fsFixture({
      files: { '/private/tmp/ws/a.js': {} },
      links: { '/tmp/ws': '/private/tmp/ws', '/tmp/ws/a.js': '/private/tmp/ws/a.js' },
      dirs: ['/private/tmp/ws'],
    }),
  }));
  assert.deepStrictEqual(r, { ok: true, path: '/private/tmp/ws/a.js' });
});

test('refuses a directory', () => {
  const r = vetFileWrite(base({ ...fsFixture({ files: { '/repo/src/a.js': { dir: true } } }) }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Not a regular file/);
});

test('refuses a missing file — the Edit tab never creates one', () => {
  const r = vetFileWrite(base({ filePath: '/repo/nope.js' }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /No such file/);
});

test('refuses binary content', () => {
  const r = vetFileWrite(base({ ...fsFixture({ files: { '/repo/src/a.js': { head: 'a\0b' } } }) }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Binary file/);
});

// The data-loss guard: the peek only READ the first PEEK_MAX_BYTES, so writing
// the textarea back would truncate the file to the head it showed.
test('refuses a file larger than the peek cap', () => {
  const r = vetFileWrite(base({ ...fsFixture({ files: { '/repo/src/a.js': { size: PEEK_MAX_BYTES + 1 } } }) }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /peek limit/);
});

test('refuses when the mtime moved under the open editor', () => {
  const r = vetFileWrite(base({ expectMtime: 900 })); // fixture stats at 1000
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /changed on disk/);
});

test('accepts when the mtime still matches', () => {
  assert.deepStrictEqual(vetFileWrite(base({ expectMtime: 1000 })), { ok: true, path: '/repo/src/a.js' });
});

test('refuses a session with no cwd — there is nothing to confine the write to', () => {
  const r = vetFileWrite(base({ cwd: null }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no working directory/);
});

test('refuses non-string content rather than coercing it', () => {
  const r = vetFileWrite(base({ content: { toString: () => 'oops' } }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /must be a string/);
});

test('accepts empty content — clearing a file is a legitimate edit', () => {
  assert.deepStrictEqual(vetFileWrite(base({ content: '' })), { ok: true, path: '/repo/src/a.js' });
});
