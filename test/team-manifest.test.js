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
    template: 'sonnet-review', prompt: null, brief: null, worktree: false,
  }, 'the cut keys are absent from the normalized def, not carried as null');
  assert.strictEqual(m.version, 1, 'no version field → version 1');
  assert.strictEqual(m.watchdogMs, 600000, 'watchdogMs override still carried');
  assert.strictEqual(warned.length, 1, 'ENTER: exactly one warning line was emitted');
  for (const k of ['instantiate', 'tools', 'type', 'standing', 'ephemeral']) {
    assert.match(warned[0], new RegExp(`reviewer\\.${k}`), `the warning names reviewer.${k}`);
  }
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
test('loadManifest: role worktree opt-in normalizes to a boolean, default false', () => {
  const home = mkHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  mkTeam(home, 'shop', {
    root, lead: 'lead',
    roles: {
      lead: {},
      hand: { worktree: true },
      helper: {},
    },
  });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const m = tm.loadManifest('shop');
  assert.deepStrictEqual(m.roles.hand, {
    template: null, prompt: null, brief: null, worktree: true,
  }, 'opted-in role def in full');
  assert.deepStrictEqual(m.roles.helper, {
    template: null, prompt: null, brief: null, worktree: false,
  }, 'absent worktree is FALSE, not undefined — undefined reads as opted-out at every consumer');
  // A non-boolean is a loud manifest error, not a truthy opt-in: `worktree: "no"`
  // must never enable the thing it plainly denies.
  const home2 = mkHome();
  mkTeam(home2, 'shop', { root, lead: 'lead', roles: { lead: {}, hand: { worktree: 'no' } } });
  assert.throws(() => createTeamManifest({ fs, clodexHome: home2 }).loadManifest('shop'),
    /worktree must be a boolean/);
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
    [{ root: '/p', lead: 'lead', roles: { lead: { worktree: 'yes' } } }, /worktree must be a boolean/],
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

  // A role may legitimately end in a digit. Stripping first would resolve its
  // own seat to a DIFFERENT role, which is worse than not resolving at all.
  const digitRole = teamFixture();
  digitRole.roles.hand2 = { template: null, standing: null, prompt: null, instantiate: 'session', ephemeral: false, brief: null };
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
  assert.ok(team.roles.lead.brief, 'lead gets a stock brief');
  assert.strictEqual(team.roles.hand.prompt, 'clodex-team-hand');
  assert.strictEqual(team.roles.reviewer.prompt, 'clodex-team-reviewer');
  // The reviewer's read-only cap is REVIEWER_TOOL_CAP in session-manager, a code
  // constant on the one spawn path that can enforce it. A scaffolded `tools:`
  // here restated it as data the manifest looked authoritative over and wasn't.
  assert.ok(!('tools' in team.roles.reviewer), 'the cap is code, not a scaffolded field');
  assert.strictEqual(team.version, 2, 'a freshly written manifest carries the current version');
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
    template: null, prompt: null, brief: 'a runner', worktree: false,
  }, 'the normalized def carries no tools key in any form');

  // The reviewer likewise declares none: its cap is REVIEWER_TOOL_CAP in code.
  assert.ok(!('tools' in team.roles.reviewer), 'the reviewer cap is not a manifest field');
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
    template: null, prompt: 'new-runner', brief: 'new brief', worktree: false,
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
  assert.throws(() => tm.removeRole('shop', 'lead'), /operator-owned topology/);
  assert.throws(() => tm.removeRole('shop', 'reviewer'), /operator-owned topology/);
  assert.throws(() => tm.removeRole('shop', 'ghost'), /not found on team "shop"/);
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
  lead: { instantiate: 'session', brief: 'the lead', prompt: null, template: null, standing: null, ephemeral: false },
  hand: { instantiate: 'session', brief: 'the hand', prompt: null, template: 'clodex-team-hand', standing: null, ephemeral: false },
  reviewer: { instantiate: 'subagent', brief: 'the reviewer', prompt: null, template: null, standing: null, ephemeral: false },
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
  assert.match(forLead, /Dispatch: \[agent:task add <role>\] <spec>/);
  // t174: add DISPATCHES, and the lead that filed a ticket whose body said
  // "do not start" was following a line that offered no other way to file for
  // later. The line must name the park form and say the body is not read, or
  // the prose convention it replaces gets reinvented.
  assert.match(forLead, /\[agent:task add park <role>\] <spec>/, 'the park form is named');
  assert.match(forLead, /body is NOT read by anything/, 'and the body convention is explicitly disclaimed');
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
  assert.match(roster, /Dispatch: \[agent:task add <role>\] <spec>/);
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
