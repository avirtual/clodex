'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { resolveDisplayedPath } = require('../file-resolve');

// `exists` is the set of paths that stat as regular files. Everything else is
// injected, so nothing here touches a real disk.
const call = (raw, { exists = [], cwd = '/repo', baseDir = null, touched = [], home = '/home/u' } = {}) =>
  resolveDisplayedPath({
    raw, cwd, baseDir, touched, home, path,
    statFile: (p) => exists.includes(p),
  });

test('an absolute path that exists resolves to itself', () => {
  assert.deepStrictEqual(call('/repo/a.js', { exists: ['/repo/a.js'] }),
    { ok: true, path: '/repo/a.js', via: 'absolute' });
});

test('a relative path resolves against the session cwd', () => {
  assert.deepStrictEqual(call('src/a.js', { exists: ['/repo/src/a.js'] }),
    { ok: true, path: '/repo/src/a.js', via: 'relative to the session directory' });
});

// The reason baseDir exists: `lib/format.js` inside renderer/x.js means
// renderer/lib/format.js, NOT <repo>/lib/format.js.
//
// Both candidates must EXIST for this to test the ordering at all. With only
// one on disk the fallback finds it whichever order the two are tried in, and
// the test passes against a resolver that prefers the cwd.
test('a relative path prefers the open file\'s own directory over the cwd', () => {
  const r = call('lib/format.js', {
    baseDir: '/repo/renderer',
    exists: ['/repo/renderer/lib/format.js', '/repo/lib/format.js'],
  });
  assert.deepStrictEqual(r, { ok: true, path: '/repo/renderer/lib/format.js', via: 'relative to the open file' });
});

// The same ordering, one level up: a `../` path that resolves to a real file
// from BOTH bases still takes the open file's.
test('the open file\'s directory wins for a ../ path too', () => {
  const r = call('../shared/util.js', {
    cwd: '/repo/pkg', baseDir: '/repo/pkg/renderer',
    exists: ['/repo/pkg/shared/util.js', '/repo/shared/util.js'],
  });
  assert.deepStrictEqual(r, { ok: true, path: '/repo/pkg/shared/util.js', via: 'relative to the open file' });
});

test('falls back to the cwd when the open file\'s directory has no such file', () => {
  const r = call('lib/format.js', {
    baseDir: '/repo/renderer/popovers',
    exists: ['/repo/lib/format.js'],
  });
  assert.deepStrictEqual(r, { ok: true, path: '/repo/lib/format.js', via: 'relative to the session directory' });
});

test('expands ~ against home', () => {
  assert.deepStrictEqual(call('~/.clodex/x.json', { exists: ['/home/u/.clodex/x.json'] }),
    { ok: true, path: '/home/u/.clodex/x.json', via: 'absolute' });
});

// A path outside the session cwd still RESOLVES — reading bytes into a modal is
// not an authority, and the write side (file-edit.js) confines separately.
test('resolves a real file outside the session cwd', () => {
  assert.deepStrictEqual(call('/etc/hosts.md', { exists: ['/etc/hosts.md'] }),
    { ok: true, path: '/etc/hosts.md', via: 'absolute' });
});

// `@plan.md` is how the CLI is told to load a file, so the `@` is displayed
// constantly and is not part of any name. The scanner cannot drop it (`@` is
// legal in a path — see the scoped-package case below), so resolution tries it
// both ways.
test('strips a leading @ sigil when only the bare name exists', () => {
  assert.deepStrictEqual(call('@plan.md', { exists: ['/repo/plan.md'] }),
    { ok: true, path: '/repo/plan.md', via: 'relative to the session directory' });
});

test('strips a leading @ sigil on a path with directories', () => {
  assert.deepStrictEqual(call('@docs/spec-v2.md', { exists: ['/repo/docs/spec-v2.md'] }),
    { ok: true, path: '/repo/docs/spec-v2.md', via: 'relative to the session directory' });
});

test('strips a leading @ sigil on an absolute path', () => {
  assert.deepStrictEqual(call('@/etc/notes.md', { exists: ['/etc/notes.md'] }),
    { ok: true, path: '/etc/notes.md', via: 'absolute' });
});

// The whole reason the literal form is tried first. A file really named
// `@types.md` is a fact on disk; the sigil reading is an inference about what
// someone meant. Both candidates must exist or this passes against either order.
test('a file literally named with a leading @ wins over the stripped reading', () => {
  assert.deepStrictEqual(call('@types.md', { exists: ['/repo/@types.md', '/repo/types.md'] }),
    { ok: true, path: '/repo/@types.md', via: 'relative to the session directory' });
});

// `@` is in the scanner's char class for this case, so stripping it blindly
// would break the commonest real path that starts with one.
test('a scoped package path is not mangled by the sigil strip', () => {
  assert.deepStrictEqual(
    call('node_modules/@babel/core/lib/index.js',
      { exists: ['/repo/node_modules/@babel/core/lib/index.js'] }),
    { ok: true, path: '/repo/node_modules/@babel/core/lib/index.js', via: 'relative to the session directory' });
});

test('a bare @ is not treated as a path', () => {
  assert.strictEqual(call('@', { exists: ['/repo'] }).ok, false);
});

// baseDir still outranks the cwd for the stripped form: the sigil changes what
// the string NAMES, not where a relative name is anchored.
test('the @-stripped form still prefers the open file\'s directory', () => {
  const r = call('@lib/format.js', {
    baseDir: '/repo/renderer',
    exists: ['/repo/renderer/lib/format.js', '/repo/lib/format.js'],
  });
  assert.deepStrictEqual(r,
    { ok: true, path: '/repo/renderer/lib/format.js', via: 'relative to the open file' });
});

test('a shortened @ path recovers from the touched set', () => {
  const r = call('@…/tasks/HANDOFF.md', {
    exists: ['/home/u/.clodex/tasks/HANDOFF.md'],
    touched: ['/home/u/.clodex/tasks/HANDOFF.md'],
  });
  assert.deepStrictEqual(r,
    { ok: true, path: '/home/u/.clodex/tasks/HANDOFF.md', via: 'a file this session touched' });
});

test('a path that names nothing is an honest miss, not a guess', () => {
  const r = call('nope.js', { exists: ['/repo/other.js'] });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Can't find "nope\.js"/);
});

// The truncated-path case: the terminal shortened it, so neither cwd nor baseDir
// resolution can work — only the touched set knows the full path.
test('recovers a truncated path from a unique touched-files suffix match', () => {
  const r = call('…/deep/nested/thing.js', {
    exists: ['/repo/a/deep/nested/thing.js'],
    touched: ['/repo/a/deep/nested/thing.js', '/repo/other.js'],
  });
  assert.deepStrictEqual(r, { ok: true, path: '/repo/a/deep/nested/thing.js', via: 'a file this session touched' });
});

// Picking arbitrarily between two real files is the confident-wrong-answer
// failure this whole module is written to avoid.
test('refuses an ambiguous suffix match rather than picking one', () => {
  const r = call('…/nested/thing.js', {
    exists: ['/repo/a/nested/thing.js', '/repo/b/nested/thing.js'],
    touched: ['/repo/a/nested/thing.js', '/repo/b/nested/thing.js'],
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Ambiguous: 2 touched files/);
});

// Suffix matching is on a path BOUNDARY: "x/ab.js" must not satisfy a request
// for "b.js", which a bare endsWith would accept.
test('a suffix match respects segment boundaries', () => {
  const r = call('b.js', { exists: ['/repo/x/ab.js'], touched: ['/repo/x/ab.js'] });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Can't find/);
});

test('a touched path that no longer exists on disk does not resolve', () => {
  const r = call('…/gone.js', { exists: [], touched: ['/repo/gone.js'] });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Can't find/);
});

// Direct resolution is a stronger signal of intent than a suffix match; if the
// touched set were consulted first, a stale entry could shadow the real file.
test('cwd resolution wins over a touched-files match for the same name', () => {
  const r = call('a.js', {
    exists: ['/repo/a.js', '/elsewhere/a.js'],
    touched: ['/elsewhere/a.js'],
  });
  assert.deepStrictEqual(r, { ok: true, path: '/repo/a.js', via: 'relative to the session directory' });
});

test('empty input is refused rather than resolving to the cwd itself', () => {
  for (const v of ['', '   ', null, undefined]) {
    const r = call(v);
    assert.strictEqual(r.ok, false, `resolved empty input: ${JSON.stringify(v)}`);
    assert.match(r.error, /Empty path/);
  }
});

test('a session with no cwd still resolves an absolute path', () => {
  assert.deepStrictEqual(call('/x/y.js', { cwd: null, exists: ['/x/y.js'] }),
    { ok: true, path: '/x/y.js', via: 'absolute' });
});

test('a throwing statFile is treated as "not a file", not an exception', () => {
  const r = resolveDisplayedPath({
    raw: '/x/y.js', cwd: '/repo', touched: [], home: '/home/u', path,
    statFile: () => { throw new Error('EACCES'); },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Can't find/);
});
