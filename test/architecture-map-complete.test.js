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
//
// THE OTHER DIRECTION (t394). The scan above catches a module the map omits. It
// cannot catch a map ENTRY naming a module that no longer exists — a rename or a
// delete leaves a confident, well-formed entry pointing at nothing, and an agent
// orienting here trusts the map's prose over the tree. extractEntries() below
// closes that direction, and carries its own floor + ENTER for the same vacuity
// reason: it is a second reducer, and its assertion is also an absence.

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

// WHAT COUNTS AS AN ENTRY. The map claims a module exists by writing its BARE
// BASENAME (`session-manager.js`) — that is also the form the presence check
// above keys by. Once the map writes a PATH it is pointing somewhere else in the
// tree: `build/build-web.js`, `cli/src/import.js`, `test/*.test.js` are
// cross-references to populations this map does not own, so they are MENTIONS
// and a stale one is not this test's business.
//
// The reviewer proposed keying on the bold form (`**session-manager.js**`). It
// does not hold uniformly: the Popovers section presents its whole family as a
// backticked prose list (`report-panel.js`, `session-menus.js`, …), which are
// entries by intent, so bold-only would leave renderer/popovers unwatched in
// exactly the direction this test exists to watch. Bare-basename subsumes bold.
//
// Two path-qualified forms ARE entries — `renderer/renderer.js` and
// `renderer/peers-ui.js` — because their dirname is a scanned dir. The rule is
// the dirname, not a pair of special cases.
const ENTRY_TOKEN = /(?<![A-Za-z0-9_.\-/])([A-Za-z0-9_.\-/]+\.js)(?![A-Za-z0-9])/g;

// A name the map discusses in prose without claiming it lives here. Empty
// today: every bare non-test name in the map resolves to a real scanned module.
// An entry here must NOT resolve, for the same reason EXEMPT entries must not
// appear in the map — a stale escape hatch is rot wearing the shape of a rule.
const MENTION_ONLY = {};

// Floor, not an exact count — same reasoning as FLOOR. Only has to make a
// collapsed extraction go red.
const ENTRY_FLOOR = 120;

// ENTER: these must survive the extraction. Chosen as the shapes an extractor
// is most likely to eat — a bold entry, a backticked prose-list popover entry
// (the case that kills the bold-only rule), a path-qualified in-scan entry, a
// renderer/lib leaf, and a name containing another entry's name.
const ENTRY_ENTER = [
  'session-manager.js',
  'session-menus.js',
  'report-panel.js',
  'renderer/renderer.js',
  'renderer/peers-ui.js',
  'format.js',
  'plugin-host-engine.js',
];

// The negative half of ENTER: these appear in the map as .js tokens and must NOT
// be extracted as entries, or the test goes red on files it has no claim over.
const ENTRY_NOT = [
  'build/build-web.js',
  'cli/src/import.js',
  'test/free-identifier-leaks.test.js',
  'test/architecture-map-complete.test.js',
  'free-identifier-leaks.test.js',
];

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

// The map's claims that a module exists HERE. Returns the token as written, so a
// failure message points at the string a human has to go delete.
function extractEntries(text) {
  const out = new Set();
  for (const [, tok] of text.matchAll(ENTRY_TOKEN)) {
    if (tok.endsWith('.test.js')) continue; // test/ is not this map's population
    if (tok.includes('/')) {
      // Qualified: an entry only if it points inside the scanned population.
      if (!SCANNED_DIRS.includes(path.dirname(tok))) continue;
    }
    out.add(tok);
  }
  return [...out].sort();
}

const modules = scanModules();
const mapText = fs.readFileSync(MAP, 'utf8');
const entries = extractEntries(mapText);

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

test('the extracted entry set is the map\'s claims, not an empty set', () => {
  // extractEntries is a second reducer and the assertion downstream of it is an
  // ABSENCE, true of an empty extraction. Pin the extraction before using it.
  assert.ok(
    entries.length >= ENTRY_FLOOR,
    `extracted ${entries.length} entries from the map, floor is ${ENTRY_FLOOR} — the extractor collapsed`
  );
  for (const e of ENTRY_ENTER) {
    assert.ok(entries.includes(e), `ENTER: ${e} is written in the map but did not survive extraction`);
  }
  // The other half: an extractor that swallows the whole tree would also pass a
  // floor and an ENTER list, and would then fail on files this map never claimed.
  for (const e of ENTRY_NOT) {
    assert.ok(!entries.includes(e), `${e} is a MENTION, not an entry, but extraction claimed it`);
  }
  for (const [name, reason] of Object.entries(MENTION_ONLY)) {
    assert.ok(
      typeof reason === 'string' && reason.trim().length > 0,
      `MENTION_ONLY entry ${name} has no reason string`
    );
    assert.ok(
      !modules.some((m) => m === name || path.basename(m) === name),
      `${name} is MENTION_ONLY but DOES exist in the scanned population — drop the stale exclusion`
    );
  }
});

test('every module docs/architecture.md claims exists on disk', () => {
  // The direction the presence check cannot see: a rename or a delete leaves the
  // entry behind, well-formed and pointing at nothing.
  const known = new Set([...modules, ...modules.map((m) => path.basename(m))]);
  const stale = entries.filter(
    (e) => !known.has(e) && !Object.prototype.hasOwnProperty.call(MENTION_ONLY, e)
  );
  assert.deepStrictEqual(
    stale,
    [],
    `docs/architecture.md names these modules, which do not exist — the entry is stale, delete or correct it:\n  ${stale.join('\n  ')}`
  );
});
