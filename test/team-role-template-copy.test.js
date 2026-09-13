'use strict';

// t789: a new team gets its OWN copy of each role's template.
//
// A role pointing at a library stem (`clodex-team-hand`) has nothing of its own
// to edit, and the library copy is re-seeded on boot — so an operator editing it
// cannot tell what they are changing or keep it. createTeam and addRole now copy
// the stock template to `templates/<role>.json` in the team dir and repoint the
// role at `<role>`.
//
// Real fs on tmpdirs with a hand-built `library/templates/`, because the claim is
// about bytes landing in one directory rather than another.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');

const { createTeamManifest, STOCK_ROLE_DEFS } = require('../team-manifest');
const { mkPark, mkTeamCreate } = require('./lib/session-fixtures');

// `id` is LISTING decoration, not a template key. It has no business in a file on
// disk, but a hand-authored library template can carry one — and the copy strips
// the same set deriveModelTemplate strips, so the deepStrictEqual below measures
// that strip only because this key is here to be dropped.
const LIB_HAND = {
  name: 'clodex-team-hand',
  type: 'claude',
  cwd: '${TEAM_ROOT}',
  execCommands: ['clodex-run-tests'],
  env: { A: '1' },
  id: 'clodex-team-hand',
};
const LIB_HAND_COPIED = { ...LIB_HAND };
delete LIB_HAND_COPIED.id;
const LIB_LEAD = { name: 'clodex-team-lead', type: 'claude', cwd: '${TEAM_ROOT}', stripLevel: 2 };
const LIB_REVIEWER = {
  name: 'clodex-team-reviewer',
  type: 'claude',
  systemPromptFile: 'clodex-team-reviewer',
  tools: ['Read', 'Grep', 'Glob'],
  extraArgs: ['--model', 'sonnet'],
};

// A clodex home whose `library/templates/` holds whatever the caller names. With
// `library` false the directory is absent entirely — the not-installed case.
// t791: the prompt bodies, one per stock role. Deliberately distinct strings —
// a copy that wrote the wrong role's body would satisfy an existsSync check and
// a length check, but not the byte comparison these feed.
const LIB_PROMPTS = {
  'clodex-team-lead': 'you are the lead\n',
  'clodex-team-hand': 'you are the hand\n',
  'clodex-team-reviewer': 'you are the reviewer\n',
};

function mkHome({
  library = { 'clodex-team-hand': LIB_HAND, 'clodex-team-lead': LIB_LEAD, 'clodex-team-reviewer': LIB_REVIEWER },
  prompts = LIB_PROMPTS,
} = {}) {
  const home = mkTmpRoot('t789-home-');
  fs.mkdirSync(path.join(home, 'teams'), { recursive: true });
  if (library) {
    const dir = path.join(home, 'library', 'templates');
    fs.mkdirSync(dir, { recursive: true });
    for (const [stem, body] of Object.entries(library)) {
      fs.writeFileSync(path.join(dir, `${stem}.json`), `${JSON.stringify(body, null, 2)}\n`);
    }
  }
  if (prompts) {
    const dir = path.join(home, 'library', 'prompts', 'system');
    fs.mkdirSync(dir, { recursive: true });
    for (const [stem, body] of Object.entries(prompts)) {
      fs.writeFileSync(path.join(dir, `${stem}.md`), body);
    }
  }
  return home;
}

const teamDir = (home, name) => path.join(home, 'teams', name);
const tplDir = (home, name) => path.join(teamDir(home, name), 'templates');
const readTpl = (home, name, stem) => JSON.parse(fs.readFileSync(path.join(tplDir(home, name), `${stem}.json`), 'utf-8'));

test('t789 createTeam: every role with a stock template gets the team\'s own copy, and points at it', () => {
  const home = mkHome();
  const root = mkTmpRoot('t789-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });

  // ENTER: the team dir does not exist yet, so every assertion below is about
  // bytes THIS call wrote. Without it a fixture that pre-seeded the copies would
  // satisfy the whole test with createTeam writing nothing.
  assert.strictEqual(fs.existsSync(teamDir(home, 'x')), false, 'ENTER: no team dir before the create');

  const team = tm.createTeam({ name: 'x', root, lead: 'x-lead' });

  // The copies exist and are the library body with `name` swapped to the ROLE —
  // the same shape deriveModelTemplate produces, minus the --model splice.
  assert.deepStrictEqual(readTpl(home, 'x', 'hand'), { ...LIB_HAND_COPIED, name: 'hand' });
  assert.deepStrictEqual(readTpl(home, 'x', 'lead'), { ...LIB_LEAD, name: 'lead' });
  assert.deepStrictEqual(readTpl(home, 'x', 'reviewer'), { ...LIB_REVIEWER, name: 'reviewer' },
    't891: the reviewer is copied for too, and its `extraArgs` survives verbatim — reviewerModelArgs reads the --model out of exactly this array, so a copier that dropped it would seed a team whose reviewer silently lost its model');
  assert.deepStrictEqual(fs.readdirSync(tplDir(home, 'x')).sort(), ['hand.json', 'lead.json', 'reviewer.json'],
    'three copies and no more — a fourth file means a role gained a template nobody decided to give it, a missing one means a stock role lost the file its seat boots on, and a listing assertion catches both where existsSync calls would not');
  assert.deepStrictEqual(team.templatesCopied, ['lead', 'hand', 'reviewer'],
    'and the create reports exactly the roles it wrote a file for');

  // ON DISK in team.json, which is what every later resolution reads: a return
  // value repointed while the manifest still named the library stem would leave
  // the operator editing a file nothing loads.
  const m = tm.loadManifest('x');
  assert.strictEqual(m.roles.hand.template, 'hand');
  assert.strictEqual(m.roles.lead.template, 'lead');
  assert.strictEqual(m.roles.reviewer.template, 'reviewer',
    't891: the reviewer points at its own copy, so its model is a per-team setting');
});

test('t789 createTeam: a library that does not have the template leaves the def naming the stem', () => {
  const home = mkHome({ library: false, prompts: false });
  const root = mkTmpRoot('t789-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });

  // ENTER: there is no library at all, which is the not-installed case this
  // covers — 101 existing fixtures construct createTeamManifest exactly so.
  assert.strictEqual(fs.existsSync(path.join(home, 'library')), false, 'ENTER: no library dir');

  const team = tm.createTeam({ name: 'x', root, lead: 'x-lead' });

  const m = tm.loadManifest('x');
  assert.strictEqual(m.roles.hand.template, 'clodex-team-hand', 'the stem survives — the resolver falls back to it');
  assert.strictEqual(m.roles.lead.template, 'clodex-team-lead');
  assert.deepStrictEqual(team.templatesCopied, [], 'nothing was copied, and the reply says so');
  assert.strictEqual(fs.existsSync(tplDir(home, 'x')), false,
    'and no empty templates/ directory was left behind to look like a team that owns files');
});

test('t789 addRole: a new role gets its own copy; a re-add over an existing copy does not rewrite it', () => {
  const home = mkHome();
  const root = mkTmpRoot('t789-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'x', root, lead: 'x-lead' });

  const added = tm.addRole('x', 'scribe', { template: 'clodex-team-hand', brief: 'writes things' });
  assert.deepStrictEqual(readTpl(home, 'x', 'scribe'), { ...LIB_HAND_COPIED, name: 'scribe' });
  assert.strictEqual(added.roles.scribe.template, 'scribe');
  assert.deepStrictEqual(added.templatesCopied, ['scribe']);

  // The operator's edit. A re-add that overwrote the copy would silently discard
  // it — this is the whole reason the team gets a file of its own.
  const own = path.join(tplDir(home, 'x'), 'scribe.json');
  fs.writeFileSync(own, `${JSON.stringify({ ...LIB_HAND_COPIED, name: 'scribe', env: { A: 'edited' } }, null, 2)}\n`);
  const edited = fs.readFileSync(own);

  tm.removeRole('x', 'scribe');
  // ENTER: role-rm removes the ROLE, not the file — the re-add below is only a
  // test of the not-overwritten guard while the copy is still on disk.
  assert.ok(fs.existsSync(own), 'ENTER: removeRole left the team\'s own copy in place');
  assert.strictEqual(tm.loadManifest('x').roles.scribe, undefined, 'ENTER: and the role is gone');

  const re = tm.addRole('x', 'scribe', { template: 'clodex-team-hand', brief: 'writes things' });
  assert.deepStrictEqual(fs.readFileSync(own), edited,
    'BYTES: the operator\'s edited copy is what stayed — a rewrite from the library would compare equal as JSON only if the edit were lost');
  assert.strictEqual(re.roles.scribe.template, 'scribe', 'and the role points at it again');
  assert.deepStrictEqual(re.templatesCopied, [],
    'nothing was written, so the reply must not claim a copy it skipped');
});

// The ordering constraint inside addRole: the copy runs on the MINT arm only,
// after the already-exists check. Copying first would repoint `template` at the
// role's own file, and addRole is exact-match-or-throw. The comparison therefore
// runs against the def REPOINTED the same way, or re-riding the stock def (which
// team:join does unconditionally) would compare `clodex-team-hand` against the
// `hand` already on disk and throw "already exists with a different definition",
// breaking every join.
test('t789 addRole: re-riding the same stock def stays a no-op after the copy repointed the role', () => {
  const home = mkHome();
  const root = mkTmpRoot('t789-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });
  // No `roles`, so the scaffold seeds lead+hand+reviewer and hand's copy lands.
  tm.createTeam({ name: 'x', root, lead: 'x-lead' });
  // ENTER: the create repointed the role, which is the state that makes the
  // re-ride below a mismatch if the copy ran on the wrong side of the check.
  assert.strictEqual(tm.loadManifest('x').roles.hand.template, 'hand',
    'ENTER: the role already points at its own copy');

  // What team:join re-rides: the STOCK def, still naming the library stem.
  assert.doesNotThrow(() => tm.addRole('x', 'hand', { ...STOCK_ROLE_DEFS.hand }),
    'a join onto a role the create already copied for must not read as a redefinition');
  assert.strictEqual(tm.loadManifest('x').roles.hand.template, 'hand',
    'and the no-op left the role pointing at its own copy');
});

// mkTeamCreate's home ships no library, so a create through it copies nothing —
// which is exactly the case the shipped box is NOT in. Seeding it is what makes
// the handler tests below run against the on-disk layout a real create produces.
function seedLibrary(home) {
  const dir = path.join(home, 'library', 'templates');
  fs.mkdirSync(dir, { recursive: true });
  for (const [stem, body] of [['clodex-team-hand', LIB_HAND], ['clodex-team-lead', LIB_LEAD]]) {
    fs.writeFileSync(path.join(dir, `${stem}.json`), `${JSON.stringify(body, null, 2)}\n`);
  }
  const pdir = path.join(home, 'library', 'prompts', 'system');
  fs.mkdirSync(pdir, { recursive: true });
  for (const [stem, body] of Object.entries(LIB_PROMPTS)) {
    fs.writeFileSync(path.join(pdir, `${stem}.md`), body);
  }
}

// The intent replies. The clause is how a lead learns the team owns files now —
// without it the copy is invisible until someone lists the directory.
test('t789 [agent:team create]: the reply names the roles that got a copy, and omits the clause when none did', async () => {
  const f = mkTeamCreate();
  seedLibrary(f.home);

  await f.m._handleIntent('a', { type: 'team-create', name: 'shop', root: f.projectRoot, lead: null, body: '' });
  assert.ok(f.injected.some((t) => t.includes('templates copied to templates/<role>.json for lead, hand')),
    `the create reply names the copied roles — got: ${JSON.stringify(f.injected)}`);

  // The same intent against a home with no library: no clause at all, so a lead
  // is never told about a file that is not there.
  const bare = mkTeamCreate();
  await bare.m._handleIntent('a', { type: 'team-create', name: 'shop', root: bare.projectRoot, lead: null, body: '' });
  assert.ok(bare.injected.length, 'ENTER: the bare create replied at all');
  assert.ok(!bare.injected.some((t) => /templates copied/.test(t)),
    'no library, no copy, no clause');
});

test('t789 [agent:team role-add]: the reply names the copy, over the REAL mutator', async () => {
  const home = mkHome();
  const root = mkTmpRoot('t789-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'lead' });
  // The real addRole, not a stub: the clause is built from what the mutator
  // reports, so a stub would pin the formatting against a value nothing produces.
  const { m, injected } = mkPark({
    fs, path, REGISTRY_DIR: home,
    resolveTeam: () => tm.loadManifest('shop'),
    findProjectRoot: () => root,
    addRole: tm.addRole,
  });
  m._broadcast = () => {};
  m._sendToSession = () => {};
  const seat = { name: 'lead', type: 'claude', agentType: 'claude', cwd: root, activityState: 'idle' };
  m.sessions.set('lead', seat);

  m._handleTeam(seat, { type: 'team', sub: 'role-add', name: 'scribe', template: 'clodex-team-hand', body: 'writes' });

  assert.deepStrictEqual(readTpl(home, 'shop', 'scribe'), { ...LIB_HAND_COPIED, name: 'scribe' },
    'ENTER: the role-add really did write the copy — the clause below is about this file');
  assert.ok(injected.some((t) => t.includes('role "scribe" added to shop; templates copied to templates/<role>.json for scribe')),
    `the role-add reply carries the clause — got: ${JSON.stringify(injected)}`);
});

test('t789 createTeam: a copy that cannot be written throws, and unwinds the copies it already made', () => {
  const home = mkHome();
  const root = mkTmpRoot('t789-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });
  // A DIRECTORY where hand.json must go: the rename onto it fails, and it fails
  // on the second role, after lead.json has already landed. That ordering is the
  // point — a create that threw before writing anything would pass this test
  // without the unwind existing.
  fs.mkdirSync(path.join(tplDir(home, 'x'), 'hand.json'), { recursive: true });

  assert.throws(() => tm.createTeam({ name: 'x', root, lead: 'x-lead' }));

  assert.strictEqual(fs.existsSync(path.join(teamDir(home, 'x'), 'team.json')), false,
    'no manifest: a team.json naming templates/hand.json that is not there is worse than no team');
  assert.deepStrictEqual(fs.readdirSync(tplDir(home, 'x')).sort(), ['hand.json'],
    'lead.json was unwound — only the fixture\'s own obstruction is left');
  assert.strictEqual(fs.statSync(path.join(tplDir(home, 'x'), 'hand.json')).isDirectory(), true,
    'ENTER: the obstruction is the directory this test planted, so the write really was refused');
});

test('t789 createTeam: a team.json that cannot be written unwinds the copies made for that call', () => {
  const home = mkHome();
  const root = mkTmpRoot('t789-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });
  // The copies succeed and the MANIFEST write is what fails — the other side of
  // the ordering. Without the unwind the team dir is left holding two templates
  // for a team that does not exist, which the next create of the same name then
  // adopts as "already owned" copies it never made.
  fs.mkdirSync(path.join(teamDir(home, 'x'), 'team.json'), { recursive: true });

  assert.throws(() => tm.createTeam({ name: 'x', root, lead: 'x-lead' }));

  assert.deepStrictEqual(fs.readdirSync(teamDir(home, 'x')).sort(), ['team.json'],
    'both copies AND the templates/ directory are gone — only the fixture\'s obstruction is left');
  assert.strictEqual(fs.statSync(path.join(teamDir(home, 'x'), 'team.json')).isDirectory(), true,
    'ENTER: the obstruction is the directory this test planted, so the manifest write really was refused');
});

// The kickstart create's OTHER unwind, the one that runs after createTeam already
// succeeded. The pre-t789 pin for this (session-manager.test.js, 'a brief that
// cannot be saved leaves NO team behind') stays green over a home with no
// library, so it never sees a copy — and `rmdir` refuses a non-empty directory,
// which is how a fully-unwound-looking cleanup started leaving a team dir with
// no manifest for listTeams to report as a broken team.
//
// A READ-ONLY prompts/append/ rather than the older pin's directory-shaped prompt
// file: that obstruction lives INSIDE teams/<name>, so it keeps the directory
// alive on its own and no unwind could ever empty it. This one makes
// teamPromptSave's write fail while leaving nothing of the caller's behind, so
// "the team directory is gone" is a claim about the unwind rather than about the
// fixture. It is `append/` and not `prompts/` itself because t791's prompt copies
// mkdir `prompts/system` during the create: an unwritable `prompts/` would fail
// the CREATE, and the brief save under test here would never run.
function mkFailedBriefCreate() {
  const f = mkTeamCreate();
  seedLibrary(f.home);
  const dir = path.join(f.home, 'teams', 'shop');
  fs.mkdirSync(path.join(dir, 'prompts', 'append'), { recursive: true });
  fs.chmodSync(path.join(dir, 'prompts', 'append'), 0o500);
  return { f, dir };
}

test('t789 create: a brief that cannot be saved unwinds the template copies too, on a box that HAS a library', async () => {
  const { f, dir } = mkFailedBriefCreate();

  await f.m._handleIntent('a', {
    type: 'team-create', name: 'shop', root: f.projectRoot, lead: null, body: 'the brief',
  });

  assert.ok(f.injected[0] && f.injected[0].includes('no team was created'),
    `ENTER: the brief save really failed — got: ${f.injected[0]}`);
  assert.strictEqual(fs.existsSync(dir), false,
    'the whole team directory is gone: a surviving templates/ would make rmdir(dir) fail and leave a manifest-less team listTeams still reports');
});

test('t789 create: the re-fire after that failure copies again, and says so', async () => {
  // The reply above tells the seat to re-fire. If the copies had survived the
  // unwind, the retry would treat them as already owned: repointed silently, with
  // `templatesCopied` empty and no clause — the operator never told the team owns
  // files it did not write.
  const { f, dir } = mkFailedBriefCreate();
  await f.m._handleIntent('a', {
    type: 'team-create', name: 'shop', root: f.projectRoot, lead: null, body: 'the brief',
  });
  assert.strictEqual(fs.existsSync(dir), false, 'ENTER: the failed create left nothing');

  f.injected.length = 0;
  await f.m._handleIntent('a', {
    type: 'team-create', name: 'shop', root: f.projectRoot, lead: null, body: '',
  });

  assert.ok(f.injected.some((t) => t.includes('templates copied to templates/<role>.json for lead, hand')),
    `the retry reports both copies — got: ${JSON.stringify(f.injected)}`);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'templates')).sort(), ['hand.json', 'lead.json'],
    'and the files are really there, written by THIS create');
});

// --- t791: the same, for each role's SYSTEM PROMPT. A role pointing at a library
// stem has no prompt of its own to edit; create and role-add now copy the stock
// prompt to `prompts/system/<role>.md` and repoint the role at `<role>`. Unlike a
// template the bytes are copied verbatim, so every assertion below is byte-exact.

const sysDir = (home, name) => path.join(teamDir(home, name), 'prompts', 'system');
const readPrompt = (home, name, stem) => fs.readFileSync(path.join(sysDir(home, name), `${stem}.md`), 'utf-8');

test('t791 createTeam: every role with a stock prompt gets the team\'s own copy, byte-equal, and points at it', () => {
  const home = mkHome();
  const root = mkTmpRoot('t791-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });

  assert.strictEqual(fs.existsSync(teamDir(home, 'x')), false, 'ENTER: no team dir before the create');

  const team = tm.createTeam({ name: 'x', root, lead: 'x-lead' });

  // BYTES, not a JSON compare: the prompt is prose, and the only claim worth
  // making about a copy of prose is that it is the same prose.
  assert.strictEqual(readPrompt(home, 'x', 'lead'), LIB_PROMPTS['clodex-team-lead']);
  assert.strictEqual(readPrompt(home, 'x', 'hand'), LIB_PROMPTS['clodex-team-hand']);
  assert.strictEqual(readPrompt(home, 'x', 'reviewer'), LIB_PROMPTS['clodex-team-reviewer']);
  // The count, anchored at THREE: unlike templates, every stock role carries a
  // prompt — so the reviewer, which has no template, must still be copied for.
  // A fourth file means a role gained a prompt nobody decided to give it.
  assert.deepStrictEqual(fs.readdirSync(sysDir(home, 'x')).sort(), ['hand.md', 'lead.md', 'reviewer.md'],
    'three copies and no more — the reviewer HAS a prompt even without a template');
  assert.deepStrictEqual(team.promptsCopied, ['lead', 'hand', 'reviewer'],
    'and the create reports exactly the roles it wrote a file for');

  const m = tm.loadManifest('x');
  assert.strictEqual(m.roles.lead.prompt, 'lead');
  assert.strictEqual(m.roles.hand.prompt, 'hand');
  assert.strictEqual(m.roles.reviewer.prompt, 'reviewer',
    'the reviewer is repointed too — it is the role whose template could not carry it');
});

test('t791 createTeam: a library with no prompts leaves every def naming its stem', () => {
  const home = mkHome({ prompts: false });
  const root = mkTmpRoot('t791-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });

  // ENTER: templates ARE installed here, so a create that copied nothing at all
  // would pass this test for the wrong reason.
  assert.strictEqual(fs.existsSync(path.join(home, 'library', 'templates')), true, 'ENTER: templates installed');
  assert.strictEqual(fs.existsSync(path.join(home, 'library', 'prompts')), false, 'ENTER: no prompts installed');

  const team = tm.createTeam({ name: 'x', root, lead: 'x-lead' });

  const m = tm.loadManifest('x');
  assert.strictEqual(m.roles.hand.prompt, 'clodex-team-hand', 'the stem survives — the resolver falls back to it');
  assert.strictEqual(m.roles.reviewer.prompt, 'clodex-team-reviewer');
  assert.deepStrictEqual(team.promptsCopied, [], 'nothing was copied, and the reply says so');
  assert.strictEqual(fs.existsSync(path.join(teamDir(home, 'x'), 'prompts')), false,
    'and no empty prompts/ directory was left behind to look like a team that owns files');
  assert.deepStrictEqual(team.templatesCopied, ['lead', 'hand', 'reviewer'],
    'ENTER: the template copies still ran — the two copiers are independent');
});

test('t791 addRole: a new role gets its own prompt copy; a re-add over an existing copy does not rewrite it', () => {
  const home = mkHome();
  const root = mkTmpRoot('t791-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'x', root, lead: 'x-lead' });

  const added = tm.addRole('x', 'scribe', { prompt: 'clodex-team-hand', brief: 'writes things' });
  assert.strictEqual(readPrompt(home, 'x', 'scribe'), LIB_PROMPTS['clodex-team-hand']);
  assert.strictEqual(added.roles.scribe.prompt, 'scribe');
  assert.deepStrictEqual(added.promptsCopied, ['scribe']);

  // The operator's edit — the whole reason the team gets a file of its own.
  const own = path.join(sysDir(home, 'x'), 'scribe.md');
  fs.writeFileSync(own, 'the operator rewrote this\n');
  const edited = fs.readFileSync(own);

  tm.removeRole('x', 'scribe');
  assert.ok(fs.existsSync(own), 'ENTER: removeRole left the team\'s own copy in place');
  assert.strictEqual(tm.loadManifest('x').roles.scribe, undefined, 'ENTER: and the role is gone');

  const re = tm.addRole('x', 'scribe', { prompt: 'clodex-team-hand', brief: 'writes things' });
  assert.deepStrictEqual(fs.readFileSync(own), edited,
    'BYTES: the operator\'s edited copy is what stayed — a rewrite from the library would restore the stock prose');
  assert.strictEqual(re.roles.scribe.prompt, 'scribe', 'and the role points at it again');
  assert.deepStrictEqual(re.promptsCopied, [],
    'nothing was written, so the reply must not claim a copy it skipped');
});

test('t791 addRole: re-riding the same stock def stays a no-op after the prompt copy repointed the role', () => {
  const home = mkHome();
  const root = mkTmpRoot('t791-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'x', root, lead: 'x-lead' });
  assert.strictEqual(tm.loadManifest('x').roles.hand.prompt, 'hand',
    'ENTER: the role already points at its own prompt copy');

  // What team:join re-rides: the STOCK def, still naming the library stems. The
  // repointOnly pass has to cover BOTH fields, or the comparison sees a def whose
  // template matches and whose prompt does not.
  assert.doesNotThrow(() => tm.addRole('x', 'hand', { ...STOCK_ROLE_DEFS.hand }),
    'a join onto a role the create already copied for must not read as a redefinition');
  assert.strictEqual(tm.loadManifest('x').roles.hand.prompt, 'hand',
    'and the no-op left the role pointing at its own copy');
});

test('t791 createTeam: a team.json that cannot be written unwinds the prompt copies made for that call', () => {
  const home = mkHome();
  const root = mkTmpRoot('t791-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });
  fs.mkdirSync(path.join(teamDir(home, 'x'), 'team.json'), { recursive: true });

  assert.throws(() => tm.createTeam({ name: 'x', root, lead: 'x-lead' }));

  assert.deepStrictEqual(fs.readdirSync(teamDir(home, 'x')).sort(), ['team.json'],
    'the prompt copies, prompts/system and prompts are ALL gone — only the fixture\'s obstruction is left');
});

test('t791 createTeam: an unwind of the prompt copies leaves a team brief on the append rail untouched', () => {
  const home = mkHome();
  const root = mkTmpRoot('t791-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });
  // The brief shares `prompts/` with the copies but is not theirs. Both rmdirs
  // refuse a non-empty directory, which is what has to save it.
  const brief = path.join(teamDir(home, 'x'), 'prompts', 'append', 'team-project.md');
  fs.mkdirSync(path.dirname(brief), { recursive: true });
  fs.writeFileSync(brief, 'the project brief\n');
  fs.mkdirSync(path.join(teamDir(home, 'x'), 'team.json'), { recursive: true });

  assert.throws(() => tm.createTeam({ name: 'x', root, lead: 'x-lead' }));

  assert.strictEqual(fs.readFileSync(brief, 'utf-8'), 'the project brief\n',
    'the brief survived: an unwind that rmdir -r\'d prompts/ would have taken a file it never wrote');
  assert.strictEqual(fs.existsSync(path.join(teamDir(home, 'x'), 'prompts', 'system')), false,
    'and the copies it DID write are gone, directory included');
});

test('t791 [agent:team create]: the reply names the roles that got a prompt copy', async () => {
  const f = mkTeamCreate();
  seedLibrary(f.home);

  await f.m._handleIntent('a', { type: 'team-create', name: 'shop', root: f.projectRoot, lead: null, body: '' });
  assert.ok(f.injected.some((t) => t.includes('prompts copied to prompts/system/<role>.md for lead, hand, reviewer')),
    `the create reply names the copied roles — got: ${JSON.stringify(f.injected)}`);

  const bare = mkTeamCreate();
  await bare.m._handleIntent('a', { type: 'team-create', name: 'shop', root: bare.projectRoot, lead: null, body: '' });
  assert.ok(bare.injected.length, 'ENTER: the bare create replied at all');
  assert.ok(!bare.injected.some((t) => /prompts copied/.test(t)),
    'no library, no copy, no clause');
});

test('t791 create: a brief that cannot be saved unwinds the prompt copies too', async () => {
  const { f, dir } = mkFailedBriefCreate();

  await f.m._handleIntent('a', {
    type: 'team-create', name: 'shop', root: f.projectRoot, lead: null, body: 'the brief',
  });

  assert.ok(f.injected[0] && f.injected[0].includes('no team was created'),
    `ENTER: the brief save really failed — got: ${f.injected[0]}`);
  assert.strictEqual(fs.existsSync(dir), false,
    'the whole team directory is gone: a surviving prompts/system would make rmdir(prompts) and then rmdir(dir) fail, leaving a manifest-less team listTeams still reports');
});

test('t791 [agent:team role-add]: the reply names the prompt copy, over the REAL mutator', async () => {
  const home = mkHome();
  const root = mkTmpRoot('t791-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'shop', root, lead: 'lead' });
  const { m, injected } = mkPark({
    fs, path, REGISTRY_DIR: home,
    resolveTeam: () => tm.loadManifest('shop'),
    findProjectRoot: () => root,
    addRole: tm.addRole,
  });
  m._broadcast = () => {};
  m._sendToSession = () => {};
  const seat = { name: 'lead', type: 'claude', agentType: 'claude', cwd: root, activityState: 'idle' };
  m.sessions.set('lead', seat);

  m._handleTeam(seat, { type: 'team', sub: 'role-add', name: 'scribe', prompt: 'clodex-team-hand', body: 'writes' });

  assert.strictEqual(readPrompt(home, 'shop', 'scribe'), LIB_PROMPTS['clodex-team-hand'],
    'ENTER: the role-add really did write the copy — the clause below is about this file');
  assert.ok(injected.some((t) => t.includes('role "scribe" added to shop; prompts copied to prompts/system/<role>.md for scribe')),
    `the role-add reply carries the clause — got: ${JSON.stringify(injected)}`);
});

test('t891 createTeam: the reviewer role reads back WHOLE, pointing at the team\'s own copy', () => {
  const home = mkHome();
  const root = mkTmpRoot('t891-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });

  assert.strictEqual(fs.existsSync(teamDir(home, 'x')), false, 'ENTER: no team dir before the create');
  tm.createTeam({ name: 'x', root, lead: 'x-lead' });

  assert.deepStrictEqual(tm.loadManifest('x').roles.reviewer, {
    template: 'reviewer',
    prompt: 'reviewer',
    brief: STOCK_ROLE_DEFS.reviewer.brief,
    dispatch: 'standing',
    cwd: null,
    account: null,
  }, 'the WHOLE def, not a substring: a role that kept the library stem while the file was written under the role name would satisfy any single-field check on `prompt` or `brief`');

  assert.deepStrictEqual(readTpl(home, 'x', 'reviewer'), { ...LIB_REVIEWER, name: 'reviewer' },
    'and the file it points at is the library body with `name` swapped to the role');
});

test('t891: an agent still cannot repoint the reviewer role, template or not', () => {
  const home = mkHome();
  const root = mkTmpRoot('t891-proj-');
  const tm = createTeamManifest({ fs, clodexHome: home });
  tm.createTeam({ name: 'x', root, lead: 'x-lead' });
  const before = tm.loadManifest('x').roles.reviewer;
  assert.strictEqual(before.template, 'reviewer',
    'ENTER: the template is a real field on the reviewer def now, so the refusals below stop being vacuous — they are what keeps an agent from pointing the reviewer at a template of its own choosing');

  assert.throws(() => tm.setRole('x', 'reviewer', { template: 'attacker-template' }), /operator-owned topology/);
  assert.throws(() => tm.addRole('x', 'reviewer', { template: 'attacker-template' }),
    /already exists on team "x" with a different definition/,
    'addRole over an EXISTING key never reaches the reserved branch — the already-exists arm refuses here instead: a different message, the same refusal, and both must stay');
  assert.deepStrictEqual(tm.loadManifest('x').roles.reviewer, before, 'the def is untouched by both');
});
