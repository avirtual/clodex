'use strict';

// team-manifest: project/team resolution (teams-design.md [internal design doc, not in this repo]). Pure-leaf
// contract: teams live under ~/.clodex/teams/<name>/team.json (Bogdan ruling
// 2026-07-19 — zero clodex droppings in project repos); resolution is by the
// manifest's REQUIRED absolute `root` field containing a cwd, deepest wins.
// Real fs on tmpdirs (injected CLODEX_HOME) — the module takes fs injected,
// but its behavior is fs semantics, so test the real thing.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createTeamManifest, matchSeatRole, formatTeamBlock, formatRoster,
  formatCompositionDelta, STOCK_ROLE_DEFS, CUT_ROLE_FIELDS, HONORED_CUT_FIELDS, MANIFEST_VERSION,
} = require('../team-manifest');

// A fresh fake ~/.clodex per helper call, so tests don't cross-contaminate.
function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'team-home-'));
  fs.mkdirSync(path.join(home, 'teams'), { recursive: true });
  return home;
}

// Write teams/<name>/team.json. `manifest` may be an object or a raw string
// (to test non-JSON / bad shapes); undefined writes no file (missing manifest).
function mkTeam(home, name, manifest) {
  const dir = path.join(home, 'teams', name);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) {
    const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
    fs.writeFileSync(path.join(dir, 'team.json'), body);
  }
  return dir;
}

function validManifest(root) {
  return {
    root,
    lead: 'lead',
    roles: {
      lead: { template: 'fable-lead' },
      reviewer: { template: 'sonnet-review' },
      runner: { template: 'haiku-runner' },
    },
  };
}

test('resolveTeam finds the team whose root contains a nested cwd', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'shop', validManifest(root));
  const tm = createTeamManifest({ fs, clodexHome: home });

  const deep = path.join(root, 'src', 'lib', 'deep');
  const team = tm.resolveTeam(deep);
  assert.strictEqual(team.name, 'shop');
  assert.strictEqual(team.root, path.resolve(root));
  assert.strictEqual(team.lead, 'lead');
  assert.strictEqual(tm.resolveTeam(root).name, 'shop');
});

test('resolveTeam returns null when no team root contains the cwd', () => {
  const home = mkHome();
  mkTeam(home, 'shop', validManifest('/some/project'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  assert.strictEqual(tm.resolveTeam('/elsewhere/entirely'), null);
  assert.strictEqual(tm.resolveTeam(null), null);
});

test('resolveTeam picks the deepest root on nesting', () => {
  const home = mkHome();
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'outer-'));
  const inner = path.join(outer, 'packages', 'app');
  mkTeam(home, 'monorepo', validManifest(outer));
  mkTeam(home, 'app', validManifest(inner));
  const tm = createTeamManifest({ fs, clodexHome: home });
  // a cwd inside the inner root belongs to the deeper team, not the enclosing one
  assert.strictEqual(tm.resolveTeam(path.join(inner, 'src')).name, 'app');
  // a cwd only inside the outer root belongs to the outer team
  assert.strictEqual(tm.resolveTeam(path.join(outer, 'docs')).name, 'monorepo');
});

test('resolveTeam skips an invalid manifest instead of throwing', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'broken', 'not json {');           // invalid — must be skipped
  mkTeam(home, 'good', validManifest(root));
  const tm = createTeamManifest({ fs, clodexHome: home });
  assert.strictEqual(tm.resolveTeam(root).name, 'good');
});

test('findProjectRoot returns the plain root string (core-compatible)', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'shop', validManifest(root));
  const tm = createTeamManifest({ fs, clodexHome: home });
  const found = tm.findProjectRoot(path.join(root, 'src'));
  assert.strictEqual(typeof found, 'string');
  assert.strictEqual(found, path.resolve(root));
  // two resolutions of the same team compare equal by === (the retire check)
  assert.strictEqual(tm.findProjectRoot(root), tm.findProjectRoot(path.join(root, 'a', 'b')));
  assert.strictEqual(tm.findProjectRoot('/nowhere'), null);
});

test('listTeams lists team dirs, excludes dotfiles, empty when none', () => {
  const home = mkHome();
  mkTeam(home, 'a', validManifest('/p/a'));
  mkTeam(home, 'b', validManifest('/p/b'));
  fs.mkdirSync(path.join(home, 'teams', '.hidden'), { recursive: true });
  const tm = createTeamManifest({ fs, clodexHome: home });
  assert.deepStrictEqual(tm.listTeams(), ['a', 'b']);

  const empty = createTeamManifest({ fs, clodexHome: mkHome() });
  assert.deepStrictEqual(empty.listTeams(), []);
});

test('loadManifest applies defaults and returns name/root', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'shop', validManifest(root));
  const tm = createTeamManifest({ fs, clodexHome: home });
  const m = tm.loadManifest('shop');
  assert.strictEqual(m.name, 'shop');
  assert.strictEqual(m.root, path.resolve(root));
  assert.strictEqual(m.lead, 'lead');
  assert.strictEqual(m.roles.lead.template, 'fable-lead');
  assert.strictEqual(m.roles.reviewer.template, 'sonnet-review');
  assert.strictEqual(m.roles.lead.prompt, null, 'prompt defaults to null when absent');
  assert.strictEqual(m.version, 1, 'a file with no version IS a version-1 file');
});

test('loadManifest carries an optional role prompt through the shape', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'shop', {
    root, lead: 'lead',
    roles: {
      lead: { template: 'fable-lead', prompt: 'clodex-team-lead' },
      dev: { template: null }, // no prompt → null
    },
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const m = tm.loadManifest('shop');
  assert.strictEqual(m.roles.lead.prompt, 'clodex-team-lead');
  assert.strictEqual(m.roles.dev.prompt, null);
});

// team.json is agent-writable and version-1 files exist on disk carrying the five
// cut keys. A load that THREW on one would not read as "this role has a stale
// field" — every caller resolves teams inside a best-effort catch, so it reads as
// "this cwd is on no team" at every call site, and the whole team layer vanishes
// over a key nothing consumes. Warn and drop.
test('loadManifest: a version-1 file carrying the cut keys loads clean, dropping them', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'shop', {
    root, lead: 'lead', watchdogMs: 600000,
    roles: {
      lead: { template: 'fable-lead' },
      // Every cut field at once, including the `instantiate: subagent` that used
      // to be REQUIRED to be `session` on the lead role and would have thrown.
      reviewer: {
        template: 'sonnet-review', instantiate: 'subagent',
        tools: ['Read', 'Grep', 'Glob'], type: 'claude',
        standing: 'prompts/rev.md', ephemeral: true,
      },
    },
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const warned = [];
  const realWarn = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  let m;
  try { m = tm.loadManifest('shop'); } finally { console.warn = realWarn; }

  // WHOLE object: a partial probe would read right past a key that survived the
  // cut in the returned shape while the schema claims it is gone.
  assert.deepStrictEqual(m.roles.reviewer, {
    template: 'sonnet-review', prompt: null, brief: null, dispatch: 'standing', cwd: null,
  }, 'the cut keys are absent from the normalized def, not carried as null');
  assert.strictEqual(m.version, 1, 'no version field → version 1');
  assert.strictEqual(m.watchdogMs, 600000, 'watchdogMs override still carried');
  assert.strictEqual(warned.length, 1, 'ENTER: exactly one warning line was emitted');
  for (const k of ['instantiate', 'tools', 'type', 'standing', 'ephemeral']) {
    assert.match(warned[0], new RegExp(`reviewer\\.${k}`), `the warning names reviewer.${k}`);
  }
});

// The warn's two bounds, and `version`'s reason to exist. loadManifest has no
// cache and resolveTeam loads EVERY team on EVERY call — _sweepTickets runs it
// every 60s per live seat — so an ungated warn is a console line several times a
// minute, forever, for one legacy file. Bounded twice: deduped per (file, keys),
// and gated on version, which is what lets a rewrite clear it for good.
test('loadManifest: the drop warning is emitted once per key set, and a current-version file is silent', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'shop', {
    root, lead: 'lead',
    roles: { lead: {}, runner: { brief: 'r', tools: ['Read'] } },
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const warned = [];
  const realWarn = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    for (let i = 0; i < 5; i++) tm.loadManifest('shop');
  } finally { console.warn = realWarn; }
  assert.strictEqual(warned.length, 1, 'five loads of the same stale file warn ONCE, not five times');
  assert.match(warned[0], /runner\.tools/, 'ENTER: the warning is the one about the stale key under test');

  // A file that DECLARES the current version is silent even carrying an unknown
  // key: that is a hand-added key on today's schema (the legibility gate's job),
  // not the migration this warning exists for.
  const home2 = mkHome();
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home2, 'shop', {
    version: 3, root: root2, lead: 'lead',
    roles: { lead: {}, runner: { brief: 'r', invented: 'x' } },
  });
  const tm2 = createTeamManifest({ fs, clodexHome: home2 });
  const warned2 = [];
  console.warn = (msg) => warned2.push(String(msg));
  let m2;
  try { m2 = tm2.loadManifest('shop'); } finally { console.warn = realWarn; }
  assert.deepStrictEqual(warned2, [], 'a current-version file does not warn');
  assert.ok(!('invented' in m2.roles.runner), 'ENTER: the unknown key was still DROPPED — silence is not acceptance');
});

// A RETIRED field is not an unknown one, and the difference is the version gate.
// `tools: [...]` on a role reads as a capability restriction and enforces
// nothing — the reviewer's real cap is REVIEWER_TOOL_CAP in session-manager —
// and under the gate above a file stamped with the current version dropped it in
// total silence. That is the trap at its worst: the stamp makes the file look
// current while it still carries a field that reads as policy. So the cut-field
// warn is deliberately NOT version-gated.
test('loadManifest: a retired role field warns even on a CURRENT-version file, and says it is ignored', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'shop', {
    version: MANIFEST_VERSION, root, lead: 'lead',
    roles: { lead: {}, reviewer: { prompt: 'rev', tools: ['Read', 'Grep', 'Glob'] } },
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const warned = [];
  const realWarn = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  let m;
  try { m = tm.loadManifest('shop'); } finally { console.warn = realWarn; }

  assert.strictEqual(warned.length, 1, 'ENTER: the current-version file with a retired key DID warn');
  assert.match(warned[0], /reviewer\.tools/, 'the warning names the role and the field');
  assert.match(warned[0], /IGNORED/, 'it says the field is ignored, not merely that it was dropped');
  assert.match(warned[0], /enforces or configures nothing/, 'it says the field does nothing — the reason it misleads');
  assert.ok(warned[0].includes(path.join(home, 'teams', 'shop', 'team.json')), 'it names the file to edit');

  // Additive: the drop itself is unchanged. A warning that also started
  // preserving the field would hand a live restriction to code that ignores it.
  assert.deepStrictEqual(m.roles.reviewer, {
    template: null, prompt: 'rev', brief: null, dispatch: 'standing', cwd: null,
  }, 'the retired key is still dropped — the warning changed nothing about behaviour');
});

// Every member, not just `tools`: the next inert field is the next wasted round,
// and iterating the exported constant means a field added to it cannot ship
// silent. The VALUE is the honored one (`true`) rather than a placeholder — a
// value chosen so the compatibility branch cannot fire is how the first cut of
// this test pinned a message that was false for `worktree`.
test('loadManifest: every CUT_ROLE_FIELDS member warns on a current-version file, truthfully', () => {
  for (const field of CUT_ROLE_FIELDS) {
    const home = mkHome();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    mkTeam(home, 'shop', {
      version: MANIFEST_VERSION, root, lead: 'lead',
      roles: { lead: {}, runner: { brief: 'r', [field]: true } },
    });
    const tm = createTeamManifest({ fs, clodexHome: home });
    const warned = [];
    const realWarn = console.warn;
    console.warn = (msg) => warned.push(String(msg));
    let m;
    try { m = tm.loadManifest('shop'); } finally { console.warn = realWarn; }

    assert.strictEqual(warned.length, 1, `ENTER: a current-version file carrying "${field}" warned`);
    assert.match(warned[0], new RegExp(`runner\\.${field}`), `the warning names runner.${field}`);
    assert.ok(!(field in m.roles.runner), `"${field}" is still dropped from the normalized def`);

    // The partition, asserted from the constant rather than by naming the key:
    // a field promoted into HONORED_CUT_FIELDS later must not keep the
    // "enforces nothing" line just because this loop hardcoded the old split.
    // Keyed off the MEASURED effect, the same question the code asks — not off
    // membership, which only gates whether the question is worth asking. The
    // baseline is what the role normalizes to carrying no cut key at all, so
    // "took effect" means exactly "the def came out different".
    // Key ORDER matters here, not just membership: this is a stringify compare,
    // and normalizeRoleDef returns a fixed-key-order literal (`cwd` last).
    const changed = JSON.stringify(m.roles.runner)
      !== JSON.stringify({ template: null, prompt: null, brief: 'r', dispatch: 'standing', cwd: null });
    assert.strictEqual(changed, HONORED_CUT_FIELDS.has(field),
      `ENTER: seeded as \`true\` on a plain role, "${field}" ${HONORED_CUT_FIELDS.has(field) ? 'DID' : 'did not'} change the normalized def`);
    if (changed) {
      assert.doesNotMatch(warned[0], /enforces or configures nothing/,
        `"${field}" took effect here — the warning must not claim it does nothing`);
      assert.match(warned[0], /STILL READ/, `the "${field}" warning says it still takes effect`);
    } else {
      assert.match(warned[0], /IGNORED/, `the "${field}" warning says the field is ignored`);
    }
  }
});

// The trap this ticket's first cut walked into. `worktree: true` is the ONE cut
// key still resolved onto `dispatch`, so a warning telling a reader it changes
// nothing gets the key deleted and every worktree role silently becomes
// standing — hands landing in the shared checkout weeks later. Both versions are
// covered because v2 is the live migration population: those files carry
// `worktree: true` and used to receive the milder line.
for (const version of [MANIFEST_VERSION, 2]) {
  test(`loadManifest: \`worktree: true\` is warned as STILL READ, never as inert (version ${version})`, () => {
    const home = mkHome();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    mkTeam(home, 'shop', {
      version, root, lead: 'lead',
      roles: { lead: {}, hand: { brief: 'h', worktree: true } },
    });
    const tm = createTeamManifest({ fs, clodexHome: home });
    const warned = [];
    const realWarn = console.warn;
    console.warn = (msg) => warned.push(String(msg));
    let m;
    try { m = tm.loadManifest('shop'); } finally { console.warn = realWarn; }

    // The compatibility branch really fired — without this the assertion below
    // would pass over a fixture where `worktree` was inert after all, which is
    // exactly how the false message shipped green the first time.
    assert.strictEqual(m.roles.hand.dispatch, 'worktree',
      'ENTER: the key under test IS honored — it resolved onto dispatch');
    assert.strictEqual(warned.length, 1, 'exactly one line was emitted');
    assert.match(warned[0], /hand\.worktree/, 'the warning names the role and the field');
    assert.doesNotMatch(warned[0], /enforces or configures nothing/,
      'the inert-field wording must never be emitted for a key that is still read');
    assert.match(warned[0], /STILL READ/, 'it says the key still takes effect');
    assert.match(warned[0], /CHANGES BEHAVIOUR/, 'it warns that deleting the key is not safe');
    assert.match(warned[0], /dispatch: "worktree"/, 'it names the replacement to write instead');
  });
}

// The other half of the same sentence, and the round-2 defect pointing the other
// way. `worktree` is honored ONLY as an exact `true`, on a non-reserved role,
// with no explicit `dispatch` — so these three occurrences are inert, and the
// STILL READ line would be false for each. Its remedy is the harm: told to
// "write dispatch: \"worktree\" instead", the owner of a `worktree: false` role
// converts a standing role into one that mints branches nobody asked for, and
// the owner of a reserved role hand-authors a value assertDispatchAllowed
// refuses at every write path.
for (const [label, roleName, def, why] of [
  ['a false value', 'helper', { worktree: false }, 'only an exact `true` is read'],
  ['a reserved role', 'lead', { worktree: true }, 'lead/reviewer never honored the legacy key'],
  ['an explicit dispatch', 'hand', { worktree: true, dispatch: 'standing' }, 'an explicit dispatch wins'],
]) {
  test(`loadManifest: an INERT \`worktree\` (${label}) gets the ignored line, never the still-read one`, () => {
    const home = mkHome();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    mkTeam(home, 'shop', {
      version: MANIFEST_VERSION, root, lead: 'lead',
      roles: { lead: {}, ...{ [roleName]: def } },
    });
    const tm = createTeamManifest({ fs, clodexHome: home });
    const warned = [];
    const realWarn = console.warn;
    console.warn = (msg) => warned.push(String(msg));
    let m;
    try { m = tm.loadManifest('shop'); } finally { console.warn = realWarn; }

    // The occurrence really IS inert — without this the wording assertions could
    // pass over a fixture where the branch fired after all.
    assert.strictEqual(m.roles[roleName].dispatch, 'standing',
      `ENTER: the key did not take effect here (${why})`);
    assert.strictEqual(warned.length, 1, 'exactly one line was emitted');
    assert.match(warned[0], new RegExp(`${roleName}\\.worktree`), 'the warning names the role and the field');
    assert.doesNotMatch(warned[0], /CHANGES BEHAVIOUR/,
      'an inert occurrence must not be described as one whose deletion changes behaviour');
    assert.doesNotMatch(warned[0], /write `dispatch/,
      'and must not carry a remedy that would CHANGE the role');
    assert.match(warned[0], /IGNORED/, 'it gets the inert line, which is true of it');
  });
}

// A v1 file with one retired and one never-modeled key emits TWO lines, not one:
// the populations carry contradictory messages and a refactor that merges them
// would have to make one of the two texts false.
test('loadManifest: retired and unknown keys on one file warn separately', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'shop', {
    root, lead: 'lead',
    roles: { lead: {}, runner: { brief: 'r', tools: ['Read'], invented: 'x' } },
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const warned = [];
  const realWarn = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  let m;
  try { m = tm.loadManifest('shop'); } finally { console.warn = realWarn; }

  assert.strictEqual(warned.length, 2, 'ENTER: two lines, one per population');
  assert.ok(warned.some((w) => /runner\.tools/.test(w) && /IGNORED/.test(w)), 'the retired key got the retired line');
  assert.ok(warned.some((w) => /runner\.invented/.test(w) && /no longer models/.test(w)), 'the unknown key got the unknown line');
  assert.ok(!('tools' in m.roles.runner) && !('invented' in m.roles.runner), 'both keys still dropped');
});

// Same bound as the unknown-key warn: loadManifest has no cache and resolveTeam
// loads every team on every call, so an ungated line is console spam forever.
// The two warns are deduped under NAMESPACED keys — sharing a key would let a
// file whose unknown and retired sets stringify alike silence one of them.
test('loadManifest: the retired-field warning is emitted once per file, and a clean manifest is silent', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'shop', {
    version: MANIFEST_VERSION, root, lead: 'lead',
    roles: { lead: {}, runner: { brief: 'r', tools: ['Read'] } },
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const warned = [];
  const realWarn = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    for (let i = 0; i < 5; i++) tm.loadManifest('shop');
  } finally { console.warn = realWarn; }
  assert.strictEqual(warned.length, 1, 'five loads of the same file warn ONCE, not five times');
  assert.match(warned[0], /runner\.tools/, 'ENTER: the one line is the retired-field warning under test');

  // A manifest carrying no retired field says nothing — the warn must not
  // become background noise every team pays on every resolve.
  const home2 = mkHome();
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home2, 'shop', {
    version: MANIFEST_VERSION, root: root2, lead: 'lead',
    roles: { lead: {}, runner: { brief: 'r', dispatch: 'worktree' } },
  });
  const tm2 = createTeamManifest({ fs, clodexHome: home2 });
  const warned2 = [];
  console.warn = (msg) => warned2.push(String(msg));
  let m2;
  try { m2 = tm2.loadManifest('shop'); } finally { console.warn = realWarn; }
  assert.deepStrictEqual(warned2, [], 'a clean current-version manifest is silent');
  assert.strictEqual(m2.roles.runner.dispatch, 'worktree', 'ENTER: the clean file really did load its role');
});

// `version`'s consumer, end to end: a legacy file warns until a mutator rewrites
// it clean, then goes quiet permanently. Without the migration the drop is merely
// suppressed; with it the system heals, which is the whole argument for the field
// existing at all under a rule that forbids declarations nothing reads.
//
// THE REAL SHAPE, not a convenient one. The v1 stock scaffold put the cut keys on
// `reviewer` — this fixture is the operator's own live team.json — and every
// mutator refuses the reserved roles. A migration that only cleans the role being
// edited can therefore never fire on the one file that motivated the warning:
// `reviewer` stays stale forever, `clean` stays false forever, and the mechanism
// is inert while claiming to be self-healing.
test('a mutator migrates EVERY role off the cut fields, including reserved ones, and stamps', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const file = path.join(home, 'teams', 'shop', 'team.json');
  mkTeam(home, 'shop', {
    root, lead: 'clodex',
    roles: {
      lead: { prompt: 'clodex-team-lead' },
      hand: { template: 'clodex-hand-seat', prompt: 'clodex-team-hand', ephemeral: true, worktree: true },
      // Reserved AND stale: unreachable by addRole, setRole, removeRole and
      // renameRole alike. If this role does not heal, nothing does.
      reviewer: { instantiate: 'subagent', prompt: 'clodex-team-reviewer', tools: ['Read', 'Grep', 'Glob'] },
      designer: { instantiate: 'session', ephemeral: true, template: 'fable-design' },
    },
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    assert.strictEqual(tm.loadManifest('shop').version, 1, 'ENTER: starts as a version-1 file');
    const before = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.ok('tools' in before.roles.reviewer && 'instantiate' in before.roles.reviewer,
      'ENTER: the reserved role genuinely carries the cut keys on disk to begin with');
    // A mutation on an UNRELATED, non-reserved role: the migration must not
    // require touching the stale role, because the stale role cannot be touched.
    tm.setRole('shop', 'designer', { brief: 'designs things' });
  } finally { console.warn = realWarn; }

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepStrictEqual(onDisk.roles.reviewer, { prompt: 'clodex-team-reviewer' },
    'the RESERVED role healed: the cut keys left the file even though no mutator may address it');
  assert.deepStrictEqual(onDisk.roles.hand,
    { template: 'clodex-hand-seat', prompt: 'clodex-team-hand', dispatch: 'worktree' },
    'ephemeral is gone from hand; the worktree opt-in survived as the dispatch enum');
  assert.deepStrictEqual(onDisk.roles.designer,
    { template: 'fable-design', brief: 'designs things' },
    'the edited role took the patch and lost its cut keys');
  assert.strictEqual(onDisk.version, 3, 'and the file now declares the schema it was rewritten against');

  const warned = [];
  console.warn = (msg) => warned.push(String(msg));
  try { tm.loadManifest('shop'); } finally { console.warn = realWarn; }
  assert.deepStrictEqual(warned, [], 'the healed file is silent forever, not merely deduped for this process');
});

// The migration is NAMED, not derived. A hand-authored key outside the cut set is
// data we do not model but were never asked to delete — deriving the strip as
// "anything not in ROLE_KEYS" would turn a migration into data loss, and would
// also stamp a file that still carries something a reader drops.
test('the migration strips only the NAMED cut fields, leaving hand-authored keys and the stamp off', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const file = path.join(home, 'teams', 'shop', 'team.json');
  mkTeam(home, 'shop', {
    root, lead: 'lead',
    roles: { lead: {}, runner: { brief: 'r' }, other: { brief: 'o', tools: ['Read'], customField: 'keepme' } },
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const realWarn = console.warn;
  console.warn = () => {};
  try { tm.setRole('shop', 'runner', { brief: 'r2' }); } finally { console.warn = realWarn; }

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(onDisk.roles.runner.brief, 'r2', 'ENTER: the edit landed');
  assert.deepStrictEqual(onDisk.roles.other, { brief: 'o', customField: 'keepme' },
    'the cut key went; the unmodeled hand-authored one stayed');
  assert.ok(!('version' in onDisk),
    'and the file does not claim to be migrated while it still carries a key every reader drops');
});

// The lead role specifically: `instantiate: subagent` on it was a hard throw.
test('loadManifest: a version-1 lead role with instantiate: subagent no longer throws', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'shop', { root, lead: 'lead', roles: { lead: { instantiate: 'subagent' } } });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const realWarn = console.warn;
  console.warn = () => {};
  let m;
  try { m = tm.loadManifest('shop'); } finally { console.warn = realWarn; }
  assert.strictEqual(m.name, 'shop', 'the team still resolves — a stale key must not take the team layer down');
  assert.ok(!('instantiate' in m.roles.lead), 'the key is dropped, not honored');
});

// Whole-object, not a field probe: normalizeRoleDef builds the def every
// downstream consumer reads, so a field that silently stops being emitted (or
// arrives undefined rather than false) reads as "not opted in" at every call
// site — indistinguishable from a real opt-out.
test('loadManifest: role dispatch normalizes to the enum, default standing', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'shop', {
    root, lead: 'lead',
    roles: {
      lead: {},
      hand: { dispatch: 'worktree' },
      helper: {},
    },
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const m = tm.loadManifest('shop');
  assert.deepStrictEqual(m.roles.hand, {
    template: null, prompt: null, brief: null, dispatch: 'worktree', cwd: null,
  }, 'opted-in role def in full');
  assert.deepStrictEqual(m.roles.helper, {
    template: null, prompt: null, brief: null, dispatch: 'standing', cwd: null,
  }, 'absent dispatch is the STANDING string, not undefined — undefined reads as neither value at a consumer that compares');
  // An off-enum value is a loud manifest error, not a truthy opt-in:
  // `dispatch: "no"` must never enable the thing it plainly denies, and
  // `dispatch: true` must not be laundered by the boolean this replaced.
  for (const bad of ['no', true, 'Worktree']) {
    const h = mkHome();
    mkTeam(h, 'shop', { root, lead: 'lead', roles: { lead: {}, hand: { dispatch: bad } } });
    assert.throws(() => createTeamManifest({ fs, clodexHome: h }).loadManifest('shop'),
      /dispatch must be one of standing, worktree/, `dispatch: ${JSON.stringify(bad)} must throw`);
  }
});

// The regression that shipped and had to be caught against real data: migration
// runs on mutator WRITES, so a v2 team.json nobody edits is read by loadManifest
// exactly as it sits. If the READER does not understand the legacy key, every
// role that opted into a worktree dispatches to a standing seat instead — with
// no warning, because `standing` is a legitimate value. NO MUTATOR IS CALLED IN
// THIS TEST; that absence is the whole point.
test('loadManifest: an UNMIGRATED v2 `worktree: true` dispatches to a worktree without any write', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const file = path.join(home, 'teams', 'shop', 'team.json');
  mkTeam(home, 'shop', {
    version: 2,
    root, lead: 'lead',
    roles: {
      lead: { prompt: 'clodex-team-lead' },
      hand: { template: 'clodex-hand-seat', worktree: true },
      helper: { worktree: false },
      quiet: {},
    },
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const realWarn = console.warn;
  console.warn = () => {};
  let m;
  try { m = tm.loadManifest('shop'); } finally { console.warn = realWarn; }

  assert.strictEqual(m.roles.hand.dispatch, 'worktree',
    'an unmigrated opt-in must still dispatch to a worktree — otherwise merging this schema '
    + 'silently stops every live hand role getting a tree, which is the data loss the '
    + 'cut-outright option was rejected for');
  // The negatives keep this from being "always worktree": a role that opted OUT,
  // and one that never carried the key, must both read as standing.
  assert.strictEqual(m.roles.helper.dispatch, 'standing', '`worktree: false` reads as standing');
  assert.strictEqual(m.roles.quiet.dispatch, 'standing', 'a role without the key reads as standing');
  // A reserved role's stale opt-in is NOT honored, matching migrateRoles: it was
  // already inert at dispatch, so reading it now would invent an opt-in.
  assert.strictEqual(m.roles.lead.dispatch, 'standing', 'a reserved role never reads as a worktree role');

  // ENTER, asserted AFTER the load so it also proves the read did not rewrite:
  // the file must still be the untouched v2 fixture. A loadManifest that quietly
  // migrated on disk would make every assertion above true for the wrong reason.
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(onDisk.version, 2, 'ENTER: the file is still a v2 file — no write happened');
  assert.strictEqual(onDisk.roles.hand.worktree, true,
    'ENTER: the legacy key is still on disk and was READ, not migrated');
  assert.ok(!('dispatch' in onDisk.roles.hand), 'ENTER: nothing wrote the new key to the file');
});

// An explicit `dispatch` is the authority when both keys are present: the legacy
// read is a fallback for files that predate the enum, never an override of one.
test('loadManifest: an explicit dispatch wins over a stale `worktree` boolean', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'shop', {
    version: 2, root, lead: 'lead',
    roles: {
      lead: {},
      // The contradiction a half-finished hand-edit leaves behind.
      hand: { worktree: true, dispatch: 'standing' },
      other: { worktree: false, dispatch: 'worktree' },
    },
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const realWarn = console.warn;
  console.warn = () => {};
  let m;
  try { m = tm.loadManifest('shop'); } finally { console.warn = realWarn; }
  assert.strictEqual(m.roles.hand.dispatch, 'standing', 'the enum wins, not the legacy boolean');
  assert.strictEqual(m.roles.other.dispatch, 'worktree', 'and in the other direction too');
});

// The regression the version-3 migration exists to prevent. `worktree` is in
// CUT_ROLE_FIELDS, so the migration DELETES it; if that delete runs before the
// carry-over, every role that opted into a worktree silently becomes standing —
// no throw, no warning, and the only symptom is hands landing in the shared
// checkout weeks later.
test('v2 → v3: a role\'s `worktree: true` carries over to dispatch BEFORE the cut delete', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const file = path.join(home, 'teams', 'shop', 'team.json');
  mkTeam(home, 'shop', {
    version: 2,
    root, lead: 'lead',
    roles: {
      lead: { prompt: 'clodex-team-lead' },
      hand: { template: 'clodex-hand-seat', worktree: true },
      helper: { worktree: false },
      quiet: {},
    },
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const before = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(before.roles.hand.worktree, true,
    'ENTER: the fixture is a v2 file whose hand role genuinely opted in on disk — without that key this test migrates nothing and every assertion below is vacuous');

  // Stubbed like every other v2-fixture test here: the load emits a real drop
  // line for the legacy keys, which is noise in the run output, not a finding.
  const realWarn = console.warn;
  console.warn = () => {};
  try { tm.setRole('shop', 'quiet', { brief: 'unrelated edit' }); } finally { console.warn = realWarn; }

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepStrictEqual(onDisk.roles.hand, { template: 'clodex-hand-seat', dispatch: 'worktree' },
    'the opt-in became the enum and the old key left the file');
  assert.deepStrictEqual(onDisk.roles.helper, {},
    '`worktree: false` migrates to ABSENT, not to an explicit "standing" — absent already reads as standing');
  assert.deepStrictEqual(onDisk.roles.quiet, { brief: 'unrelated edit' },
    'a role that never carried the key gains nothing');
  assert.strictEqual(onDisk.version, 3, 'the file declares the schema it was rewritten against');

  // The behavioural half: it is not enough that the KEY moved — the migrated
  // role must still resolve as a worktree role at the dispatch gate.
  const m = tm.loadManifest('shop');
  assert.strictEqual(m.roles.hand.dispatch, 'worktree',
    'the migrated hand role still dispatches to a worktree — this is the assertion the delete-before-carry bug fails');
  assert.strictEqual(m.roles.helper.dispatch, 'standing', 'the opted-out role reads as standing');
});

// Reserved roles were excluded at DISPATCH before this ticket, so `worktree: true`
// on lead/reviewer was already a claim that did nothing. Carrying it into a schema
// whose front door refuses to write it would migrate a lie into a stricter world.
test('v2 → v3: a reserved role\'s `worktree: true` is dropped, not carried', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const file = path.join(home, 'teams', 'shop', 'team.json');
  mkTeam(home, 'shop', {
    version: 2,
    root, lead: 'lead',
    roles: {
      lead: { worktree: true },
      reviewer: { worktree: true, prompt: 'clodex-team-reviewer' },
      hand: {},
    },
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).roles.lead.worktree, true,
    'ENTER: the reserved role genuinely carries the opt-in on disk to begin with');

  tm.setRole('shop', 'hand', { brief: 'x' });

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepStrictEqual(onDisk.roles.lead, {}, 'lead lost the key without gaining a dispatch value');
  assert.deepStrictEqual(onDisk.roles.reviewer, { prompt: 'clodex-team-reviewer' },
    'reviewer likewise — its other fields are untouched');
  assert.strictEqual(tm.loadManifest('shop').roles.lead.dispatch, 'standing',
    'the reserved role reads as standing, which is what it already behaved as');
});

// The front door must refuse what the resolver already refuses, or team.json
// grows values that read as policy and do nothing.
test('addRole/setRole/createTeam refuse a worktree dispatch on a reserved role', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'lead' });

  assert.throws(() => tm.addRole('shop', 'reviewer', { dispatch: 'worktree', prompt: 'clodex-team-reviewer' }),
    /operator-owned|standing/, 'reviewer cannot be defined as a worktree role');
  assert.throws(() => tm.setRole('shop', 'lead', { dispatch: 'worktree' }),
    /operator-owned/, 'setRole bounces every reserved-role edit already');

  const home2 = mkHome();
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'proj2-'));
  assert.throws(() => createTeamManifest({ fs, clodexHome: home2 }).createTeam({
    name: 'shop2', root: root2, lead: 'lead', roles: { lead: { dispatch: 'worktree' } },
  }), /cannot dispatch to a worktree/, 'a brand-new file cannot be BORN naming lead a worktree role');

  // An ordinary role is the control: the refusal is about the reserved key, not
  // about the value, and a blanket refusal would pass every assertion above.
  const m = tm.addRole('shop', 'runner', { dispatch: 'worktree' });
  assert.strictEqual(m.roles.runner.dispatch, 'worktree', 'an ordinary role takes the value');
});

// The legacy key is readable on the LOAD path but must never enter through a
// WRITE. pickRoleKeys drops it and emits no `dispatch`, so without this throw the
// call stores a STANDING role and answers {ok:true} — the caller's opt-in
// discarded with no error anywhere, which is the exact failure shape this ticket
// exists to end.
test('addRole refuses the legacy `worktree` key rather than silently dropping it', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'lead' });

  assert.throws(() => tm.addRole('shop', 'runner', { worktree: true }),
    /"worktree" was replaced by "dispatch"/,
    'the refusal names the replacement — a bare "unknown field" would leave the caller guessing');
  // `worktree: false` is refused too: it is equally a caller believing in a key
  // that no longer exists, and accepting it would teach that the key still works.
  assert.throws(() => tm.addRole('shop', 'runner2', { worktree: false }),
    /"worktree" was replaced by "dispatch"/);
  // Nothing was written by either refusal.
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'teams', 'shop', 'team.json'), 'utf-8'));
  assert.ok(!raw.roles.runner && !raw.roles.runner2, 'the refused roles did not land on disk');

  // The control: the same intent spelled the new way succeeds, so the throw is
  // about the dead key and not about worktree dispatch in general.
  assert.strictEqual(tm.addRole('shop', 'runner', { dispatch: 'worktree' }).roles.runner.dispatch, 'worktree');
});

test('setRole refuses an off-enum dispatch, naming the field', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'lead' });
  tm.addRole('shop', 'runner', {});
  assert.throws(() => tm.setRole('shop', 'runner', { dispatch: 'sometimes' }),
    /dispatch must be one of standing, worktree/);
  // And the legitimate values land, both directions — a refusal that also
  // refused the good values would satisfy the throw above.
  assert.strictEqual(tm.setRole('shop', 'runner', { dispatch: 'worktree' }).roles.runner.dispatch, 'worktree');
  assert.strictEqual(tm.setRole('shop', 'runner', { dispatch: 'standing' }).roles.runner.dispatch, 'standing');
});

test('loadManifest rejects bad shapes with pointed errors', () => {
  const home = mkHome();
  const tm = createTeamManifest({ fs, clodexHome: home });
  let i = 0;
  for (const [manifest, rx] of [
    ['not json {', /not valid JSON/],
    [[], /must be an object/],
    [{ lead: 'lead', roles: {} }, /"root" must be an absolute path/],       // missing root
    [{ root: 'relative/path', lead: 'lead', roles: {} }, /"root" must be an absolute path/],
    [{ root: '/p', roles: {} }, /"lead" must be a seat name/],
    [{ root: '/p', lead: 'x y', roles: {} }, /"lead" must be a seat name/],
    [{ root: '/p', lead: 'lead', roles: [] }, /"roles" must be an object/],
    [{ root: '/p', lead: 'lead', roles: { dev: {} } }, /roles must include a "lead" role/],
    [{ root: '/p', lead: 'lead', roles: { lead: {}, 'bad name': {} } }, /role name "bad name"/],
    [{ root: '/p', lead: 'lead', roles: { lead: { template: 42 } } }, /template must be a string/],
    [{ root: '/p', lead: 'lead', roles: { lead: { prompt: 42 } } }, /prompt must be a string/],
    [{ root: '/p', lead: 'lead', roles: { lead: { brief: 42 } } }, /brief must be a string/],
    [{ root: '/p', lead: 'lead', roles: { lead: { dispatch: 'yes' } } }, /dispatch must be one of standing, worktree/],
    // NOTE: the five cut fields are NOT here. A bad value on a key the schema no
    // longer models is dropped with a warning, not thrown — see the version-1
    // compatibility tests above. Adding a throw back here would take the team
    // layer down on exactly the old files that motivated the drop.
    //
    // NOTE: watchdogMs no longer THROWS on a bad value — it's CLAMPED at consume
    // (T29 C3): a hand-written bad value must never break a team's resolution.
    // See the dedicated clamp test below.
  ]) {
    const name = `bad-${i++}`;
    mkTeam(home, name, manifest);
    assert.throws(() => tm.loadManifest(name), rx, JSON.stringify(manifest));
  }
});

test('loadManifest on a missing manifest names the path', () => {
  const home = mkHome();
  mkTeam(home, 'empty', undefined); // dir exists, no team.json
  const tm = createTeamManifest({ fs, clodexHome: home });
  assert.throws(() => tm.loadManifest('empty'), /no team manifest at .*team\.json/);
});

test('cwdInProject: membership is root-or-under, not prefix-string', () => {
  const tm = createTeamManifest({ fs, clodexHome: mkHome() });
  assert.ok(tm.cwdInProject('/a/b', '/a/b'));
  assert.ok(tm.cwdInProject('/a/b/c/d', '/a/b'));
  assert.ok(!tm.cwdInProject('/a/bb', '/a/b')); // prefix trap
  assert.ok(!tm.cwdInProject('/a', '/a/b'));
  assert.ok(!tm.cwdInProject(null, '/a/b'));
  assert.ok(!tm.cwdInProject('/a/b', null));
});

// --- worktree membership -----------------------------------------------------
// A team is a REPOSITORY, not a path. git's default worktree location is a
// SIBLING of the repo (`<repo>/../<repo>-<branch>`), so pure path containment
// excluded every worktree — a seat working in one fell off its team, and the
// lead saw "no live seat yet", a timing message for a membership fault.
// Real git is required (not a fixture) because the thing under test is the exact
// on-disk shape git writes: a `.git` FILE holding `gitdir: <main>/.git/worktrees/<id>`.

const { execFileSync } = require('child_process');

function mkRepoWithWorktree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-team-'));
  // Real paths: macOS /tmp is a symlink to /private/tmp, and git writes the
  // RESOLVED path into the .git file. Comparing against the unresolved one would
  // fail for a reason that has nothing to do with membership.
  const root = fs.realpathSync(base);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const g = (...args) => execFileSync('git', ['-C', repo, ...args], {
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  g('init', '-q');
  g('commit', '-q', '--allow-empty', '-m', 'init');
  g('worktree', 'add', '-q', path.join(root, 'wt-a'), '-b', 'feat-a');
  return { root, repo, worktree: path.join(root, 'wt-a') };
}

test('cwdInProject: a git worktree of the repo is ON the team, and a foreign repo is not', () => {
  const { root, repo, worktree } = mkRepoWithWorktree();
  const tm = createTeamManifest({ fs, clodexHome: mkHome() });

  // ENTER: the fixture must have produced git's linked-worktree shape (a .git
  // FILE, not a dir). If git ever changed this, every assertion below would still
  // pass for the wrong reason — the walk would find nothing and fall through.
  assert.ok(fs.lstatSync(path.join(worktree, '.git')).isFile(),
    'ENTER: linked worktree must carry a .git FILE — the fixture built the wrong shape');

  assert.ok(tm.cwdInProject(worktree, repo), 'a worktree of the repo is on the team');
  const deep = path.join(worktree, 'deep', 'er');
  fs.mkdirSync(deep, { recursive: true });
  assert.ok(tm.cwdInProject(deep, repo), 'a SUBDIR of a worktree resolves too');

  // The negatives are what keep this from being "return true": the worktree's own
  // parent holds both trees, and an unrelated repo must not join by proximity.
  assert.ok(!tm.cwdInProject(root, repo), 'the shared parent is not a member');
  assert.ok(!tm.cwdInProject(worktree, path.join(root, 'other-repo')),
    'a worktree does not join a DIFFERENT repo that merely sits nearby');

  fs.rmSync(root, { recursive: true, force: true });
});

test('cwdInProject: a plain directory containing a .git FILE does not smuggle membership', () => {
  const tm = createTeamManifest({ fs, clodexHome: mkHome() });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-fake-')));
  const repo = path.join(root, 'repo');
  const impostor = path.join(root, 'impostor');
  fs.mkdirSync(repo); fs.mkdirSync(impostor);
  // A `.git` file whose gitdir is NOT under .git/worktrees/ — a submodule points
  // this way. It must not resolve to a main checkout.
  fs.writeFileSync(path.join(impostor, '.git'), `gitdir: ${path.join(repo, '.git', 'modules', 'x')}\n`);
  assert.ok(!tm.cwdInProject(impostor, repo), 'a submodule-shaped .git file is not a worktree');
  fs.writeFileSync(path.join(impostor, '.git'), 'not a gitdir line at all\n');
  assert.ok(!tm.cwdInProject(impostor, repo), 'an unparseable .git file resolves to nothing');
  fs.rmSync(root, { recursive: true, force: true });
});

// --- spawn-time team context (matchSeatRole + formatTeamBlock) --------------
// The pure pieces behind session-manager's spawn-time injection, ROLE-KEYED
// schema: bind a seat to its role (the lead SEAT → `lead` role; other seats via
// the `<team>-<role>` convention with `-N` collision stripping), and render the
// per-seat-invariant identity block (roster listing moved OUT to a data message).

const teamFixture = () => ({
  name: 'shop', root: '/Users/me/shop', lead: 'boss',
  roles: {
    lead: { template: 'fable-lead', prompt: null, brief: null, dispatch: 'standing' },
    hand: { template: null, prompt: null, brief: null, dispatch: 'standing' },
    reviewer: { template: 'sonnet-review', prompt: null, brief: null, dispatch: 'standing' },
  },
});

test('matchSeatRole: lead seat, <team>-<role> convention, -N suffix, non-member', () => {
  const team = teamFixture();
  assert.strictEqual(matchSeatRole(team, 'boss'), 'lead');          // lead SEAT → lead role
  assert.strictEqual(matchSeatRole(team, 'shop-hand'), 'hand');     // <team>-<role>
  assert.strictEqual(matchSeatRole(team, 'shop-hand-2'), 'hand');   // -N collision suffix stripped
  assert.strictEqual(matchSeatRole(team, 'shop-reviewer'), 'reviewer');
  assert.strictEqual(matchSeatRole(team, 'hand'), null);            // bare role name is NOT a member
  assert.strictEqual(matchSeatRole(team, 'shop-nobody'), null);     // derived key names no role
  assert.strictEqual(matchSeatRole(team, 'random-seat'), null);     // no prefix, not the lead
  assert.strictEqual(matchSeatRole(null, 'boss'), null);
  assert.strictEqual(matchSeatRole(team, ''), null);
});

// F008. The test above ENUMERATES seat-name forms, and the enumeration reads as
// coverage — but `<team>-<role>N` (no hyphen) is not in it, and that was the
// form that resolved to nothing while looking perfectly conventional. What the
// suffix rule structurally EXCLUDES is the question; these are the exclusions.
test('matchSeatRole: a numeric suffix strips with or without a separator, and an exact role name wins (F008)', () => {
  const team = teamFixture();
  assert.strictEqual(matchSeatRole(team, 'shop-hand2'), 'hand');    // the form that used to vanish
  assert.strictEqual(matchSeatRole(team, 'shop-hand12'), 'hand');
  assert.strictEqual(matchSeatRole(team, 'shop-hand_4'), 'hand');
  assert.strictEqual(matchSeatRole(team, 'shop-hand-3'), 'hand');   // the form that already worked, unbroken

  // A NON-numeric tail names a different thing. Resolution must not guess: the
  // `-wire` scheme was proposed as the workaround for this very bug and has the
  // identical defect, which is worth pinning so it stays a null and not a
  // surprise `hand`.
  assert.strictEqual(matchSeatRole(team, 'shop-hand-wire'), null);
  assert.strictEqual(matchSeatRole(team, 'shop-2'), null);          // digits only: no key left

  // `-rN` is the one LETTERED tail that strips, and only ahead of the numeric
  // one: a ticket's reviewer is `<team>-reviewer-<ticket>-r<round>`, so both
  // tails must go or the key keeps the ticket number and resolves to nothing.
  // A role-less reviewer drops off the roster, loses its role prompt and slips
  // past the fail-CLOSED _roleInUse guard.
  assert.strictEqual(matchSeatRole(team, 'shop-reviewer-337-r1'), 'reviewer');
  assert.strictEqual(matchSeatRole(team, 'shop-reviewer-337-r12'), 'reviewer');
  assert.strictEqual(matchSeatRole(team, 'shop-hand-337-r2'), 'hand');
  // Still only DIGITS after the `r`, and still not a general escape.
  assert.strictEqual(matchSeatRole(team, 'shop-reviewer-337-rx'), null);
  assert.strictEqual(matchSeatRole(team, 'shop-r1'), null);         // the round alone is no key

  // A role may legitimately end in a digit. Stripping first would resolve its
  // own seat to a DIFFERENT role, which is worse than not resolving at all.
  const digitRole = teamFixture();
  digitRole.roles.hand2 = { template: null, prompt: null, brief: null, dispatch: 'standing' };
  assert.strictEqual(matchSeatRole(digitRole, 'shop-hand2'), 'hand2');
  assert.strictEqual(matchSeatRole(digitRole, 'shop-hand2-2'), 'hand2');
  assert.strictEqual(matchSeatRole(digitRole, 'shop-hand3'), 'hand');

  // Roles come from JSON.parse, so the roles object carries Object's prototype:
  // a membership test that walks it would hand back a role that is a function.
  assert.strictEqual(matchSeatRole(team, 'shop-toString'), null);
  assert.strictEqual(matchSeatRole(team, 'shop-constructor'), null);
});

test('formatTeamBlock: shrunk identity block with role match (lead seat)', () => {
  const block = formatTeamBlock(teamFixture(), 'boss');
  assert.match(block, /^# Team$/m);
  assert.match(block, /You are seat boss on team shop \(root \/Users\/me\/shop\)\. Your role: lead\./);
  assert.match(block, /Team composition arrives in your context; ground truth: \[agent:exec clodex-team\] \{"action":"roster","agent":"boss"\}/);
  // The roster listing moved OUT — no "Roles:" line in the invariant block.
  assert.ok(!/Roles:/.test(block), 'roster listing no longer in the system-prompt block');
});

test('formatTeamBlock: role match via the <team>-<role> naming convention', () => {
  const block = formatTeamBlock(teamFixture(), 'shop-hand');
  assert.match(block, /You are seat shop-hand on team shop/);
  assert.match(block, /Your role: hand\./);
});

test('formatTeamBlock: a seat that matches no role reports the none-case', () => {
  const block = formatTeamBlock(teamFixture(), 'wanderer');
  assert.match(block, /Your role: none — not a manifest role/);
});

// The exact caller expression session-manager uses at the spawn callsite:
// resolveTeam(cwd) → a block when the cwd is inside a team root, '' when not.
test('spawn-callsite: block present when cwd-in-team, absent when not', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'shop', validManifest(root));
  const tm = createTeamManifest({ fs, clodexHome: home });

  const block = (cwd, name) => {
    const team = tm.resolveTeam(cwd);
    return team ? formatTeamBlock(team, name) : '';
  };
  // cwd inside the team root → a real block naming the seat + team.
  const inside = block(path.join(root, 'src'), 'shop-reviewer');
  assert.match(inside, /# Team/);
  assert.match(inside, /on team shop/);
  assert.match(inside, /Your role: reviewer/);
  // cwd on no team → empty string (the concat at the callsite becomes a no-op).
  assert.strictEqual(block('/elsewhere/entirely', 'shop-reviewer'), '');
});

// --- spawn-callsite: role prompt appended after the team block --------------
// Models session-manager's assembly EXACTLY: resolveTeam → formatTeamBlock,
// then when the matched role names a `prompt` library entry, read
// ~/.clodex/library/prompts/system/<name>.md (REGISTRY_DIR) best-effort and
// append it AFTER the block. Order is team block ("who you're with") then role
// prompt ("how you operate"); a missing/unreadable prompt file is skipped
// silently and the block still stands.
test('spawn-callsite: role prompt rides after the team block, best-effort', () => {
  const home = mkHome();
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  // A team whose reviewer role names a prompt, plus a dev role that names none.
  mkTeam(home, 'shop', {
    root, lead: 'lead',
    roles: {
      lead: { template: 'fable-lead' },
      dev: { template: null }, // no prompt
      reviewer: { template: 'sonnet-review', prompt: 'clodex-team-reviewer' },
      ghost: { prompt: 'no-such-prompt' }, // names a prompt whose file is absent
    },
  });
  // Seed just the reviewer prompt into the fake library.
  const sysDir = path.join(registryDir, 'library', 'prompts', 'system');
  fs.mkdirSync(sysDir, { recursive: true });
  fs.writeFileSync(path.join(sysDir, 'clodex-team-reviewer.md'), 'REVIEWER STANDING PROMPT');
  const tm = createTeamManifest({ fs, clodexHome: home });

  // The exact assembly session-manager runs at the spawn callsite.
  const assemble = (cwd, name) => {
    const team = tm.resolveTeam(cwd);
    if (!team) return '';
    let teamBlock = formatTeamBlock(team, name);
    const role = matchSeatRole(team, name);
    const def = role ? team.roles[role] : null;
    if (def && def.prompt) {
      try {
        const promptFile = path.join(registryDir, 'library', 'prompts', 'system', `${def.prompt}.md`);
        const rolePrompt = fs.readFileSync(promptFile, 'utf-8');
        if (rolePrompt) teamBlock = `${teamBlock}\n\n${rolePrompt}`;
      } catch { /* skip — block still stands */ }
    }
    return teamBlock;
  };

  // (a) role WITH a prompt → block first, then the prompt content after it.
  const withPrompt = assemble(path.join(root, 'src'), 'shop-reviewer');
  assert.match(withPrompt, /# Team/);
  assert.match(withPrompt, /Your role: reviewer/);
  assert.match(withPrompt, /REVIEWER STANDING PROMPT$/);
  assert.ok(withPrompt.indexOf('# Team') < withPrompt.indexOf('REVIEWER STANDING PROMPT'),
    'team block precedes the role prompt');

  // (b) role WITHOUT a prompt → team block only, no prompt content appended.
  const noPrompt = assemble(path.join(root, 'src'), 'shop-dev');
  assert.match(noPrompt, /Your role: dev/);
  assert.ok(!noPrompt.includes('REVIEWER STANDING PROMPT'));
  assert.strictEqual(noPrompt, formatTeamBlock(tm.resolveTeam(root), 'shop-dev'),
    'no-prompt role assembles to exactly the team block');

  // (c) role names a prompt whose FILE is missing → block still present, no throw.
  const missing = assemble(path.join(root, 'src'), 'shop-ghost');
  assert.match(missing, /# Team/);
  assert.match(missing, /Your role: ghost/);

  // (d) off-manifest seat → unchanged: team block only, no prompt read at all.
  const offManifest = assemble(path.join(root, 'src'), 'wanderer');
  assert.match(offManifest, /Your role: none — not a manifest role/);
  assert.ok(!offManifest.includes('REVIEWER STANDING PROMPT'));
});

// --- createTeam: the front door's write path -------------------------------
test('createTeam writes the default manifest and adopts the lead seat', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  const team = tm.createTeam({ name: 'shop', root, lead: 'clodex' });
  // Returned manifest: lead SEAT adopted, default lead + hand + reviewer roles
  // present (T26 scaffold — a fresh team is briefed out of the box).
  assert.strictEqual(team.name, 'shop');
  assert.strictEqual(team.root, path.resolve(root));
  assert.strictEqual(team.lead, 'clodex');
  assert.strictEqual(team.roles.lead.prompt, 'clodex-team-lead');
  assert.ok(team.roles.lead.brief, 'lead gets a stock brief');
  assert.strictEqual(team.roles.hand.prompt, 'clodex-team-hand');
  assert.strictEqual(team.roles.reviewer.prompt, 'clodex-team-reviewer');
  // The reviewer's read-only cap is REVIEWER_TOOL_CAP in session-manager, a code
  // constant on the one spawn path that can enforce it. A scaffolded `tools:`
  // here restated it as data the manifest looked authoritative over and wasn't.
  assert.ok(!('tools' in team.roles.reviewer), 'the cap is code, not a scaffolded field');
  assert.strictEqual(team.version, 3, 'a freshly written manifest carries the current version');
  // The lead SEAT binds to the lead role; <team>-<role> seats bind hand/reviewer.
  assert.strictEqual(matchSeatRole(team, 'clodex'), 'lead');
  assert.strictEqual(matchSeatRole(team, 'shop-hand'), 'hand');
  assert.strictEqual(matchSeatRole(team, 'shop-reviewer'), 'reviewer');
  // On-disk it's valid JSON and re-loads identically (atomic write left no tmp).
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'teams', 'shop', 'team.json'), 'utf-8'));
  assert.strictEqual(onDisk.lead, 'clodex');
  assert.deepStrictEqual(
    fs.readdirSync(path.join(home, 'teams', 'shop')).filter((f) => f.startsWith('.')),
    [], 'no leftover .tmp file after the atomic rename',
  );
});

test('createTeam honors caller-supplied roles over the default scaffold', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  // A caller passing its own non-empty roles map wins — the scaffold defaults
  // (hand + reviewer tools) must NOT be merged in.
  const team = tm.createTeam({
    name: 'shop', root, lead: 'clodex',
    roles: { lead: { prompt: 'my-lead' }, runner: { prompt: 'my-runner' } },
  });
  assert.strictEqual(team.roles.lead.prompt, 'my-lead');
  assert.strictEqual(team.roles.runner.prompt, 'my-runner');
  assert.ok(!('hand' in team.roles), 'scaffold hand not injected when caller supplies roles');
  assert.ok(!('reviewer' in team.roles), 'scaffold reviewer not injected when caller supplies roles');
  // An empty roles map falls back to the default scaffold (not honored as "no roles").
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const team2 = tm.createTeam({ name: 'shop2', root: root2, lead: 'clodex', roles: {} });
  assert.strictEqual(team2.roles.hand.prompt, 'clodex-team-hand', 'empty roles → default scaffold');
});

test('createTeam refuses a duplicate name, a duplicate exact root, and a bad name', () => {
  const home = mkHome();
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root: rootA, lead: 'clodex' });
  // (1) duplicate team name.
  assert.throws(() => tm.createTeam({ name: 'shop', root: rootB, lead: 'x' }), /already exists/);
  // (2) duplicate EXACT root (a different name, same root) — nesting would be OK.
  assert.throws(() => tm.createTeam({ name: 'other', root: rootA, lead: 'x' }), /already owns root/);
  // A nested (deeper) root is fine — resolveTeam's deepest-root rule disambiguates.
  assert.doesNotThrow(() => tm.createTeam({ name: 'nested', root: path.join(rootA, 'sub'), lead: 'x' }));
  // (3) team name off the session charset.
  assert.throws(() => tm.createTeam({ name: 'bad name', root: rootB, lead: 'x' }), /must match/);
});

// --- addRole: the join path (no-op-if-equal / refuse-if-differs) ------------
test('addRole appends a new role, no-ops on an identical def, refuses a divergent one', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' });

  // First hand joins → the `hand` role is appended from the stock def.
  let team = tm.addRole('shop', 'hand', { ...STOCK_ROLE_DEFS.hand });
  assert.ok(team.roles.hand, 'hand role added');
  assert.strictEqual(team.roles.hand.prompt, 'clodex-team-hand');
  assert.strictEqual(matchSeatRole(team, 'shop-hand'), 'hand');

  // Second hand joins with the SAME def → no-op, no throw, role unchanged.
  assert.doesNotThrow(() => { team = tm.addRole('shop', 'hand', { ...STOCK_ROLE_DEFS.hand }); });
  assert.strictEqual(team.roles.hand.prompt, 'clodex-team-hand');

  // A join that would REDEFINE an existing role is refused — joins never mutate.
  assert.throws(
    () => tm.addRole('shop', 'hand', { prompt: 'something-else' }),
    /already exists on team "shop" with a different definition/,
  );

  // A bad def field still throws through the shared schema, naming the file.
  assert.throws(() => tm.addRole('shop', 'runner', { brief: 42 }), /brief must be a string/);
  // Adding to a missing team throws.
  assert.throws(() => tm.addRole('nope', 'hand', {}), /no team manifest/);
});

// --- addRole guards: C1 (MF1) never mints an operator-owned key; C4 (MF2) ----
// pins template to a bare NAME. The join path re-rides the stock reviewer def
// (no-op-if-equal), but an absent reserved key must never be CREATED by a
// lead-supplied def — the spec's C1 attack via a hand-deleted key.
test('addRole refuses to MINT lead/reviewer when the key is absent (C1), no-ops a matching stock re-join', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' });
  const file = path.join(home, 'teams', 'shop', 'team.json');

  // A re-join of the stock reviewer def that's ALREADY on disk is a no-op (the
  // existing-and-equal branch), NOT a mint — must not be blocked by the C1 guard.
  // The `tools` here is a version-1 caller (an older clodex-team, a stale script)
  // re-riding the stock def: it must still resolve to the no-op, since the cut key
  // normalizes away on both sides rather than making the defs differ.
  const stockReviewer = { ...STOCK_ROLE_DEFS.reviewer, tools: ['Read', 'Grep', 'Glob'] };
  assert.doesNotThrow(() => tm.addRole('shop', 'reviewer', stockReviewer));

  // Hand-delete the reviewer key (team.json is agent-writable; loadManifest only
  // REQUIRES `lead`), then a lead-authored role-add tries to forge it → REFUSED.
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  delete raw.roles.reviewer;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  assert.throws(
    () => tm.addRole('shop', 'reviewer', { prompt: 'rubber-stamp' }),
    /operator-owned topology/,
    'minting an absent reviewer key is the C1 attack — refused',
  );
  // Symmetric guard on lead (a hand-deleted lead already fails loadManifest, but
  // the mint refusal is symmetric). Re-load a manifest missing lead is invalid,
  // so re-add lead to a fresh team and prove the mint refusal fires the same way.
  const raw2 = JSON.parse(fs.readFileSync(file, 'utf-8'));
  raw2.roles.reviewer = stockReviewer; // restore so loadManifest is valid again
  delete raw2.roles.lead;              // ...but now lead is gone
  fs.writeFileSync(file, JSON.stringify(raw2, null, 2));
  // loadManifest itself now throws (required lead) — addRole surfaces that first.
  assert.throws(() => tm.addRole('shop', 'lead', { prompt: 'x' }), /roles must include a "lead" role|operator-owned topology/);
});

test('addRole (C4/MF2) rejects a template that is not a bare library-template NAME', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' });
  // A path-shaped template (what the \S+ scanner token would let through) is refused.
  assert.throws(() => tm.addRole('shop', 'runner', { template: '/tmp/evil.json' }), /template must be a library-template name/);
  assert.throws(() => tm.addRole('shop', 'runner', { template: 'bad name!' }), /template must be a library-template name/);
  // A bare NAME is accepted.
  const team = tm.addRole('shop', 'runner', { template: 'fable-lead', brief: 'r' });
  assert.strictEqual(team.roles.runner.template, 'fable-lead');
});

// F008's successor. `tools` was enforced on ONE role and inert everywhere else,
// and the apparatus that managed that lie (the empty-array guard, the addRole
// refusal) existed only because the field did. The field is gone: a hand-authored
// `tools` is now dropped like any other unmodeled key, and the reviewer's cap is
// code. What must NOT come back is a stored allowlist that reads as a restriction
// and enforces nothing.
test('a hand-authored role `tools` is dropped, never stored as a restriction', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' });

  // addRole no longer bounces it — the def normalizes without the key at all.
  const team = tm.addRole('shop', 'runner', { brief: 'a runner', tools: ['Read'] });
  assert.deepStrictEqual(team.roles.runner, {
    template: null, prompt: null, brief: 'a runner', dispatch: 'standing', cwd: null,
  }, 'the normalized def carries no tools key in any form');

  // ON DISK, which is the claim in this test's title and the only one that
  // matters: normalizing on the way OUT would leave `"tools": ["Read"]` in
  // team.json, dropped by every reader and believed by every author. Asserting
  // the return alone reads right past that — the refusal this replaced existed
  // precisely to keep the bytes off the file.
  const file = path.join(home, 'teams', 'shop', 'team.json');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.ok(onDisk.roles && onDisk.roles.runner, 'ENTER: the role reached the file');
  assert.deepStrictEqual(onDisk.roles.runner, { brief: 'a runner' },
    'the WHOLE stored def: only the schema keys the caller supplied, with no tools in any form');

  // The reviewer likewise declares none: its cap is REVIEWER_TOOL_CAP in code.
  assert.ok(!('tools' in team.roles.reviewer), 'the reviewer cap is not a manifest field');
  assert.ok(!('tools' in onDisk.roles.reviewer), 'nor does the scaffold write one');
});

// createTeam is the other verbatim write: a caller-supplied roles map went to
// disk unfiltered, so a team could be BORN carrying the fields addRole refuses.
test('createTeam picks caller roles down to the schema before writing', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({
    name: 'shop',
    root,
    lead: 'clodex',
    roles: {
      lead: { prompt: 'clodex-team-lead', instantiate: 'session' },
      runner: { brief: 'r', tools: ['Read'], type: 'codex', standing: 's', invented: 1 },
    },
  });
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'teams', 'shop', 'team.json'), 'utf-8'));
  assert.ok(onDisk.roles && onDisk.roles.runner, 'ENTER: the caller roles reached the file');
  assert.deepStrictEqual(onDisk.roles.lead, { prompt: 'clodex-team-lead' });
  assert.deepStrictEqual(onDisk.roles.runner, { brief: 'r' });
});

// --- setRole / removeRole / renameRole: T29 Layer A metadata mutators -------
// Pure JSON edits with the C1/C4/C6 guards. C5 (seat fail-close) is Slice 2.
test('setRole edits the editable fields, ignores everything else, preserves unmodeled raw', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' });
  tm.addRole('shop', 'runner', { prompt: 'old-runner', brief: 'old brief' });
  // Hand-author a field the module doesn't model, to prove re-read-raw preserves it.
  const file = path.join(home, 'teams', 'shop', 'team.json');
  const raw0 = JSON.parse(fs.readFileSync(file, 'utf-8'));
  raw0.roles.runner.customField = 'keepme';
  fs.writeFileSync(file, JSON.stringify(raw0, null, 2));

  // Edit brief + prompt; also echo the cut fields, which must not be written.
  const team = tm.setRole('shop', 'runner', {
    brief: 'new brief', prompt: 'new-runner',
    tools: ['Bash'], type: 'codex', instantiate: 'subagent', standing: 's', ephemeral: true,
  });
  // WHOLE object: a field probe would read past a cut key that came back through
  // the patch, since a key nothing models arrives as undefined and every
  // `strictEqual(x, null)` on it would fail loudly but one on `undefined` reads
  // as an absence that was never asserted.
  assert.deepStrictEqual(team.roles.runner, {
    template: null, prompt: 'new-runner', brief: 'new brief', dispatch: 'standing', cwd: null,
  }, 'only the editable fields land; the cut ones are ignored');
  // Confirm on-disk raw took none of them, and kept the unmodeled one.
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  for (const k of ['tools', 'type', 'instantiate', 'standing', 'ephemeral']) {
    assert.ok(!(k in onDisk.roles.runner), `${k} absent on disk`);
  }
  assert.strictEqual(onDisk.roles.runner.customField, 'keepme', 'unmodeled raw field preserved');
});

test('setRole: C1 refuses reviewer + lead, C4 validates template, throws on missing role', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' }); // scaffold has lead+hand+reviewer
  // C1: operator-owned topology keys are refused.
  assert.throws(() => tm.setRole('shop', 'reviewer', { brief: 'x' }), /operator-owned topology/);
  assert.throws(() => tm.setRole('shop', 'lead', { brief: 'x' }), /operator-owned topology/);
  // A non-existent role points at addRole.
  assert.throws(() => tm.setRole('shop', 'ghost', { brief: 'x' }), /not found on team "shop" — use addRole/);
  // C4: garbage template rejected; a valid NAME accepted and written (resolved nowhere).
  assert.throws(() => tm.setRole('shop', 'hand', { template: 42 }), /template must be a library-template name/);
  assert.throws(() => tm.setRole('shop', 'hand', { template: 'bad name!' }), /template must be a library-template name/);
  const team = tm.setRole('shop', 'hand', { template: 'fable-lead' });
  assert.strictEqual(team.roles.hand.template, 'fable-lead', 'valid template name accepted');
});

test('removeRole removes a normal role, refuses lead + reviewer (C1), throws on missing', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' });
  tm.addRole('shop', 'runner', { prompt: 'r' });
  const team = tm.removeRole('shop', 'runner');
  assert.ok(!('runner' in team.roles), 'runner removed');
  // The DEFAULT (no opts) is the agent/intent path — unchanged by t421.
  assert.throws(() => tm.removeRole('shop', 'lead'), /cannot be removed/);
  assert.throws(() => tm.removeRole('shop', 'reviewer'), /operator-owned topology/);
  assert.throws(() => tm.removeRole('shop', 'ghost'), /not found on team "shop"/);
});

// --- t421: the operator may drop `reviewer`, and get it back ---------------
//
// The two halves are ONE decision: removal without a re-mint strands a team
// permanently reviewer-less, so both arms are asserted together here.

test('removeRole: the operator may drop `reviewer`; an agent still cannot', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' });
  assert.ok(tm.loadManifest('shop').roles.reviewer,
    'ENTER: a fresh team really has a reviewer role to remove — without it every assertion below is about an absence that was always there');

  // The agent path (no opts, and an explicitly false opt-in) is refused, and the
  // FILE is untouched: a refusal that had already written would make the message
  // a lie and the guard decorative.
  assert.throws(() => tm.removeRole('shop', 'reviewer'), /operator-owned topology/);
  assert.throws(() => tm.removeRole('shop', 'reviewer', { operator: false }), /operator-owned topology/);
  // Not `operator: true` by any other spelling, either — a truthy value is not
  // the opt-in, so a stray argument cannot become one.
  assert.throws(() => tm.removeRole('shop', 'reviewer', { operator: 1 }), /operator-owned topology/);
  assert.ok(tm.loadManifest('shop').roles.reviewer, 'the refused removals wrote nothing');

  const team = tm.removeRole('shop', 'reviewer', { operator: true });
  assert.ok(!('reviewer' in team.roles), 'the operator removal took effect in the returned manifest');
  // Read back from DISK, not just the return value: the return is a re-load, but
  // asserting the file is what pins that the write happened rather than that the
  // in-memory object was edited.
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'teams', 'shop', 'team.json'), 'utf-8'));
  assert.ok(!('reviewer' in raw.roles), 'and on disk');
  // The team still LOADS with no reviewer — the whole premise of the ticket.
  assert.ok(tm.loadManifest('shop').roles.lead, 'a reviewer-less team.json still loads');
});

test('removeRole: `lead` is refused for EVERYONE, operator included, with its own reason', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' });

  // Not the generic reserved message: a team that lost `lead` fails loadManifest
  // outright and reads as "no team" everywhere, so the refusal must name that
  // rather than suggest the app can do it.
  assert.throws(() => tm.removeRole('shop', 'lead'), /cannot be removed/);
  assert.throws(() => tm.removeRole('shop', 'lead', { operator: true }), /cannot be removed/);
  assert.throws(() => tm.removeRole('shop', 'lead', { operator: true }), /fails to load/);
  assert.ok(tm.loadManifest('shop').roles.lead, 'lead survives both attempts');
});

test('addRole: an operator re-mint of `reviewer` writes the STOCK def and IGNORES the supplied one', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' });
  tm.removeRole('shop', 'reviewer', { operator: true });
  assert.ok(!tm.loadManifest('shop').roles.reviewer,
    'ENTER: the reviewer is genuinely absent before the re-mint — a re-mint over an EXISTING key takes the no-op branch and would assert nothing about minting');

  // The delete-then-recreate bypass, attempted: a def that is nothing like the
  // stock one. The def must be discarded WHOLE, not merged field-by-field.
  const team = tm.addRole('shop', 'reviewer', {
    prompt: 'rubber-stamp', brief: 'approves everything', template: 'attacker-template', dispatch: 'standing',
  }, { operator: true });

  assert.deepStrictEqual(team.roles.reviewer, {
    ...STOCK_ROLE_DEFS.reviewer, template: null, dispatch: 'standing', cwd: null,
  }, 'the reviewer reads back as the STOCK def — the attacker def bought nothing');
  assert.strictEqual(team.roles.reviewer.prompt, STOCK_ROLE_DEFS.reviewer.prompt,
    'specifically: the prompt is Clodex\'s, not the caller\'s');

  // On disk too, in the raw file — a normalization that hid an attacker value on
  // read-back would still leave it in a file every agent can open.
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'teams', 'shop', 'team.json'), 'utf-8'));
  assert.deepStrictEqual(raw.roles.reviewer, { ...STOCK_ROLE_DEFS.reviewer },
    'the stock def is what landed in team.json, verbatim');
});

test('addRole: an AGENT still cannot mint an absent `reviewer`, stock def or not', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' });
  tm.removeRole('shop', 'reviewer', { operator: true });

  // Without the opt-in the mint refusal is unchanged — including for a caller
  // that offers the stock def itself, which is the shape a clever agent would
  // reach for once it learned the operator path writes exactly that.
  assert.throws(() => tm.addRole('shop', 'reviewer', { prompt: 'rubber-stamp' }), /operator-owned topology/);
  assert.throws(() => tm.addRole('shop', 'reviewer', { ...STOCK_ROLE_DEFS.reviewer }), /operator-owned topology/);
  assert.throws(() => tm.addRole('shop', 'reviewer', {}, { operator: false }), /operator-owned topology/);
  assert.ok(!tm.loadManifest('shop').roles.reviewer, 'nothing was minted by any of them');
});

test('addRole: the operator opt-in does NOT let a reserved def be rewritten when the key exists', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' });
  const before = tm.loadManifest('shop').roles.reviewer;
  assert.ok(before, 'ENTER: the key exists, so this is the existing-key branch and not a mint');

  // The stock-def branch is gated on the key being ABSENT. With it present, an
  // operator addRole falls through to the ordinary already-exists arm: a matching
  // def is a no-op, a divergent one is refused. Editing a reserved def stays out
  // of scope for every caller (setRole refuses it too).
  assert.throws(
    () => tm.addRole('shop', 'reviewer', { prompt: 'rubber-stamp' }, { operator: true }),
    /already exists on team "shop" with a different definition/,
  );
  assert.deepStrictEqual(tm.loadManifest('shop').roles.reviewer, before, 'the def is untouched');
  assert.doesNotThrow(() => tm.addRole('shop', 'reviewer', { ...STOCK_ROLE_DEFS.reviewer }, { operator: true }));
});

test('addRole: an operator mint of an absent `lead` is refused — removeRole can never produce that state', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' });
  const file = path.join(home, 'teams', 'shop', 'team.json');

  // Reachable only by hand-editing team.json, since removeRole refuses `lead` for
  // everyone. loadManifest throws on the missing key before addRole can mint it,
  // which is the honest answer: the file is invalid, not merely short a role.
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  delete raw.roles.lead;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  assert.throws(() => tm.addRole('shop', 'lead', {}, { operator: true }), /roles must include a "lead" role/);
});

test('renameRole renames a normal role, refuses lead/reviewer either direction, guards collisions', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' });
  tm.addRole('shop', 'runner', { prompt: 'r', brief: 'the runner' });
  const team = tm.renameRole('shop', 'runner', 'worker');
  assert.ok(!('runner' in team.roles) && team.roles.worker, 'runner → worker');
  assert.strictEqual(team.roles.worker.prompt, 'r', 'def carried across the rename');
  // C1/C5: reserved keys refused in EITHER direction.
  assert.throws(() => tm.renameRole('shop', 'lead', 'boss'), /cannot be renamed/);
  assert.throws(() => tm.renameRole('shop', 'reviewer', 'checker'), /cannot be renamed/);
  assert.throws(() => tm.renameRole('shop', 'worker', 'reviewer'), /cannot be renamed/);
  assert.throws(() => tm.renameRole('shop', 'worker', 'lead'), /cannot be renamed/);
  // Bad target charset / missing source / collision.
  assert.throws(() => tm.renameRole('shop', 'worker', 'bad name'), /must match/);
  assert.throws(() => tm.renameRole('shop', 'ghost', 'x'), /not found on team "shop"/);
  assert.throws(() => tm.renameRole('shop', 'worker', 'hand'), /already exists on team "shop"/);
});

test('watchdogMs is CLAMPED at consume (C3): below min → min, above max → max, mid unchanged, junk → null', () => {
  const home = mkHome();
  const tm = createTeamManifest({ fs, clodexHome: home });
  const mk = (name, watchdogMs) => {
    mkTeam(home, name, { root: `/p/${name}`, lead: 'lead', watchdogMs, roles: { lead: {} } });
    return tm.loadManifest(name).watchdogMs;
  };
  assert.strictEqual(mk('a', 1), 5 * 60 * 1000, 'below min clamps up to 5min');
  assert.strictEqual(mk('b', 1e12), 7 * 24 * 60 * 60 * 1000, 'above max clamps down to 7d');
  assert.strictEqual(mk('c', 600000), 600000, 'a valid mid value is unchanged');
  assert.strictEqual(mk('d', 0), null, 'non-positive → null (no throw)');
  assert.strictEqual(mk('e', -5), null, 'negative → null (no throw)');
  assert.strictEqual(mk('f', 'soon'), null, 'non-number → null (no throw)');
  // absent → null (falls back to the caller default).
  mkTeam(home, 'g', { root: '/p/g', lead: 'lead', roles: { lead: {} } });
  assert.strictEqual(tm.loadManifest('g').watchdogMs, null, 'absent → null');
});

test('setLead re-points the lead SEAT, accepts a seat that is not running, validates the name', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' });
  let team = tm.setLead('shop', 'shop-lead-2');
  assert.strictEqual(team.lead, 'shop-lead-2', 'the top-level lead pointer moved');
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'teams', 'shop', 'team.json'), 'utf-8'));
  assert.strictEqual(onDisk.lead, 'shop-lead-2', 'written to disk, not just returned');
  // THE ROLE IS UNTOUCHED. This is the whole point of the two-`lead` split: the
  // reserved role must survive a seat re-point byte-for-byte, and setRole('lead')
  // must still refuse. A setLead that "helpfully" wrote into roles.lead would
  // pass a pointer-only assertion and silently unlock reserved topology.
  assert.deepStrictEqual(onDisk.roles.lead, JSON.parse(JSON.stringify(STOCK_ROLE_DEFS.lead)), 'roles.lead unchanged by a seat re-point');
  assert.throws(() => tm.setRole('shop', 'lead', { brief: 'x' }), /operator-owned topology/, 'the lead ROLE is still locked');
  // A seat with no session anywhere is ACCEPTED: that is a stopped lead, and it
  // is also the state the front door exists to let an operator repair.
  team = tm.setLead('shop', 'never-existed');
  assert.strictEqual(team.lead, 'never-existed', 'a not-running seat name is a legal pointer');
  // Charset gated by the same NAME_RE createTeam uses for `lead`.
  assert.throws(() => tm.setLead('shop', 'bad name!'), /must be a seat name matching/);
  assert.throws(() => tm.setLead('shop', ''), /must be a seat name matching/);
  assert.throws(() => tm.setLead('shop', '..'), /must be a seat name matching/);
  assert.throws(() => tm.setLead('shop', 42), /must be a seat name matching/);
  // A missing team throws from loadManifest, like every other mutator.
  assert.throws(() => tm.setLead('ghost', 'x'), /no team manifest at/);
});

test('setTeamWatchdog writes a finite ms, clears on null, rejects non-finite, round-trips clamped', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'clodex' });
  // Write a valid value → carried, round-trips through the consume clamp unchanged.
  let team = tm.setTeamWatchdog('shop', 600000);
  assert.strictEqual(team.watchdogMs, 600000, 'valid ms written and read back');
  // A below-floor value is WRITTEN raw but READ clamped (the clamp is at consume).
  team = tm.setTeamWatchdog('shop', 1);
  assert.strictEqual(team.watchdogMs, 5 * 60 * 1000, 'a below-min value reads back clamped to the floor');
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'teams', 'shop', 'team.json'), 'utf-8'));
  assert.strictEqual(onDisk.watchdogMs, 1, 'the raw value is on disk — the clamp is a read-time guard, not a write mutation');
  // null clears the field (back to the caller default).
  team = tm.setTeamWatchdog('shop', null);
  assert.strictEqual(team.watchdogMs, null, 'null clears the override');
  assert.ok(!('watchdogMs' in JSON.parse(fs.readFileSync(path.join(home, 'teams', 'shop', 'team.json'), 'utf-8'))), 'field removed from disk');
  // Non-finite is rejected (ergonomics — the clamp would neutralize it anyway).
  assert.throws(() => tm.setTeamWatchdog('shop', 'soon'), /must be a finite number or null/);
  assert.throws(() => tm.setTeamWatchdog('shop', Infinity), /must be a finite number or null/);
});

// --- formatRoster: the initial-roster message ------------------------------

// The roster's exec line is only worth printing if it actually runs, so the
// tests below validate it against the real schema rather than a copy of it:
// the day clodex-team.json gains a required key, these fail instead of
// shipping a line that bounces at the decision point.
const EXEC_SCHEMA = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'resources', 'library', 'exec', 'clodex-team.json'), 'utf-8')).schema;

/** The payload object an `[agent:exec clodex-team] {...}` line carries. */
function execPayloadFrom(text) {
  const m = text.match(/\[agent:exec clodex-team\]\s*(\{.*\})/);
  return m ? JSON.parse(m[1]) : null;
}

/** Minimal check against the subset of JSON Schema clodex-team.json uses. */
function schemaViolations(payload, schema) {
  const bad = [];
  if (payload === null || typeof payload !== 'object') return ['payload is not an object'];
  for (const key of schema.required || []) {
    if (!(key in payload)) bad.push(`missing required key "${key}"`);
  }
  for (const [key, val] of Object.entries(payload)) {
    const prop = (schema.properties || {})[key];
    if (!prop) { if (schema.additionalProperties === false) bad.push(`unknown key "${key}"`); continue; }
    if (prop.type === 'string' && typeof val !== 'string') bad.push(`"${key}" must be a string`);
    if (prop.enum && !prop.enum.includes(val)) bad.push(`"${key}" must be one of ${prop.enum.join('|')}`);
    if (prop.maxLength != null && String(val).length > prop.maxLength) bad.push(`"${key}" too long`);
  }
  return bad;
}

const ROLES = () => ({
  lead: { brief: 'the lead', prompt: null, template: null, dispatch: 'standing' },
  hand: { brief: 'the hand', prompt: null, template: 'clodex-team-hand', dispatch: 'standing' },
  reviewer: { brief: 'the reviewer', prompt: null, template: null, dispatch: 'standing' },
});
const TEAM = () => ({ name: 'shop', root: '/r', lead: 'clodex', roles: ROLES() });

test('formatRoster lists roles, briefs, class, and live seats per role', () => {
  const roster = formatRoster(TEAM(), ['clodex', 'shop-hand', 'shop-hand-2']);
  assert.match(roster, /^\[team shop\] roster \(lead: clodex\)/m);
  assert.match(roster, /- lead \(session\) — the lead · live: clodex/);
  assert.match(roster, /- hand \(session, tmpl clodex-team-hand\) — the hand · live: shop-hand, shop-hand-2/);
  // The reviewer renders HOW IT IS REACHED, never its manifest instantiate class:
  // printing "(subagent)" next to it sent a lead to its harness subagent tool,
  // which produces an uncapped reviewer with no [agent:review-done] channel and no
  // seat the operator can see. No live seat → listed, no "live:" tail.
  assert.match(roster, /- reviewer \(lead-only\) — the reviewer · no live seat/m);
  assert.ok(!/reviewer \(subagent\)/.test(roster), 'the reviewer must never read as a harness subagent');
  assert.match(roster, /Ground truth on demand: \[agent:exec clodex-team\]/);
});

// A definition row and a live row used to differ only by the ABSENCE of a
// `· live:` tail, so a reader scanning for teammates read the role key as an
// addressable name and dm'd a seat that did not exist. Liveness must be stated
// in that slot, not inferred from what is missing.
test('formatRoster: a role with no live seat says so; it never reads as a teammate', () => {
  const roster = formatRoster(TEAM(), ['shop-hand'], { seat: 'clodex' });
  assert.match(roster, /- hand \(session, tmpl clodex-team-hand\) — the hand · live: shop-hand$/m,
    'a role WITH a seat names the seat');
  assert.match(roster, /- lead \(session\) — the lead · no live seat — role definition only, not addressable$/m,
    'a role WITHOUT a seat states that, in the same slot the live names would occupy');

  // Every role row carries exactly one liveness verdict — the property that
  // makes the two cases distinguishable without knowing the mechanism.
  const roleRows = roster.split('\n').filter((l) => /^- /.test(l));
  assert.strictEqual(roleRows.length, 3, 'three roles, three rows');
  for (const row of roleRows) {
    const live = / · live: /.test(row);
    const dead = / · no live seat /.test(row);
    assert.ok(live !== dead, `exactly one liveness verdict per row, never both or neither: ${row}`);
  }
});

test('formatRoster: the exec line carries the reading seat name in a schema-valid payload', () => {
  const payload = execPayloadFrom(formatRoster(TEAM(), ['clodex'], { seat: 'shop-hand' }));
  assert.ok(payload, 'the exec line carries a JSON payload, not a bare word');
  assert.deepStrictEqual(payload, { action: 'roster', agent: 'shop-hand' });
  assert.deepStrictEqual(schemaViolations(payload, EXEC_SCHEMA), [],
    'the rendered payload satisfies resources/library/exec/clodex-team.json');
  // schemaViolations is the only thing standing between us and a payload that
  // has drifted from the schema, so prove it can actually reject: a checker
  // that accepts everything is the same false green in a new place.
  assert.notDeepStrictEqual(schemaViolations({ action: 'roster' }, EXEC_SCHEMA), [], 'missing a required key is caught');
  assert.notDeepStrictEqual(schemaViolations({ action: 'nope', agent: 'x' }, EXEC_SCHEMA), [], 'an out-of-enum action is caught');
  assert.notDeepStrictEqual(schemaViolations({ action: 'roster', agent: 'x', stray: 1 }, EXEC_SCHEMA), [], 'an unknown key is caught');
  // No seat: a placeholder, still the payload FORM, never the bare word.
  const generic = execPayloadFrom(formatRoster(TEAM(), []));
  assert.deepStrictEqual(generic, { action: 'roster', agent: '<your name>' },
    'the seatless fallback names the placeholder explicitly, not an empty or omitted agent');
  assert.deepStrictEqual(schemaViolations(generic, EXEC_SCHEMA), [],
    'the seatless fallback is still a schema-valid shape');
});

// Who may invoke the intent decides who is told about it: _handleTeamReview
// bounces a non-lead, so naming it to a hand only buys a wasted turn.
test('formatRoster: the reviewer names its intent to the lead, and reads lead-only to everyone else', () => {
  const forLead = formatRoster(TEAM(), [], { seat: 'clodex' });
  assert.match(forLead, /- reviewer \(via \[agent:team-review\]\)/, 'the lead is told the exact intent');
  for (const seat of ['shop-hand', null]) {
    const other = formatRoster(TEAM(), [], seat ? { seat } : {});
    assert.match(other, /- reviewer \(lead-only\)/, `seat ${seat}: told the role exists and is not theirs`);
    assert.ok(!/via \[agent:team-review\]/.test(other), `seat ${seat}: not handed an intent that would bounce`);
  }
});

test('formatRoster: a role renders `tmpl <name>` only when its def has a template', () => {
  const roster = formatRoster(TEAM(), []);
  assert.match(roster, /- hand \(session, tmpl clodex-team-hand\)/, 'a templated role names its template');
  assert.match(roster, /- lead \(session\) —/, 'a template-less role renders no tmpl token');
  assert.ok(!/lead \(session, tmpl/.test(roster), 'never "tmpl none" for a null template');
  assert.strictEqual((roster.match(/tmpl /g) || []).length, 1, 'exactly one tmpl token, for the one templated role');
});

test('formatRoster: a live seat carries its label verbatim, and the reading seat reads `(you)`', () => {
  const roster = formatRoster(TEAM(), [
    { name: 'clodex', label: 'working' },
    { name: 'shop-hand', label: 'idle 12m, warm' },
    { name: 'shop-hand-2', label: null },
  ], { seat: 'clodex' });
  assert.match(roster, /live: clodex \(you\)/, 'the reading seat is marked, not labelled');
  assert.ok(!/clodex \(working\)/.test(roster), 'the reading seat never renders its own label');
  assert.match(roster, /shop-hand \(idle 12m, warm\)/, 'a label is rendered verbatim');
  assert.match(roster, /shop-hand-2(?!\s*\()/, 'a null label renders the bare name, no empty parens');
});

test('formatRoster: live seats matching no role are listed, and the line is absent when none are', () => {
  const withStray = formatRoster(TEAM(), [
    { name: 'clodex', label: 'working' },
    { name: 'scratch-seat', label: 'working' },
  ], { seat: 'clodex' });
  assert.match(withStray, /^also live, no role: scratch-seat \(working\)$/m,
    'an off-convention live seat is warm and DM-able — it must not vanish from a liveness listing');
  const allMatched = formatRoster(TEAM(), [{ name: 'clodex', label: 'working' }], { seat: 'clodex' });
  assert.ok(!/also live, no role/.test(allMatched), 'no stray seats → no line');
});

test('formatRoster: the action line is rendered for the lead seat only', () => {
  const forLead = formatRoster(TEAM(), [], { seat: 'clodex' });
  assert.match(forLead, /\[agent:task add <role>\] <spec>/);
  // t174 pinned "the park form is named" because add DISPATCHED: a lead with no
  // file-for-later verb wrote "do not start" into the body, which nothing reads.
  // t308 removed the dispatch from add, so the file-for-later verb is now add
  // itself — but the HAZARD t174 found is unchanged, and the line still has to
  // close it. It does so by naming the second step: a lead that cannot see where
  // "start" lives is a lead that goes looking for a prose way to say it.
  assert.match(forLead, /\[agent:task start <id>\]/, 'the start verb is named — dispatch is a step the lead must be able to find');
  assert.match(forLead, /starts NOTHING/, 'and add is explicitly stated not to dispatch');
  assert.match(forLead, /body is NOT read by anything/, 'the body convention stays explicitly disclaimed (t174)');
  // The intent must be stated as SELF-SUFFICIENT. "Review: [agent:team-review]"
  // alone read as a channel the lead had to spawn a seat for first.
  assert.match(forLead, /Review: \[agent:team-review\] <scope> — the intent spawns the cold reviewer seat itself; do NOT spawn or subagent one by hand\./,
    'a reviewer is reached by intent, and the line must say the intent does the spawning');
  assert.match(forLead, /New session seat: \[agent:spawn name:shop-<role> template:<tmpl>\]\./);
  // A hand does not dispatch, and this text is regenerated into every context
  // reset of every seat — non-leads pay nothing for it.
  const forHand = formatRoster(TEAM(), [], { seat: 'shop-hand' });
  assert.ok(!/Dispatch:/.test(forHand), 'a non-lead seat gets no action line');
  assert.ok(!/team-review/.test(forHand));
  const seatless = formatRoster(TEAM(), []);
  assert.ok(!/Dispatch:/.test(seatless), 'no seat → the generic form, no action line');
});

test('formatRoster: the action line keys off the role name, never the lead SEAT name', () => {
  // team.lead is a seat name (see the `lead` field's contract), so a team whose
  // lead seat is named after an unrelated role must still list that role.
  const team = { name: 'shop', root: '/r', lead: 'hand', roles: ROLES() };
  const roster = formatRoster(team, [], { seat: 'hand' });
  assert.match(roster, /New session seat: \[agent:spawn name:shop-<role>/,
    'the hand role survives a lead seat that happens to be called "hand"');
  assert.match(roster, /Dispatch: TWO steps\. \[agent:task add <role>\] <spec>/);
});

test('formatTeamBlock: its ground-truth invocation is concrete and schema-valid', () => {
  const payload = execPayloadFrom(formatTeamBlock(TEAM(), 'shop-hand'));
  assert.ok(payload, 'the block carries a JSON payload, not the bare word "roster"');
  assert.deepStrictEqual(payload, { action: 'roster', agent: 'shop-hand' });
  assert.deepStrictEqual(schemaViolations(payload, EXEC_SCHEMA), [],
    'the rendered payload satisfies resources/library/exec/clodex-team.json');
});

// --- formatCompositionDelta: the passive one-liner -------------------------
test('formatCompositionDelta renders seat and role-only events', () => {
  assert.strictEqual(
    formatCompositionDelta('shop', 'spawned', { seat: 'shop-hand', role: 'hand' }),
    '[team shop] seat shop-hand spawned (role: hand)',
  );
  assert.strictEqual(
    formatCompositionDelta('shop', 'retired', { seat: 'shop-hand-2', role: 'hand' }),
    '[team shop] seat shop-hand-2 retired (role: hand)',
  );
  assert.strictEqual(
    formatCompositionDelta('shop', 'added', { role: 'researcher' }),
    '[team shop] role researcher added (no seat)',
  );
});

// --- role cwd: the write-time gate (t422) ----------------------------------
//
// `cwd` flows to create() as a PTY working directory and team.json is
// agent-writable, so its confinement is a security property. Each refusal below
// asserts BOTH that the write throws and that nothing reached the disk: a
// mutator that threw after writing would pass a throws-only test while leaving
// exactly the state the refusal exists to prevent.

// A team with a real root on disk and an `api/` inside it, plus the raw bytes of
// its team.json for before/after comparison.
function teamForCwd() {
  const home = mkHome();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwdproj-')));
  fs.mkdirSync(path.join(root, 'api'));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'shop-lead' });
  const file = path.join(home, 'teams', 'shop', 'team.json');
  return { home, root, tm, file, before: fs.readFileSync(file, 'utf-8') };
}

test('role cwd: addRole stores a relative cwd naming a real directory', () => {
  const { tm, file } = teamForCwd();
  tm.addRole('shop', 'api-hand', { brief: 'b', cwd: 'api' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.ok(raw.roles && raw.roles['api-hand'], 'ENTER: the role reached the file');
  assert.strictEqual(raw.roles['api-hand'].cwd, 'api', 'stored RELATIVE, exactly as written');
  assert.strictEqual(tm.loadManifest('shop').roles['api-hand'].cwd, 'api', 'and survives a load');
});

test('role cwd: an ABSOLUTE path is refused and nothing is written', () => {
  const { tm, file, before } = teamForCwd();
  assert.throws(() => tm.addRole('shop', 'api-hand', { cwd: '/etc' }), /absolute/);
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), before,
    'the manifest is byte-identical — a refusal that wrote first would leave the very cwd it refused');
});

test('role cwd: a `..` escape is refused and nothing is written', () => {
  const { tm, file, before } = teamForCwd();
  // Does NOT start with '..', so only a RESOLVING check catches it — a raw
  // string-prefix guard reads this as confined.
  assert.throws(() => tm.addRole('shop', 'api-hand', { cwd: 'api/../../elsewhere' }),
    /outside the team root/);
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), before);
});

test('role cwd: a directory that does not exist is refused and nothing is written', () => {
  const { tm, file, before } = teamForCwd();
  assert.throws(() => tm.addRole('shop', 'api-hand', { cwd: 'nope' }),
    /not an existing directory/);
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), before,
    'and it is NOT created — an invented empty directory looks like a seat working correctly');
  assert.ok(!fs.existsSync(path.join(JSON.parse(before).root, 'nope')),
    'ENTER: the directory really is absent, so the refusal above was about this case');
});

test('role cwd: a SYMLINK out of the root is refused and nothing is written', () => {
  const { tm, root, file, before } = teamForCwd();
  // statSync FOLLOWS the link, so the directory check passes, and the lexical
  // confinement compares path strings, so `link` reads as confined — the value
  // still points a PTY at another project. Only a realpath comparison sees it.
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwdout-')));
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.ok(fs.statSync(path.join(root, 'link')).isDirectory(),
    'ENTER: the link must resolve to a real directory, or this passes for the wrong reason');
  assert.throws(() => tm.addRole('shop', 'api-hand', { cwd: 'link' }), /outside the team root/);
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), before);
});

test('role cwd: a symlink INSIDE the root is honored, and so is a symlinked root', () => {
  // The other side of the check above, and the reason BOTH sides are realpath'd:
  // on macOS a /tmp project root is itself a symlink (/tmp → /private/tmp), so a
  // one-sided comparison would refuse every legitimate cwd under it.
  const home = mkHome();
  const realRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwdreal-')));
  fs.mkdirSync(path.join(realRoot, 'api'));
  fs.symlinkSync(path.join(realRoot, 'api'), path.join(realRoot, 'api-link'));
  // The team names the root through a symlinked PREFIX, the shape /tmp gives.
  const linkRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cwdlink-')), 'proj');
  fs.symlinkSync(realRoot, linkRoot);
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root: linkRoot, lead: 'l' });
  assert.notStrictEqual(fs.realpathSync(linkRoot), linkRoot,
    'ENTER: the root really is reached through a symlink, or this asserts nothing');
  tm.addRole('shop', 'api-hand', { brief: 'b', cwd: 'api-link' });
  assert.strictEqual(tm.loadManifest('shop').roles['api-hand'].cwd, 'api-link',
    'a link that stays inside the root is fine, and a symlinked root does not poison it');
});

test('role cwd: the stored bytes are TRIMMED, so what lands is what was validated', () => {
  const { tm, file } = teamForCwd();
  tm.addRole('shop', 'api-hand', { brief: 'b', cwd: '  api  ' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.ok(raw.roles && raw.roles['api-hand'], 'ENTER: the role reached the file');
  assert.strictEqual(raw.roles['api-hand'].cwd, 'api', 'addRole stores the trimmed form');
  tm.setRole('shop', 'api-hand', { cwd: '\tapi ' });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).roles['api-hand'].cwd, 'api',
    'and so does setRole, which does not go through pickRoleKeys');
});

test('role cwd: a FILE is not a directory and is refused', () => {
  const { tm, root, file, before } = teamForCwd();
  fs.writeFileSync(path.join(root, 'README.md'), 'x');
  assert.throws(() => tm.addRole('shop', 'api-hand', { cwd: 'README.md' }),
    /not an existing directory/);
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), before);
});

test('role cwd: the LEAD role refuses one, and the reason names the fix (D3)', () => {
  // resolveSeatShape is never called with roleKey 'lead' — the lead's seat is
  // operator-created and standing — so a cwd there would be inert-but-believed
  // on exactly one role. That is the shape `type` and `tools` were cut for.
  const { home, root } = teamForCwd();
  const tm2 = createTeamManifest({ fs, clodexHome: home });
  assert.throws(
    () => tm2.createTeam({
      name: 'shop2', root: fs.mkdtempSync(path.join(os.tmpdir(), 'cwdproj2-')),
      lead: 'l', roles: { lead: { cwd: 'api' } },
    }),
    /lead[\s\S]*not spawned by the team/,
    'the message must say WHY, because the operator CAN set that directory — just not here',
  );
  assert.ok(root, 'ENTER: the fixture built a real root');
});

test('role cwd: createTeam refuses an escaping cwd on a seeded role, and writes no team', () => {
  const home = mkHome();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwdproj3-')));
  const tm = createTeamManifest({ fs, clodexHome: home });
  assert.throws(
    () => tm.createTeam({ name: 'shop3', root, lead: 'l', roles: { hand: { cwd: '../outside' } } }),
    /outside the team root/,
  );
  assert.ok(!fs.existsSync(path.join(home, 'teams', 'shop3', 'team.json')),
    'a brand-new file must not be born carrying a cwd every other door refuses');
});

test('role cwd: setRole validates the patch, and a refusal leaves the stored value alone', () => {
  const { tm, file } = teamForCwd();
  tm.addRole('shop', 'api-hand', { cwd: 'api' });
  const before = fs.readFileSync(file, 'utf-8');
  assert.throws(() => tm.setRole('shop', 'api-hand', { cwd: '/etc' }), /absolute/);
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), before);
  assert.strictEqual(tm.loadManifest('shop').roles['api-hand'].cwd, 'api',
    'ENTER: the previously-stored cwd is still there — a partial write would have cleared it');
});

test('role cwd: setRole with a BLANK cwd clears the key rather than storing an empty string', () => {
  // path.resolve(root, '') IS root, so '' on disk would be a value meaning
  // exactly what its absence means. The popover's cleared text input sends ''.
  const { tm, file } = teamForCwd();
  tm.addRole('shop', 'api-hand', { cwd: 'api' });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).roles['api-hand'].cwd, 'api',
    'ENTER: there was a cwd to clear');
  tm.setRole('shop', 'api-hand', { cwd: '  ' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.ok(!('cwd' in raw.roles['api-hand']), 'the key is GONE, not empty-stringed');
  assert.strictEqual(tm.loadManifest('shop').roles['api-hand'].cwd, null);
});

test('role cwd: a non-string is refused by the schema', () => {
  const { tm } = teamForCwd();
  assert.throws(() => tm.addRole('shop', 'api-hand', { cwd: 42 }), /cwd must be a string/);
});

test('role cwd: a hand-edited bad cwd LOADS rather than breaking the whole team', () => {
  // loadManifest runs inside every caller's best-effort catch, so a throw here
  // would make a team with one bad role read as NO TEAM everywhere at once —
  // no roster, no ticket resolution, no surface left to fix it from. The bad
  // value is neutralized at SPAWN instead (resolve-seat-shape.test.js).
  const home = mkHome();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwdproj4-')));
  mkTeam(home, 'shop', { root, lead: 'l', roles: { lead: {}, hand: { cwd: '/etc' } } });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const m = tm.loadManifest('shop');
  assert.strictEqual(m.roles.hand.cwd, '/etc', 'carried through the load as written');
  assert.strictEqual(tm.resolveTeam(root).name, 'shop',
    'ENTER: the team still resolves — this is the property the load-path leniency buys');
});
