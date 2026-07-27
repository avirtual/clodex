'use strict';
// web-dist-portable.test.js — the bundle must not name the machine that built it.
//
// esbuild writes a source-marker comment naming each file it inlines, and the
// name is RELATIVE TO THE BUILD'S WORKING DIRECTORY. Build `web-dist/index.html`
// from the repo root and the markers read `node_modules/@xterm/xterm/lib/...`.
// Build it from a git worktree — which is exactly where a delegated hand does
// its work — and the same markers read `../wb-wrap-ui/node_modules/@xterm/...`,
// pointing back at the original checkout.
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
// Fix when this fails: `npm run build:web` FROM THE REPO ROOT, commit the
// regenerated bundle.

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
    + 'checkout and are meaningful on that machine alone. Remedy: run '
    + '`npm run build:web` from the repo root and commit the regenerated bundle.');
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
