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
  // clodex-run-tests / clodex-check-syntax / clodex-repo-state all run
  // ${TEAM_ROOT}/scripts/<name>.sh, which exists only in this repo: TEAM_ROOT
  // follows a new team correctly and the script is still missing, so the grant
  // bounces on every call. A default that is broken out of the box teaches the
  // operator to distrust the grants list.
  const REPO_SCOPED = ['clodex-run-tests', 'clodex-check-syntax', 'clodex-repo-state'];
  for (const cmd of REPO_SCOPED) {
    assert.ok(!(tpl.execCommands || []).includes(cmd),
      `${cmd} needs a script only this repo ships — it cannot be a portable default`);
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

test('the stock hand def stays inside the role schema (template/prompt/brief only)', () => {
  // A role field no resolver reads is how the five cut fields were born.
  assert.deepStrictEqual(Object.keys(STOCK_ROLE_DEFS.hand).sort(), ['brief', 'prompt', 'template']);
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
    assert.deepStrictEqual(seeded.execCommands, ['clodex-team']);
    assert.deepStrictEqual(seeded.appendPromptFiles, ['team-project']);
    // Its one grant must be seeded too, or the default template ships a grant
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

test('re-pointing the stock hand template is SEED-ONLY — an existing team.json is unaffected', () => {
  // Our own team.json names clodex-hand-seat explicitly, so this change must be
  // inert for us. STOCK_ROLE_DEFS is read at createTeam and at team:join's
  // add-role; nothing re-reads it for a team that already has the role.
  const manifestSrc = fs.readFileSync(path.join(__dirname, '..', 'team-manifest.js'), 'utf-8');
  const uses = manifestSrc.split('STOCK_ROLE_DEFS').length - 1;
  assert.strictEqual(uses, 5,
    'declaration + export + the three createTeam defaults. A NEW read site means it stopped being seed-only — '
    + 'check it cannot rewrite a live team\'s role, then update this count.');
});
