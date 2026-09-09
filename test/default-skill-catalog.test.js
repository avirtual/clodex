'use strict';
// default-skill-catalog.test.js — the DEFAULTS skill list must offer every skill
// any seat on this box has discovered.
//
// The bug: `settings:skillCatalogFor` composed its own two-source union inline
// in the IPC handler while `readSkillCatalog` — the real composer — unioned
// five. A CLI-shipped-but-DISCOVERED skill (`design`, `dataviz`) is in neither
// static seed, so it reached the seat popover and never the defaults, and an
// operator could not pre-uncheck it before a spawn.
//
// The fixtures below plant a REAL transcript under a temp registry root and go
// through the real `createEngine` + the real `registerIpcHandlers`, because the
// composer's whole job is reading that file: a test that handed it a name list
// would assert the union operator works and prove nothing about the read.
//
// The skill names here are invented (`fixture-only-skill`), NOT `design`. A
// fixture that named the real one would pass off the static seed the day
// somebody "fixes" this by hardcoding a literal — which is the failure mode the
// spec forbids. Discovery is the property under test, not one skill's name.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('../engine');
const { registerIpcHandlers } = require('../ipc-handlers');
const { CLAUDE_SKILLS } = require('../catalogs');
const { mkTmpRoot } = require('./lib/tmp-roots');

const DISCOVERED = ['fixture-only-skill', 'plugin-ns:fixture-two'];
const SCOPED = ['fixture-scoped-skill'];

function listingLine(names, { initial }) {
  return JSON.stringify({
    type: 'attachment',
    attachment: {
      type: 'skill_listing',
      isInitial: initial,
      names,
      content: names.map((n) => (initial
        ? `- ${n}: does a thing`
        : `- ${n}: does a thing (from app/, applies when working on files under app/)`)).join('\n'),
    },
  });
}

// A seat with a transcript the sweep can find: run/<name>/transcript.jsonl is a
// SYMLINK in production (the SessionStart hook makes it), and both readers
// resolve it, so the fixture is a symlink too — a plain file would pass while
// the production path is a dangling link.
function plantSeat(registryDir, name, { lines, padBytes = 0 }) {
  const runDir = path.join(registryDir, 'run', name);
  fs.mkdirSync(runDir, { recursive: true });
  const real = path.join(registryDir, `${name}-real.jsonl`);
  const pad = padBytes
    ? `${JSON.stringify({ type: 'user', filler: 'x'.repeat(padBytes) })}\n`
    : '';
  fs.writeFileSync(real, pad + lines.map((l) => `${l}\n`).join(''));
  fs.symlinkSync(real, path.join(runDir, 'transcript.jsonl'));
}

function mkBox({ seats = [] } = {}) {
  const tmp = mkTmpRoot('clx-skill-catalog-');
  const registryDir = path.join(tmp, 'clodex-home');
  fs.mkdirSync(path.join(registryDir, 'run'), { recursive: true });
  for (const s of seats) plantSeat(registryDir, s.name, s);
  const engine = createEngine({
    userDataPath: tmp,
    seams: { registryDir },
    log: { info() {}, warn() {}, error() {} },
  });
  const handlers = new Map();
  registerIpcHandlers({
    ...engine,
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, warn() {}, error() {} },
  });
  return {
    tmp,
    registryDir,
    engine,
    defaults: (cwd = null) => handlers.get('settings:skillCatalogFor')(null, cwd),
    seat: (name) => handlers.get('session:skillCatalog')(null, name),
  };
}

const ROSTER_SEAT = {
  name: 'seat-one',
  lines: [
    JSON.stringify({ type: 'user', message: 'noise' }),
    listingLine([...DISCOVERED], { initial: true }),
    listingLine([...SCOPED], { initial: false }),
  ],
};

test('the defaults catalog offers a skill only a seat discovered', () => {
  const box = mkBox({ seats: [ROSTER_SEAT] });
  const res = box.defaults();
  assert.strictEqual(res.ok, true);
  // ENTER: the fixture's discovered names really are in the list the dialog
  // renders. Without this the absence assertions below are true of an empty
  // catalog, which is exactly the state the bug produced.
  for (const n of DISCOVERED) {
    assert.ok(res.names.includes(n), `defaults catalog is missing discovered '${n}': ${res.names.join(',')}`);
  }
});

test('the defaults catalog still carries the static seed', () => {
  const box = mkBox({ seats: [ROSTER_SEAT] });
  const names = box.defaults().names;
  for (const n of CLAUDE_SKILLS) assert.ok(names.includes(n), `seed name '${n}' dropped`);
});

test('the two paths agree on the seed + discovered union', () => {
  const box = mkBox({ seats: [ROSTER_SEAT] });
  const seatNames = box.seat(ROSTER_SEAT.name).names;
  const defaultNames = box.defaults().names;
  // The seat path additionally sees its OWN out-of-scope names; everything else
  // must match, so a third source added to one composer and not the other shows
  // up here as a difference rather than as a silently shorter dialog.
  assert.deepStrictEqual(
    defaultNames,
    seatNames.filter((n) => !SCOPED.includes(n)),
  );
  // ENTER: the difference the filter removes was really there — otherwise the
  // equality above holds trivially and this subject asserts nothing about scope.
  assert.deepStrictEqual(seatNames.filter((n) => SCOPED.includes(n)), [...SCOPED]);
});

test('the defaults path returns names only, not any seat per-session state', () => {
  const box = mkBox({ seats: [ROSTER_SEAT] });
  assert.deepStrictEqual(
    Object.keys(box.defaults()).sort(),
    ['canReenable', 'effective', 'names', 'ok', 'skillsLocked'],
  );
});

test('the seat path keeps the fields its popover renders', () => {
  const box = mkBox({ seats: [ROSTER_SEAT] });
  const res = box.seat(ROSTER_SEAT.name);
  assert.deepStrictEqual(
    Object.keys(res).sort(),
    ['allOff', 'canReenable', 'disabledSkills', 'effective', 'injectSkills', 'names',
      'ok', 'outOfScope', 'skillLib', 'skillsLocked'],
  );
  assert.deepStrictEqual(res.outOfScope, SCOPED.map((name) => ({ name, dir: 'app/' })));
  assert.strictEqual(res.allOff, false, 'an ordinary seat carries no sentinel');
});

test('t769: a seat carrying the `*` sentinel reports allOff, and never `*` as a skill name', () => {
  // `*` is not a skill. Left in `names` it renders as a checkbox row the operator
  // can tick, and the save would then write it back as an ordinary name — the
  // sentinel silently demoted to a skill nothing on the box is called.
  const box = mkBox({ seats: [ROSTER_SEAT] });
  box.engine.stores.persistence.upsert({
    name: ROSTER_SEAT.name, type: 'claude', cwd: box.tmp, workspaceId: 'default',
    disabledSkills: ['*'],
  });
  const res = box.seat(ROSTER_SEAT.name);
  assert.strictEqual(res.allOff, true);
  assert.ok(!res.names.includes('*'), `'*' must not be offered as a skill: ${res.names.join(',')}`);
  assert.ok(res.names.length > 0, 'ENTER: there are real names to have been filtered from');
  assert.deepStrictEqual(res.disabledSkills, ['*'],
    'the raw list still reaches the popover — the sentinel is what the record holds');
});

test('names discovered once survive the run dir going away', () => {
  const box = mkBox({ seats: [ROSTER_SEAT] });
  assert.ok(box.defaults().names.includes(DISCOVERED[0]));
  fs.rmSync(path.join(box.registryDir, 'run'), { recursive: true, force: true });
  // A SECOND engine over the same userData: a restart rebuilds every in-memory
  // cache, so a union held only in this process would answer an empty list here
  // and the defaults dialog would go back to the seed on a box with no seats.
  const engine2 = createEngine({
    userDataPath: box.tmp,
    seams: { registryDir: box.registryDir },
    log: { info() {}, warn() {}, error() {} },
  });
  const handlers = new Map();
  registerIpcHandlers({
    ...engine2,
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, warn() {}, error() {} },
  });
  const names = handlers.get('settings:skillCatalogFor')(null, null).names;
  for (const n of DISCOVERED) assert.ok(names.includes(n), `'${n}' lost across restart`);
});

test('a listing past the head bound is not read', () => {
  // The bound is a measured tradeoff, not an invariant of the format, so it gets
  // a subject that states it: a transcript whose only listing sits beyond 256 KiB
  // contributes nothing. If the CLI ever moves the listing, this reds and names
  // the reason rather than the defaults quietly losing a skill.
  const box = mkBox({
    seats: [{
      name: 'seat-deep',
      padBytes: 300 * 1024,
      lines: [listingLine(['far-past-the-bound'], { initial: true })],
    }],
  });
  assert.ok(!box.defaults().names.includes('far-past-the-bound'));
});

test('a seat with no transcript at all is skipped, not fatal', () => {
  const box = mkBox({ seats: [ROSTER_SEAT] });
  fs.mkdirSync(path.join(box.registryDir, 'run', 'seat-empty'), { recursive: true });
  const res = box.defaults();
  assert.strictEqual(res.ok, true);
  assert.ok(res.names.includes(DISCOVERED[0]));
});

// The engine leaves background timers running (proxy poll, pending poll); the
// same force-exit every other createEngine file uses.
test('done', () => { setImmediate(() => process.exit(0)); });
