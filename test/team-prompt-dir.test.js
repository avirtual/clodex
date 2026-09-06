'use strict';
// team-prompt-dir.test.js — t699: a colon-less prompt stem resolves against the
// SEAT'S TEAM DIRECTORY first (~/.clodex/teams/<name>/prompts/{system,append}/)
// and against the shared library second.
//
// The subjects drive the ENGINE resolvers, not the leaf alone. The leaf is pure,
// so every precedence assertion below would pass unchanged against an engine.js
// that never calls it — the same trap test/plugin-prompt-resolution.test.js
// closes with a source-shape check. Here the wiring is exercised directly
// instead: createEngine is built over a real temp clodex home, the team is
// created with the real createTeamManifest, and the files are real bytes on
// disk, so what runs is what a spawn runs.
//
// Every `assert.ok(RE.test(src))` below is deliberately not `assert.match`: a
// failing match formats the whole source file into the diff, and node:test then
// spends minutes rendering a 400KB string it will print as one line of noise.
//
// WHY THE CONFINEMENT IS ON THE INPUT rather than a startsWith check on the
// joined path: `team.dir` is derived from a manifest inside an AGENT-WRITABLE
// directory — team.json itself is written by [agent:team role-set] — so the
// stem, which arrives from a role def or a seat template, is the untrusted half.
// Rejecting `../x` before any join means a traversal never becomes a path at
// all; a post-hoc containment check on the joined result would still have
// touched the filesystem to decide, and would have to be re-derived correctly at
// every future call site. The "refused WITHOUT touching the fs" subject below
// asserts exactly that, by counting the calls a double records.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { teamPromptFile } = require('../team-prompt-dir');
const { createTeamManifest } = require('../team-manifest');
const { teamPreflight } = require('../team-preflight');
const { createEngine } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

const TEAM_BODY = 'TEAM\n';
const LIB_BODY = 'LIB\n';

// A real clodex home: `library/prompts/<kind>/` is what the prompt store reads
// and `teams/<name>/team.json` is what resolveTeam loads, both hung off the same
// REGISTRY_DIR the app hangs them off.
function mkHome() {
  const tmp = mkTmpRoot('clx-t699-');
  const home = path.join(tmp, 'clodex-home');
  const eng = createEngine({
    userDataPath: tmp,
    seams: { registryDir: home },
    log: { info() {}, warn() {}, error() {} },
  });
  const { createTeam, loadManifest, resolveTeam } = createTeamManifest({ fs, clodexHome: home });
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  createTeam({ name: 't', root: repo, lead: 't-lead' });
  return { eng, home, repo, team: loadManifest('t'), resolveTeam };
}

function writePrompt(dir, kind, stem, body) {
  const d = path.join(dir, 'prompts', kind);
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, `${stem}.md`);
  fs.writeFileSync(file, body);
  return file;
}

const libDir = (home) => path.join(home, 'library');
const teamDir = (home) => path.join(home, 'teams', 't');

// An fs double that records every call the leaf makes. `accessSync` THROWING is
// the point: a stem the shape test should have refused would reach it, and the
// throw names the exact call that must not have happened.
function countingFs() {
  const calls = [];
  return {
    calls,
    constants: fs.constants,
    accessSync(p) { calls.push(['accessSync', p]); throw new Error(`accessSync must not be reached for ${p}`); },
    readFileSync(p) { calls.push(['readFileSync', p]); throw new Error(`readFileSync must not be reached for ${p}`); },
  };
}

after(() => { setImmediate(() => process.exit(0)); });

// ── 1. the team copy wins on all three resolvers ────────────────────────────

test('t699: a stem present in BOTH places resolves to the team copy on every resolver', () => {
  const { eng, home, team } = mkHome();
  const teamFile = writePrompt(teamDir(home), 'system', 'x', TEAM_BODY);
  const libFile = writePrompt(libDir(home), 'system', 'x', LIB_BODY);
  writePrompt(teamDir(home), 'append', 'x', TEAM_BODY);
  writePrompt(libDir(home), 'append', 'x', LIB_BODY);

  // ENTER: both files must exist AND differ, or "the team copy won" is
  // indistinguishable from "the library copy was returned".
  assert.strictEqual(fs.readFileSync(teamFile, 'utf8'), TEAM_BODY);
  assert.strictEqual(fs.readFileSync(libFile, 'utf8'), LIB_BODY);
  assert.notStrictEqual(TEAM_BODY, LIB_BODY);

  assert.strictEqual(eng.resolveSystemPromptFile('x', null, team), teamFile,
    'the system resolver returns the path INSIDE the team directory');
  assert.strictEqual(eng.readSystemPromptBody('x', null, team), TEAM_BODY,
    'and the body reader reads that file, not the library one');
  assert.deepStrictEqual(eng.readAppendBodies(['x'], null, team), [TEAM_BODY],
    'the append arm resolves against teams/<name>/prompts/append the same way');
});

// ── 2. the library is the fallback, not a second-class path ─────────────────

test('t699: a stem the team does not carry falls through to the library', () => {
  const { eng, home, team } = mkHome();
  const libFile = writePrompt(libDir(home), 'system', 'y', LIB_BODY);
  writePrompt(libDir(home), 'append', 'y', LIB_BODY);
  // ENTER: the team must really have no copy — a team file left over from
  // another subject would make this pass while proving the opposite.
  assert.strictEqual(fs.existsSync(path.join(teamDir(home), 'prompts', 'system', 'y.md')), false);

  assert.strictEqual(eng.resolveSystemPromptFile('y', null, team), libFile);
  assert.strictEqual(eng.readSystemPromptBody('y', null, team), LIB_BODY);
  assert.deepStrictEqual(eng.readAppendBodies(['y'], null, team), [LIB_BODY]);
});

// ── 3. a seat on no team is byte-identical to today ─────────────────────────
// GUARD PIN: this passes against the unfixed module by construction — there was
// no team argument before. It is here so a future change that makes `team`
// required, or that reaches for a default team, is caught rather than shipped.

test('t699: GUARD — no team resolves against the library alone, identically to the two-arg call', () => {
  const { eng, home } = mkHome();
  const libFile = writePrompt(libDir(home), 'system', 'z', LIB_BODY);
  writePrompt(libDir(home), 'append', 'z', LIB_BODY);

  for (const noTeam of [null, undefined, {}, { dir: null }, 'not-a-team']) {
    assert.strictEqual(eng.resolveSystemPromptFile('z', null, noTeam), libFile,
      `${JSON.stringify(noTeam)} names no team directory — the library answers`);
  }
  assert.strictEqual(eng.resolveSystemPromptFile('z', null), libFile,
    'and the two-argument call every existing caller makes is unchanged');
  assert.strictEqual(eng.readSystemPromptBody('z', null), LIB_BODY);
  assert.deepStrictEqual(eng.readAppendBodies(['z'], null), [LIB_BODY]);
});

// ── 4. confinement, decided before the filesystem is touched ────────────────

test('t699: a stem that could escape the team directory is refused WITHOUT touching the fs', () => {
  const dbl = countingFs();
  const team = { name: 't', dir: '/teams/t' };

  for (const bad of ['../x', 'a/b', 'a\\b', '..', '.', '', '../../etc/passwd', 'sub/../x']) {
    for (const kind of ['system', 'append']) {
      assert.strictEqual(teamPromptFile({ fs: dbl, path }, team, kind, bad), null,
        `${JSON.stringify(bad)} is refused as a ${kind} stem`);
    }
  }
  for (const badKind of ['', 'System', '../system', null, undefined]) {
    assert.strictEqual(teamPromptFile({ fs: dbl, path }, team, badKind, 'x'), null,
      `${JSON.stringify(badKind)} is not one of the two kinds`);
  }
  assert.deepStrictEqual(dbl.calls, [],
    'the shape test decides alone: a refused stem never becomes a path the fs is asked about');

  // The same double answers the other half: a WELL-SHAPED stem DOES reach the
  // fs, so the emptiness above is a refusal rather than a leaf that never runs.
  // (The leaf swallows the throw and answers null — never throwing is its other
  // contract — so what is asserted is the recorded call, not an exception.)
  assert.strictEqual(teamPromptFile({ fs: dbl, path }, team, 'system', 'ok'), null,
    'an access that fails is a miss, not a throw');
  assert.deepStrictEqual(dbl.calls, [['accessSync', path.join('/teams/t', 'prompts', 'system', 'ok.md')]],
    'ENTER: a good stem reaches accessSync at the confined path — the emptiness above measures refusal, not inertness');
});

// ── 5. a plugin ref never reaches the team directory ────────────────────────

test('t699: a `<plugin>:<stem>` ref takes the plugin branch and never consults the team copy', () => {
  const { eng, home, team } = mkHome();
  // The team owns a file at the bare stem. If the colon branch did not run
  // first, `p:x` would be split nowhere and the team file would answer.
  const teamFile = writePrompt(teamDir(home), 'system', 'x', TEAM_BODY);
  writePrompt(teamDir(home), 'append', 'x', TEAM_BODY);
  assert.ok(fs.existsSync(teamFile), 'ENTER: the team copy of the bare stem is on disk');

  // The plugin branch's REFUSAL is what proves the ordering: no plugin "p" is
  // loaded, so it throws naming "p". A team-directory branch that ran first
  // would have returned the team file and no throw would ever be seen.
  for (const call of [
    () => eng.resolveSystemPromptFile('p:x', null, team),
    () => eng.readSystemPromptBody('p:x', null, team),
    () => eng.readAppendBodies(['p:x'], null, team),
  ]) {
    assert.throws(call, /"p" plugin, which is not loaded/,
      'the colon branch runs first and refuses — it does not degrade to the team copy of the bare stem');
  }

  // And the leaf itself is never handed a colon ref by those resolvers: the
  // counting double proves the branch order rather than inferring it from the
  // null above, which a team file that simply failed to resolve would also give.
  const dbl = countingFs();
  assert.strictEqual(teamPromptFile({ fs: dbl, path }, team, 'system', 'p:x'), null,
    'a colon ref is not a bare stem this leaf serves');
  assert.deepStrictEqual(dbl.calls.map((c) => c[0]), ['accessSync'],
    'and if it ever were handed one it would look for a literal "p:x.md" INSIDE the team dir, never outside it');
});

// ── 6. a read failure after a successful access falls through ───────────────

// The window the engine's readers guard: accessSync says yes, the read then
// fails. Pinned ONLY through the engine, on a real filesystem — an earlier
// version of this section also stubbed the two calls apart and asserted the stub
// threw inside the test's own try/catch, which measured the stub and nothing else.

test('t699: the engine resolvers fall through on an unreadable team copy, and never throw', () => {
  const { eng, home, team } = mkHome();
  const teamDirPath = path.join(teamDir(home), 'prompts', 'system');
  fs.mkdirSync(teamDirPath, { recursive: true });
  // A DIRECTORY where the .md is expected: accessSync(R_OK) succeeds on it and
  // readFileSync throws EISDIR — the real-filesystem form of the split above,
  // reachable through the engine without stubbing anything.
  fs.mkdirSync(path.join(teamDirPath, 'v.md'), { recursive: true });
  writePrompt(libDir(home), 'system', 'v', LIB_BODY);
  writePrompt(libDir(home), 'append', 'v', LIB_BODY);
  fs.mkdirSync(path.join(teamDir(home), 'prompts', 'append'), { recursive: true });
  fs.mkdirSync(path.join(teamDir(home), 'prompts', 'append', 'v.md'), { recursive: true });

  assert.strictEqual(eng.readSystemPromptBody('v', null, team), LIB_BODY,
    'the unreadable team copy falls through to the library body');
  assert.deepStrictEqual(eng.readAppendBodies(['v'], null, team), [LIB_BODY]);
});

// ── 7. the manifest carries its own directory ───────────────────────────────

test('t699: loadManifest and resolveTeam both carry `dir`, the directory holding team.json', () => {
  const { home, repo, resolveTeam } = mkHome();
  const { loadManifest } = createTeamManifest({ fs, clodexHome: home });
  const m = loadManifest('t');
  const file = path.join(home, 'teams', 't', 'team.json');

  assert.deepStrictEqual(m, {
    name: 't',
    root: repo,
    lead: 't-lead',
    roles: m.roles,
    file,
    dir: path.dirname(file),
    watchdogMs: null,
    version: 3,
    droppedFields: [],
  }, 'the WHOLE object, so a field that stops being carried cannot pass unnoticed');
  assert.strictEqual(m.dir, teamDir(home), 'and `dir` is teams/<name>/, where prompts/ lives beside team.json');

  const viaCwd = resolveTeam(repo);
  assert.strictEqual(viaCwd.dir, m.dir, 'resolveTeam returns the same object shape, so `dir` reaches every caller');
});

// ── 8. preflight names the team's own copies ────────────────────────────────

test('t699: preflight notes a team-owned prompt and stays silent on a library one', () => {
  const team = {
    name: 't', root: '/repo', dir: '/teams/t',
    roles: { lead: { prompt: 'own' }, hand: { prompt: 'shared' } },
  };
  const findings = teamPreflight(team, {
    resolvePrompt: (kind, stem) => (kind === 'system' && stem === 'own' ? 'team' : 'library'),
  });

  const notes = findings.filter((f) => f.role === 'lead');
  assert.deepStrictEqual(notes, [{
    level: 'note', kind: 'prompt', role: 'lead', ref: 'own', resolvedFrom: 'team',
    message: 'role "lead": prompt "own" is the team\'s own copy (teams/t/prompts/system), shadowing the library',
  }], 'the whole finding, so the field the popover keys on cannot go missing');

  assert.deepStrictEqual(findings.filter((f) => f.role === 'hand'), [],
    'a library hit stays silent — the shadowing is the fact, not the resolving');

  const missing = teamPreflight(team, { resolvePrompt: () => null });
  assert.deepStrictEqual(missing.map((f) => [f.level, f.resolvedFrom]), [['warn', null], ['warn', null]],
    'and an unresolved prompt is still the warn it was, with no team note attached');
});

test('t699: the ipc probe reports team|library|null, and the team dir wins', () => {
  const { home, team } = mkHome();
  writePrompt(teamDir(home), 'system', 'own', TEAM_BODY);
  writePrompt(libDir(home), 'system', 'own', LIB_BODY);
  writePrompt(libDir(home), 'system', 'shared', LIB_BODY);

  // The probe below is a COPY of the expression ipc-handlers.js installs, so on
  // its own it would pass against a handler that never grew the team branch.
  // This is what ties the copy to the shipped one; without it the subject
  // measures the leaf twice and the wiring not at all.
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'ipc-handlers.js'), 'utf8');
  assert.ok(/resolvePrompt: \(kind, stem\) => \(teamPromptFile\(\{ fs, path \}, team, kind, stem\)\s*\n\s*\? 'team'\s*\n\s*: \(promptLibrary\.raw\(kind, stem\) == null \? null : 'library'\)\),/.test(ipcSrc),
    'the team:preflight handler builds its probe over the team, team-copy branch first');

  const promptLibrary = {
    raw: (kind, stem) => {
      try { return fs.readFileSync(path.join(libDir(home), 'prompts', kind, `${stem}.md`), 'utf-8'); }
      catch { return null; }
    },
  };
  const probe = (kind, stem) => (teamPromptFile({ fs, path }, team, kind, stem)
    ? 'team'
    : (promptLibrary.raw(kind, stem) == null ? null : 'library'));

  assert.strictEqual(probe('system', 'own'), 'team', 'present in both — the team copy is what a spawn would use');
  assert.strictEqual(probe('system', 'shared'), 'library');
  assert.strictEqual(probe('system', 'nowhere'), null);
});

// ── 9. the wiring: a seat in a team boots on the team's copy ────────────────
// Pinned at source level as well as behaviourally. Everything above runs against
// the engine's resolvers directly; the property THIS asserts is that
// session-manager hands them the seat's team at all, which no fixture over the
// resolvers can see.

test('t699: session-manager threads the seat\'s resolved team into every prompt resolution', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');

  assert.ok(/resolveSystemPromptFile\(systemPromptFile, Array\.isArray\(plugins\) \? plugins : null, resolvedTeam\)/.test(src),
    'the claude arm passes the team _teamBlockFor already resolved');
  assert.ok(/readSystemPromptBody\(systemPromptFile, seatPlugins, resolvedTeam\)/.test(src),
    'and so does the codex system arm');
  assert.ok(/readAppendBodies\(appendPromptFiles, seatPlugins, resolvedTeam\)/.test(src),
    'and the codex append arm');
  assert.ok(/readAppendBodies\(recipe\.appendPromptFiles, recipe\.plugins, team\)/.test(src),
    'the REBAKE reads it off the refresh\'s own resolution — a refresh that dropped it '
    + 'would rewrite a live seat\'s prompt file without the team bodies it booted with');
  assert.ok(/_realIpcFor\(session\.promptRecipe, teamBlock, resolvedTeam\)/.test(src),
    'and refreshPrompt threads the team the refresh resolved rather than resolving a second time');
  assert.ok(/readSystemPromptBody\(def\.prompt, null, team\)/.test(src),
    'the team-block builder goes through the resolver too — a hand-rolled library join here '
    + 'is the third place the rule would have to be restated');
  assert.ok(!/path\.join\(REGISTRY_DIR, 'library', 'prompts', 'system'/.test(src),
    'and no hand-rolled library prompt path survives in session-manager.js');
});

test('t699: a seat in a team boots with the TEAM copy of its role prompt', () => {
  const { eng, home, repo, team } = mkHome();
  const { setRole } = createTeamManifest({ fs, clodexHome: home });
  setRole('t', 'hand', { prompt: 'rolep' });
  writePrompt(teamDir(home), 'system', 'rolep', 'TEAM ROLE PROMPT\n');
  writePrompt(libDir(home), 'system', 'rolep', 'LIB ROLE PROMPT\n');

  const m = eng.manager;
  const r = m._teamBlockFor('t-hand', repo, 'claude', null);
  assert.ok(r.resolvedTeam, 'ENTER: the cwd must resolve to a team at all, or nothing below is about a team seat');
  assert.strictEqual(r.resolvedTeam.dir, team.dir);
  assert.ok(r.teamBlock.includes('TEAM ROLE PROMPT'),
    'the composed block carries the team\'s copy');
  assert.ok(!r.teamBlock.includes('LIB ROLE PROMPT'),
    'and not the library one it shadows');
  assert.strictEqual(r.missingPrompt, null);
});

// ── 10. the reviewer preflight ──────────────────────────────────────────────

// The reviewer preflight is DRIVEN, not restated, and it is driven where the
// review fixture lives: test/session-manager.test.js, subjects "a role prompt
// only under the TEAM dir yields NO unbriefed warning" and "a stem in NEITHER
// place warns, naming both". Both run _handleTeamReview, so the branch that
// decides the warning actually executes.
//
// A version of this section used to live here instead, defining its own resolver,
// calling it, and stating the result — a leaf measured twice with the wiring not
// measured at all. `missing = false` in team-tickets.js left every subject in this
// file green. It is deleted rather than repaired: the fixture that can reach the
// preflight is over there, and a second one here could only ever restate it.

test('t699: the reviewer resolver is an OPTIONAL dep, and its absent branch is the old library join', () => {
  // The behavioural half of this is a GUARD: a fixture that builds team-tickets'
  // deps without the new key must keep working exactly as before, and dozens of
  // them do — every review fixture in the suite is that assertion, which is why
  // there is no new one here. What IS pinned is the shape those fixtures rely
  // on: the dep is PROBED rather than assumed, and the absent branch is the
  // library join, byte for byte, that the code computed before this ticket. Make
  // the dep required and this reds here instead of in thirty review fixtures.
  const src = fs.readFileSync(path.join(__dirname, '..', 'team-tickets.js'), 'utf8');
  assert.ok(/typeof resolveSystemPromptFile === 'function'/.test(src),
    'the dep is probed, not assumed');
  assert.ok(/path\.join\(REGISTRY_DIR, 'library', 'prompts', 'system', `\$\{stem\}\.md`\)/.test(src),
    'and the absent-dep branch is the library join the code used before this ticket');
  assert.ok(/resolveSystemPromptFile,\n/.test(src),
    'destructured off deps, where an absent key is undefined rather than a throw');
});
