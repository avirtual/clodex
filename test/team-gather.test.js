'use strict';
// team-gather.test.js — t701. Gather copies every LIBRARY piece a team's manifest
// references into the team's own directory, under the same stems, so the
// team-first rule t699/t700 established picks them up on the next spawn with
// nothing rewritten.
//
// The leaf is split from its probes so the walk is assertable with no library on
// disk (groups 1, 2 and 7 inject them), and the probes are exercised for real by
// building an actual engine over a temp ~/.clodex (groups 3 and 4). Both halves
// are needed and neither substitutes for the other: an injected-only file would
// pass against probes bound to the wrong store, and an end-to-end-only file
// could not reach the failed-write arm at all.
//
// Every positive subject ENTERs on the two facts that make it discriminating —
// the library piece EXISTS and the team copy does NOT — because without them
// "the copy was made" and "the file was already there" are the same observation,
// and a gather that did nothing would pass.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { planGather, applyGather, formatGatherReport } = require('../team-gather');
const { badStem, readTeamJson } = require('../team-prompt-dir');
const { parseIntent } = require('../intent-scanner');
const { createSessionManager } = require('../session-manager');
const { registerIpcHandlers } = require('../ipc-handlers');
const { createEngine } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

const silent = { info() {}, warn() {}, error() {} };

// ── group 1: the plan, over injected probes ─────────────────────────────────

// The manifest of the walk's interesting shape: a role whose TEMPLATE names three
// more refs (one of them the same prompt stem the role already named — the dedupe
// case), one plugin ref, one ref the library does not have, plus a second role
// with a prompt and no template at all.
const TWO_ROLE_TEAM = {
  name: 't', dir: '/teams/t',
  roles: {
    hand: { prompt: 'h', template: 'hs' },
    reviewer: { prompt: 'r' },
  },
};

const HS_TEMPLATE = {
  systemPromptFile: 'h',
  appendPromptFiles: ['proj', 'p:knowledge'],
  execCommands: ['run', 'missing-def'],
};

// Records every probe call so a subject can assert what the walk did NOT touch,
// which is the only way to see confinement from outside the leaf.
function mkSources({ has = () => false, library = {}, templates = {} } = {}) {
  const calls = [];
  return {
    calls,
    libraryPath: (kind, stem) => { calls.push(['libraryPath', kind, stem]); return `/lib/${kind}/${stem}`; },
    readLibrary: (kind, stem) => {
      calls.push(['readLibrary', kind, stem]);
      const v = library[`${kind}/${stem}`];
      return v === undefined ? null : v;
    },
    teamHas: (kind, stem) => { calls.push(['teamHas', kind, stem]); return !!has(kind, stem); },
    readTemplateForWalk: (stem) => { calls.push(['readTemplateForWalk', stem]); return templates[stem] || null; },
  };
}

const LIB = {
  'system/h': 'HAND PROMPT',
  'system/r': 'REVIEWER PROMPT',
  'templates/hs': '{"systemPromptFile":"h"}',
  'append/proj': 'PROJECT KNOWLEDGE',
  'exec/run': '{"argv":["true"]}',
};

test('t701 plan: the whole items array — discovery order, dedupe, skip, missing', () => {
  const sources = mkSources({ library: LIB, templates: { hs: HS_TEMPLATE } });
  const { items } = planGather(TWO_ROLE_TEAM, sources);

  assert.deepStrictEqual(items, [
    { kind: 'system', stem: 'h', role: 'hand', via: 'role.prompt', action: 'copy', from: '/lib/system/h', to: '/teams/t/prompts/system/h.md', bytes: 'HAND PROMPT' },
    { kind: 'templates', stem: 'hs', role: 'hand', via: 'role.template', action: 'copy', from: '/lib/templates/hs', to: '/teams/t/templates/hs.json', bytes: '{"systemPromptFile":"h"}' },
    { kind: 'append', stem: 'proj', role: 'hand', via: 'template.appendPromptFiles', action: 'copy', from: '/lib/append/proj', to: '/teams/t/prompts/append/proj.md', bytes: 'PROJECT KNOWLEDGE' },
    { kind: 'append', stem: 'p:knowledge', role: 'hand', via: 'template.appendPromptFiles', action: 'skipped', reason: 'plugin ref', from: null, to: null },
    { kind: 'exec', stem: 'run', role: 'hand', via: 'template.execCommands', action: 'copy', from: '/lib/exec/run', to: '/teams/t/exec/run.json', bytes: '{"argv":["true"]}' },
    { kind: 'exec', stem: 'missing-def', role: 'hand', via: 'template.execCommands', action: 'missing', from: '/lib/exec/missing-def', to: '/teams/t/exec/missing-def.json' },
    { kind: 'system', stem: 'r', role: 'reviewer', via: 'role.prompt', action: 'copy', from: '/lib/system/r', to: '/teams/t/prompts/system/r.md', bytes: 'REVIEWER PROMPT' },
  ], 'the whole plan: order is discovery order, `h` appears ONCE (as role.prompt of hand, not again as the template\'s systemPromptFile), the colon ref is skipped and the absent exec def is missing');
});

test('t701 plan: a stem the team already owns is KEPT — the library bytes are never read for it', () => {
  const sources = mkSources({
    library: LIB,
    templates: { hs: HS_TEMPLATE },
    has: (kind, stem) => kind === 'system' && stem === 'h',
  });
  const { items } = planGather(TWO_ROLE_TEAM, sources);

  const h = items.find((i) => i.kind === 'system' && i.stem === 'h');
  // ENTER: the row under test survived the find — every assertion below is about
  // it, and a plan that dropped `h` entirely would satisfy them vacuously.
  assert.ok(h, 'ENTER: the plan still has a row for the stem the team owns');
  assert.strictEqual(h.action, 'kept', 'the team already has it');
  assert.ok(!('bytes' in h), 'and a kept item carries no bytes — there is nothing to write');
  assert.deepStrictEqual(sources.calls.filter((c) => c[0] === 'readLibrary' && c[2] === 'h'), [],
    'the library was never read for a stem the team already owns');
  // The OTHER rows must be unaffected: a teamHas that short-circuited the walk
  // would leave a plan whose every remaining assertion is about an empty set.
  assert.strictEqual(items.find((i) => i.stem === 'r').action, 'copy',
    'ENTER: the walk continued past the kept row');
});

test('t701 plan: an empty/absent manifest walks to an empty plan rather than throwing (guard)', () => {
  assert.deepStrictEqual(planGather({ name: 't', dir: '/teams/t', roles: {} }, mkSources()).items, []);
  assert.deepStrictEqual(planGather({ name: 't', dir: '/teams/t' }, mkSources()).items, []);
});

// ── group 2: apply ──────────────────────────────────────────────────────────

test('t701 apply: exactly the copy items are written, and one failed write does not hide the rest', () => {
  const plan = planGather(TWO_ROLE_TEAM, mkSources({ library: LIB, templates: { hs: HS_TEMPLATE } }));
  const wrote = [];
  // ENTER: there is more than one copy item, or "the others still copied" is
  // unobservable and the partition below is trivially satisfied.
  assert.strictEqual(plan.items.filter((i) => i.action === 'copy').length, 5,
    'ENTER: five pieces to copy, so a single failure leaves four survivors');

  const result = applyGather(plan, {
    write: (to, bytes) => {
      if (to.endsWith('/exec/run.json')) throw new Error('EACCES: denied');
      wrote.push([to, bytes]);
    },
  });

  assert.deepStrictEqual(wrote, [
    ['/teams/t/prompts/system/h.md', 'HAND PROMPT'],
    ['/teams/t/templates/hs.json', '{"systemPromptFile":"h"}'],
    ['/teams/t/prompts/append/proj.md', 'PROJECT KNOWLEDGE'],
    ['/teams/t/prompts/system/r.md', 'REVIEWER PROMPT'],
  ], 'io.write received exactly the copy items\' (to, bytes) — nothing for kept/skipped/missing, and nothing invented');

  assert.deepStrictEqual(result.copied.map((i) => `${i.kind}/${i.stem}`),
    ['system/h', 'templates/hs', 'append/proj', 'system/r'], 'the four that wrote are copied');
  assert.deepStrictEqual(result.failed.map((i) => [`${i.kind}/${i.stem}`, i.error]),
    [['exec/run', 'EACCES: denied']], 'the thrower is failed and carries the message');
  assert.deepStrictEqual(result.skipped.map((i) => i.stem), ['p:knowledge']);
  assert.deepStrictEqual(result.missing.map((i) => i.stem), ['missing-def']);
  assert.deepStrictEqual(result.kept, []);

  const partition = [...result.copied, ...result.kept, ...result.skipped, ...result.missing, ...result.failed];
  assert.strictEqual(partition.length, plan.items.length, 'the five lists partition the plan — every item is in exactly one');
  assert.deepStrictEqual(new Set(partition), new Set(plan.items), 'and they are the SAME item objects, not copies');
});

test('t701 report: the applied head line counts outcomes, the dry one counts intent', () => {
  const plan = planGather(TWO_ROLE_TEAM, mkSources({ library: LIB, templates: { hs: HS_TEMPLATE } }));
  const dry = formatGatherReport({ team: 't', items: plan.items }, { dry: true });
  assert.strictEqual(dry.split('\n')[0], 'gather plan for t: 5 to copy, 0 kept, 1 skipped, 1 missing');
  assert.ok(dry.includes('  skipped append/p:knowledge (template.appendPromptFiles of hand): plugin ref'),
    'a skipped line names its reason, its via and its role');

  const result = applyGather(plan, { write: (to) => { if (to.endsWith('run.json')) throw new Error('nope'); } });
  const applied = formatGatherReport({ team: 't', items: plan.items, ...result }, { dry: false });
  assert.strictEqual(applied.split('\n')[0], 'gathered t: 4 copied, 0 kept, 1 skipped, 1 missing, 1 failed',
    'the failed term appears only when something failed');
  assert.ok(applied.includes('  failed exec/run (template.execCommands of hand): nope'));

  const clean = formatGatherReport({ team: 't', items: [], copied: [], kept: [], skipped: [], missing: [], failed: [] }, {});
  assert.strictEqual(clean, 'gathered t: 0 copied, 0 kept, 0 skipped, 0 missing', 'no failed term when nothing failed');
});

// ── groups 3 & 4: the real thing, over a real temp ~/.clodex ────────────────

// A real clodex home with a library and a team.json, plus a real engine bound to
// it. Everything below goes through the engine's own gatherTeam, so the probes
// under test are the ones the app binds — not a second set assembled here.
function mkRealHome(prefix, { roles, library = {} }) {
  const tmp = mkTmpRoot(prefix);
  const home = path.join(tmp, 'clodex-home');
  const repo = path.join(tmp, 'repo');
  const userData = path.join(tmp, 'userdata');
  const dir = path.join(home, 'teams', 't');
  for (const d of [repo, userData, dir]) fs.mkdirSync(d, { recursive: true });
  for (const [rel, body] of Object.entries(library)) {
    const p = path.join(home, 'library', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  const teamFile = path.join(dir, 'team.json');
  fs.writeFileSync(teamFile, JSON.stringify({ root: repo, lead: 't-lead', roles }, null, 2));
  const eng = createEngine({ userDataPath: userData, seams: { registryDir: home }, log: silent });
  return { tmp, home, repo, dir, teamFile, eng };
}

const REAL_LIBRARY = {
  'prompts/system/h.md': '# hand prompt\n',
  'prompts/append/proj.md': '# project knowledge\n',
  'templates/hs.json': '{\n  "name": "hs",\n  "type": "claude",\n  "appendPromptFiles": ["proj"],\n  "execCommands": ["run"]\n}',
  'exec/run.json': '{"argv":["/bin/true"],"cwd":"${TEAM_ROOT}"}',
};

// The lead carries no prompt on purpose: the engine SEEDS the stock library into
// this temp home at construction, so a lead pointing at `clodex-team-lead` would
// add a fifth copied piece that says nothing about the walk under test.
const REAL_ROLES = { lead: { brief: 'the lead' }, hand: { prompt: 'h', template: 'hs' } };

test('t701 real gather: every referenced library piece lands under the team directory, byte-identical', () => {
  const { home, dir, teamFile, eng } = mkRealHome('clx-t701-real-', { roles: REAL_ROLES, library: REAL_LIBRARY });
  const expected = [
    ['prompts/system/h.md', 'prompts/system/h.md'],
    ['prompts/append/proj.md', 'prompts/append/proj.md'],
    ['templates/hs.json', 'templates/hs.json'],
    ['exec/run.json', 'exec/run.json'],
  ];
  // ENTER, both halves: the library has each piece and the team has NONE of them.
  // Without the second half a gather that wrote nothing would pass every
  // assertion below.
  for (const [lib, own] of expected) {
    assert.ok(fs.existsSync(path.join(home, 'library', lib)), `ENTER: library has ${lib}`);
    assert.ok(!fs.existsSync(path.join(dir, own)), `ENTER: the team does NOT have ${own} yet`);
  }
  const before = fs.readFileSync(teamFile);

  const res = eng.gatherTeam('t', {});

  assert.strictEqual(res.failed.length, 0, `nothing failed: ${JSON.stringify(res.failed)}`);
  assert.deepStrictEqual(res.copied.map((i) => `${i.kind}/${i.stem}`).sort(),
    ['append/proj', 'exec/run', 'system/h', 'templates/hs'], 'all four kinds copied');
  for (const [lib, own] of expected) {
    // BUFFERS, not parsed objects: a template copy that round-tripped through
    // JSON.parse/stringify would compare equal as an object while being bytes the
    // operator never authored.
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, own)), fs.readFileSync(path.join(home, 'library', lib)),
      `${own} is byte-identical to its library original`);
  }
  assert.deepStrictEqual(fs.readFileSync(teamFile), before, 'team.json is untouched — refs are stems, so nothing is rewritten');
});

test('t701 real gather: a second run keeps everything and rewrites no file', () => {
  const { dir, eng } = mkRealHome('clx-t701-twice-', { roles: REAL_ROLES, library: REAL_LIBRARY });
  const first = eng.gatherTeam('t', {});
  // ENTER: the first run actually wrote, or "the second changed nothing" is a
  // statement about two runs that both did nothing.
  assert.strictEqual(first.copied.length, 4, 'ENTER: the first run copied four pieces');

  const owned = ['prompts/system/h.md', 'prompts/append/proj.md', 'templates/hs.json', 'exec/run.json'];
  // The INODE, not the mtime: atomicWriteFileSync renames a fresh file into
  // place, so a rewrite changes the inode even when two writes land in the same
  // millisecond and the mtime does not move.
  const before = owned.map((p) => fs.statSync(path.join(dir, p)).ino);

  const second = eng.gatherTeam('t', {});

  assert.deepStrictEqual(second.copied, [], 'the second run copies nothing');
  assert.deepStrictEqual(second.kept.map((i) => `${i.kind}/${i.stem}`).sort(),
    ['append/proj', 'exec/run', 'system/h', 'templates/hs'], 'it reports all four kept');
  assert.deepStrictEqual(owned.map((p) => fs.statSync(path.join(dir, p)).ino), before,
    'no file was replaced — gather never overwrites what the team already owns');
});

test('t701 dry: the plan is produced and NOTHING is written', () => {
  const { dir, eng } = mkRealHome('clx-t701-dry-', { roles: REAL_ROLES, library: REAL_LIBRARY });
  const owned = ['prompts/system/h.md', 'prompts/append/proj.md', 'templates/hs.json', 'exec/run.json'];
  for (const p of owned) assert.ok(!fs.existsSync(path.join(dir, p)), `ENTER: the team owns nothing yet (${p})`);

  const plan = eng.gatherTeam('t', { dry: true });

  assert.strictEqual(plan.dry, true);
  assert.deepStrictEqual(plan.copied, [], 'dry writes nothing, so nothing is copied');
  for (const p of owned) assert.ok(!fs.existsSync(path.join(dir, p)), `dry left ${p} unwritten`);

  const applied = eng.gatherTeam('t', {});
  assert.deepStrictEqual(
    plan.items.map((i) => [i.kind, i.stem, i.role, i.via, i.action === 'copy' ? 'copy' : i.action]),
    applied.items.map((i) => [i.kind, i.stem, i.role, i.via, i.action === 'copied' ? 'copy' : i.action]),
    'the dry plan is the applied report minus the outcome — same items, same order',
  );
});

test('t701 the copies take effect: the next resolution reads the team\'s own file', () => {
  const { home, dir, eng } = mkRealHome('clx-t701-effect-', { roles: REAL_ROLES, library: REAL_LIBRARY });
  const team = { name: 't', dir, root: path.join(dir, '..'), roles: REAL_ROLES };
  const libPrompt = path.join(home, 'library', 'prompts', 'system', 'h.md');

  // ENTER: before the gather the SAME call resolves to the library. This is the
  // whole subject — without it, "it resolves to the team path" could be true of a
  // resolver that never had a library branch.
  assert.strictEqual(eng.resolveSystemPromptFile('h', null, team), libPrompt,
    'ENTER: before gather, `h` resolves to the library file');
  assert.strictEqual(readTeamJson({ fs, path }, team, 'templates', 'hs'), null,
    'ENTER: before gather, the team has no template copy');

  eng.gatherTeam('t', {});

  assert.strictEqual(eng.resolveSystemPromptFile('h', null, team), path.join(dir, 'prompts', 'system', 'h.md'),
    'after gather the team\'s own copy answers — nothing in team.json changed, the stem simply resolves here first');
  assert.deepStrictEqual(readTeamJson({ fs, path }, team, 'templates', 'hs'),
    JSON.parse(fs.readFileSync(path.join(home, 'library', 'templates', 'hs.json'), 'utf8')),
    'and the gathered template is what the team resolves to');
});

// ── group 5: the intent ─────────────────────────────────────────────────────

test('t701 intent: parseTeam shapes for gather / gather dry, and the alternation stays closed', () => {
  assert.deepStrictEqual(parseIntent('[agent:team gather]'),
    { type: 'team', sub: 'gather', dry: false, body: '' });
  assert.deepStrictEqual(parseIntent('[agent:team gather dry]'),
    { type: 'team', sub: 'gather', dry: true, body: '' });
  assert.strictEqual(parseIntent('[agent:team gatherx]'), null,
    'closed alternation — gatherx is not gather, the same pin role-addx carries');
});

// A manager with just enough wiring for _handleTeam's gather case: a team to
// resolve, a stubbed gatherTeam to capture the call, and a recording _injectText.
function mkTeamGatherMut({ gather = () => ({ team: 't', items: [], copied: [], kept: [], skipped: [], missing: [], failed: [] }) } = {}) {
  const calls = [];
  const injected = [];
  const team = { name: 't', root: '/proj', lead: 'lead', dir: '/teams/t', roles: {} };
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    os: require('node:os'),
    fs,
    path,
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? team : null),
    findProjectRoot: () => '/proj',
    gatherTeam: (...args) => { calls.push(['gatherTeam', ...args]); return gather(...args); },
    log: silent,
    getPersistence: () => ({ get: () => null, list: () => [] }),
    getTemplates: () => ({ list: () => [] }),
    listAllTemplates: () => [],
    withoutPrivilegedIntentsFor: (x) => x,
    ensureDir: () => {},
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    DEFAULT_WORKSPACE_ID: 'default',
  });
  const m = new SessionManager();
  m.sessions = new Map();
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._injectText = (_s, text) => { injected.push(text); };
  const seat = (name, cwd = '/proj') => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, activityState: 'idle' });
    return m.sessions.get(name);
  };
  return { m, calls, injected, team, seat };
}

test('t701 intent: the lead\'s gather calls gatherTeam once and replies with the report', () => {
  const f = mkTeamGatherMut({
    gather: () => ({
      team: 't', dry: false,
      items: [{ kind: 'system', stem: 'h', role: 'hand', via: 'role.prompt', action: 'copied' }],
      copied: [{}], kept: [], skipped: [], missing: [], failed: [],
    }),
  });
  f.seat('lead');
  f.m._handleTeam(f.seat('lead'), { type: 'team', sub: 'gather', dry: false, body: '' });

  assert.deepStrictEqual(f.calls, [['gatherTeam', 't', { dry: false }]], 'called ONCE, with the team name and the dry flag');
  assert.ok(f.injected.some((t) => t.startsWith('[agent:team] gathered t:')), `applied reply: ${JSON.stringify(f.injected)}`);
});

test('t701 intent: `gather dry` passes dry through and the reply says it is a plan', () => {
  const f = mkTeamGatherMut({
    gather: () => ({ team: 't', dry: true, items: [], copied: [], kept: [], skipped: [], missing: [], failed: [] }),
  });
  f.seat('lead');
  f.m._handleTeam(f.seat('lead'), { type: 'team', sub: 'gather', dry: true, body: '' });

  assert.deepStrictEqual(f.calls, [['gatherTeam', 't', { dry: true }]]);
  assert.ok(f.injected.some((t) => t.startsWith('[agent:team] gather plan for t:')), `dry reply: ${JSON.stringify(f.injected)}`);
});

test('t701 intent GUARD: a non-lead seat is bounced and gatherTeam is never called', () => {
  // GUARD PIN: gather rides the lead-only gate _handleTeam already applies to
  // every verb, so this passes by construction. It is here because gather is the
  // first team verb that WRITES outside team.json, and a future `case` placed
  // above the gate would not be caught anywhere else.
  const f = mkTeamGatherMut();
  f.seat('t-hand');
  f.m._handleTeam(f.seat('t-hand'), { type: 'team', sub: 'gather', dry: false, body: '' });

  assert.deepStrictEqual(f.calls, [], 'no gather for a non-lead');
  assert.ok(f.injected.some((t) => /only the team lead \(lead\) can edit team metadata/.test(t)));
});

// ── group 6: the IPC door ───────────────────────────────────────────────────

function mkGatherDoor(gatherTeam) {
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: silent,
    gatherTeam,
  });
  return (name, opts) => handlers.get('team:gather')(null, name, opts);
}

test('t701 ipc: team:gather returns { ok: true } with the five lists', () => {
  const { eng, dir } = mkRealHome('clx-t701-ipc-', { roles: REAL_ROLES, library: REAL_LIBRARY });
  assert.ok(!fs.existsSync(path.join(dir, 'prompts', 'system', 'h.md')), 'ENTER: the team owns nothing yet');

  const res = mkGatherDoor(eng.gatherTeam)('t', {});

  assert.strictEqual(res.ok, true, `expected ok (got: ${res.error})`);
  for (const k of ['copied', 'kept', 'skipped', 'missing', 'failed']) {
    assert.ok(Array.isArray(res[k]), `${k} is a list on the envelope`);
  }
  assert.deepStrictEqual(res.copied.map((i) => `${i.kind}/${i.stem}`).sort(),
    ['append/proj', 'exec/run', 'system/h', 'templates/hs']);
  assert.ok(fs.existsSync(path.join(dir, 'prompts', 'system', 'h.md')), 'and it really wrote');
});

test('t701 ipc: an unknown team comes back as { ok: false, error } in the team:setRole shape', () => {
  const res = mkGatherDoor(() => { throw new Error('no such team: nope'); })('nope', {});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'no such team: nope', 'the mutator\'s message reaches the caller, not a generic one');
});

// ── group 7: confinement ────────────────────────────────────────────────────

test('t701 confinement: a traversing prompt and a separator-bearing template are skipped, untouched', () => {
  // ENTER: these are exactly the stems team-prompt-dir.js refuses to resolve, so
  // gather refusing to WRITE them is the same rule read in the other direction.
  assert.ok(badStem('../x') && badStem('a/b'), 'ENTER: both stems are ones the resolver refuses');

  const sources = mkSources({ library: LIB, templates: { 'a/b': HS_TEMPLATE } });
  const team = { name: 't', dir: '/teams/t', roles: { rogue: { prompt: '../x', template: 'a/b' } } };
  const { items } = planGather(team, sources);

  assert.deepStrictEqual(items, [
    { kind: 'system', stem: '../x', role: 'rogue', via: 'role.prompt', action: 'skipped', reason: 'bad stem', from: null, to: null },
    { kind: 'templates', stem: 'a/b', role: 'rogue', via: 'role.template', action: 'skipped', reason: 'bad stem', from: null, to: null },
  ], 'both are skipped as bad stems — and the walk does not descend into the refused template');

  assert.deepStrictEqual(sources.calls, [],
    'no probe fired at all: nothing outside team.dir was read, and no path was even built for them');

  const wrote = [];
  applyGather({ items }, { write: (...a) => wrote.push(a) });
  assert.deepStrictEqual(wrote, [], 'and apply writes nothing for a skipped item');
});

// createEngine starts background timers that keep the loop alive.
after(() => { setImmediate(() => process.exit(0)); });
