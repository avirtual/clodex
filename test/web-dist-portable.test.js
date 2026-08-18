'use strict';
// web-dist-portable.test.js — the bundle must not name the machine that built it.
//
// esbuild writes a source-marker comment naming each file it inlines, and the
// name is RELATIVE TO THE BUILD'S WORKING DIRECTORY, after symlinks are
// resolved. Two ways that leaked the build machine into the bundle: building
// from a git worktree — which is exactly where a delegated hand does its work —
// escaped through the loop's `node_modules` symlink and wrote
// `../wb-wrap-ui/node_modules/@xterm/...`, pointing back at the original
// checkout; and invoking the build from a subdirectory moved every marker with
// the cwd.
//
// Both are now closed AT THE BUILD, not by convention: build/build-web.js pins
// `absWorkingDir: ROOT` + `preserveSymlinks: true` on both esbuild calls, so the
// bundle is byte-identical wherever it is built from. Verified by building the
// same tree from a worktree and from a subdirectory of one — both reproduced the
// committed root-built bundle exactly.
//
// It has shipped twice. Nothing catches it: the file commits clean, the suite
// stays green, and a reviewer reading a 1.4MB generated bundle would not see
// it. The only signal is a grep nobody remembers to run — which is the shape of
// the packaging bugs `packaging-allowlist.test.js` exists for, one layer down.
// Same remedy: derive the property, fail closed.
//
// TWO WRONG FORMULATIONS I TRIED FIRST, recorded because each looked right and
// each was green over the real defect:
//
//   1. "two or more `../`". The real defect has exactly ONE (`../wb-wrap-ui/`),
//      and so does a correct build (`../node_modules/` in older bundles). The
//      count carries no signal at all.
//   2. "resolves outside the repo root". Resolved from `web-dist/`, the shipped
//      path lands at `<root>/wb-wrap-ui/node_modules/...` — INSIDE the root by
//      string comparison. It is wrong because that directory does not exist,
//      not because it escapes.
//
// The property that actually holds: in a correct bundle every marker is the
// BARE relative path from the root. Any prefix on it is the build machine
// leaking in. That is exact, has no false positives (checked: the only other
// relative strings in the bundle are CSS fragments), and cannot be confused
// with a legitimate path the way a home-directory pattern can — the bundle
// legitimately contains `/home/clodex/work`, the sandbox container work dir.
//
// Fix when this fails: `npm run build:web` (from anywhere — the build pins its
// own working directory), commit the regenerated bundle. If a rebuild does NOT
// clear it, the two esbuild options above were dropped from build/build-web.js;
// restore them rather than rebuilding from somewhere else. The old advice here
// said "build from the repo root", which a hand cannot do — the root is the
// shared checkout holding master's sources, not the branch under review.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'web-dist', 'index.html');

// Everything immediately preceding a `node_modules/` mention, stopping at
// whitespace or a quote. Empty means the marker is bare, which is correct.
const PREFIXED = /[^\s"'`(]+node_modules\//g;

function prefixes(src) {
  return [...new Set(src.match(PREFIXED) || [])];
}

test('web-dist bundle names no path from the build machine', () => {
  const src = fs.readFileSync(BUNDLE, 'utf8');
  assert.deepStrictEqual(prefixes(src), [],
    'web-dist/index.html records module paths with a directory prefix: '
    + `${prefixes(src).join(', ')}. esbuild names inlined files RELATIVE TO THE `
    + 'BUILD DIRECTORY, so a prefix means this bundle was built from a git '
    + 'worktree rather than the repo root — the paths point back at the original '
    + 'checkout and are meaningful on that machine alone. Remedy: re-run '
    + '`npm run build:web` (from anywhere) and commit the regenerated bundle. If '
    + 'the prefix survives a rebuild, build/build-web.js has lost its '
    + '`absWorkingDir: ROOT` / `preserveSymlinks: true` esbuild options.');
});

test('web-dist bundle embeds no absolute path from this machine', () => {
  // The other half of the same failure, with its own remedy: an absolute path
  // usually means a tool configured with one rather than a worktree build.
  //
  // Scoped to THIS machine's home, resolved at runtime, rather than to /Users/
  // or /home/ generally. The bundle legitimately contains `/home/clodex/work`
  // — the sandbox container work dir (renderer/lib/placement.js:21,
  // sandbox.js:57). A pattern broad enough to catch that one asks "does this
  // look like a home directory" when the question is "is this a path from the
  // machine that built this". Caught by this test failing on its first run.
  const src = fs.readFileSync(BUNDLE, 'utf8');
  const home = require('os').homedir();
  const abs = [...new Set(src.match(new RegExp(`${home}[^\\s"'\`)]{0,60}`, 'g')) || [])];
  assert.deepStrictEqual(abs, [],
    `web-dist/index.html embeds absolute paths from the build machine: ${abs.join(', ')}. `
    + 'The bundle ships to users who do not have those directories.');
});

test('the detector separates the shipped defect from a correct build', () => {
  // Guards the guard, and it is not optional here: both tests above pass on a
  // clean bundle, so neither can tell us the detector still SEPARATES the two
  // cases. Two of my formulations were green on a clean bundle AND green over
  // the real defect (see the header). A guard that cannot fail for the reason
  // it exists is not a guard, and only this test would have said so.
  const shipped = 'lib/xterm.js\n// ../wb-wrap-ui/node_modules/@xterm/xterm/lib/xterm.js';
  const correct = 'lib/xterm.js\n// node_modules/@xterm/xterm/lib/xterm.js';

  assert.deepStrictEqual(prefixes(shipped), ['../wb-wrap-ui/node_modules/'],
    'the detector no longer flags the marker shape that actually shipped twice — '
    + 'the tests above are now green for the wrong reason');
  assert.deepStrictEqual(prefixes(correct), [],
    'the detector flags a correct root build, so it would fail on every clean '
    + 'bundle and be disabled within a week');
});

test('build-web pins the two esbuild options that keep the bundle portable', () => {
  // The tests above read the COMMITTED bundle, so they cannot see this
  // regression: drop the options, rebuild from the repo root, and the bundle is
  // still clean and still green — the defect only reappears later, for the next
  // hand who builds from a worktree and gets sent back over a file they built
  // correctly. That is the loop this ticket closed, so pin the cause.
  //
  // Both options, both esbuild calls. Measured from a worktree: with only
  // `preserveSymlinks` a subdirectory build writes `../node_modules/`, and with
  // only `absWorkingDir` the symlink escape is untouched. Neither is redundant.
  const src = fs.readFileSync(path.join(ROOT, 'build', 'build-web.js'), 'utf8');
  const calls = src.match(/esbuild\.build\(\{[\s\S]*?\n  \}\)/g) || [];
  assert.strictEqual(calls.length, 2,
    'build/build-web.js no longer has exactly two esbuild.build calls — this pin '
    + 'matched them by shape, so re-derive it rather than deleting it');
  for (const call of calls) {
    assert.match(call, /absWorkingDir:\s*ROOT/,
      'an esbuild.build call in build/build-web.js lost `absWorkingDir: ROOT`, so its '
      + 'source markers move with the invocation cwd and a build from a subdirectory '
      + 'embeds the build machine in the shipped bundle');
    assert.match(call, /preserveSymlinks:\s*true/,
      'an esbuild.build call in build/build-web.js lost `preserveSymlinks: true`, so it '
      + 'resolves through the ticket loop\'s worktree `node_modules` symlink and writes '
      + 'paths back into the original checkout');
  }
});
