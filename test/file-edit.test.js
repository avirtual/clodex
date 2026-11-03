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
  const closed = [];
  const fileOf = (h) => h.slice('fd:'.length);
  return {
    resolve: path.resolve,
    realpath,
    open: (p) => {
      if (!files[p]) throw new Error(`ENOENT ${p}`);
      return `fd:${p}`;
    },
    stat: (h) => {
      const f = files[fileOf(h)];
      return { isFile: () => f.dir !== true, size: f.size == null ? 10 : f.size, mtimeMs: f.mtimeMs == null ? 1000 : f.mtimeMs };
    },
    readHead: (h) => Buffer.from(files[fileOf(h)].head || 'text'),
    close: (h) => closed.push(h),
    closed,
  };
}

const base = (over = {}) => ({
  filePath: '/repo/src/a.js', cwd: '/repo', content: 'new bytes', expectMtime: null,
  ...fsFixture({ files: { '/repo/src/a.js': {} } }),
  ...over,
});

test('accepts a regular file inside the session cwd and returns its realpath', () => {
  assert.deepStrictEqual(vetFileWrite(base()), { ok: true, path: '/repo/src/a.js', handle: 'fd:/repo/src/a.js' });
});

test('accepts a relative path resolved against the cwd', () => {
  assert.deepStrictEqual(vetFileWrite(base({ filePath: 'src/a.js' })), { ok: true, path: '/repo/src/a.js', handle: 'fd:/repo/src/a.js' });
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
  assert.deepStrictEqual(r, { ok: true, path: '/private/tmp/ws/a.js', handle: 'fd:/private/tmp/ws/a.js' });
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

test('refuses a file that is not UTF-8', () => {
  const r = vetFileWrite(base({ ...fsFixture({ files: { '/repo/src/a.js': { head: Buffer.from([0x63, 0x61, 0x66, 0xE9]) } } }) }));
  assert.deepStrictEqual(r, { ok: false, error: 'File is not UTF-8 — edit it outside Clodex' });
});

test('refuses a file with CRLF line endings, a CR past the NUL sniff included', () => {
  const r = vetFileWrite(base({ ...fsFixture({ files: { '/repo/src/a.js': { head: 'a'.repeat(9000) + '\r\n' } } }) }));
  assert.deepStrictEqual(r, { ok: false, error: 'File uses CRLF line endings — edit it outside Clodex' });
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
  assert.deepStrictEqual(vetFileWrite(base({ expectMtime: 1000 })), { ok: true, path: '/repo/src/a.js', handle: 'fd:/repo/src/a.js' });
});

test('accepts the integral expectMtime the peek reports when the real mtime carries a fraction', () => {
  const frac = fsFixture({ files: { '/repo/src/a.js': { mtimeMs: 1000.4624 } } });
  assert.deepStrictEqual(vetFileWrite(base({ expectMtime: 1000, ...frac })), { ok: true, path: '/repo/src/a.js', handle: 'fd:/repo/src/a.js' });
  assert.match(vetFileWrite(base({ expectMtime: 999, ...frac })).error, /changed on disk/);
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
  assert.deepStrictEqual(vetFileWrite(base({ content: '' })), { ok: true, path: '/repo/src/a.js', handle: 'fd:/repo/src/a.js' });
});

test('every refusal after the open closes the handle it opened; the accept leaves it open for the writer', () => {
  const cases = [
    [{ dir: true }, null, 'Not a regular file'],
    [{ size: PEEK_MAX_BYTES + 1 }, null, 'File is larger than the 512KB peek limit — edit it in a real editor'],
    [{}, 900, 'File changed on disk since it was opened — reopen it to see the current bytes'],
    [{ head: 'a\0b' }, null, 'Binary file'],
    [{ head: 'a\r\n' }, null, 'File uses CRLF line endings — edit it outside Clodex'],
  ];
  for (const [file, expectMtime, error] of cases) {
    const fx = fsFixture({ files: { '/repo/src/a.js': file } });
    assert.deepStrictEqual(vetFileWrite(base({ expectMtime, ...fx })), { ok: false, error });
    assert.deepStrictEqual(fx.closed, ['fd:/repo/src/a.js'], error);
  }
  const fx = fsFixture({ files: { '/repo/src/a.js': {} } });
  assert.strictEqual(vetFileWrite(base(fx)).ok, true);
  assert.deepStrictEqual(fx.closed, []);
});

test('a confinement refusal never opens the file outside the cwd', () => {
  const fx = fsFixture({ files: { '/etc/passwd': {} }, links: { '/repo/link.js': '/etc/passwd' } });
  const opened = [];
  const r = vetFileWrite(base({ filePath: '/repo/link.js', ...fx, open: (p) => { opened.push(p); return fx.open(p); } }));
  assert.deepStrictEqual(r, { ok: false, error: 'Refusing to write outside the session directory' });
  assert.deepStrictEqual(opened, []);
});

test('an open that fails after realpath succeeded closes nothing and names its cause', () => {
  for (const [code, error] of [
    ['ELOOP', 'File changed under the editor — reload and retry'],
    ['EISDIR', 'Not a regular file'],
    ['ENOENT', 'No such file: /repo/src/a.js'],
    ['ENOTDIR', 'No such file: /repo/src/a.js'],
    ['EACCES', 'EACCES'],
  ]) {
    const fx = fsFixture({ files: { '/repo/src/a.js': {} } });
    const r = vetFileWrite(base({ ...fx, open: () => { throw Object.assign(new Error(code), { code }); } }));
    assert.deepStrictEqual(r, { ok: false, error });
    assert.deepStrictEqual(fx.closed, []);
  }
});
