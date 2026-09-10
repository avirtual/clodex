'use strict';
// Run: node --test test/team-kits.test.js
//
// t803 — two shipped team profiles, selectable at create time.
//
// The `clodex` kit is a byte-for-byte duplicate of the flat library's stock
// trio, because pre-kit teams resolve `clodex-team-*` from the flat library at
// spawn (team-tickets _templateShape falls back to allTemplates()) and the kit
// cannot replace it. A duplicate nobody pins drifts, so the first block below
// is the drift gate: it compares BYTES, not parsed objects, since a reformat is
// exactly the kind of divergence a deepStrictEqual would wave through.
//
// The `default` kit is the same three roles with every restriction lifted. What
// "lifted" MEANS is not a matter of taste per key — it is whatever the resolver
// reads as "no restriction", and for `plugins` that is an ABSENT key rather
// than `[]`. Those literals are pinned here against the resolvers themselves.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createTeamManifest, STOCK_ROLE_DEFS } = require('../team-manifest');
const { seatHasPlugin } = require('../plugin-api');
const { expandSkillsOff } = require('../skills-off');
const { mkTmpRoot } = require('./lib/tmp-roots');

const LIB = path.join(__dirname, '..', 'resources', 'library');
const KITS = path.join(LIB, 'kits');
const readKitJson = (kit) => JSON.parse(fs.readFileSync(path.join(KITS, kit, 'kit.json'), 'utf-8'));
const readTpl = (kit, stem) => JSON.parse(fs.readFileSync(path.join(KITS, kit, 'templates', `${stem}.json`), 'utf-8'));

// ── kit `clodex`: pinned against drift from the flat library ────────────────

const STOCK_STEMS = ['clodex-team-lead', 'clodex-team-hand', 'clodex-team-reviewer'];

test('ENTER: the clodex kit really holds a file per stock stem', () => {
  // Without this, the byte comparisons below would pass vacuously over a kit
  // that ships nothing: a missing file makes both reads throw, and a loop over
  // an empty directory asserts nothing at all.
  assert.deepStrictEqual(fs.readdirSync(path.join(KITS, 'clodex', 'templates')).sort(),
    STOCK_STEMS.map((s) => `${s}.json`).sort());
  assert.deepStrictEqual(fs.readdirSync(path.join(KITS, 'clodex', 'prompts', 'system')).sort(),
    STOCK_STEMS.map((s) => `${s}.md`).sort());
});

for (const stem of STOCK_STEMS) {
  test(`kits/clodex/templates/${stem}.json is byte-identical to its flat sibling`, () => {
    assert.strictEqual(
      fs.readFileSync(path.join(KITS, 'clodex', 'templates', `${stem}.json`), 'utf-8'),
      fs.readFileSync(path.join(LIB, 'templates', `${stem}.json`), 'utf-8'),
      `the kit copy of ${stem} drifted from the library copy — a pre-kit team spawns from the `
      + 'library one and a kit team from this one, so the two seats would differ silently');
  });

  test(`kits/clodex/prompts/system/${stem}.md is byte-identical to its flat sibling`, () => {
    assert.strictEqual(
      fs.readFileSync(path.join(KITS, 'clodex', 'prompts', 'system', `${stem}.md`), 'utf-8'),
      fs.readFileSync(path.join(LIB, 'prompts', 'system', `${stem}.md`), 'utf-8'),
      `the kit copy of ${stem}.md drifted from the library copy`);
  });
}

test('the clodex kit\'s roles are STOCK_ROLE_DEFS verbatim', () => {
  assert.deepStrictEqual(readKitJson('clodex').roles, STOCK_ROLE_DEFS);
});

// ── kit `default`: the lifted restrictions, by their resolver's literal ─────

test('the default kit lifts every restriction, and `lifted` means what each resolver reads', () => {
  for (const stem of ['lead', 'hand']) {
    const tpl = readTpl('default', stem);
    const stock = JSON.parse(fs.readFileSync(path.join(LIB, 'templates', `clodex-team-${stem}.json`), 'utf-8'));

    // ENTER: the stock template really restricts, so the lifts below are a
    // contrast rather than a restatement of a template that never denied.
    assert.ok(stock.disabledTools.length > 20, `ENTER: stock ${stem} must deny a real tool list`);
    assert.deepStrictEqual(stock.disabledSkills, ['*'], `ENTER: stock ${stem} must disable every skill`);
    assert.deepStrictEqual(stock.plugins, [], `ENTER: stock ${stem} must carry the empty plugin list`);

    // DENYLISTS — cli-hooks renders each into settings.permissions.deny /
    // skillOverrides, and an EMPTY list renders nothing. `[]` is the literal.
    assert.deepStrictEqual(tpl.disabledTools, []);
    assert.deepStrictEqual(tpl.disabledSkills, []);
    assert.deepStrictEqual(tpl.denyBuiltins, []);

    // `agents` is NOT a denylist and has no widening value: session-manager's
    // effectiveInjectedAgents unions the seat's list with the `sessions:`-scoped
    // auto-includes, so `[]` and absent both mean "the auto-includes only".
    // `[]` is the honest spelling of the weakest restriction that exists.
    assert.deepStrictEqual(tpl.agents, []);

    // `plugins` is the key where `[]` is the RESTRICTION: seatHasPlugin reads a
    // non-array as "every SHIPPED plugin" and an array as an allowlist. So the
    // "no restriction" literal is the ABSENT key, not an empty one.
    assert.ok(!('plugins' in tpl),
      `${stem}: a plugins key — even [] — withholds every shipped bundle; absent is what grants them`);

    // Kept, per the spec: these are not restrictions.
    assert.strictEqual(tpl.cwd, '${TEAM_ROOT}');
    assert.deepStrictEqual(tpl.intents, stock.intents);
    assert.deepStrictEqual(tpl.execCommands, stock.execCommands);
    assert.deepStrictEqual(tpl.appendPromptFiles, stock.appendPromptFiles);
    assert.strictEqual(tpl.stripLevel, stock.stripLevel);
    assert.deepStrictEqual(tpl.env, stock.env);
    assert.strictEqual(tpl.spawnerHint, stock.spawnerHint);
    assert.strictEqual(tpl.name, stem, 'a template `name` that is not its stem names a file nothing resolves');
  }
});

test('the resolvers themselves agree with the literals pinned above', () => {
  // The assertions above are about JSON. These are about the CODE that reads
  // it — without them the literals are a convention two files happen to share.
  const hand = readTpl('default', 'hand');

  // plugins: absent (undefined) grants a shipped bundle; [] withholds it.
  assert.strictEqual(seatHasPlugin('builder', hand.plugins, true), true,
    'the absent plugins key must resolve to "every shipped plugin"');
  assert.strictEqual(seatHasPlugin('builder', [], true), false,
    'and [] must be the restriction — otherwise the absent key above proves nothing');

  // disabledSkills: [] expands to [] (nothing overridden); ['*'] expands to the
  // whole known set, which is the restriction being lifted.
  assert.deepStrictEqual(expandSkillsOff(hand.disabledSkills, { known: ['a', 'b'] }), [],
    'an empty disabledSkills must disable nothing');
  assert.deepStrictEqual(expandSkillsOff(['*'], { known: ['a', 'b'] }), ['a', 'b'],
    'and "*" must be the restriction — otherwise the contrast is empty');
});

test('the default kit\'s reviewer carries a prompt only, and no reviewer template ships with it', () => {
  // Read-only tools are the review's design, not a restriction to lift. The
  // role names no template, so the copy falls through to the flat library's
  // clodex-team-reviewer — which is why the kit ships no reviewer template.
  const roles = readKitJson('default').roles;
  assert.deepStrictEqual(Object.keys(roles.reviewer).sort(), ['brief', 'prompt']);
  assert.strictEqual(fs.existsSync(path.join(KITS, 'default', 'templates', 'reviewer.json')), false);
  assert.deepStrictEqual(fs.readdirSync(path.join(KITS, 'default', 'templates')).sort(),
    ['hand.json', 'lead.json']);
});

test('every kit role names stems its OWN kit ships, except where the library covers it', () => {
  for (const kit of ['clodex', 'default']) {
    for (const [role, def] of Object.entries(readKitJson(kit).roles)) {
      for (const [key, sub, ext] of [['prompt', 'prompts/system', '.md'], ['template', 'templates', '.json']]) {
        const stem = def[key];
        if (!stem) continue;
        const inKit = fs.existsSync(path.join(KITS, kit, ...sub.split('/'), `${stem}${ext}`));
        const inLib = fs.existsSync(path.join(LIB, ...sub.split('/'), `${stem}${ext}`));
        assert.ok(inKit || inLib,
          `kit ${kit} role ${role} names ${key} "${stem}", which neither the kit nor the library ships`);
      }
    }
  }
});

// ── createTeam seeds from a kit ─────────────────────────────────────────────

// A clodex home whose library/kits is the SHIPPED tree, copied rather than
// symlinked so a test that wrote through it could not touch resources/.
function mkHome() {
  const home = mkTmpRoot('t803-home-');
  fs.mkdirSync(path.join(home, 'teams'), { recursive: true });
  fs.cpSync(LIB, path.join(home, 'library'), { recursive: true });
  return home;
}

const readTeamTpl = (home, team, stem) => JSON.parse(
  fs.readFileSync(path.join(home, 'teams', team, 'templates', `${stem}.json`), 'utf-8'));

test('createTeam with kit:default writes the LIFTED hand template, whole', () => {
  const home = mkHome();
  const tm = createTeamManifest({ fs, clodexHome: home });
  const team = tm.createTeam({ name: 'x', root: mkTmpRoot('t803-proj-'), lead: 'x-lead', kit: 'default' });

  // The whole object, per CLAUDE.md: a key-subset check reads around a key the
  // copy dropped, which is the whole class of defect a copy path produces.
  assert.deepStrictEqual(readTeamTpl(home, 'x', 'hand'), {
    name: 'hand',
    spawnerHint: 'off',
    type: 'claude',
    cwd: '${TEAM_ROOT}',
    proxy: null,
    agents: [],
    execCommands: ['clodex-team', 'clodex-monitor', 'clodex-run-tests'],
    intents: ['dm', 'who', 'context', 'memory', 'file', 'resend', 'exec', 'remind', 'notify-user'],
    denyBuiltins: [],
    disabledTools: [],
    disabledSkills: [],
    injectSkills: [],
    stripLevel: 2,
    systemPromptFile: null,
    appendPromptFiles: ['team-project'],
    env: { CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '60000' },
  });
  assert.strictEqual(team.kit, 'default');
  assert.strictEqual(JSON.parse(fs.readFileSync(team.file, 'utf-8')).kit, 'default',
    'and the kit is recorded ON DISK — a later addRole reads it from there');
});

test('createTeam with kit:clodex writes the AGGRESSIVE hand template', () => {
  const home = mkHome();
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'x', root: mkTmpRoot('t803-proj-'), lead: 'x-lead', kit: 'clodex' });

  const copied = readTeamTpl(home, 'x', 'hand');
  const stock = JSON.parse(fs.readFileSync(path.join(LIB, 'templates', 'clodex-team-hand.json'), 'utf-8'));
  assert.deepStrictEqual(copied, { ...stock, name: 'hand' });
  // The CONTRAST, on one fixture: the two kits must not produce the same file.
  assert.ok(copied.disabledTools.length > 20, 'the clodex kit keeps the denylist the default kit lifts');
});

test('the kit\'s reviewer prompt reaches the team even though the kit is the copy SOURCE', () => {
  const home = mkHome();
  const tm = createTeamManifest({ fs, clodexHome: home });
  const team = tm.createTeam({ name: 'x', root: mkTmpRoot('t803-proj-'), lead: 'x-lead', kit: 'default' });
  assert.strictEqual(
    fs.readFileSync(path.join(home, 'teams', 'x', 'prompts', 'system', 'reviewer.md'), 'utf-8'),
    fs.readFileSync(path.join(KITS, 'default', 'prompts', 'system', 'reviewer.md'), 'utf-8'));
  assert.strictEqual(team.roles.reviewer.template, null, 'the reviewer still names no template');
});

test('createTeam defaults to the default kit when the caller names none', () => {
  const home = mkHome();
  const tm = createTeamManifest({ fs, clodexHome: home });
  const team = tm.createTeam({ name: 'x', root: mkTmpRoot('t803-proj-'), lead: 'x-lead' });
  assert.strictEqual(team.kit, 'default');
  assert.deepStrictEqual(readTeamTpl(home, 'x', 'hand').disabledTools, [],
    'a kitless create takes the mundane profile, not the aggressive one');
});

test('an unknown kit throws, lists what IS available, and writes nothing', () => {
  const home = mkHome();
  const tm = createTeamManifest({ fs, clodexHome: home });
  assert.throws(
    () => tm.createTeam({ name: 'x', root: mkTmpRoot('t803-proj-'), lead: 'x-lead', kit: 'nope' }),
    /unknown kit "nope" \(available: clodex, default\)/);
  assert.strictEqual(fs.existsSync(path.join(home, 'teams', 'x')), false,
    'the refusal must land BEFORE any write — a half-made team dir would refuse the retry');
});

test('a caller `roles` object wins over the kit\'s roles, but the kit stays the COPY SOURCE', () => {
  // Today's contract: an explicit roles map is honored verbatim. The kit still
  // decides which bytes those role stems resolve to, which is what lets the
  // intent path overlay `dispatch: "worktree"` without losing the kit.
  const home = mkHome();
  const tm = createTeamManifest({ fs, clodexHome: home });
  const team = tm.createTeam({
    name: 'x', root: mkTmpRoot('t803-proj-'), lead: 'x-lead', kit: 'default',
    roles: { lead: { prompt: 'lead', template: 'lead' }, hand: { prompt: 'hand', template: 'hand', dispatch: 'worktree' } },
  });
  assert.strictEqual(team.roles.hand.dispatch, 'worktree', 'the caller\'s role def is honored');
  assert.ok(!('reviewer' in team.roles), 'and the kit\'s third role is NOT merged in');
  assert.deepStrictEqual(readTeamTpl(home, 'x', 'hand').disabledTools, [],
    'while the bytes still came from the kit named on the call');
});

// ── addRole reads the team's recorded kit ──────────────────────────────────

test('addRole copies from the team\'s OWN kit, not from whatever the library holds', () => {
  const home = mkHome();
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({
    name: 'x', root: mkTmpRoot('t803-proj-'), lead: 'x-lead', kit: 'default',
    roles: { lead: { prompt: 'lead', template: 'lead' } },
  });
  assert.strictEqual(fs.existsSync(path.join(home, 'teams', 'x', 'templates', 'hand.json')), false,
    'ENTER: the hand role does not exist yet, so the file below is one THIS call wrote');

  tm.addRole('x', 'hand', { prompt: 'hand', template: 'hand' });
  assert.deepStrictEqual(readTeamTpl(home, 'x', 'hand').disabledTools, [],
    'a role added later must take the same profile the team was created from');
});

test('a LEGACY manifest (no kit key) reads as clodex and addRole copies the flat library', () => {
  const home = mkHome();
  const tm = createTeamManifest({ fs, clodexHome: home });
  const root = mkTmpRoot('t803-proj-');
  // Hand-written, as a pre-kit build left it: no `kit`, roles naming the flat
  // library stems.
  fs.mkdirSync(path.join(home, 'teams', 'old'), { recursive: true });
  fs.writeFileSync(path.join(home, 'teams', 'old', 'team.json'), JSON.stringify({
    version: 3, lead: 'old-lead', root, roles: { lead: { ...STOCK_ROLE_DEFS.lead } },
  }, null, 2));

  assert.strictEqual(tm.loadManifest('old').kit, 'clodex');
  tm.addRole('old', 'hand', { ...STOCK_ROLE_DEFS.hand });
  const copied = readTeamTpl(home, 'old', 'hand');
  const stock = JSON.parse(fs.readFileSync(path.join(LIB, 'templates', 'clodex-team-hand.json'), 'utf-8'));
  assert.deepStrictEqual(copied, { ...stock, name: 'hand' },
    'a legacy team must keep getting the aggressive profile its live seats already run');

  // And the key is NOT written back: rewriting a manifest nobody asked us to
  // touch is exactly what the legacy read exists to avoid.
  assert.ok(!('kit' in JSON.parse(fs.readFileSync(path.join(home, 'teams', 'old', 'team.json'), 'utf-8'))),
    'the load-time default must not be persisted onto the operator\'s file');
});

test('addRole survives a kit that has since been deleted from the library', () => {
  const home = mkHome();
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({
    name: 'x', root: mkTmpRoot('t803-proj-'), lead: 'x-lead', kit: 'default',
    roles: { lead: { prompt: 'lead', template: 'lead' } },
  });
  fs.rmSync(path.join(home, 'library', 'kits', 'default'), { recursive: true, force: true });

  // The flat library still has the stock stems, so the role resolves — the point
  // is that a missing kit does not turn every later role-add into a throw.
  assert.doesNotThrow(() => tm.addRole('x', 'hand', { ...STOCK_ROLE_DEFS.hand }));
  assert.strictEqual(tm.loadManifest('x').roles.hand.template, 'hand');
});

// ── the discovery surface ──────────────────────────────────────────────────

test('kitCatalog lists each kit with its description, one line each', () => {
  const home = mkHome();
  const tm = createTeamManifest({ fs, clodexHome: home });
  const lines = tm.kitCatalog();
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /^clodex — Clodex's own profile: /);
  assert.match(lines[1], /^default — Stock team on your own Claude Code: /);
  for (const l of lines) assert.ok(!l.includes('\n'), 'one line each — a body with a newline would break the reply');
});

test('a home with no kits seeded falls back to the flat library and records no kit', () => {
  // The upgrade path: a registry whose library predates kits. A throw here
  // would make team create unusable until the next seed ran.
  const home = mkTmpRoot('t803-nokits-');
  fs.mkdirSync(path.join(home, 'teams'), { recursive: true });
  fs.cpSync(path.join(LIB, 'templates'), path.join(home, 'library', 'templates'), { recursive: true });
  fs.cpSync(path.join(LIB, 'prompts'), path.join(home, 'library', 'prompts'), { recursive: true });
  const tm = createTeamManifest({ fs, clodexHome: home });

  const team = tm.createTeam({ name: 'x', root: mkTmpRoot('t803-proj-'), lead: 'x-lead' });
  assert.strictEqual(team.kit, 'clodex', 'no key on disk, so it loads as legacy');
  assert.ok(!('kit' in JSON.parse(fs.readFileSync(team.file, 'utf-8'))));
  assert.deepStrictEqual(readTeamTpl(home, 'x', 'hand').disabledTools,
    JSON.parse(fs.readFileSync(path.join(LIB, 'templates', 'clodex-team-hand.json'), 'utf-8')).disabledTools,
    'the flat library supplied the bytes');
  // An EXPLICIT name still refuses, rather than silently taking the fallback.
  assert.throws(() => tm.createTeam({ name: 'y', root: mkTmpRoot('t803-proj-'), lead: 'y-lead', kit: 'default' }),
    /unknown kit "default" \(available: none\)/);
});

test('a kit ships exec defs into the team\'s own exec/, and never over one it owns', () => {
  const home = mkHome();
  fs.mkdirSync(path.join(home, 'library', 'kits', 'default', 'exec'), { recursive: true });
  fs.writeFileSync(path.join(home, 'library', 'kits', 'default', 'exec', 'kit-cmd.json'),
    JSON.stringify({ argv: ['echo', 'from-kit'] }));
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'x', root: mkTmpRoot('t803-proj-'), lead: 'x-lead', kit: 'default' });
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(home, 'teams', 'x', 'exec', 'kit-cmd.json'), 'utf-8')),
    { argv: ['echo', 'from-kit'] });
});

// ── the intent surface ─────────────────────────────────────────────────────
//
// Through _handleIntent over the real fixture, because what is claimed is about
// the SITE: a `kit:` the parser reads and the handler drops is inert, and no
// assertion about createTeam's arguments can see that.

const { mkTeamCreate } = require('./lib/session-fixtures');

// The fixture's home holds no library at all. Copying the shipped kits into it
// is what makes `kit:` resolvable there — without it every create below takes
// the no-kits fallback and the contrast is empty.
function seedKits(home) {
  fs.cpSync(LIB, path.join(home, 'library'), { recursive: true });
}

test('[agent:team create kit:default] records the kit and says so in the reply', async () => {
  const f = mkTeamCreate();
  seedKits(f.home);

  await f.m._handleIntent('a', {
    type: 'team-create', name: 'shop', root: f.projectRoot, lead: null, kit: 'default', body: '',
  });

  assert.ok(f.injected.some((t) => t.includes('created from kit default')),
    `the reply names the kit — got: ${JSON.stringify(f.injected)}`);
  assert.strictEqual(f.readTeam('shop').kit, 'default');
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(f.home, 'teams', 'shop', 'templates', 'hand.json'), 'utf-8')).disabledTools,
    [], 'and the LIFTED template is what landed on disk');
});

test('[agent:team create kit:clodex] with a brief takes the kit\'s roles, worktree hand and all', async () => {
  // The brief path builds its own roles map, which WINS over the kit's in
  // createTeam — so a map built from STOCK_ROLE_DEFS would make `kit:` inert on
  // exactly this path while the reply still claimed the kit.
  const f = mkTeamCreate({ makeRepo: true });
  seedKits(f.home);

  await f.m._handleIntent('a', {
    type: 'team-create', name: 'shop', root: f.projectRoot, lead: null, kit: 'clodex', body: 'build a thing',
  });

  const team = f.readTeam('shop');
  assert.strictEqual(team.kit, 'clodex');
  assert.strictEqual(team.roles.hand.dispatch, 'worktree', 'the per-ticket hand survives the kit');
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.home, 'teams', 'shop', 'templates', 'hand.json'), 'utf-8'))
    .disabledTools.length > 20, 'and the aggressive template is what the kit supplied');
});

test('a brief create with kit:default gets the LIFTED hand — the contrast, same path', async () => {
  const f = mkTeamCreate({ makeRepo: true });
  seedKits(f.home);

  await f.m._handleIntent('a', {
    type: 'team-create', name: 'shop', root: f.projectRoot, lead: null, kit: 'default', body: 'build a thing',
  });

  const team = f.readTeam('shop');
  assert.strictEqual(team.roles.hand.dispatch, 'worktree');
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(f.home, 'teams', 'shop', 'templates', 'hand.json'), 'utf-8')).disabledTools,
    []);
});

test('[agent:team create kit:bogus] refuses, lists the kits, and creates NOTHING', async () => {
  const f = mkTeamCreate();
  seedKits(f.home);

  await f.m._handleIntent('a', {
    type: 'team-create', name: 'shop', root: f.projectRoot, lead: null, kit: 'bogus', body: '',
  });

  const reply = f.injected.join('\n');
  assert.match(reply, /unknown kit "bogus" \(available: clodex, default\)/);
  assert.match(reply, /no team was created/);
  assert.match(reply, /^clodex — /m, 'the refusal doubles as the discovery surface');
  assert.match(reply, /^default — /m);
  assert.strictEqual(f.teamExists('shop'), false);
});

test('[agent:team create kit:?] lists the kits and creates nothing', async () => {
  const f = mkTeamCreate();
  seedKits(f.home);

  await f.m._handleIntent('a', {
    type: 'team-create', name: 'shop', root: f.projectRoot, lead: null, kit: '?', body: '',
  });

  const reply = f.injected.join('\n');
  assert.match(reply, /^clodex — /m);
  assert.match(reply, /^default — /m);
  assert.strictEqual(f.teamExists('shop'), false);
});

test('the kit refusal lands BEFORE the root is git-init\'d', async () => {
  // The refusal has to precede _classifyTeamRoot, which mkdirs and git-inits.
  // "No team was created" is not true of a call that left a repo behind.
  const f = mkTeamCreate();
  seedKits(f.home);
  const fresh = path.join(f.projectRoot, 'not-yet');

  await f.m._handleIntent('a', {
    type: 'team-create', name: 'shop', root: fresh, lead: null, kit: 'bogus', body: '',
  });

  assert.match(f.injected.join('\n'), /unknown kit "bogus"/);
  assert.strictEqual(fs.existsSync(fresh), false,
    'the root directory must not exist — an unknown kit must leave the disk untouched');
});

test('a create naming NO kit still works on a home with no kits at all', async () => {
  // The fixture's bare home is the pre-seed registry. A throw here would make
  // team create unusable between an app upgrade and its next library seed.
  const f = mkTeamCreate();
  await f.m._handleIntent('a', {
    type: 'team-create', name: 'shop', root: f.projectRoot, lead: null, kit: null, body: '',
  });
  assert.strictEqual(f.teamExists('shop'), true);
  assert.ok(!f.injected.some((t) => t.includes('from kit')),
    'and the reply claims no kit, because none was recorded');
});

test('createTeam reports the kit it SEEDED from, distinct from the manifest\'s effective kit', () => {
  // Two different questions, and one key cannot answer both: `kit` is what a
  // later addRole must copy from (legacy → clodex), `kitSeeded` is what THIS
  // call actually used. A create that recorded nothing must report nothing, or
  // the reply claims a kit the operator never picked.
  const home = mkHome();
  const tm = createTeamManifest({ fs, clodexHome: home });
  const seeded = tm.createTeam({ name: 'x', root: mkTmpRoot('t803-proj-'), lead: 'x-lead', kit: 'clodex' });
  assert.strictEqual(seeded.kitSeeded, 'clodex');
  assert.strictEqual(seeded.kit, 'clodex');

  const bare = mkTmpRoot('t803-bare-');
  fs.mkdirSync(path.join(bare, 'teams'), { recursive: true });
  fs.cpSync(path.join(LIB, 'templates'), path.join(bare, 'library', 'templates'), { recursive: true });
  const tmBare = createTeamManifest({ fs, clodexHome: bare });
  const legacy = tmBare.createTeam({ name: 'y', root: mkTmpRoot('t803-proj-'), lead: 'y-lead' });
  assert.strictEqual(legacy.kitSeeded, null, 'nothing was seeded from, so nothing is claimed');
  assert.strictEqual(legacy.kit, 'clodex', 'while the effective kit still answers "what does addRole copy"');
});

test('a brief that cannot be saved unwinds the kit\'s exec copies too', async () => {
  // The whole directory has to go. A surviving exec/ makes rmdir(dir) fail, and
  // what is left is a manifest-less team directory listTeams still reports —
  // the same failure mode the template and prompt unwinds exist to prevent.
  const f = mkTeamCreate({ makeRepo: true });
  seedKits(f.home);
  fs.mkdirSync(path.join(f.home, 'library', 'kits', 'default', 'exec'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'library', 'kits', 'default', 'exec', 'kit-cmd.json'),
    JSON.stringify({ argv: ['echo', 'hi'] }));
  // The brief save fails because its target directory is not writable.
  const dir = path.join(f.home, 'teams', 'shop');
  fs.mkdirSync(path.join(dir, 'prompts', 'append'), { recursive: true });
  fs.chmodSync(path.join(dir, 'prompts', 'append'), 0o500);

  await f.m._handleIntent('a', {
    type: 'team-create', name: 'shop', root: f.projectRoot, lead: null, kit: 'default', body: 'the brief',
  });

  assert.ok(f.injected[0] && f.injected[0].includes('no team was created'),
    `ENTER: the brief save really failed — got: ${f.injected[0]}`);
  assert.strictEqual(fs.existsSync(dir), false, 'the whole team directory is gone, exec/ included');
});

test('createTeam unwinds its kit exec copies when team.json cannot be written', () => {
  const home = mkHome();
  fs.mkdirSync(path.join(home, 'library', 'kits', 'default', 'exec'), { recursive: true });
  fs.writeFileSync(path.join(home, 'library', 'kits', 'default', 'exec', 'kit-cmd.json'),
    JSON.stringify({ argv: ['echo', 'hi'] }));
  // A directory where team.json must go: the atomic write fails, the unwind runs.
  fs.mkdirSync(path.join(home, 'teams', 'x', 'team.json'), { recursive: true });
  const tm = createTeamManifest({ fs, clodexHome: home });

  assert.throws(() => tm.createTeam({ name: 'x', root: mkTmpRoot('t803-proj-'), lead: 'x-lead', kit: 'default' }));
  assert.strictEqual(fs.existsSync(path.join(home, 'teams', 'x', 'exec')), false,
    'the exec copies this call made are gone');
});
