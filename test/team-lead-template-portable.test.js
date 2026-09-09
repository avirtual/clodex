// The shipped portable LEAD template (t770).
//
// The lead is the seat that carries a project's whole context on every turn, and
// a bare [agent:spawn name:X-lead cwd:Y] used to hand it every skill, every
// plugin and no exec grants at all. These pins hold the shape the default
// resolution now reaches for, and hold it AGAINST the hand template rather than
// against a copy of its fields — the two must not drift apart silently.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { usesTeamRoot } = require('../team-root-expand');

const TPL_DIR = path.join(__dirname, '..', 'resources', 'library', 'templates');
const LEAD_PATH = path.join(TPL_DIR, 'clodex-team-lead.json');
const HAND_PATH = path.join(TPL_DIR, 'clodex-team-hand.json');
const tpl = JSON.parse(fs.readFileSync(LEAD_PATH, 'utf-8'));
const hand = JSON.parse(fs.readFileSync(HAND_PATH, 'utf-8'));

test('the shipped lead template writes ${TEAM_ROOT}, never an absolute path', () => {
  assert.strictEqual(tpl.cwd, '${TEAM_ROOT}');
  assert.ok(usesTeamRoot(tpl.cwd), 'and it is the literal the expander recognizes');
});

test('its name matches its filename stem — a role naming it must resolve', () => {
  assert.strictEqual(tpl.name, 'clodex-team-lead');
  assert.strictEqual(path.basename(LEAD_PATH, '.json'), tpl.name);
});

test('the stock lead is lean by default: no model pin, every skill off', () => {
  assert.strictEqual(tpl.extraArgs, undefined, 'no model pin: seats follow the box default');
  assert.deepStrictEqual(tpl.disabledSkills, ['*']);
});

test('it grants spawn and none of the privileged intents', () => {
  // `spawn` is the one capability the lead has over a hand, and it is the only
  // one that had to be added: task, team and team-review are ungateable.
  // term/reboot/team-create are privileged: withoutPrivilegedIntentsFor strips
  // them off any agent-initiated spawn anyway, so a template naming one would
  // read as a grant that silently does nothing.
  assert.ok(tpl.intents.includes('spawn'), 'the lead must be able to open seats');
  for (const priv of ['term', 'reboot', 'team-create']) {
    assert.ok(!tpl.intents.includes(priv), `${priv} is privileged and must stay off`);
  }
  assert.deepStrictEqual(tpl.intents, [...hand.intents, 'spawn'],
    'otherwise the hand\'s intent set exactly — spawn is the only difference');
});

test('it carries the hand\'s three portable exec grants, unchanged', () => {
  // The grant is the capability: without these the lead cannot run its own
  // roster or its own suite, which is what a box-default spawn left it with.
  assert.deepStrictEqual(tpl.execCommands, hand.execCommands);
  assert.deepStrictEqual(tpl.execCommands, ['clodex-team', 'clodex-monitor', 'clodex-run-tests']);
});

test('its tool posture is the hand\'s, read from the hand file rather than copied', () => {
  // A second literal list here is the drift: the hand's posture is reviewed and
  // this template is derived from it, so the pin must fail when they diverge.
  assert.deepStrictEqual(tpl.disabledTools, hand.disabledTools);
  assert.deepStrictEqual(tpl.denyBuiltins, hand.denyBuiltins);
});

test('spawnerHint is the string "on", inverted from the hand it derives from', () => {
  // Shape only. NOTHING reads a template's top-level `spawnerHint`: the live
  // switch is env.CLODEX_SPAWNER_HINT, which session-manager reads off the
  // merged env, and neither this template nor the hand sets it. So this pins
  // that the derived file inverted the field, not that any block was turned on.
  assert.strictEqual(tpl.spawnerHint, 'on');
  assert.strictEqual(hand.spawnerHint, 'off');
  assert.strictEqual(tpl.env && tpl.env.CLODEX_SPAWNER_HINT, undefined,
    'and the field that WOULD take effect is unset, exactly as on the hand');
});

test('it names the team-project append stem, like the hand', () => {
  assert.deepStrictEqual(tpl.appendPromptFiles, ['team-project']);
});

test('it carries no systemPromptFile — the role prompt arrives via the team block', () => {
  // The lead's system prompt is the role's `prompt` (clodex-team-lead), resolved
  // by _teamBlockFor. A template naming one too would fork that resolution.
  assert.strictEqual(tpl.systemPromptFile, null);
});

test('the lead and hand templates differ in exactly name, spawnerHint and intents', () => {
  const keys = new Set([...Object.keys(tpl), ...Object.keys(hand)]);
  const differ = [...keys].filter((k) => JSON.stringify(tpl[k]) !== JSON.stringify(hand[k])).sort();
  assert.deepStrictEqual(differ, ['intents', 'name', 'spawnerHint']);
});

test('it seeds into a fresh registry byte-exact and surfaces through the templates store', () => {
  // DEFAULT_LEAD_TEMPLATE naming this stem is only correct if a fresh install
  // actually has the file — an unseeded default resolves to nothing and the
  // spawn falls back to a bare seat.
  const os = require('node:os');
  const { initStores } = require('../stores');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 't770-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 't770-reg-'));
  try {
    const stores = initStores(userData, { registryDir });
    const dest = path.join(registryDir, 'library', 'templates', 'clodex-team-lead.json');
    assert.ok(fs.existsSync(dest), 'seeded on construction');
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), fs.readFileSync(LEAD_PATH, 'utf-8'),
      'byte-for-byte the shipped template');
    const seeded = stores.templates.list().find((t) => t.name === 'clodex-team-lead');
    assert.ok(seeded, 'the seeded lead template is listed');
    assert.strictEqual(seeded.cwd, '${TEAM_ROOT}', 'the token survives the store round-trip unexpanded');
    assert.deepStrictEqual(seeded.execCommands, ['clodex-team', 'clodex-monitor', 'clodex-run-tests']);
    for (const cmd of seeded.execCommands) {
      assert.ok(fs.existsSync(path.join(registryDir, 'library', 'exec', `${cmd}.json`)),
        `${cmd}.json seeded alongside it`);
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});
