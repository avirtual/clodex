// The shipped portable hand template (t415, stage 2).
//
// A new team's hand seat needs a cwd, and the only correct one is "the team's
// own root". Our live clodex-hand-seat.json hardcodes THIS repo's path, so an
// operator copying it across gets a hand booting in Clodex while its ticket
// lives in their project — silent, and it presents as "the engine is broken".
// These pins hold the shipped default portable: the token, no grants a fresh
// project cannot satisfy, and the append stem that names what the operator is
// expected to write.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { STOCK_ROLE_DEFS } = require('../team-manifest');
const { usesTeamRoot } = require('../team-root-expand');

const TPL_PATH = path.join(__dirname, '..', 'resources', 'library', 'templates', 'clodex-team-hand.json');
const tpl = JSON.parse(fs.readFileSync(TPL_PATH, 'utf-8'));

test('the shipped hand template writes ${TEAM_ROOT}, never an absolute path', () => {
  assert.strictEqual(tpl.cwd, '${TEAM_ROOT}');
  assert.ok(usesTeamRoot(tpl.cwd), 'and it is the literal the expander recognizes');
});

test('the shipped hand template grants no exec command that assumes OUR scripts', () => {
  // clodex-check-syntax / clodex-repo-state run ${TEAM_ROOT}/scripts/<name>.sh,
  // which exists only in this repo: TEAM_ROOT follows a new team correctly and
  // the script is still missing, so the grant bounces on every call. A default
  // that is broken out of the box teaches the operator to distrust the grants
  // list. clodex-run-tests is NOT in this set: it runs a bin Clodex ships, and
  // the only project file it needs is scripts/run-tests.js — which the merge
  // gate already requires of every team.
  const REPO_SCOPED = ['clodex-check-syntax', 'clodex-repo-state'];
  for (const cmd of REPO_SCOPED) {
    assert.ok(!(tpl.execCommands || []).includes(cmd),
      `${cmd} needs a script only this repo ships — it cannot be a portable default`);
  }
});

test('it grants the three portable commands a fresh team\'s hand needs', () => {
  // The grant is the capability: a def seeded into the library does nothing for
  // a seat whose template does not name it, so a new team's hand was born with
  // no way to run its own suite and hand-wrote a def per team.
  assert.deepStrictEqual(tpl.execCommands, ['clodex-team', 'clodex-monitor', 'clodex-run-tests']);
});

test('t803: every KIT\'s hand template carries the same portable grants', () => {
  // Kit-independent: an exec grant that needs a script only this repo ships
  // bounces on every call whichever profile a team was created from, and the
  // grant IS the capability — a kit whose hand cannot run its own suite is
  // broken in the same way the pre-t415 default was.
  const KIT_DIR = path.join(__dirname, '..', 'resources', 'library', 'kits');
  const kits = fs.readdirSync(KIT_DIR);
  assert.ok(kits.length >= 2, 'ENTER: more than one kit ships, or this loop asserts about one file');
  for (const kit of kits) {
    const dir = path.join(KIT_DIR, kit, 'templates');
    const handFile = fs.readdirSync(dir).find((f) => /^(hand|clodex-team-hand)\.json$/.test(f));
    assert.ok(handFile, `kit ${kit} ships no hand template`);
    const kitHand = JSON.parse(fs.readFileSync(path.join(dir, handFile), 'utf-8'));
    assert.deepStrictEqual(kitHand.execCommands, tpl.execCommands,
      `kit ${kit}'s hand must carry the same three portable grants`);
    for (const cmd of ['clodex-check-syntax', 'clodex-repo-state']) {
      assert.ok(!(kitHand.execCommands || []).includes(cmd),
        `kit ${kit}: ${cmd} needs a script only this repo ships`);
    }
    assert.deepStrictEqual(kitHand.appendPromptFiles, tpl.appendPromptFiles,
      `kit ${kit}'s hand must compose the same team brief`);
  }
});

test('every exec grant it DOES carry is one a fresh project can satisfy', () => {
  // The survivors must be ${CLODEX_BIN}-based (shipped with the app) rather than
  // ${TEAM_ROOT}-based (supplied by the project).
  const EXEC_DIR = path.join(__dirname, '..', 'resources', 'library', 'exec');
  for (const cmd of tpl.execCommands || []) {
    const defPath = path.join(EXEC_DIR, `${cmd}.json`);
    assert.ok(fs.existsSync(defPath), `${cmd} must be a SHIPPED exec def (seeded on first run), not a local one`);
    const def = JSON.parse(fs.readFileSync(defPath, 'utf-8'));
    const argv = def.argv.join(' ');
    assert.ok(!argv.includes('${TEAM_ROOT}'),
      `${cmd} runs a script under the team root, which a new project does not have`);
    assert.ok(argv.includes('${CLODEX_BIN}'),
      `${cmd} must run a binary Clodex itself ships`);
  }
});

test('it names the team-project append stem — the file the operator must write', () => {
  // The library deliberately ships NO team-project.md: the stem resolving to
  // nothing is the mechanism that makes preflight name the exact expected path.
  // Shipping a skeleton would report "resolved" over placeholder bytes.
  assert.deepStrictEqual(tpl.appendPromptFiles, ['team-project']);
  const shipped = path.join(__dirname, '..', 'resources', 'library', 'prompts', 'append', 'team-project.md');
  assert.ok(!fs.existsSync(shipped), 'shipping this file would defeat the named-missing-file mechanism');
});

test('the stock hand is lean by default: no model pin, and every skill off', () => {
  // The first team stood up from the bootstrap skill came up with Fable-class
  // hands carrying every installed skill, and was stopped on cost. The skills
  // sentinel is the only portable "none", because a template cannot name skills
  // that differ per box.
  assert.strictEqual(tpl.extraArgs, undefined, 'no model pin: seats follow the box default');
  assert.deepStrictEqual(tpl.disabledSkills, ['*']);
});

test('it carries no systemPromptFile — the role prompt arrives via the team block', () => {
  // The hand's system prompt is the role's `prompt` (clodex-team-hand), resolved
  // by _teamBlockFor. A template naming one too would fork that resolution.
  assert.strictEqual(tpl.systemPromptFile, null);
});

test('STOCK_ROLE_DEFS.hand points at the shipped template by its FILE name', () => {
  // The name must match the seeded filename or the role names a template that
  // does not exist, which is the trap wearing a different hat.
  assert.strictEqual(STOCK_ROLE_DEFS.hand.template, 'clodex-team-hand');
  assert.strictEqual(tpl.name, 'clodex-team-hand', 'template `name` matches its filename stem');
  assert.strictEqual(path.basename(TPL_PATH, '.json'), tpl.name);
});

test('t789: a team created against the SHIPPED library owns a copy of this template', () => {
  // The stem above is what a new team STARTS from; the copy is what it edits.
  // Driven from resources/ rather than a fixture body, so a change to the shipped
  // template that the copy path cannot carry fails here.
  const { mkTmpRoot } = require('./lib/tmp-roots');
  const { createTeamManifest } = require('../team-manifest');
  const home = mkTmpRoot('t789-portable-');
  const libDir = path.join(home, 'library', 'templates');
  fs.mkdirSync(libDir, { recursive: true });
  fs.copyFileSync(TPL_PATH, path.join(libDir, 'clodex-team-hand.json'));
  const root = mkTmpRoot('t789-portable-proj-');

  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'x', root, lead: 'x-lead' });

  const own = path.join(home, 'teams', 'x', 'templates', 'hand.json');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(own, 'utf-8')), { ...tpl, name: 'hand' },
    'the whole shipped body, with `name` swapped to the role — a key the copy dropped would show here');
  assert.strictEqual(tm.loadManifest('x').roles.hand.template, 'hand',
    'and the role names its own file, not the library stem');
  // The library original is never touched: the next team starts from it.
  assert.strictEqual(fs.readFileSync(path.join(libDir, 'clodex-team-hand.json'), 'utf-8'),
    fs.readFileSync(TPL_PATH, 'utf-8'), 'the library copy is byte-identical still');
  // The `${TEAM_ROOT}` token is the reason this file exists: a copy that expanded
  // it would pin the new team's hand to whatever root created it.
  assert.strictEqual(JSON.parse(fs.readFileSync(own, 'utf-8')).cwd, '${TEAM_ROOT}',
    'unexpanded in the copy — expanding here would hardcode a root into the team\'s own file');
});

test('the stock hand def stays inside the role schema (template/prompt/brief/dispatch only)', () => {
  // A role field no resolver reads is how the five cut fields were born.
  assert.deepStrictEqual(Object.keys(STOCK_ROLE_DEFS.hand).sort(), ['brief', 'dispatch', 'prompt', 'template']);
});

test('it seeds into a fresh registry byte-exact and surfaces through the templates store', () => {
  // STOCK_ROLE_DEFS.hand naming this template is only correct if a fresh install
  // actually HAS it — an unseeded default is a role pointing at nothing.
  const os = require('node:os');
  const { initStores } = require('../stores');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 't415-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 't415-reg-'));
  try {
    const stores = initStores(userData, { registryDir });
    const dest = path.join(registryDir, 'library', 'templates', 'clodex-team-hand.json');
    assert.ok(fs.existsSync(dest), 'seeded on construction');
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), fs.readFileSync(TPL_PATH, 'utf-8'),
      'byte-for-byte the shipped template');
    const seeded = stores.templates.list().find((t) => t.name === 'clodex-team-hand');
    assert.ok(seeded, 'the seeded hand template is listed');
    assert.strictEqual(seeded.cwd, '${TEAM_ROOT}', 'the token survives the store round-trip unexpanded');
    assert.deepStrictEqual(seeded.execCommands, ['clodex-team', 'clodex-monitor', 'clodex-run-tests']);
    assert.deepStrictEqual(seeded.appendPromptFiles, ['team-project']);
    // Its grants must be seeded too, or the default template ships a grant
    // that cannot resolve on a fresh install.
    for (const cmd of seeded.execCommands) {
      assert.ok(fs.existsSync(path.join(registryDir, 'library', 'exec', `${cmd}.json`)),
        `${cmd}.json seeded alongside it`);
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test('re-pointing the stock hand template is SEED-ONLY — every consumer, repo-wide', () => {
  // Our own team.json names clodex-hand-seat explicitly, so this must be inert
  // for us. The FIRST version of this pin counted references in team-manifest.js
  // alone and was therefore blind to ipc-handlers.js's team:join — the very site
  // where adding `template` to the stock def broke joining an older team. A pin
  // that cannot see the site that broke is not a pin, so this walks the whole
  // repo (non-test, non-artifact) and asserts the exact reference set.
  const ROOT = path.join(__dirname, '..');
  const SKIP_DIRS = new Set(['node_modules', 'test', 'web-dist', 'dist', '.git', 'docs', 'tasks', 'vendor']);
  const hits = [];
  const walk = (dir, rel = '') => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { walk(abs, relPath); continue; }
      if (!ent.name.endsWith('.js')) continue;
      // CODE references only: a comment naming the constant (this change added
      // one) is not a read site, and counting prose would make the pin fire on
      // documentation edits — the fastest way to get a ratchet deleted.
      const n = fs.readFileSync(abs, 'utf-8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
        .split('STOCK_ROLE_DEFS').length - 1;
      if (n) hits.push([relPath, n]);
    }
  };
  walk(ROOT);
  // ENTER: the reduction above must not have dropped the site this test exists
  // for. Asserting the set below over an empty/partial walk would pass vacuously.
  assert.ok(hits.some(([f]) => f === 'ipc-handlers.js'),
    'the walk must reach ipc-handlers.js — the join site that this pin was widened to cover');
  assert.deepStrictEqual(Object.fromEntries(hits.sort()), {
    // declaration + export + the three createTeam role defaults, and (t421)
    // addRole's operator re-mint of a REMOVED reserved role.
    //
    // That sixth site was checked against the question this message asks, and it
    // is still seed-only: the branch is gated on `!team.roles[roleName]`, so it
    // is reachable ONLY when the key is absent. A live team's role never enters
    // it — an existing key falls through to the ordinary already-exists arm
    // (exact-match no-op, else throw), exactly as before. Pinned in
    // team-manifest.test.js, 'the operator opt-in does NOT let a reserved def be
    // rewritten when the key exists'. So re-pointing a stock def still cannot
    // rewrite or refuse a role any live team already has.
    'team-manifest.js': 6,
    'ipc-handlers.js': 5,
    // t803: import + ONE fallback. _handleTeamCreate still builds the three role
    // defaults it hands to createTeam on a kickstart brief, but it now reads
    // them from the named KIT and falls back to this constant only for a home
    // with no kits seeded. (The hand's copy gains `dispatch: 'worktree'`; the
    // def itself is untouched, kit or fallback.)
    //
    // Checked against the question this message asks: createTeam is the MINT, and
    // it throws "already exists" on a team.json it can read, so this site is
    // reachable only for a team that does not exist yet. It never sees a live
    // team's role, so it can neither rewrite nor refuse one.
    'team-tickets.js': 2,
  }, 'a NEW read site means the stock def stopped being seed-only — verify it cannot rewrite '
    + 'or refuse a live team\'s role (addRole is exact-match-or-throw), then update this set.');
});

// The team:join regression, driven through the REAL handler.
//
// An earlier version of this test called addRole directly and asserted it
// throws. That passed with the guard reverted — it pinned team-manifest's
// behaviour, which never changed, and was blind to the handler that broke.
// A test for a call-site bug has to run the call site.
function joinFixture({ existingHand }) {
  const handlers = new Map();
  const roles = {
    lead: { prompt: 'clodex-team-lead', template: null, brief: null, dispatch: 'standing' },
    ...(existingHand ? { hand: existingHand } : {}),
  };
  const calls = { addRole: [], spawned: 0 };
  const { registerIpcHandlers } = require('../ipc-handlers');
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, error() {}, warn() {} },
    loadManifest: (name) => ({ name, roles, root: '/tmp/x', lead: 'l', file: 'team.json' }),
    // Mirrors team-manifest's exact-match-or-throw contract.
    addRole: (team, role, def) => {
      calls.addRole.push([team, role, def]);
      const existing = roles[role];
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(def)) return;
        throw new Error(`role "${role}" already exists on team "${team}" with a different definition`);
      }
      roles[role] = def;
    },
    // spawnFromParams is module-internal and cannot be stubbed, so the seams it
    // needs are supplied instead — the join path then runs for real down to
    // manager.create, which is where the spawn is counted.
    workspaceOfSender: () => 'default',
    nameConflict: () => null,
    persistence: { get: () => null, setStripLevel() {}, setAutoCompact() {} },
    agentDefaults: { getDefaultDeny: () => [], getDefaultSkillDeny: () => [], getDefaultBuiltinDeny: () => [], getStrip: () => 0 },
    manager: {
      sessions: new Map(),
      create: async () => { calls.spawned += 1; return { name: 'seat' }; },
    },
  });
  return { join: (spec) => handlers.get('team:join')(null, spec), calls };
}

test('team:join as hand SUCCEEDS on a team seeded by an older build', async () => {
  // The older shape: stock hand minus `template`. Adding `template` to
  // STOCK_ROLE_DEFS made the unconditional re-ride a definition mismatch, so
  // join failed outright with "already exists with a different definition".
  const { join, calls } = joinFixture({
    existingHand: {
      prompt: 'clodex-team-hand',
      brief: 'implementer; executes a spec to done, one distilled report per task.',
      template: null,
      dispatch: 'standing',
    },
  });
  const res = await join({ team: 'old', role: 'hand', name: 'old-hand-1', type: 'claude' });
  assert.strictEqual(res.ok, true, `joining an existing role must not fail (got: ${res.error})`);
  assert.strictEqual(calls.addRole.length, 0, 'an existing role is ADOPTED, never redefined');
  assert.strictEqual(calls.spawned, 1, 'and the seat still spawns');
});

test('team:join still MINTS the hand role when the team has none', async () => {
  // The guard must not turn join into a no-op for the case it was written for.
  const { join, calls } = joinFixture({ existingHand: null });
  const res = await join({ team: 'fresh', role: 'hand', name: 'fresh-hand-1', type: 'claude' });
  assert.strictEqual(res.ok, true, `expected a successful join (got: ${res.error})`);
  assert.strictEqual(calls.addRole.length, 1, 'an absent role is minted');
  assert.strictEqual(calls.addRole[0][2].template, 'clodex-team-hand',
    'and it is minted with the portable template');
  assert.strictEqual(calls.spawned, 1);
});

test('team:join adopts an existing CUSTOM role without rewriting its prompt', async () => {
  const { join, calls } = joinFixture({
    existingHand: { prompt: 'their-own-prompt', brief: null, template: 'their-tpl', dispatch: 'standing' },
  });
  const res = await join({ team: 'old', role: 'hand', prompt: 'something-else', name: 'x', type: 'claude' });
  assert.strictEqual(res.ok, true, `expected a successful join (got: ${res.error})`);
  assert.strictEqual(calls.addRole.length, 0,
    "the team's own definition is the authority; a join must not overwrite it");
});
