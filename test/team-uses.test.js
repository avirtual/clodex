'use strict';
// team-uses.test.js — t702. The roles popover shows what each role USES and
// whether the team owns it. The list is the Gather plan re-read: same walk, same
// order, same verdict per piece, so the popover, `[agent:team gather dry]` and
// the applied report cannot disagree.
//
// `usesByRole` is the whole testable surface — the popover itself is DOM-bound
// and untested by design (its header says so). Two facts about it are worth more
// than the mapping table and are pinned separately: `bytes` (a whole library
// file) never reaches the result or the IPC reply, and the badges FLIP from
// library to team when Gather is applied, which is the only reason the list is
// derived from the plan rather than from the manifest.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { usesByRole } = require('../team-gather');
const { registerIpcHandlers } = require('../ipc-handlers');
const { createEngine } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

const silent = { info() {}, warn() {}, error() {} };
const entries = (m) => [...m.entries()];

// ── group 1: the mapping, pure ──────────────────────────────────────────────

// Every action/reason combination planGather can emit, across two roles, with
// `bytes` present on the copy item exactly as the leaf produces it.
const ALL_ACTIONS = [
  { kind: 'system', stem: 'own', role: 'hand', via: 'role.prompt', action: 'kept' },
  { kind: 'templates', stem: 'hs', role: 'hand', via: 'role.template', action: 'copy', bytes: 'LIBRARY FILE BODY' },
  { kind: 'append', stem: 'p:knowledge', role: 'hand', via: 'template.appendPromptFiles', action: 'skipped', reason: 'plugin ref' },
  { kind: 'append', stem: '../esc', role: 'hand', via: 'template.appendPromptFiles', action: 'skipped', reason: 'bad stem' },
  { kind: 'exec', stem: 'nowhere', role: 'hand', via: 'template.execCommands', action: 'missing' },
  { kind: 'system', stem: 'r', role: 'reviewer', via: 'role.prompt', action: 'copy', bytes: 'ANOTHER BODY' },
];

test('t702 usesByRole: the whole map — five verdicts, discovery order, roles kept apart', () => {
  // ENTER: the input really carries every action AND both skip reasons, or the
  // table below asserts a mapping over cases that were never present.
  assert.deepStrictEqual(
    [...new Set(ALL_ACTIONS.map((i) => (i.action === 'skipped' ? `skipped/${i.reason}` : i.action)))].sort(),
    ['copy', 'kept', 'missing', 'skipped/bad stem', 'skipped/plugin ref'],
    'ENTER: all five action/reason combinations are in the fixture',
  );

  assert.deepStrictEqual(entries(usesByRole(ALL_ACTIONS)), [
    ['hand', [
      { kind: 'system', stem: 'own', via: 'role.prompt', where: 'team' },
      { kind: 'templates', stem: 'hs', via: 'role.template', where: 'library' },
      { kind: 'append', stem: 'p:knowledge', via: 'template.appendPromptFiles', where: 'plugin' },
      { kind: 'append', stem: '../esc', via: 'template.appendPromptFiles', where: 'missing' },
      { kind: 'exec', stem: 'nowhere', via: 'template.execCommands', where: 'missing' },
    ]],
    ['reviewer', [
      { kind: 'system', stem: 'r', via: 'role.prompt', where: 'library' },
    ]],
  ], 'kept→team, copy→library, plugin ref→plugin, bad stem→missing, missing→missing');
});

test('t702 usesByRole: `bytes` is never carried into the result', () => {
  // The popover must not receive library FILE CONTENTS. deepStrictEqual above
  // would already catch an extra key, but this states the property by name and
  // over every entry, so it survives a future widening of the table.
  const withBytes = ALL_ACTIONS.filter((i) => 'bytes' in i);
  assert.strictEqual(withBytes.length, 2, 'ENTER: two fixture items carry bytes');

  for (const [role, list] of usesByRole(ALL_ACTIONS)) {
    for (const u of list) {
      assert.deepStrictEqual(Object.keys(u).sort(), ['kind', 'stem', 'via', 'where'],
        `${role}/${u.stem}: exactly the four display fields, no bytes`);
    }
  }
});

test('t702 usesByRole: a role that references nothing is PRESENT with an empty list', () => {
  // Absent and empty are different states to a renderer: absent falls through to
  // whatever a missing key renders as, empty says "uses nothing" in words. A role
  // with no refs contributes no plan items at all, so the role KEYS are a second
  // argument — the plan cannot name a role it never walked.
  const items = [{ kind: 'system', stem: 'h', role: 'hand', via: 'role.prompt', action: 'kept' }];
  assert.deepStrictEqual(items.filter((i) => i.role === 'lead'), [],
    'ENTER: the plan carries no item for `lead` — it references nothing');

  assert.deepStrictEqual(entries(usesByRole(items, ['lead', 'hand'])), [
    ['lead', []],
    ['hand', [{ kind: 'system', stem: 'h', via: 'role.prompt', where: 'team' }]],
  ], 'lead is present-and-empty, in manifest order, ahead of the roles the plan named');

  assert.deepStrictEqual(entries(usesByRole([], ['lead'])), [['lead', []]],
    'and a whole team that references nothing still yields one entry per role');
});

test('t702 usesByRole GUARD: junk in, empty map out — never a throw', () => {
  // GUARD PIN: the popover calls this with `res.items` from an IPC reply it did
  // not validate. A throw here empties the whole roles list, so every non-array
  // and every non-object item must be skipped rather than mapped.
  for (const junk of [null, undefined, 'items', 42, {}]) {
    assert.deepStrictEqual(entries(usesByRole(junk)), [], `${JSON.stringify(junk)} → empty map`);
  }
  assert.deepStrictEqual(entries(usesByRole([null, 'x', { kind: 'system' }, { role: '', kind: 'system' }])), [],
    'an item with no usable role is dropped, not filed under ""');
});

// ── group 2: a real plan → uses, and the flip on gather ─────────────────────

// A real temp ~/.clodex: the team owns one exec def, the library has the rest,
// one exec def exists nowhere, and one append stem is a plugin ref. Every `where`
// the badge can show is reachable from this one fixture.
const T702_LIBRARY = {
  'prompts/system/h.md': '# hand prompt\n',
  'prompts/append/proj.md': '# project knowledge\n',
  'templates/hs.json': '{\n  "name": "hs",\n  "type": "claude",\n'
    + '  "appendPromptFiles": ["proj", "p:knowledge"],\n'
    + '  "execCommands": ["lib-run", "own-run", "nowhere"]\n}',
  'exec/lib-run.json': '{"argv":["/bin/true"]}',
};

const T702_ROLES = { lead: { brief: 'the lead' }, hand: { prompt: 'h', template: 'hs' } };

function mkHome(prefix) {
  const tmp = mkTmpRoot(prefix);
  const home = path.join(tmp, 'clodex-home');
  const repo = path.join(tmp, 'repo');
  const userData = path.join(tmp, 'userdata');
  const dir = path.join(home, 'teams', 't');
  for (const d of [repo, userData, dir]) fs.mkdirSync(d, { recursive: true });
  for (const [rel, body] of Object.entries(T702_LIBRARY)) {
    const p = path.join(home, 'library', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  // The one piece the team ALREADY owns, so `team` is reachable before any
  // gather runs — otherwise the pre-gather table could not distinguish "owned"
  // from "not yet gathered" at all.
  fs.mkdirSync(path.join(dir, 'exec'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'exec', 'own-run.json'), '{"argv":["/bin/true"]}');
  fs.writeFileSync(path.join(dir, 'team.json'),
    JSON.stringify({ root: repo, lead: 't-lead', roles: T702_ROLES }, null, 2));
  return { tmp, home, dir, eng: createEngine({ userDataPath: userData, seams: { registryDir: home }, log: silent }) };
}

// Each row's `where` is a LITERAL, not derived from the item it describes: the
// table's job is to state five different verdicts over one walk, and a computed
// column would assert only that the code agrees with itself.
const BEFORE_GATHER = [
  ['hand', 'system', 'h', 'library'],
  ['hand', 'templates', 'hs', 'library'],
  ['hand', 'append', 'proj', 'library'],
  ['hand', 'append', 'p:knowledge', 'plugin'],
  ['hand', 'exec', 'lib-run', 'library'],
  ['hand', 'exec', 'own-run', 'team'],
  ['hand', 'exec', 'nowhere', 'missing'],
];

const flat = (m) => [...m.entries()].flatMap(([role, list]) => list.map((u) => [role, u.kind, u.stem, u.where]));

test('t702 real plan: every badge a role can show, over one real team', () => {
  const { eng } = mkHome('clx-t702-plan-');

  const rows = flat(usesByRole(eng.gatherTeam('t', { dry: true }).items, Object.keys(T702_ROLES)));

  assert.deepStrictEqual(rows, BEFORE_GATHER, 'the plan, rendered: four verdicts in discovery order');
  // ENTER for the flip below, stated here where the table is: the pre-gather
  // list really does contain library rows. Without them "everything says team
  // afterwards" would be true of a fixture that said team all along.
  assert.ok(rows.some(([, , , w]) => w === 'library'), 'ENTER: at least one piece is borrowed before the gather');
});

test('t702 the flip: applying Gather turns every `library` row into `team`, and nothing else moves', () => {
  const { eng } = mkHome('clx-t702-flip-');
  const before = flat(usesByRole(eng.gatherTeam('t', { dry: true }).items, Object.keys(T702_ROLES)));
  assert.deepStrictEqual(before, BEFORE_GATHER, 'ENTER: the pre-gather table, with its library rows');

  const applied = eng.gatherTeam('t', {});
  assert.strictEqual(applied.failed.length, 0, `ENTER: the gather really wrote: ${JSON.stringify(applied.failed)}`);

  const after = flat(usesByRole(eng.gatherTeam('t', { dry: true }).items, Object.keys(T702_ROLES)));

  assert.deepStrictEqual(after, BEFORE_GATHER.map(([r, k, s, w]) => [r, k, s, w === 'library' ? 'team' : w]),
    'library → team; the plugin ref, the already-owned piece and the missing one are unchanged');
  assert.deepStrictEqual(after.map(([r, k, s]) => [r, k, s]), before.map(([r, k, s]) => [r, k, s]),
    'and the same pieces in the same order — the gather changed ownership, not the walk');
});

test('t702 the lead references nothing, and says so rather than vanishing', () => {
  const { eng } = mkHome('clx-t702-lead-');
  const plan = eng.gatherTeam('t', { dry: true });
  assert.deepStrictEqual(plan.items.filter((i) => i.role === 'lead'), [],
    'ENTER: this team\'s lead names no prompt and no template, so the plan skips it');

  assert.deepStrictEqual(usesByRole(plan.items, Object.keys(T702_ROLES)).get('lead'), [],
    'the popover gets an empty list to render as "uses nothing"');
});

// ── group 3: the IPC edge strips bytes, the leaf keeps them ─────────────────

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

const LISTS = ['items', 'copied', 'kept', 'skipped', 'missing', 'failed'];

test('t702 ipc: no item in any of the six lists carries `bytes`, dry or applied', () => {
  const { eng } = mkHome('clx-t702-ipc-');
  const door = mkGatherDoor(eng.gatherTeam);

  for (const [label, opts] of [['dry', { dry: true }], ['applied', {}]]) {
    const res = door('t', opts);
    assert.strictEqual(res.ok, true, `${label}: ok (got ${res.error})`);
    // ENTER: there IS something to strip on this path. A reply whose lists were
    // all empty would satisfy every assertion below while stripping nothing.
    const seen = LISTS.flatMap((k) => (Array.isArray(res[k]) ? res[k] : []));
    assert.ok(seen.length, `ENTER (${label}): the reply carries items at all`);

    for (const k of LISTS) {
      for (const i of (Array.isArray(res[k]) ? res[k] : [])) {
        assert.ok(!('bytes' in i), `${label}: ${k}/${i.kind}/${i.stem} reached the renderer with bytes`);
      }
    }
  }
});

test('t702 ipc GUARD: the leaf still carries `bytes` — the strip is at the edge, not in gatherTeam', () => {
  // GUARD PIN: applyGather WRITES item.bytes. Had the strip been pushed down into
  // team-gather.js or engine.js instead, this file's other subject would still be
  // green and every gather would silently copy empty files. The direct call is
  // the intent path (`[agent:team gather]`), which must be unaffected.
  const { eng } = mkHome('clx-t702-leaf-');
  const plan = eng.gatherTeam('t', { dry: true });
  const copies = plan.items.filter((i) => i.action === 'copy');
  assert.ok(copies.length, 'ENTER: this fixture has pieces to copy');

  for (const i of copies) {
    assert.ok('bytes' in i && i.bytes != null && i.bytes.length,
      `${i.kind}/${i.stem}: the leaf keeps the file contents applyGather writes`);
  }
});

// ── group 4: what this ticket must NOT have widened ─────────────────────────

test('t702 preflight is untouched: LEVELS and KINDS are the arrays ~20 whole-array pins expect', () => {
  // The uses list is ONE mechanism, and preflight is not it: a finding still
  // means "something is owed", so a borrowed piece must stay silent there even
  // though it now shows a `library` badge two lines above. Source-shape, because
  // the tables are module constants with no runtime accessor.
  const src = fs.readFileSync(path.join(__dirname, '..', 'team-preflight.js'), 'utf8');
  assert.ok(/const LEVELS = \['warn', 'note'\];/.test(src), 'LEVELS is unchanged');
  assert.ok(/const KINDS = \['prompt', 'append', 'template', 'exec', 'verify'\];/.test(src), 'KINDS is unchanged');
});

// ── group 5: the renderer's copy ────────────────────────────────────────────

test('t702 parity: the renderer copy of usesByRole is byte-identical to the main-process one', () => {
  // The renderer CANNOT require team-gather.js: it requires `path`, and
  // build/build-web.js aliases only os/crypto/child_process, so the cross-boundary
  // require fails the browser bundle with `Could not resolve "path"` (verified by
  // building it). The function is therefore duplicated, and duplication with no
  // pin is drift with extra steps — this is the pin.
  const ROOT = path.join(__dirname, '..');
  const grab = (file) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const at = src.indexOf('function usesByRole');
    assert.ok(at > 0, `${file} defines usesByRole`);
    const end = src.indexOf('\n}\n', at);
    assert.ok(end > at, `${file}: usesByRole has a closing brace at column 0`);
    return src.slice(at, end + 2);
  };
  const constants = (file) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    return [/const WHERE_BY_ACTION = .*;/, /const WHERE_BY_REASON = .*;/].map((re) => {
      const m = src.match(re);
      assert.ok(m, `${file} declares ${re}`);
      return m[0];
    });
  };

  assert.strictEqual(grab('renderer/lib/team-roles.js'), grab('team-gather.js'),
    'the two usesByRole bodies must be byte-identical — edit them together');
  assert.deepStrictEqual(constants('renderer/lib/team-roles.js'), constants('team-gather.js'),
    'and so must the two lookup tables the body reads');
});

test('t702 parity GUARD: the renderer never requires team-gather across the bundle boundary', () => {
  // GUARD PIN: the byte-identity subject above stays green if someone "fixes" the
  // duplication with a require and leaves the dead copy behind — and the failure
  // would appear only in `npm run build:web`, which no unit test runs.
  for (const file of ['renderer/lib/team-roles.js', 'renderer/popovers/team-roles-popover.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(!/require\(['"][./]*\.\.\/team-gather['"]\)/.test(src),
      `${file} must not require team-gather — it is unbundlable for the browser`);
  }
});

test('t702 wiring: the popover loads the uses map on every refresh and renders a badge per piece', () => {
  // The popover is DOM-bound and has no unit tests (its header says so), so the
  // wire is pinned by shape. Three facts, each of which failing would leave the
  // pure helper perfectly correct and the feature invisible: the dry gather is
  // called, its result reaches usesByRole with the MANIFEST's role keys, and the
  // load happens inside refresh (which a Gather apply calls — that is the flip).
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'popovers', 'team-roles-popover.js'), 'utf8');

  assert.ok(/teamGather\(name, \{ dry: true \}\)/.test(src), 'loadUses asks for a DRY plan — it must not write');
  assert.ok(/uses = usesByRole\(res\.items, roleKeys\)/.test(src), 'the reply feeds usesByRole');

  const refresh = src.slice(src.indexOf('async function refresh'));
  const body = refresh.slice(0, refresh.indexOf('\n  }\n'));
  assert.ok(/await loadUses\(res\.team\.name, Object\.keys\(\(res\.team && res\.team\.roles\) \|\| \{\}\)\)/.test(body),
    'refresh loads the uses map with the manifest role keys, so a Gather apply flips the badges');
  // The CALL, not the bare word: `renderRows` is named in a comment further up
  // this same body, and matching that instead made the ordering unassertable.
  assert.ok(body.indexOf('await loadUses') < body.indexOf('renderRows(res.team)'),
    'and it loads BEFORE renderRows, or the rows paint the previous team\'s badges');

  assert.ok(/team-role-badge team-role-where \$\{u\.where\}/.test(src), 'each piece gets a where-badge');
  assert.ok(/textContent = 'uses nothing'/.test(src), 'and an empty list says so in words');
});

// createEngine starts background timers that keep the loop alive.
after(() => { setImmediate(() => process.exit(0)); });
