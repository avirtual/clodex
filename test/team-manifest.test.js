'use strict';

// team-manifest: project/team resolution (docs/teams-design.md). Pure-leaf
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
  formatCompositionDelta, STOCK_ROLE_DEFS,
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
      lead: { template: 'fable-lead', standing: 'prompts/lead.md' },
      reviewer: { template: 'sonnet-review', instantiate: 'subagent' },
      runner: { template: 'haiku-runner', ephemeral: true },
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
  assert.strictEqual(m.roles.lead.instantiate, 'session');
  assert.strictEqual(m.roles.lead.ephemeral, false);
  assert.strictEqual(m.roles.reviewer.instantiate, 'subagent');
  assert.strictEqual(m.roles.runner.ephemeral, true);
  assert.strictEqual(m.roles.runner.standing, null);
  assert.strictEqual(m.roles.lead.prompt, null, 'prompt defaults to null when absent');
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

test('loadManifest carries optional role tools + type through the shape (default null)', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'shop', {
    root, lead: 'lead', watchdogMs: 600000,
    roles: {
      lead: { template: 'fable-lead' }, // no tools/type → null
      reviewer: { instantiate: 'subagent', tools: ['Read', 'Grep', 'Glob'], type: 'claude' },
    },
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const m = tm.loadManifest('shop');
  assert.deepStrictEqual(m.roles.reviewer.tools, ['Read', 'Grep', 'Glob'], 'tools allowlist carried');
  assert.strictEqual(m.roles.reviewer.type, 'claude', 'type carried');
  assert.strictEqual(m.roles.lead.tools, null, 'tools defaults to null when absent');
  assert.strictEqual(m.roles.lead.type, null, 'type defaults to null when absent');
  assert.strictEqual(m.watchdogMs, 600000, 'watchdogMs override carried');
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
    [{ root: '/p', lead: 'lead', roles: { lead: {}, dev: { instantiate: 'daemon' } } }, /instantiate must be/],
    [{ root: '/p', lead: 'lead', roles: { lead: { instantiate: 'subagent' } } }, /lead role "lead" must have instantiate: session/],
    [{ root: '/p', lead: 'lead', roles: { lead: { template: 42 } } }, /template must be a string/],
    [{ root: '/p', lead: 'lead', roles: { lead: { prompt: 42 } } }, /prompt must be a string/],
    [{ root: '/p', lead: 'lead', roles: { lead: { brief: 42 } } }, /brief must be a string/],
    [{ root: '/p', lead: 'lead', roles: { lead: { tools: 'Read' } } }, /tools must be an array of strings/],
    [{ root: '/p', lead: 'lead', roles: { lead: { tools: ['Read', 7] } } }, /tools must be an array of strings/],
    [{ root: '/p', lead: 'lead', roles: { lead: { tools: [] } } }, /tools must not be empty/],
    [{ root: '/p', lead: 'lead', roles: { lead: { type: 42 } } }, /type must be a string/],
    [{ root: '/p', lead: 'lead', roles: { lead: {} }, watchdogMs: 'soon' }, /"watchdogMs" must be a positive number/],
    [{ root: '/p', lead: 'lead', roles: { lead: {} }, watchdogMs: 0 }, /"watchdogMs" must be a positive number/],
    [{ root: '/p', lead: 'lead', roles: { lead: {} }, watchdogMs: -5 }, /"watchdogMs" must be a positive number/],
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

// --- spawn-time team context (matchSeatRole + formatTeamBlock) --------------
// The pure pieces behind session-manager's spawn-time injection, ROLE-KEYED
// schema: bind a seat to its role (the lead SEAT → `lead` role; other seats via
// the `<team>-<role>` convention with `-N` collision stripping), and render the
// per-seat-invariant identity block (roster listing moved OUT to a data message).

const teamFixture = () => ({
  name: 'shop', root: '/Users/me/shop', lead: 'boss',
  roles: {
    lead: { template: 'fable-lead', standing: null, prompt: null, instantiate: 'session', ephemeral: false, brief: null },
    hand: { template: null, standing: null, prompt: null, instantiate: 'session', ephemeral: false, brief: null },
    reviewer: { template: 'sonnet-review', standing: null, prompt: null, instantiate: 'subagent', ephemeral: false, brief: null },
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

test('formatTeamBlock: shrunk identity block with role match (lead seat)', () => {
  const block = formatTeamBlock(teamFixture(), 'boss');
  assert.match(block, /^# Team$/m);
  assert.match(block, /You are seat boss on team shop \(root \/Users\/me\/shop\)\. Your role: lead\./);
  assert.match(block, /Team composition arrives in your context; ground truth: \[agent:exec clodex-team\] roster\./);
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
      reviewer: { template: 'sonnet-review', instantiate: 'subagent', prompt: 'clodex-team-reviewer' },
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
  assert.strictEqual(team.roles.lead.instantiate, 'session');
  assert.ok(team.roles.lead.brief, 'lead gets a stock brief');
  assert.strictEqual(team.roles.hand.prompt, 'clodex-team-hand');
  assert.strictEqual(team.roles.hand.instantiate, 'session');
  assert.strictEqual(team.roles.reviewer.instantiate, 'subagent');
  assert.strictEqual(team.roles.reviewer.prompt, 'clodex-team-reviewer');
  assert.deepStrictEqual(team.roles.reviewer.tools, ['Read', 'Grep', 'Glob'],
    'stock reviewer is a read-only subagent');
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
    roles: { lead: { prompt: 'my-lead' }, runner: { instantiate: 'subagent', prompt: 'my-runner' } },
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

// --- formatRoster: the initial-roster message ------------------------------
test('formatRoster lists roles, briefs, class, and live seats per role', () => {
  const team = {
    name: 'shop', root: '/r', lead: 'clodex',
    roles: {
      lead: { instantiate: 'session', brief: 'the lead', prompt: null, template: null, standing: null, ephemeral: false },
      hand: { instantiate: 'session', brief: 'the hand', prompt: null, template: null, standing: null, ephemeral: false },
      reviewer: { instantiate: 'subagent', brief: 'the reviewer', prompt: null, template: null, standing: null, ephemeral: false },
    },
  };
  const roster = formatRoster(team, ['clodex', 'shop-hand', 'shop-hand-2']);
  assert.match(roster, /^\[team shop\] roster \(lead: clodex\)/m);
  assert.match(roster, /- lead \(session\) — the lead · live: clodex/);
  assert.match(roster, /- hand \(session\) — the hand · live: shop-hand, shop-hand-2/);
  // reviewer is subagent-class and has no live seat → listed, no "live:" tail.
  assert.match(roster, /- reviewer \(subagent\) — the reviewer$/m);
  assert.match(roster, /Ground truth on demand: \[agent:exec clodex-team\] roster\./);
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
