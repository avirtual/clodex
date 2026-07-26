'use strict';
// packaging-allowlist.test.js — t39: `build.files` is an ALLOWLIST, and an
// allowlist fails SILENTLY.
//
// Three times now a tree the running app depends on was simply not in it:
//
//   1. `cli/`     — the app imports `cli/src/transport.js`. Resolved in dev,
//                   MODULE_NOT_FOUND in every DMG. Caught by hand, one merge
//                   from shipping.
//   2. `docs/`    — the frozen `hostApi "1"` plugin contract never reached the
//                   artifact. Nothing threw: an absent doc has no error to
//                   announce it, so it survived four phases of plugin work.
//   3. `peering/` — `ipc-handlers.js` reads `peering/clodex-deploy.sh` at
//                   runtime with no packaged-path branch. This one SHIPPED: the
//                   Test & Set Up wizard's install step failed with
//                   "deploy script unreadable: ENOENT" in v4.3.1.
//
// Three instances and two ad-hoc tests is not a guard. This file derives the
// dependency instead of restating the list.
//
// WHY THREE LAYERS AND NOT JUST A REQUIRE-SCAN. The obvious general form is to
// walk the module graph and check every file it reaches. Measured against the
// three real instances, that catches ONE. `docs/` is required by nothing;
// `peering/` is read with `fs.readFileSync`, not `require`. A module-graph-only
// guard would be green right now over instance 3 while carrying the authority of
// a general invariant — worse than the two explicit tests it replaced, because
// it would look like it covered the question.
//
//   Layer 1  module graph      — transitive local require() from the main-process
//                                entry points.                    (catches #1)
//   Layer 2  runtime asset reads — path.join(__dirname, '<tree>' …) in first-party
//                                main-process modules.             (catches #3)
//   Layer 3  exhaustive classification — every top-level directory is either
//                                covered by a pattern or EXCLUDED with a reason.
//                                                                  (catches #2)
//
// Layer 3 is not the enumerated list this file exists to replace. `docs/` is
// human-facing: nothing requires it and nothing reads it, so NO derivation can
// ever find it, and a derive-only guard is permanently and silently incomplete
// for that whole class. So the excluded set is what is listed — a tree nobody
// classified fails CLOSED. The cost is one line when a root is added to the repo.
//
// Cheap by construction: this reasons about patterns against the repo. It never
// packs anything and never runs a build.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PATTERNS = pkg.build.files;

// Entry points of the PACKAGED main process. `build.extraMetadata.main` names
// the first; preload is the other thing Electron loads directly.
const ENTRIES = ['main.js', 'preload.js'];

// Top-level directories that deliberately do NOT ship in the DMG. Each one is a
// decision with a reason, because "not shipped" and "forgotten" are
// indistinguishable from the outside — which is the whole bug this file is about.
const EXCLUDED = {
  'dist/': 'build output, gitignored — it IS the artifact',
  'docker/': 'Dockerfile for the headless image, built from a checkout, never read by the app',
  'tasks/': 'task artifacts and journals — development record, no runtime reader',
  'test/': 'the test suite does not ship',
  'vendor/': 'ships via build.extraResources (vendor/wirescope → Contents/Resources/wirescope), '
    + 'NOT via files: python cannot execute from inside the asar — wirescope-supervisor.js:113-117 '
    + 'branches on isPackaged() for exactly this reason',
  'web-dist/': 'the browser bundle is served by web-host.js, whose only caller is headless-main.js '
    + '(a Linux node from a git clone, or the docker/web image) — never the DMG',
};

// ---------------------------------------------------------------------------
// Pattern matching. electron-builder accepts a large glob vocabulary; this repo
// uses three shapes. Rather than depend on a matcher we do not declare (and
// could lose to a dependency bump), each shape is implemented explicitly AND any
// pattern that is not one of them fails the test — a new pattern shape gets a
// decision instead of a silent mis-match.
// ---------------------------------------------------------------------------

function classifyPattern(p) {
  if (p === '*.js') return { kind: 'rootGlob', ext: '.js' };
  if (/^[\w.-]+\/\*\*\/\*$/.test(p)) return { kind: 'tree', dir: p.slice(0, p.indexOf('/')) };
  if (/^[\w./@-]+$/.test(p) && !p.includes('*')) return { kind: 'literal', file: p };
  return { kind: 'unknown' };
}

// Files electron-builder ships regardless of `files`, so an allowlist miss on
// them is a false positive. Only one, and it is verified against a real artifact
// rather than taken from the docs:
//
//   npx asar list …/app.asar | grep -E '^/[^/]+\.json$'   →   /package.json
//
// (the packaged app cannot start without it — `build.extraMetadata.main` is
// written into this very file).
const IMPLICIT = new Set(['package.json']);

// Does any pattern cover this repo-relative file path?
function covers(rel) {
  const norm = rel.split(path.sep).join('/');
  if (IMPLICIT.has(norm)) return true;
  for (const p of PATTERNS) {
    const c = classifyPattern(p);
    // `*.js` matches ROOT files ONLY — not subdirectories. This is the exact
    // trap that hid instance 1: `cli/src/transport.js` looks covered at a glance.
    if (c.kind === 'rootGlob' && !norm.includes('/') && norm.endsWith(c.ext)) return true;
    if (c.kind === 'tree' && norm.startsWith(c.dir + '/')) return true;
    if (c.kind === 'literal' && norm === c.file) return true;
  }
  return false;
}

// Does any pattern reach INTO this top-level directory at all? Weaker than
// covers() on purpose: `build/` ships two named icons and nothing else, which is
// a classification, not an omission.
function touchesTree(dir) {
  for (const p of PATTERNS) {
    const c = classifyPattern(p);
    if (c.kind === 'tree' && c.dir === dir) return true;
    if (c.kind === 'literal' && c.file.startsWith(dir + '/')) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Layer 1 — the module graph.
// ---------------------------------------------------------------------------

function resolveLocal(fromRel, spec) {
  const base = path.resolve(path.dirname(path.join(ROOT, fromRel)), spec);
  for (const cand of [base, base + '.js', base + '.json', path.join(base, 'index.js')]) {
    try { if (fs.statSync(cand).isFile()) return path.relative(ROOT, cand); } catch {}
  }
  return null;
}

function moduleClosure(entries) {
  const RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    let m;
    RE.lastIndex = 0;
    // An unresolvable specifier is skipped rather than failed: the only ones in
    // this repo are inside comments describing code that no longer exists, and a
    // packaging test is the wrong place to police prose.
    while ((m = RE.exec(src)) !== null) {
      const r = resolveLocal(f, m[1]);
      if (r && !r.startsWith('..')) stack.push(r);
    }
  }
  return seen;
}

test('layer 1: every module the packaged app requires is covered by build.files', () => {
  const reached = moduleClosure(ENTRIES);
  assert.ok(reached.size > 50, `the closure walk found only ${reached.size} files — it is not walking the graph`);
  const missing = [...reached].filter((f) => !covers(f)).sort();
  assert.deepStrictEqual(missing, [],
    'these files are require()d by the packaged main process but NO build.files pattern '
    + `covers them, so the DMG throws MODULE_NOT_FOUND on first use: ${missing.join(', ')}. `
    + `Add the tree to build.files (patterns today: ${PATTERNS.join(', ')}).`);
});

// ---------------------------------------------------------------------------
// Layer 2 — runtime asset reads. The module graph cannot see these: a script or
// an icon is opened by path, not required.
// ---------------------------------------------------------------------------

function assetRefs() {
  const RE = /path\.join\(\s*__dirname\s*,\s*((?:['"][^'"]+['"]\s*,?\s*)+)\)/g;
  const dirs = new Set(fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git')
    .map((e) => e.name));
  const out = [];
  for (const f of fs.readdirSync(ROOT).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(src)) !== null) {
      const segs = m[1].match(/['"]([^'"]+)['"]/g).map((s) => s.slice(1, -1));
      if (!dirs.has(segs[0])) continue;   // not a repo tree (a userData path, etc.)
      out.push({ from: f, segs });
    }
  }
  return out;
}

test('layer 2: every repo tree read as a runtime asset is covered by build.files', () => {
  const refs = assetRefs();
  assert.ok(refs.length > 3, `found only ${refs.length} asset references — the scan is not working`);
  const bad = [];
  for (const r of refs) {
    // A reference that names a file is checked at file level; one that names
    // only a directory is checked at tree level. `build/` ships two named icons,
    // so file-level is the honest question to ask of app-menus.js.
    const rel = r.segs.join('/');
    const namesFile = /\.[a-z0-9]+$/i.test(r.segs[r.segs.length - 1]);
    const ok = namesFile ? covers(rel) : touchesTree(r.segs[0]);
    if (!ok && !EXCLUDED[r.segs[0] + '/']) bad.push(`${r.from} reads ${rel}`);
  }
  assert.deepStrictEqual(bad.sort(), [],
    'the app opens these paths at runtime but build.files does not ship them, so the '
    + `feature fails with ENOENT in the DMG while working in dev: ${bad.join('; ')}`);
});

// ---------------------------------------------------------------------------
// Layer 3 — exhaustive classification. The layer that catches a tree no
// derivation can reach.
// ---------------------------------------------------------------------------

test('layer 3: every top-level directory is either shipped or explicitly excluded', () => {
  const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git')
    .map((e) => e.name)
    .sort();
  const unclassified = dirs.filter((d) => !touchesTree(d) && !EXCLUDED[d + '/']);
  assert.deepStrictEqual(unclassified, [],
    'these top-level directories are neither covered by a build.files pattern nor listed in '
    + `EXCLUDED with a reason: ${unclassified.join(', ')}. `
    + 'Decide: if the app reads it at runtime add it to build.files; if it is development-only '
    + 'add it to EXCLUDED here with the reason. "Not shipped" and "forgotten" look identical '
    + 'from outside, which is the bug this file exists to prevent.');
});

test('layer 3: the EXCLUDED table has no stale entries', () => {
  // An excluded tree that was later deleted, or later added to build.files,
  // leaves a reason behind that is no longer true. A table nobody prunes is a
  // table nobody trusts.
  for (const key of Object.keys(EXCLUDED)) {
    const dir = key.replace(/\/$/, '');
    assert.ok(fs.existsSync(path.join(ROOT, dir)),
      `EXCLUDED lists ${key} but that directory no longer exists — drop the entry`);
    assert.ok(!touchesTree(dir),
      `EXCLUDED lists ${key} as deliberately not shipped, but build.files now ships it — `
      + 'one of the two is wrong');
  }
});

test('every build.files pattern is a shape this test understands', () => {
  // The matcher above implements three shapes. A pattern outside them would be
  // silently treated as covering nothing, which would turn this whole file into
  // a test that passes because it stopped looking.
  const unknown = PATTERNS.filter((p) => classifyPattern(p).kind === 'unknown');
  assert.deepStrictEqual(unknown, [],
    `build.files contains pattern shapes this test cannot evaluate: ${unknown.join(', ')}. `
    + 'Teach classifyPattern() the shape — until then the coverage checks above are '
    + 'silently weaker than they look.');
});
