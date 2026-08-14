'use strict';
// architecture-map-complete.test.js — t211: docs/architecture.md is CLAUDE.md's
// designated module map, so a module the map does not name is a module an agent
// orienting in this repo cannot find. This fails precisely when a module exists
// on disk and the map does not name it.
//
// WHAT "NAMED" MEANS HERE, AND WHAT IT DOES NOT. The check is a basename
// occurrence anywhere in the file, so a module mentioned only in a prose aside
// passes. That is deliberate and it is the ceiling of this test: it gates
// PRESENCE, never that the entry describes the module or sits under the right
// heading. Do not read a green run as "the map is accurate".
//
// The reducer here is a directory scan, and a scan that returns fewer files
// makes every "each member is present" assertion vacuously true — an empty scan
// makes the whole suite pass over a map naming nothing. So the population is
// pinned three ways before anything is asserted over it: a floor per directory,
// an ENTER list of known members, and a superset check against the file set git
// itself tracks (an oracle this test does not compute).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const MAP = path.join(REPO, 'docs', 'architecture.md');

// The mapped population: the two process graphs. Everything else in the tree
// (test/, scripts/, build/, cli/, docker/, renderer/web/) is tooling or a
// separate package, not part of "where does main/renderer code live".
const SCANNED_DIRS = ['.', 'renderer', 'renderer/lib', 'renderer/popovers'];

// Floors, not exact counts: an exact count is a compliance ratchet that has to
// be edited by every commit adding a file. These exist only to make a scan that
// silently collapses go red.
const FLOOR = { '.': 100, renderer: 10, 'renderer/lib': 25, 'renderer/popovers': 8 };

// ENTER: these must survive the scan before any assertion runs over it. One per
// scanned directory plus the shapes a filter is most likely to eat — a host
// adapter, a pure leaf, a deep-nested leaf.
const ENTER = [
  'engine.js',
  'main.js',
  'headless-main.js',
  'session-manager.js',
  'sandbox.js',
  'clodex-paths.js',
  'renderer/renderer.js',
  'renderer/peers-ui.js',
  'renderer/lib/format.js',
  'renderer/lib/web-shortcuts.js',
  'renderer/popovers/session-menus.js',
];

// filename -> why it is deliberately unmapped. An entry here must NOT also
// appear in the map: a stale exemption is the same rot in the other direction,
// and it is the direction nothing else would catch.
const EXEMPT = {};

function scanModules() {
  const out = [];
  for (const dir of SCANNED_DIRS) {
    const abs = path.join(REPO, dir);
    for (const name of fs.readdirSync(abs)) {
      if (!name.endsWith('.js')) continue;
      if (!fs.statSync(path.join(abs, name)).isFile()) continue;
      out.push(dir === '.' ? name : `${dir}/${name}`);
    }
  }
  return out.sort();
}

// A bare substring match reads `engine.js` out of `plugin-host-engine.js`, which
// would let a module go unmapped behind a longer name that contains it. Both
// boundaries are load-bearing: the lookbehind for the containing-name case, the
// lookahead so a prose mention of `tickets.json` cannot satisfy a `tickets.js`.
function namedIn(text, basename) {
  const esc = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_.\\-])${esc}(?![A-Za-z0-9])`).test(text);
}

const modules = scanModules();
const mapText = fs.readFileSync(MAP, 'utf8');

test('the scanned population is the tree, not an empty set', () => {
  for (const dir of SCANNED_DIRS) {
    const n = modules.filter((m) => (dir === '.' ? !m.includes('/') : path.dirname(m) === dir)).length;
    assert.ok(n >= FLOOR[dir], `${dir}: scanned ${n} modules, floor is ${FLOOR[dir]} — the scan collapsed`);
  }
  // ENTER: without this, a filter that drops one specific module leaves every
  // downstream assertion true about a population missing exactly it.
  for (const m of ENTER) {
    assert.ok(modules.includes(m), `ENTER: ${m} did not survive the scan`);
  }
  assert.deepStrictEqual(modules, [...new Set(modules)], 'scan produced duplicates');
  // EXEMPT and the presence check both key by BASENAME, so two same-named
  // modules in different scanned dirs would share one map mention and one
  // exemption — either could cover for the other silently. No collision exists
  // today; this fails the day one is introduced, at the point of introduction.
  const basenames = modules.map((m) => path.basename(m));
  const collisions = basenames.filter((b, i) => basenames.indexOf(b) !== i);
  assert.deepStrictEqual(
    collisions,
    [],
    'two scanned modules share a basename — key EXEMPT and the presence check by relative path first'
  );
});

test('the scan is a superset of what git tracks in the same directories', () => {
  // An oracle this test does not compute. Checked in one direction only: a
  // tracked file the scan missed is the vacuity bug; a scanned file git does not
  // track is a legitimately new, not-yet-added module.
  const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.js'], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((f) => SCANNED_DIRS.includes(path.dirname(f) === '.' ? '.' : path.dirname(f)));
  assert.ok(tracked.length >= 150, `git tracked only ${tracked.length} files in the scanned dirs`);
  const missed = tracked.filter((f) => !modules.includes(f));
  assert.deepStrictEqual(missed, [], 'git tracks these modules but the scan did not return them');
});

test('every module is named in docs/architecture.md or exempt with a reason', () => {
  const unmapped = [];
  for (const m of modules) {
    const basename = path.basename(m);
    if (Object.prototype.hasOwnProperty.call(EXEMPT, basename)) continue;
    if (!namedIn(mapText, basename)) unmapped.push(m);
  }
  assert.deepStrictEqual(
    unmapped,
    [],
    `docs/architecture.md names no such modules — add an entry, or an EXEMPT reason:\n  ${unmapped.join('\n  ')}`
  );
});

test('every EXEMPT entry carries a reason and is genuinely absent from the map', () => {
  const known = new Set(modules.map((m) => path.basename(m)));
  for (const [name, reason] of Object.entries(EXEMPT)) {
    assert.ok(known.has(name), `EXEMPT names ${name}, which is not in the scanned population`);
    assert.ok(
      typeof reason === 'string' && reason.trim().length > 0,
      `EXEMPT entry ${name} has no reason string`
    );
    assert.ok(
      !namedIn(mapText, name),
      `${name} is EXEMPT but IS named in docs/architecture.md — drop the stale exemption`
    );
  }
});
