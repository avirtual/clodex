'use strict';
// A retired role field must announce its inertness in the surface where someone
// is reasoning about roles — the roster — and it must not lie about the half of
// them that are still read.
//
// The harm this pins: `roles.reviewer.tools` enforced nothing (the real cap is
// REVIEWER_TOOL_CAP in session-manager.js, intersected with template tools) and
// read as authority for hours. loadManifest warned about it the whole time, into
// a console.warn in the main process — which team-manifest.js's own comment calls
// where a real error goes to hide. The classification existed; it had no reader.
//
// TWO PROPERTIES, and the second is the one that is easy to lose:
//  1. a role carrying a retired key says so under its own row;
//  2. a key that is retired but STILL READ never renders as inert. Getting that
//     wrong reprints, in the roster, the exact falsehood above — and its remedy
//     is worse than silence: told to "delete it", the reader loses a live opt-in.
//
// The classification is NOT re-derived here. loadManifest owns it; this asserts
// the roster renders what loadManifest measured, and that the console warns and
// the roster agree — the two rendering the same array is what makes them unable
// to drift, and a test that computed the partition itself would pin a third copy.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTeamManifest, formatRoster, HONORED_CUT_FIELDS } = require('../team-manifest');
const { mkTmpRoot } = require('./lib/tmp-roots');

function mkHome() {
  const home = mkTmpRoot('retired-roster-');
  fs.mkdirSync(path.join(home, 'teams'), { recursive: true });
  return home;
}

// Loads `manifest` as team "shop" and returns the manifest object plus every
// console.warn it emitted, so the roster can be checked against the warn text
// that has to keep agreeing with it.
function load(manifest) {
  const home = mkHome();
  const dir = path.join(home, 'teams', 'shop');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify(manifest));
  const tm = createTeamManifest({ fs, clodexHome: home });
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(String(m));
  let team;
  try { team = tm.loadManifest('shop'); } finally { console.warn = orig; }
  return { team, warns };
}

// This team's own shape (PRECHECK §6): one file exercising BOTH partitions.
// `hand.worktree: true` on a non-reserved role with no explicit dispatch is
// HONORED — it resolves dispatch:'worktree', so deleting it changes behaviour.
// Everything else here is inert. No `version` key, so it reads as v1.
const BOTH = () => ({
  root: '/r',
  lead: 'boss',
  roles: {
    lead: { prompt: 'clodex-team-lead' },
    hand: { template: 'hand-tmpl', brief: 'the hand', ephemeral: true, worktree: true },
    reviewer: { instantiate: 'subagent', prompt: 'clodex-team-reviewer' },
    // TWO inert keys on one role, which no other role here has. Without it the
    // "one line per role, not one per key" assertion below is satisfied by a
    // fixture where the two can't differ, and the plural grammar branch is never
    // rendered at all. The live team carries exactly this shape (PRECHECK 6).
    designer: { instantiate: 'session', ephemeral: true },
  },
});

test('loadManifest carries the classification off the load, so the roster need not re-derive it', () => {
  const { team } = load(BOTH());
  // ENTER: everything below reads `droppedFields`. If the plumbing were dropped,
  // an absent array would make the roster assertions vacuously "clean" instead of
  // failing — the classification would be back to warning into nobody.
  assert.ok(Array.isArray(team.droppedFields), 'the manifest carries the classification as data');

  // Whole-object compare, not a partial match: a status silently arriving as
  // undefined would read around every filter downstream, and `remedy: undefined`
  // renders as "write `undefined` instead" without any regex noticing.
  assert.deepStrictEqual(team.droppedFields, [
    { role: 'hand', field: 'ephemeral', remedy: null, status: 'ignored' },
    { role: 'hand', field: 'worktree', status: 'honored', remedy: 'dispatch: "worktree"' },
    { role: 'reviewer', field: 'instantiate', remedy: null, status: 'ignored' },
    { role: 'designer', field: 'instantiate', remedy: null, status: 'ignored' },
    { role: 'designer', field: 'ephemeral', remedy: null, status: 'ignored' },
  ]);

  // The normalized roles still carry no retired key: this rides BESIDE the def,
  // it does not re-admit the field into the schema.
  assert.ok(!('worktree' in team.roles.hand), 'the def itself is still normalized clean');
  assert.strictEqual(team.roles.hand.dispatch, 'worktree', 'and the honored key still took effect');
});

test('the roster names a retired field under the role that carries it, and says it configures nothing', () => {
  const { team } = load(BOTH());
  const roster = formatRoster(team, [], { seat: 'boss' });
  const lines = roster.split('\n');

  // ENTER: the role rows themselves must still be there. Every assertion below
  // is about a line printed UNDER one, so a roster that stopped rendering roles
  // would satisfy the "no false claim" checks by printing nothing at all.
  assert.ok(lines.some((l) => l.startsWith('- hand (')), 'the hand row is rendered');
  assert.ok(lines.some((l) => l.startsWith('- reviewer (')), 'the reviewer row is rendered');

  const inert = lines.filter((l) => /configures nothing/.test(l));
  // THREE roles carry inert keys and FOUR inert keys exist between them, so this
  // count can only hold if the fold is per role. A fixture where every role has
  // at most one inert key makes the two readings numerically identical.
  assert.strictEqual(inert.length, 3, 'one inert line per role that carries an inert key, not one per key');
  assert.ok(inert.some((l) => /hand\.ephemeral/.test(l)), 'hand.ephemeral is named');
  assert.ok(inert.some((l) => /reviewer\.instantiate/.test(l)), 'reviewer.instantiate is named');
  // Both grammar branches, which are the only conditional text in the feature.
  // The designer line carries two keys and must read `them`; the single-key rows
  // must read `it`. Anchored, so a line naming both words cannot satisfy either.
  const designerLine = inert.find((l) => /designer\./.test(l));
  assert.ok(designerLine, 'the designer row carries an inert line');
  assert.match(designerLine, /designer\.instantiate, designer\.ephemeral — this schema does not read them$/);
  assert.match(inert.find((l) => /hand\./.test(l)), /does not read it$/);

  // Under the row, not in a footnote at the bottom: a reader decides about a role
  // at its row, and a note after the decision does not change it.
  const handRow = lines.findIndex((l) => l.startsWith('- hand ('));
  const handInert = lines.findIndex((l) => /hand\.ephemeral/.test(l));
  assert.ok(handInert > handRow, 'the note follows the hand row');
  const nextRow = lines.findIndex((l, i) => i > handRow && /^- /.test(l));
  assert.ok(handInert < nextRow, 'and it comes before the NEXT role row, so it attaches to the right role');

  // The lead's own field is untouched, so the lead row must stay bare.
  const leadRow = lines.findIndex((l) => l.startsWith('- lead ('));
  assert.ok(!/retired/.test(lines[leadRow + 1]), 'a clean role gets no note');
});

test('a field that is retired but STILL READ never renders as inert', () => {
  const { team, warns } = load(BOTH());
  const roster = formatRoster(team, [], { seat: 'boss' });

  // ENTER: the honored partition is non-empty for this fixture. If the effect
  // test ever stopped honoring `worktree`, this whole test would pass by
  // asserting the absence of a claim about a key nothing classified.
  assert.ok(team.droppedFields.some((d) => d.status === 'honored' && d.field === 'worktree'),
    'ENTER: `worktree: true` on a plain role with no dispatch is measured as honored');

  const honoredLine = roster.split('\n').find((l) => /hand\.worktree/.test(l));
  assert.ok(honoredLine, 'the honored key is named in the roster');
  assert.ok(!/configures nothing/.test(honoredLine),
    'it must NOT read as inert — that is the falsehood this whole ticket exists to stop');
  assert.match(honoredLine, /STILL READ/);
  assert.match(honoredLine, /CHANGES BEHAVIOUR/);
  // The remedy comes from HONORED_CUT_FIELDS, not from a copy in the renderer: a
  // hardcoded "write dispatch instead" is wrong the moment the map holds two keys.
  assert.ok(honoredLine.includes(HONORED_CUT_FIELDS.get('worktree')),
    'it carries the remedy the map defines for THIS key');

  // The console and the roster must keep saying the same thing about the same
  // key. They render one array; this is what would catch them being split again.
  const honoredWarn = warns.find((w) => /STILL READ/.test(w));
  assert.ok(honoredWarn && /hand\.worktree/.test(honoredWarn), 'the warn names it too');
  const inertWarn = warns.find((w) => /IGNORED/.test(w));
  assert.ok(inertWarn && !/worktree/.test(inertWarn), 'and the inert warn does not claim it');
});

test('a role whose def is clean renders byte-identically to a manifest with no classification at all', () => {
  const clean = {
    root: '/r',
    lead: 'boss',
    roles: { lead: { prompt: 'p' }, hand: { template: 't', brief: 'b' }, reviewer: {} },
  };
  const { team, warns } = load(clean);

  // ENTER: a clean file classifies nothing and warns nothing. Without this, a
  // fixture that quietly carried a retired key would make the equality below a
  // comparison of two identically-annotated rosters.
  assert.deepStrictEqual(team.droppedFields, [], 'ENTER: nothing was classified');
  assert.deepStrictEqual(warns, [], 'ENTER: and nothing warned');

  for (const seat of ['boss', 'shop-hand', null]) {
    const opts = seat ? { seat } : {};
    const withField = formatRoster(team, [{ name: 'shop-hand', label: 'warm' }], opts);
    // The same team as every pre-existing caller builds one: a hand-made object
    // that has never been near loadManifest and carries no `droppedFields` key.
    const legacy = { ...team };
    delete legacy.droppedFields;
    const without = formatRoster(legacy, [{ name: 'shop-hand', label: 'warm' }], opts);
    assert.strictEqual(withField, without,
      `a clean team renders identically with and without the carrier (seat: ${seat})`);
    assert.ok(!/retired/.test(withField), 'and carries no retired line at all');
  }
});

test('an unknown key this schema never modelled stays out of the roster', () => {
  // Its warn is version-gated because it exists for the MIGRATION, not as a
  // linter (team-manifest's own reason). A hand-added key on today's schema is
  // covered by the legibility gate; printing it into every context reset forever
  // would make the roster a linter and would fire on files nobody asked us about.
  const { team } = load({
    root: '/r',
    lead: 'boss',
    version: 3,
    roles: { lead: { prompt: 'p' }, hand: { template: 't', notASchemaKey: 'x' } },
  });
  assert.deepStrictEqual(
    team.droppedFields,
    [{ role: 'hand', field: 'notASchemaKey', remedy: null, status: 'unknown' }],
    'ENTER: it IS classified — as unknown, distinct from the two retired statuses');

  const roster = formatRoster(team, [], { seat: 'boss' });
  assert.ok(!/notASchemaKey/.test(roster), 'but the roster does not name it');
  assert.ok(!/retired/.test(roster), 'and prints no retired line for it');
});
