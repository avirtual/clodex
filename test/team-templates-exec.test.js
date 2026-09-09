'use strict';
// team-templates-exec.test.js — t700: a colon-less TEMPLATE stem and a colon-less
// EXEC command name resolve against the seat's team directory
// (~/.clodex/teams/<name>/{templates,exec}/) first and against the shared library
// second, by the same rule t699 gave prompts.
//
// Every "the team wins" subject below ENTERs on BOTH copies existing and
// DIFFERING. Without that, "the team copy answered" and "the library copy
// answered" are the same observation, and the subject would pass against a
// resolver that never grew a team branch at all — the exact false green
// test/team-prompt-dir.test.js's header describes.
//
// The exec RUN subject is deliberately not argv-shaped: it runs a real /bin/sh
// that touches a marker file named after the def that ran. A def's identity
// asserted from the argv the manager assembled is asserted against the manager's
// own bookkeeping; a marker on disk is asserted against the process that really
// executed, which is the thing an operator's grant actually does.
//
// `assert.ok(RE.test(src))` rather than assert.match on the big sources: a failed
// match formats a 400KB file into the diff and node:test spends minutes rendering
// it as one line of noise.
//
// NO NEW AUTHORITY IS UNDER TEST HERE, and none is created. A def under
// teams/<name>/exec/ is exactly as agent-writable as one under library/exec/ —
// both are files under ~/.clodex — and what a seat may RUN is still its persisted
// execCommands grant, which only the operator sets. The subjects below all grant
// the command first; a def only shapes what an already-granted name does.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const { teamPromptFile, teamJsonFile, readTeamJson } = require('../team-prompt-dir');
const { teamPreflight } = require('../team-preflight');
const { createSessionManager } = require('../session-manager');
const { isFilenameToken, parseAndValidate } = require('../exec-schema');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SRC = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

// A clodex home with a team directory beside a library, hung off the same
// REGISTRY_DIR the app hangs both off. `dir` is what the leaf joins onto, and it
// is what loadManifest/resolveTeam really carry (pinned in team-prompt-dir.test.js).
function mkHome(prefix) {
  const tmp = mkTmpRoot(prefix);
  const home = path.join(tmp, 'clodex-home');
  const repo = path.join(tmp, 'repo');
  const dir = path.join(home, 'teams', 't');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, 'library', 'exec'), { recursive: true });
  const team = { name: 't', root: repo, lead: 't-lead', dir, roles: {} };
  return { tmp, home, repo, dir, team };
}

function writeTeamJson(dir, kind, stem, obj) {
  const d = path.join(dir, kind);
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, `${stem}.json`);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

function writeLibExec(home, name, obj) {
  const file = path.join(home, 'library', 'exec', `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

// An fs double that RECORDS every read of a path under `dir` and otherwise
// delegates to the real one. A counting fs that refused everything could not be
// handed to a real SessionManager, which reads unrelated files on the same call.
function watchingFs(dir) {
  const hits = [];
  const note = (fn, p) => { if (String(p).startsWith(dir)) hits.push([fn, String(p)]); };
  return {
    hits,
    constants: fs.constants,
    accessSync: (p, m) => { note('accessSync', p); return fs.accessSync(p, m); },
    readFileSync: (p, e) => { note('readFileSync', p); return fs.readFileSync(p, e); },
    existsSync: (p) => fs.existsSync(p),
    writeFileSync: (...a) => fs.writeFileSync(...a),
    mkdirSync: (...a) => fs.mkdirSync(...a),
    statSync: (...a) => fs.statSync(...a),
    rmSync: (...a) => fs.rmSync(...a),
    readdirSync: (...a) => fs.readdirSync(...a),
    unlinkSync: (...a) => fs.unlinkSync(...a),
    appendFileSync: (...a) => fs.appendFileSync(...a),
  };
}

after(() => { setImmediate(() => process.exit(0)); });

// ── 1. the leaf ─────────────────────────────────────────────────────────────

// A stem that could name something outside the team's own directory is refused
// on SHAPE, before any join — `team.dir` comes off an agent-writable manifest,
// so the stem (from a role def or a template) is the untrusted half, and a
// post-hoc containment check on a joined path would have to be re-derived
// correctly at every future call site.
test('t700: teamJsonFile refuses an escaping or namespaced stem WITHOUT touching the fs', () => {
  const calls = [];
  const dbl = {
    calls,
    constants: fs.constants,
    accessSync(p) { calls.push(['accessSync', p]); throw new Error(`accessSync must not be reached for ${p}`); },
    readFileSync(p) { calls.push(['readFileSync', p]); throw new Error(`readFileSync must not be reached for ${p}`); },
  };
  const team = { name: 't', dir: '/teams/t' };

  for (const bad of ['a:b', 'plug:stem', '../x', 'a/b', 'a\\b', '..', '.', '', '../../etc/passwd', 'sub/../x']) {
    for (const kind of ['templates', 'exec']) {
      assert.strictEqual(teamJsonFile({ fs: dbl, path }, team, kind, bad), null,
        `${JSON.stringify(bad)} is refused as a ${kind} stem`);
      assert.strictEqual(readTeamJson({ fs: dbl, path }, team, kind, bad), null,
        `${JSON.stringify(bad)} is refused by the reader too`);
    }
  }
  for (const badKind of ['', 'Templates', 'system', 'append', '../exec', null, undefined]) {
    assert.strictEqual(teamJsonFile({ fs: dbl, path }, team, badKind, 'x'), null,
      `${JSON.stringify(badKind)} is not one of the two JSON kinds`);
  }
  for (const noTeam of [null, undefined, {}, { dir: '' }, 'not-a-team']) {
    assert.strictEqual(teamJsonFile({ fs: dbl, path }, team && noTeam, 'templates', 'x'), null,
      `${JSON.stringify(noTeam)} names no team directory`);
  }
  assert.deepStrictEqual(calls, [],
    'the shape test decides alone: a refused stem never becomes a path the fs is asked about');

  // The same double answers the other half: a WELL-SHAPED stem DOES reach the
  // fs, so the emptiness above measures refusal rather than a leaf that never
  // ran. The leaf swallows the throw and answers null — never throwing is its
  // other contract — so what is asserted is the recorded call.
  assert.strictEqual(teamJsonFile({ fs: dbl, path }, team, 'templates', 'ok'), null,
    'an access that fails is a miss, not a throw');
  assert.deepStrictEqual(calls, [['accessSync', path.join('/teams/t', 'templates', 'ok.json')]],
    'ENTER: a good stem reaches accessSync at the confined path');
});

test('t700: teamPromptFile refuses a `:` stem on shape, like every other kind', () => {
  const calls = [];
  const dbl = {
    constants: fs.constants,
    accessSync(p) { calls.push(['accessSync', p]); throw new Error('unreachable'); },
  };
  assert.strictEqual(teamPromptFile({ fs: dbl, path }, { name: 't', dir: '/teams/t' }, 'system', 'p:x'), null,
    'a namespaced ref never names a team file, on any kind');
  assert.deepStrictEqual(calls, [],
    'and it is decided before the join — one contract for prompts, templates and exec defs alike');
});

test('t700: readTeamJson returns the object, and null for every unusable file', () => {
  const { dir, team } = mkHome('clx-t700-leaf-');
  const d = path.join(dir, 'templates');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'good.json'), JSON.stringify({ type: 'claude', extraArgs: ['--model', 'X'] }));
  fs.writeFileSync(path.join(d, 'garbled.json'), '{ "type": "claude"  <<< truncated');
  fs.writeFileSync(path.join(d, 'arr.json'), '[1,2,3]');
  fs.writeFileSync(path.join(d, 'scalar.json'), '42');
  fs.writeFileSync(path.join(d, 'nul.json'), 'null');

  assert.deepStrictEqual(readTeamJson({ fs, path }, team, 'templates', 'good'),
    { type: 'claude', extraArgs: ['--model', 'X'] }, 'the parsed object, as written');
  assert.strictEqual(readTeamJson({ fs, path }, team, 'templates', 'garbled'), null, 'unparseable bytes');
  assert.strictEqual(readTeamJson({ fs, path }, team, 'templates', 'arr'), null, 'an array is not a def object');
  assert.strictEqual(readTeamJson({ fs, path }, team, 'templates', 'scalar'), null, 'nor is a number');
  assert.strictEqual(readTeamJson({ fs, path }, team, 'templates', 'nul'), null, 'nor is JSON null');
  assert.strictEqual(readTeamJson({ fs, path }, team, 'templates', 'absent'), null, 'nor is a missing file');
  assert.strictEqual(readTeamJson({ fs, path }, team, 'exec', 'good'), null,
    'and the kind selects the SUBDIRECTORY — a templates file is not reachable as an exec def');
});

// ── 2. resolveSeatShape reads the team's template ───────────────────────────

function shapeManager({ templatesList = [], resolveTeam = () => null, fsImpl = fs } = {}) {
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    os,
    fs: fsImpl,
    path,
    resolveTeam,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({
      get: (n) => (n === 'lead' ? { name: 'lead', extraArgs: [] } : null),
      setStripLevel() {}, setAutoCompact() {},
    }),
    getTemplates: () => ({ list: () => templatesList }),
    listAllTemplates: () => templatesList,
    withoutPrivilegedIntentsFor: (x) => x,
    ensureDir: () => {},
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    DEFAULT_WORKSPACE_ID: 'default',
  });
  const m = new SessionManager();
  m.sessions = new Map();
  return m;
}

const OPENER = { name: 'lead', cwd: '/repo', workspaceId: 'ws-7', type: 'claude', proxy: null };

test('t700: a role\'s template stem resolves to the TEAM copy when both exist', () => {
  const { dir, repo, team } = mkHome('clx-t700-shape-');
  const teamFile = writeTeamJson(dir, 'templates', 'hand-seat',
    { type: 'claude', extraArgs: ['--model', 'TEAM'], execCommands: ['team-only'] });
  const libTpl = { name: 'hand-seat', type: 'claude', extraArgs: ['--model', 'LIB'], execCommands: ['lib-only'] };

  // ENTER: both copies must exist and DIFFER, or "the team copy won" is the same
  // observation as "the library copy was returned".
  assert.ok(fs.existsSync(teamFile), 'ENTER: the team copy is on disk');
  assert.notDeepStrictEqual(JSON.parse(fs.readFileSync(teamFile, 'utf8')).extraArgs, libTpl.extraArgs);

  const m = shapeManager({ templatesList: [libTpl] });
  const withTeam = { ...team, root: repo, roles: { hand: { template: 'hand-seat' } } };
  const shape = m.resolveSeatShape(withTeam, 'hand', 'ticket', OPENER);

  assert.deepStrictEqual(shape.extraArgs, ['--model', 'TEAM'],
    'the team directory answered — the library row carrying LIB was never consulted');
  assert.deepStrictEqual(shape.execCommands, ['team-only'],
    'and the WHOLE template is the team\'s, not a merge of the two');
  assert.strictEqual(shape.tpl.name, 'hand-seat',
    'the filename is canonical, as templates.list() makes it');
  assert.strictEqual(shape.tpl.id, 'hand-seat');
});

test('t700 GUARD: the same role with no team copy still gets the library template', () => {
  // GUARD PIN: this passes against the unfixed module by construction. It is here
  // so a change that makes the team copy mandatory, or that stops falling
  // through, is caught rather than shipped.
  const { repo, team, dir } = mkHome('clx-t700-shapeguard-');
  assert.strictEqual(fs.existsSync(path.join(dir, 'templates', 'hand-seat.json')), false,
    'ENTER: the team must really carry no copy, or this measures the wrong branch');

  const m = shapeManager({ templatesList: [{ name: 'hand-seat', type: 'claude', extraArgs: ['--model', 'LIB'] }] });
  const shape = m.resolveSeatShape({ ...team, root: repo, roles: { hand: { template: 'hand-seat' } } },
    'hand', 'ticket', OPENER);
  assert.deepStrictEqual(shape.extraArgs, ['--model', 'LIB']);
});

test('t700: a `<plugin>:<stem>` template takes the plugin row and never reads the team dir', () => {
  const { dir, repo, team } = mkHome('clx-t700-shapeplugin-');
  // A file literally named for the colon ref, so a leaf that did not refuse the
  // colon would find something to return rather than merely missing.
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  const colonFile = path.join(dir, 'templates', 'rev:audit.json');
  let colonOnDisk = true;
  try { fs.writeFileSync(colonFile, JSON.stringify({ type: 'claude', extraArgs: ['--model', 'TEAM'] })); }
  catch { colonOnDisk = false; }

  const watcher = watchingFs(dir);
  const m = shapeManager({
    templatesList: [{ name: 'rev:audit', plugin: 'rev', type: 'claude', extraArgs: ['--model', 'PLUGIN'] }],
    fsImpl: watcher,
  });
  const shape = m.resolveSeatShape({ ...team, root: repo, roles: { rev: { template: 'rev:audit' } } },
    'rev', 'ticket', OPENER);

  assert.deepStrictEqual(shape.extraArgs, ['--model', 'PLUGIN'],
    'the plugin row answered');
  assert.deepStrictEqual(watcher.hits, [],
    'and the team directory was never touched for a namespaced ref');
  if (colonOnDisk) {
    assert.ok(fs.existsSync(colonFile),
      'ENTER: a file at the literal colon name was on disk the whole time — the emptiness above is a refusal, not an absence');
  }
});

// ── 3. the spawn intent from inside the team ────────────────────────────────

function spawnHarness({ listAllTemplates = () => [], resolveTeam = () => null } = {}) {
  const calls = [];
  const replies = [];
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    os,
    fs,
    path,
    resolveTeam,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ get: () => null, setStripLevel() {}, setAutoCompact() {} }),
    getTemplates: () => ({ list: () => [] }),
    listAllTemplates,
    withoutPrivilegedIntentsFor: (x) => x,
    ensureDir: () => {},
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    DEFAULT_WORKSPACE_ID: 'default',
  });
  const m = new SessionManager();
  m.sessions = new Map();
  m._injectText = (_s, t) => replies.push(t);
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m.create = async (...args) => { calls.push(args); return undefined; };
  return { m, calls, replies };
}

const EXTRA_ARGS_ARG = 3; // 0-based index of extraArgs in create()'s signature

test('t700: [agent:spawn template:<stem>] from a seat INSIDE the team takes the team copy', async () => {
  const { dir, repo, team } = mkHome('clx-t700-spawn-');
  const teamFile = writeTeamJson(dir, 'templates', 'worker',
    { type: 'claude', cwd: repo, extraArgs: ['--model', 'TEAM'] });
  const libTpl = { name: 'worker', type: 'claude', cwd: repo, extraArgs: ['--model', 'LIB'] };
  assert.ok(fs.existsSync(teamFile), 'ENTER: the team copy is on disk');
  assert.notDeepStrictEqual(JSON.parse(fs.readFileSync(teamFile, 'utf8')).extraArgs, libTpl.extraArgs,
    'ENTER: and it differs from the library row, or the assertion below proves nothing');

  const { m, calls, replies } = spawnHarness({
    listAllTemplates: () => [libTpl],
    resolveTeam: (cwd) => (cwd === repo ? team : null),
  });
  m._handleSpawnIntent(
    { name: 't-lead', cwd: repo, workspaceId: 'default', type: 'claude' },
    { name: 'child', template: 'worker' },
  );
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(calls.length, 1, `create was called (replies: ${JSON.stringify(replies)})`);
  assert.deepStrictEqual(calls[0][EXTRA_ARGS_ARG], ['--model', 'TEAM'],
    'the spawning seat\'s own team answered the bare stem');
});

test('t700 GUARD: the same spawn from a seat in NO team takes the library copy', async () => {
  const { repo } = mkHome('clx-t700-spawnguard-');
  const { m, calls, replies } = spawnHarness({
    listAllTemplates: () => [{ name: 'worker', type: 'claude', cwd: repo, extraArgs: ['--model', 'LIB'] }],
    resolveTeam: () => null,
  });
  m._handleSpawnIntent(
    { name: 'loner', cwd: repo, workspaceId: 'default', type: 'claude' },
    { name: 'child', template: 'worker' },
  );
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(calls.length, 1, `create was called (replies: ${JSON.stringify(replies)})`);
  assert.deepStrictEqual(calls[0][EXTRA_ARGS_ARG], ['--model', 'LIB'],
    'a seat outside any team behaves exactly as it did before this ticket');
});

// ── 4. the exec DESCRIPTION a seat reads in its prompt ──────────────────────

function execManager({ home, resolveTeam = () => null }) {
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: home,
    isFilenameToken,
    parseAndValidate,
    resolveTeam,
    os,
    fs,
    path,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ list: () => [], get: () => ({ execCommands: ['digest'] }) }),
    childProcess,
  });
  const m = new SessionManager();
  const replies = [];
  m._injectText = (_s, t) => replies.push(t);
  m._broadcast = () => {};
  return { m, replies };
}

test('t700: the exec def a seat reads in its prompt is the team\'s when the team has one', () => {
  const { home, dir, team } = mkHome('clx-t700-defs-');
  writeTeamJson(dir, 'exec', 'digest', {
    argv: ['/bin/sh', '-c', 'true'], description: 'TEAM digest', schema: { type: 'object' },
  });
  writeLibExec(home, 'digest', {
    argv: ['/bin/sh', '-c', 'true'], description: 'LIB digest', schema: { type: 'object' },
  });
  assert.ok(fs.existsSync(path.join(dir, 'exec', 'digest.json')), 'ENTER: the team def is on disk');
  assert.ok(fs.existsSync(path.join(home, 'library', 'exec', 'digest.json')), 'ENTER: and so is the library one');

  const { m } = execManager({ home });
  assert.deepStrictEqual(m._resolveExecDefs(['digest'], team), [{
    name: 'digest', description: 'TEAM digest', schema: { type: 'object' },
  }], 'the whole resolved def, so a field the prompt builder reads cannot go missing');

  assert.deepStrictEqual(m._resolveExecDefs(['digest'], null), [{
    name: 'digest', description: 'LIB digest', schema: { type: 'object' },
  }], 'GUARD: a seat on no team still reads the library def, unchanged');
});

test('t700: session-manager threads the seat\'s team into both def resolutions', () => {
  // Every assertion above hands `team` in by hand, so all of them would pass
  // against a session-manager whose CALL SITES still resolved library-only. This
  // is the property no fixture over the method can see.
  const src = SRC('session-manager.js');
  assert.ok(/this\._resolveExecDefs\(execCommands, resolvedTeam\)/.test(src),
    'the codex arm passes the team _teamBlockFor already resolved');
  assert.ok(/this\._resolveExecDefs\(recipe\.execCommands, team\)/.test(src),
    'and the rebake passes the team the refresh resolved — a rebake that dropped it '
    + 'would rewrite a live seat\'s prompt with the library\'s descriptions');
  assert.ok(/let team;\s*\n\s*try \{ team = resolveTeam\(session\.cwd\); \} catch \{ team = null; \}\s*\n\s*let entry = readTeamJson\(\{ fs, path \}, team, 'exec', cmd\);/.test(src),
    'the runner resolves the team ONCE, above the def read, and the team def is what it reads first');
  assert.ok(/const teamRoot = \(team && team\.root\) \|\| '';/.test(src),
    'and ${TEAM_ROOT} is derived from that same resolution rather than a second one');
});

test('t700: team-tickets threads the seat\'s team into both template resolutions', () => {
  const src = SRC('team-tickets.js');
  assert.ok(/_templateShape\(tplName, team\) \{/.test(src),
    'the resolver takes the team');
  assert.ok(/const own = readTeamJson\(\{ fs, path \}, team, 'templates', tplName\);/.test(src),
    'and reads the team copy before the list');
  assert.ok(/: \(def && def\.template\),\s*\n\s*team,\s*\n\s*\);/.test(src),
    'resolveSeatShape hands it the team it already holds');
  assert.ok(/try \{ spawnerTeam = resolveTeam\(spawner\.cwd\); \} catch \{ spawnerTeam = null; \}/.test(src),
    'the spawn intent resolves the spawner\'s team once');
  assert.ok(/const own = readTeamJson\(\{ fs, path \}, spawnerTeam, 'templates', v\);/.test(src),
    'and tries it before the by-name list match');
  assert.ok(/const spawnerRoot = \(spawnerTeam && spawnerTeam\.root\) \|\| '';/.test(src),
    'the ${TEAM_ROOT} expansion reuses that one resolution rather than resolving a second time');
});

// ── 5. the exec RUN — which def really executed ─────────────────────────────

// Polls rather than sleeps a fixed span: the runner spawns on setImmediate and
// the child is a real process, so a fixed wait is either flaky or slow.
async function waitFor(pred, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const MARKER_DEF = (marker) => ({
  argv: ['/bin/sh', '-c', `printf x > ${marker}`],
  timeoutMs: 5000,
  schema: { type: 'object', additionalProperties: false },
});

test('t700: an [agent:exec] from a seat inside the team RUNS the team\'s def', async () => {
  const { home, dir, repo, team, tmp } = mkHome('clx-t700-run-');
  const teamMarker = path.join(tmp, 'team.marker');
  const libMarker = path.join(tmp, 'lib.marker');
  writeTeamJson(dir, 'exec', 'digest', MARKER_DEF(teamMarker));
  writeLibExec(home, 'digest', MARKER_DEF(libMarker));
  // ENTER: both defs must be installed and must name DIFFERENT markers, or the
  // marker on disk cannot tell the two apart.
  assert.ok(fs.existsSync(path.join(dir, 'exec', 'digest.json')), 'ENTER: team def installed');
  assert.ok(fs.existsSync(path.join(home, 'library', 'exec', 'digest.json')), 'ENTER: library def installed');
  assert.notStrictEqual(teamMarker, libMarker);

  const { m, replies } = execManager({ home, resolveTeam: (cwd) => (cwd === repo ? team : null) });
  m._handleExecIntent({ name: 'a', agentType: 'claude', cwd: repo }, 'digest', '{}');

  assert.ok(await waitFor(() => fs.existsSync(teamMarker)),
    `the team's def is the process that ran (replies: ${JSON.stringify(replies)})`);
  assert.strictEqual(fs.existsSync(libMarker), false,
    'and the library def never ran — the team copy shadows it, it does not run beside it');
});

test('t700 GUARD: the same command from a seat in NO team runs the library def', async () => {
  const { home, dir, repo, tmp } = mkHome('clx-t700-runguard-');
  const teamMarker = path.join(tmp, 'team.marker');
  const libMarker = path.join(tmp, 'lib.marker');
  writeTeamJson(dir, 'exec', 'digest', MARKER_DEF(teamMarker));
  writeLibExec(home, 'digest', MARKER_DEF(libMarker));

  const { m, replies } = execManager({ home, resolveTeam: () => null });
  m._handleExecIntent({ name: 'a', agentType: 'claude', cwd: repo }, 'digest', '{}');

  assert.ok(await waitFor(() => fs.existsSync(libMarker)),
    `a seat outside any team behaves exactly as it did before (replies: ${JSON.stringify(replies)})`);
  assert.strictEqual(fs.existsSync(teamMarker), false,
    'and a team directory it does not belong to is never consulted');
});

test('t700: a team def with no argv hits the existing malformed arm, with today\'s text', async () => {
  const { home, dir, repo, team } = mkHome('clx-t700-runbad-');
  writeTeamJson(dir, 'exec', 'digest', { description: 'no argv here', timeoutMs: 1000 });
  const { m, replies } = execManager({ home, resolveTeam: () => team });
  m._handleExecIntent({ name: 'a', agentType: 'claude', cwd: repo }, 'digest', '{}');
  await new Promise((r) => setImmediate(r));

  assert.deepStrictEqual(replies, ['[agent:exec] digest: malformed registry entry (needs a non-empty argv)'],
    'the runner\'s refusals are untouched — a team def is checked exactly as a library one is');
});

test('t700: absent from BOTH places is still "no such registered command"', async () => {
  const { home, repo, team } = mkHome('clx-t700-runnone-');
  const { m, replies } = execManager({ home, resolveTeam: () => team });
  m._handleExecIntent({ name: 'a', agentType: 'claude', cwd: repo }, 'digest', '{}');
  await new Promise((r) => setImmediate(r));

  assert.deepStrictEqual(replies, ['[agent:exec] digest: no such registered command'],
    'the error text an operator has learned to read is unchanged');
});

test('t700: the grant, not the def\'s location, is still the capability', async () => {
  // The security property the whole ticket rests on: a def under the team
  // directory is exactly as agent-writable as one under library/exec, so if
  // WRITING one were enough to run it, an agent could grant itself commands. The
  // persisted execCommands allowlist is checked BEFORE any def is read.
  const { home, dir, repo, team, tmp } = mkHome('clx-t700-grant-');
  const marker = path.join(tmp, 'team.marker');
  writeTeamJson(dir, 'exec', 'ungranted', MARKER_DEF(marker));
  assert.ok(fs.existsSync(path.join(dir, 'exec', 'ungranted.json')),
    'ENTER: the def really is installed under the team directory');

  const { m, replies } = execManager({ home, resolveTeam: () => team });
  m._handleExecIntent({ name: 'a', agentType: 'claude', cwd: repo }, 'ungranted', '{}');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.deepStrictEqual(replies, ['[agent:exec] ungranted: not granted to this seat']);
  assert.strictEqual(fs.existsSync(marker), false, 'and nothing ran');
});

// ── 6. preflight names the team's own copies ────────────────────────────────

const PF_TEAM = {
  name: 'shop', root: '/repo/shop', dir: '/teams/shop',
  roles: { hand: { prompt: 'p', template: 'hand-seat' } },
};

function pfProbes({ teamTemplates = {}, templates = [], execs = {}, files = [] } = {}) {
  return {
    exists: (abs) => files.includes(abs),
    listTemplates: () => templates,
    readExecDef: (id) => (id in execs ? execs[id] : null),
    readTeamTemplate: (stem) => (stem in teamTemplates ? teamTemplates[stem] : null),
    resolvePrompt: () => 'library',
  };
}

test('t700: preflight notes a team-owned template AND checks THAT template\'s contents', () => {
  const findings = teamPreflight(PF_TEAM, pfProbes({
    // The two copies grant DIFFERENT commands. Only the team copy's grant can
    // produce the exec finding below, so that finding is the evidence the
    // exec/append scan ran over the team's contents rather than the library's.
    teamTemplates: { 'hand-seat': { execCommands: ['team-only'] } },
    templates: [{ name: 'hand-seat', execCommands: ['lib-only'] }],
    execs: {}, // neither def is installed, so a grant that was scanned shows up
  }));

  assert.deepStrictEqual(findings, [
    {
      level: 'note', kind: 'template', role: 'hand', ref: 'hand-seat', resolvedFrom: 'team',
      message: 'role "hand": template "hand-seat" is the team\'s own copy (teams/shop/templates), shadowing the library',
    },
    {
      level: 'warn', kind: 'exec', role: 'hand', ref: 'team-only', resolvedFrom: null,
      message: 'role "hand": template "hand-seat" grants exec command "team-only", which has no def installed under teams/shop/exec or library/exec',
    },
  ], 'the whole findings array — the note, and the exec check driven by the TEAM template\'s grants');

  assert.strictEqual(findings.some((f) => /lib-only/.test(f.message)), false,
    'the shadowed library template\'s grants were never scanned');
});

test('t700: preflight notes a team-owned exec def and still runs its path checks', () => {
  const findings = teamPreflight(PF_TEAM, pfProbes({
    templates: [{ name: 'hand-seat', execCommands: ['digest'] }],
    execs: { digest: { name: 'digest', argv: ['bash', '${TEAM_ROOT}/scripts/t.sh'], cwd: '', resolvedFrom: 'team' } },
    files: [], // the script is not there, so the path check must still speak
  }));

  assert.deepStrictEqual(findings, [
    {
      level: 'note', kind: 'exec', role: 'hand', ref: 'digest', resolvedFrom: 'team',
      message: 'role "hand": exec command "digest" runs the team\'s own def (teams/shop/exec)',
    },
    {
      level: 'warn', kind: 'exec', role: 'hand', ref: 'digest', resolvedFrom: 'team',
      message: 'role "hand": exec command "digest" needs /repo/shop/scripts/t.sh, which does not exist under this team\'s root',
    },
  ], 'the note does not replace the checks — a team def is checked exactly as a library one is');
});

test('t700: a team def with an empty argv warns with resolvedFrom team, not library', () => {
  const findings = teamPreflight(PF_TEAM, pfProbes({
    templates: [{ name: 'hand-seat', execCommands: ['digest'] }],
    execs: { digest: { name: 'digest', argv: [], cwd: '', resolvedFrom: 'team' } },
  }));
  assert.deepStrictEqual(findings, [
    {
      level: 'note', kind: 'exec', role: 'hand', ref: 'digest', resolvedFrom: 'team',
      message: 'role "hand": exec command "digest" runs the team\'s own def (teams/shop/exec)',
    },
    {
      level: 'warn', kind: 'exec', role: 'hand', ref: 'digest', resolvedFrom: 'team',
      message: 'role "hand": exec command "digest" has a def under teams/shop/exec or library/exec but no argv to run — the runner refuses it as malformed, so every call bounces',
    },
  ], 'a broken TEAM def must not be reported as a broken LIBRARY one — the operator edits a different file');
});

test('t700: a template in NEITHER place says so in both places\' terms', () => {
  const findings = teamPreflight(PF_TEAM, pfProbes({ templates: [] }));
  assert.deepStrictEqual(findings, [{
    level: 'warn', kind: 'template', role: 'hand', ref: 'hand-seat', resolvedFrom: null,
    message: 'role "hand": template "hand-seat" is in neither teams/shop/templates nor the template library — a seat spawned for this role gets none of its shape',
  }]);
});

test('t700 GUARD: with the probe absent, preflight is byte-identical to t699', () => {
  // GUARD PIN: passes against the unfixed leaf by construction — there was no
  // readTeamTemplate before. It is here so a change that makes the probe
  // required, or that stops defaulting it, is caught rather than shipped: every
  // pure fixture in test/team-preflight.test.js binds four probes and no more.
  const findings = teamPreflight(PF_TEAM, {
    exists: () => false,
    listTemplates: () => [{ name: 'hand-seat', execCommands: ['digest'] }],
    readExecDef: () => ({ name: 'digest', argv: ['bash'] }),
    resolvePrompt: () => 'library',
  });
  assert.deepStrictEqual(findings, [],
    'no probe, no team findings — a library-resolving team stays silent');
});

// ── 7. the ipc probes, driven through the REGISTERED handler ────────────────

// Everything in group 6 hands the leaf a probe result by hand, so all of it
// would pass against an ipc-handlers.js that never grew a team branch. This
// drives the real handler over a real team directory, which is the only place
// the two halves are joined.
function registerWith(overrides = {}) {
  const handlers = {};
  const stub = () => () => {};
  const deps = new Proxy({
    handle: (ch, fn) => { handlers[ch] = fn; },
    on: (ch, fn) => { handlers[ch] = fn; },
    ...(overrides.templates && !overrides.listAllTemplates
      ? { listAllTemplates: () => overrides.templates.list() } : {}),
    ...overrides,
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return stub();
    },
  });
  const { registerIpcHandlers } = require('../ipc-handlers');
  registerIpcHandlers(deps);
  return handlers;
}

test('t700: team:preflight reads the team\'s own template and exec def, end to end', () => {
  const { home, dir, repo } = mkHome('clx-t700-ipc-');
  const manifest = { name: 't', root: repo, dir, roles: { hand: { prompt: 'p', template: 'hand-seat' } } };
  writeTeamJson(dir, 'templates', 'hand-seat', { execCommands: ['digest'] });
  writeTeamJson(dir, 'exec', 'digest', { argv: ['bash', '${TEAM_ROOT}/scripts/t.sh'] });
  writeLibExec(home, 'digest', { argv: ['bash', '/absolute/elsewhere.sh'] });

  const handlers = registerWith({
    fs,
    path,
    loadManifest: () => manifest,
    // The library carries a template of the same stem granting a DIFFERENT
    // command, so a handler that listed instead of reading the team copy would
    // produce a visibly different findings array rather than the same one.
    templates: { list: () => [{ name: 'hand-seat', execCommands: ['lib-only'] }] },
    execLibrary: { list: () => [{ name: 'digest', argv: ['bash', '/absolute/elsewhere.sh'] }], raw: () => null },
    promptLibrary: { raw: () => 'body' },
  });

  const res = handlers['team:preflight']({}, 't');
  assert.strictEqual(res.ok, true, `handler succeeded (${res.error})`);
  assert.deepStrictEqual(res.findings, [
    {
      level: 'note', kind: 'template', role: 'hand', ref: 'hand-seat', resolvedFrom: 'team',
      message: 'role "hand": template "hand-seat" is the team\'s own copy (teams/t/templates), shadowing the library',
    },
    {
      level: 'note', kind: 'exec', role: 'hand', ref: 'digest', resolvedFrom: 'team',
      message: 'role "hand": exec command "digest" runs the team\'s own def (teams/t/exec)',
    },
    {
      level: 'warn', kind: 'exec', role: 'hand', ref: 'digest', resolvedFrom: 'team',
      message: `role "hand": exec command "digest" needs ${repo}/scripts/t.sh, which does not exist under this team's root`,
    },
  ], 'the whole array: both probes were bound to the team directory, and the TEAM def\'s argv is what was path-checked');

  assert.strictEqual(res.findings.some((f) => /lib-only|elsewhere/.test(f.message)), false,
    'neither shadowed library copy was consulted');
});

test('t700 GUARD: team:preflight over a team with no own copies is unchanged', () => {
  const { home, dir, repo } = mkHome('clx-t700-ipcguard-');
  assert.strictEqual(fs.existsSync(path.join(dir, 'templates')), false,
    'ENTER: the team directory must really carry no templates/');
  assert.strictEqual(fs.existsSync(path.join(dir, 'exec', 'digest.json')), false,
    'ENTER: nor an exec def');

  const handlers = registerWith({
    fs,
    path,
    loadManifest: () => ({ name: 't', root: repo, dir, roles: { hand: { prompt: 'p', template: 'hand-seat' } } }),
    templates: { list: () => [{ name: 'hand-seat', execCommands: ['digest'] }] },
    execLibrary: { list: () => [{ name: 'digest', argv: ['bash', '${TEAM_ROOT}/x.sh'] }], raw: () => null },
    promptLibrary: { raw: () => 'body' },
    // The library def's path DOES exist, so a clean run is the whole answer.
  });
  const withExisting = registerWith({
    fs: { ...fs, existsSync: (p) => p === path.join(repo, 'x.sh') || fs.existsSync(p) },
    path,
    loadManifest: () => ({ name: 't', root: repo, dir, roles: { hand: { prompt: 'p', template: 'hand-seat' } } }),
    templates: { list: () => [{ name: 'hand-seat', execCommands: ['digest'] }] },
    execLibrary: { list: () => [{ name: 'digest', argv: ['bash', '${TEAM_ROOT}/x.sh'] }], raw: () => null },
    promptLibrary: { raw: () => 'body' },
  });

  assert.deepStrictEqual(withExisting['team:preflight']({}, 't'), { ok: true, findings: [] },
    'a team owning nothing produces the same empty findings it did before this ticket');
  assert.deepStrictEqual(handlers['team:preflight']({}, 't').findings.map((f) => [f.level, f.resolvedFrom]),
    [['warn', 'library']],
    'and its library def\'s missing path is still attributed to the LIBRARY');
});
