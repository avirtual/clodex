'use strict';
// web-dist-fresh.test.js — the committed bundle must be what the current
// sources build.
//
// WHAT THIS IS AND IS NOT. `web-dist/index.html` is TRACKED and is what
// web-host.js serves to the browser frontend. Edit `renderer/web/*`, skip
// `npm run build:web`, commit: the source reads fixed and the suite stays green
// over a bundle that no longer matches it.
//
// It is NOT true that such a bundle ships. scripts/release.sh (T42) rebuilds it
// before its dirty-tree check, so a stale bundle dirties the tree and kills the
// release — do not re-solve that here, and do not let this file's existence
// suggest the ship path was ever open.
//
// The gap is the WINDOW: that guard fires at release, this one at merge. In
// between, the main branch carries a bundle that does not match its sources, and
// anything served from such a checkout (the ssh-installer deploy path) serves
// the old code while everyone believes the fix is live — which is what happened
// on t445. So the whole value is FAIL FAST: a 0.3s check moved from ship time to
// test time, next to the mistake.
//
// The mitigation this generalises was PER-SYMBOL — hand-written "symbol X is in
// the bundle" assertions, each added after an incident. Each covered its own
// symbol and nothing else; a byte comparison covers every symbol, including the
// ones nobody anticipated, so those pins were removed as redundant when this
// landed.
//
// WHY A FULL REBUILD IS AFFORDABLE HERE, and why it is trustworthy:
//   - it takes ~0.3s in-process (measured; no npm, no subprocess);
//   - it is byte-reproducible wherever it runs, which is the property
//     test/web-dist-portable.test.js establishes and pins (`absWorkingDir: ROOT`
//     + `preserveSymlinks: true` on both esbuild calls). Without that property
//     this comparison would be red on every machine and disabled within a week.
//
// IT WRITES NOTHING. `buildBundle()` returns the html string; the file write and
// the plugin-registry rewrite stay in build-web.js's `main()`. A test that built
// into `web-dist/` would REPAIR the staleness it exists to report — green, and
// the tree quietly dirty. A test that reassembled the html itself could not
// detect drift from build-web.js at all, since a second implementation of the
// build is exactly what it would be comparing against.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'web-dist', 'index.html');

// The version this bundle was built with, pinned EXACTLY (no caret) in
// package.json — see the version test below for why that pin is load-bearing.
const PINNED_ESBUILD = require(path.join(ROOT, 'package.json')).devDependencies.esbuild;

// Where two strings first differ, with a little context — a bundle is ~1.7MB and
// a diff of it is unreadable, while the offset plus the surrounding bytes names
// the drifted region in one line.
function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  if (i === n && a.length === b.length) return null;
  const show = (s) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 60));
  return `at byte ${i} of ${a.length}/${b.length}\n    committed: ${show(a)}\n    rebuilt:   ${show(b)}`;
}

test('esbuild is pinned to an exact version', () => {
  // The whole freshness check rests on the build being byte-reproducible, and
  // esbuild output can change between PATCH releases. Under a caret range a
  // contributor on a different 0.28.x gets a byte mismatch that is not a stale
  // bundle at all — a real failure and a false one, wearing the same message.
  // Pinning exactly is what keeps the freshness failure unambiguous, so it is
  // asserted here rather than trusted: a well-meant `npm update` restores the
  // caret in a heartbeat.
  assert.match(PINNED_ESBUILD, /^\d+\.\d+\.\d+$/,
    `package.json pins esbuild as "${PINNED_ESBUILD}" — a RANGE, not an exact `
    + 'version. esbuild output can differ between patch releases, so a range lets '
    + 'two contributors build byte-different bundles from identical sources and '
    + 'makes every failure of the freshness test below ambiguous. Drop the range '
    + 'specifier (keep package-lock.json in step).');
});

test('the installed esbuild is the pinned one', () => {
  // Run BEFORE the comparison so the ambiguous case is separated from the real
  // one by having its own name and its own message, rather than by a reader
  // guessing which of the two a byte mismatch meant. A stale install (pin
  // bumped, `npm install` not re-run) is the normal way to get here.
  const installed = require('esbuild').version;
  assert.strictEqual(installed, PINNED_ESBUILD,
    `esbuild ${installed} is installed but package.json pins ${PINNED_ESBUILD}. `
    + 'Run `npm install`. Until then the freshness test below is not meaningful: '
    + 'esbuild output can differ between patch releases, so it may be red over a '
    + 'bundle that is perfectly fresh.');
});

test('the committed web-dist bundle is what the current sources build', async () => {
  const { buildBundle } = require(path.join(ROOT, 'build', 'build-web.js'));
  const committed = fs.readFileSync(BUNDLE, 'utf8');
  const { html } = await buildBundle();

  const diff = firstDifference(committed, html);
  assert.strictEqual(diff, null,
    'web-dist/index.html is NOT what renderer/web/* + renderer/index.html '
    + 'currently build, so the browser frontend ships the OLD code while the '
    + 'sources read fixed and the rest of the suite stays green.\n'
    + `  Differs ${diff}\n`
    + '  Remedy: run `npm run build:web` (from anywhere) and COMMIT the '
    + 'regenerated web-dist/index.html.\n'
    + '  If a rebuild does not clear it, the bundle is not stale and the build '
    + 'is not reproducible: check `npm ls esbuild` against the package.json pin '
    + '(the two tests above cover the usual cause), and check that '
    + 'build/build-web.js still passes `absWorkingDir: ROOT` + '
    + '`preserveSymlinks: true` (test/web-dist-portable.test.js).');
});

test('the comparison separates a stale bundle from a fresh one', () => {
  // Guards the guard. The test above passes on a clean tree, so on its own it
  // cannot say whether it still SEPARATES the two cases — a comparison silently
  // reduced to something vacuous (comparing a value to itself, or a truncated
  // prefix) is green in exactly the same way, over a defect it no longer sees.
  const fresh = 'ok<script>\nconsole.log(1);\n</script>';
  const stale = fresh.replace('console.log(1)', 'console.log(2)');

  assert.strictEqual(firstDifference(fresh, fresh), null,
    'the comparison reports a difference between identical bytes — it would be '
    + 'red on every clean tree and disabled within a week');
  assert.match(String(firstDifference(fresh, stale)), /^at byte 23 of 36\/36\n/,
    'the comparison no longer sees a one-character source change, which is the '
    + 'exact shape of the bug it exists to catch');
  assert.ok(firstDifference(fresh, `${fresh}\n`),
    'and a bundle that is a strict PREFIX of the rebuild differs too — an early '
    + 'return on the shorter length would miss appended output entirely');
});

test('build-web exposes the assembly without performing the writes', () => {
  // The property that lets the test above run at all, pinned so a later
  // refactor cannot quietly take it back: requiring build-web must not build,
  // and buildBundle must not write. Fold the file write back into buildBundle
  // and this test's own module load starts rewriting the working tree.
  const src = fs.readFileSync(path.join(ROOT, 'build', 'build-web.js'), 'utf8');

  const start = src.indexOf('async function buildBundle(');
  const end = src.indexOf('async function main(');
  assert.ok(start > 0 && end > start,
    'build/build-web.js no longer defines buildBundle() ahead of main() — the '
    + 'freshness test cannot build without writing');
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /writeFileSync|mkdirSync|rmSync|writePluginRegistry/,
    'buildBundle() in build/build-web.js has regained a WRITE. It is called by '
    + 'test/web-dist-fresh.test.js, which must not mutate the working tree — a '
    + 'test that rebuilds web-dist/ repairs the staleness it exists to report '
    + 'and is green with the tree left dirty. Keep every write in main().');

  assert.match(src, /require\.main === module/,
    'build/build-web.js runs main() unconditionally at load, so merely requiring '
    + 'it performs a build and rewrites web-dist/');
});
